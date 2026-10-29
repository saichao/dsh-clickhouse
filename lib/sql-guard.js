import { UserError } from "./errors.js";
/**
 * Read-only SQL guard.
 *
 * Strategy (defence in depth, all client side):
 *  1. mask comments and quoted literals/identifiers, so only real code tokens remain;
 *  2. reject multiple statements;
 *  3. require a read-only first keyword;
 *  4. reject write statements / dangerous clauses anywhere in the code tokens;
 *  5. optionally reject external data sources (file(), url(), s3(), ...).
 *
 * Because quoted identifiers are masked, a column that collides with a blocked
 * keyword can always be written as `SELECT `delete` FROM t`.
 */
const ALLOWED_STATEMENTS = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "EXISTS"]);
/** Statements that mutate data/schema/settings and must never appear, even nested (e.g. `WITH ... INSERT`). */
const FORBIDDEN_KEYWORDS = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "ALTER",
    "CREATE",
    "DROP",
    "TRUNCATE",
    "RENAME",
    "ATTACH",
    "DETACH",
    "OPTIMIZE",
    "GRANT",
    "REVOKE",
    "KILL",
    "MOVE",
    "EXCHANGE",
    "UNDROP",
    "BACKUP",
    "RESTORE",
    "FREEZE",
    "UNFREEZE",
    "WATCH",
];
/** Table functions able to reach outside the configured ClickHouse instance. */
const EXTERNAL_SOURCE_FUNCTIONS = [
    "file",
    "url",
    "remote",
    "remoteSecure",
    "s3",
    "s3Cluster",
    "gcs",
    "azureBlobStorage",
    "hdfs",
    "jdbc",
    "odbc",
    "mysql",
    "postgresql",
    "sqlite",
    "mongodb",
    "redis",
    "deltaLake",
    "iceberg",
    "hudi",
    "input",
];
/**
 * 抹掉注释与单引号字符串，但**保留标识符**（反引号 / 双引号）。
 *
 * 提取表名不能直接用 `maskSql`：它会把 `` `表名` `` 一起抹掉；而保留单引号内容又会让
 * `WHERE title = 'from t'` 造出一个假表名。
 */
function maskCommentsAndStrings(sql) {
    const chars = sql.split("");
    const output = sql.split("");
    const length = chars.length;
    const blank = (from, to) => {
        for (let i = from; i < to && i < length; i += 1)
            output[i] = chars[i] === "\n" ? "\n" : " ";
    };
    let index = 0;
    while (index < length) {
        const char = chars[index];
        const next = index + 1 < length ? chars[index + 1] : "";
        if (char === "-" && next === "-") {
            const start = index;
            while (index < length && chars[index] !== "\n")
                index += 1;
            blank(start, index);
            continue;
        }
        if (char === "#" && next === "!") {
            const start = index;
            while (index < length && chars[index] !== "\n")
                index += 1;
            blank(start, index);
            continue;
        }
        if (char === "/" && next === "*") {
            const start = index;
            index += 2;
            while (index < length && !(chars[index] === "*" && chars[index + 1] === "/"))
                index += 1;
            index = Math.min(length, index + 2);
            blank(start, index);
            continue;
        }
        if (char === "'") {
            const start = index;
            index += 1;
            while (index < length) {
                const current = chars[index];
                if (current === "\\") {
                    index += 2;
                    continue;
                }
                if (current === "'") {
                    if (chars[index + 1] === "'") {
                        index += 2;
                        continue;
                    }
                    index += 1;
                    break;
                }
                index += 1;
            }
            blank(start, index);
            continue;
        }
        index += 1;
    }
    return output.join("");
}
/** FROM/JOIN 后面那个表名 token：`` `a b` ``、"x"、db.table、table 都认。 */
const TABLE_TOKEN = String.raw `(\`(?:[^\`]|\`\`)*\`|"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*)`;
/**
 * 出现在表列表位置的这些词表示表列表已经结束（子句关键字 / 连接修饰词 / 别名引导词）。
 * 没有它，`FROM t AS x` 里的 `AS x` 会被当成表名。
 */
const FROM_CLAUSE_TERMINATORS = new Set([
    "where",
    "prewhere",
    "group",
    "order",
    "having",
    "limit",
    "offset",
    "union",
    "intersect",
    "except",
    "settings",
    "format",
    "window",
    "qualify",
    "sample",
    "final",
    "on",
    "using",
    "join",
    "left",
    "inner",
    "full",
    "cross",
    "any",
    "all",
    "asof",
    "semi",
    "anti",
    "global",
    "array",
]);
function unquoteIdentifier(token) {
    if (token.startsWith("`") && token.endsWith("`"))
        return token.slice(1, -1).split("``").join("`");
    if (token.startsWith('"') && token.endsWith('"'))
        return token.slice(1, -1).split('""').join('"');
    return token;
}
/**
 * 列出 SQL 引用到的表（去重，忽略 CTE 名、派生表别名与 ARRAY JOIN 的数组列）。
 *
 * 只看「引用了哪些表」，所以有几个 WHERE 条件、用了多少字段、是不是子查询都不影响结论：
 * `字段A LIKE '%x%' AND 字段B LIKE '%x%'`、多字段 OR、同表子查询都只算一张表。
 *
 * 实现上先定位每个 FROM / JOIN，再解析它后面的表列表（`t`、`db.t`、`` `带空格的表` ``、
 * `t1, t2`、`t AS x` 都认），遇到顶层子句关键字（WHERE / GROUP / ON / …）就结束。
 */
export function extractTableReferences(sql, defaultDatabase = "") {
    // `ARRAY JOIN tags` 是单表内的数组展开，不是第二张表：先抹掉以免被当成表名。
    const scan = maskCommentsAndStrings(sql).replace(/\barray\s+join\b/gi, (text) => " ".repeat(text.length));
    const defaultDb = defaultDatabase.toLowerCase();
    // CTE 名不是真实表名，必须先收集出来排除掉。
    const cteNames = new Set();
    const ctePattern = /\bWITH\s+([A-Za-z_][A-Za-z0-9_$]*)\s+AS\s*\(|\B,\s*([A-Za-z_][A-Za-z0-9_$]*)\s+AS\s*\(/gi;
    let cte;
    while ((cte = ctePattern.exec(scan)) !== null) {
        const cteName = cte[1] ?? cte[2];
        if (cteName)
            cteNames.add(cteName.toLowerCase());
    }
    const seen = new Map();
    const add = (rawToken) => {
        const raw = unquoteIdentifier(rawToken);
        const last = (raw.split(".").pop() ?? raw).toLowerCase();
        if (cteNames.has(last))
            return;
        const normalized = raw.includes(".") ? raw.toLowerCase() : `${defaultDb}.${last}`;
        if (!seen.has(normalized))
            seen.set(normalized, raw);
    };
    const stickyToken = new RegExp(TABLE_TOKEN, "y");
    const stickyWord = /[A-Za-z_][A-Za-z0-9_$]*/y;
    const length = scan.length;
    const keywordPattern = /\b(?:from|join)\b/gi;
    let keyword;
    while ((keyword = keywordPattern.exec(scan)) !== null) {
        let p = keyword.index + keyword[0].length;
        let expectTable = true; // 下一个词应该是表名（逗号后也置回 true）
        while (p < length) {
            const char = scan[p];
            if (char === " " || char === "\n" || char === "\t" || char === "\r") {
                p += 1;
                continue;
            }
            if (char === ")")
                break; // 回到外层，表列表结束
            if (char === "(") {
                // 派生表：(SELECT ...) —— 它内部的 FROM 由外层循环自己的匹配处理。
                let depth = 1;
                p += 1;
                while (p < length && depth > 0) {
                    if (scan[p] === "(")
                        depth += 1;
                    else if (scan[p] === ")")
                        depth -= 1;
                    p += 1;
                }
                expectTable = false;
                continue;
            }
            if (char === ",") {
                expectTable = true;
                p += 1;
                continue;
            }
            // 先判子句关键字（普通标识符形状的词才可能是关键字），再判表名 token ——
            // 反引号/双引号包起来的表名不是「普通标识符形状」，必须直接走 token 分支。
            stickyWord.lastIndex = p;
            const word = stickyWord.exec(scan);
            const wordAtCursor = word !== null && word.index === p;
            if (wordAtCursor && FROM_CLAUSE_TERMINATORS.has((word?.[0] ?? "").toLowerCase()))
                break;
            if (expectTable) {
                stickyToken.lastIndex = p;
                const token = stickyToken.exec(scan);
                if (token && token.index === p) {
                    add(token[1]);
                    p += token[0].length;
                    expectTable = false;
                    continue;
                }
            }
            if (wordAtCursor) {
                p += word?.[0].length ?? 0; // 别名或其它词，跳过
                continue;
            }
            break; // 运算符之类的字符：表列表结束
        }
    }
    return [...seen.values()];
}
export class SqlGuardError extends UserError {
    name = "SqlGuardError";
}
const MASK_CHAR = " ";
/**
 * Replace comments and quoted literals/identifiers with spaces, keeping the rest
 * of the SQL intact so keywords can be located reliably.
 *
 * `keepQuoted: true` 时引号里的内容原样保留（只抹注释）。用于「找最后一个代码字符」，
 * 因为把引号内容也抹成空格会让以引号结尾的语句被误判为在引号之前就结束了。
 */
export function maskSql(sql, options = {}) {
    const keepQuoted = options.keepQuoted === true;
    const chars = sql.split("");
    const output = new Array(chars.length).fill(MASK_CHAR);
    const length = chars.length;
    let index = 0;
    const blank = (from, to) => {
        for (let i = from; i < to && i < length; i += 1) {
            // Keep newlines so error offsets stay roughly readable.
            output[i] = chars[i] === "\n" ? "\n" : MASK_CHAR;
        }
    };
    while (index < length) {
        const char = chars[index];
        const next = index + 1 < length ? chars[index + 1] : "";
        if (char === "-" && next === "-") {
            const start = index;
            while (index < length && chars[index] !== "\n")
                index += 1;
            blank(start, index);
            continue;
        }
        if (char === "#" && next === "!") {
            const start = index;
            while (index < length && chars[index] !== "\n")
                index += 1;
            blank(start, index);
            continue;
        }
        if (char === "/" && next === "*") {
            const start = index;
            index += 2;
            while (index < length && !(chars[index] === "*" && chars[index + 1] === "/"))
                index += 1;
            index = Math.min(length, index + 2);
            blank(start, index);
            continue;
        }
        if (char === "'" || char === '"' || char === "`") {
            const quote = char;
            const start = index;
            index += 1;
            while (index < length) {
                const current = chars[index];
                if (current === "\\") {
                    index += 2;
                    continue;
                }
                if (current === quote) {
                    if (chars[index + 1] === quote) {
                        index += 2;
                        continue;
                    }
                    index += 1;
                    break;
                }
                index += 1;
            }
            if (keepQuoted) {
                for (let i = start; i < index && i < length; i += 1)
                    output[i] = chars[i];
            }
            else {
                blank(start, index);
            }
            continue;
        }
        output[index] = char;
        index += 1;
    }
    return output.join("");
}
/** Index of the last non-space character of the masked SQL, or -1. */
function lastCodeIndex(masked) {
    for (let i = masked.length - 1; i >= 0; i -= 1) {
        if (masked[i] !== " " && masked[i] !== "\n" && masked[i] !== "\t" && masked[i] !== "\r")
            return i;
    }
    return -1;
}
/** Drop trailing comments and whitespace: `SELECT 1 -- x` -> `SELECT 1`. */
export function stripTrailingComments(sql) {
    // 必须用「保留引号内容」的掩码来找最后一个代码字符：maskSql 默认会把引号里的内容
    // 也抹成空格，于是 `SELECT 1 AS `行数``、`WHERE name = 'abc'` 这类以引号结尾的语句
    // 会被整段截断（这是一个真实踩过的 bug）。
    const codeMask = maskSql(sql, { keepQuoted: true });
    const end = lastCodeIndex(codeMask);
    if (end < 0)
        return "";
    return sql.slice(0, end + 1).trim();
}
/**
 * Validate a statement and return its normalized form.
 * @throws {SqlGuardError} when the statement is not a safe read-only query.
 */
export function inspectStatement(rawSql, options) {
    if (typeof rawSql !== "string" || rawSql.trim().length === 0) {
        throw new SqlGuardError("SQL 不能为空。");
    }
    const masked = maskSql(rawSql);
    const maskedTrimmed = masked.trim();
    if (maskedTrimmed.length === 0) {
        throw new SqlGuardError("这段内容只有注释，没有可执行的语句。");
    }
    // 1) single statement only
    const withoutTrailingSemicolons = masked.replace(/[\s;]+$/, "");
    if (withoutTrailingSemicolons.includes(";")) {
        throw new SqlGuardError("只允许执行单条语句：请去掉语句中间的 `;`。");
    }
    // 2) read-only first keyword (leading parentheses are allowed)
    const keywordMatch = /^[(\s]*([A-Za-z_][A-Za-z0-9_]*)/.exec(masked);
    if (!keywordMatch?.[1]) {
        throw new SqlGuardError("无法识别语句类型，请以 SELECT / WITH / SHOW / DESCRIBE / EXPLAIN 开头。");
    }
    const statement = keywordMatch[1].toUpperCase();
    if (!ALLOWED_STATEMENTS.has(statement)) {
        throw new SqlGuardError(`只允许只读语句（SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / EXISTS），收到的是 ${statement}。` +
            "本插件（dsh-clickhouse）不接受任何写操作。");
    }
    const code = stripTrailingComments(rawSql);
    const codeMasked = maskSql(code);
    const warnings = [];
    // 3) nested write statements, e.g. `WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x`
    for (const keyword of FORBIDDEN_KEYWORDS) {
        if (new RegExp(`\\b${keyword}\\b`, "i").test(codeMasked)) {
            throw new SqlGuardError(`查询里出现了写操作关键字 ${keyword}，已拒绝执行。` +
                "如果它只是一个同名的列/表名，请用反引号包起来，例如 `SELECT `" +
                keyword.toLowerCase() +
                "` FROM t`。");
        }
    }
    // 4) data exfiltration / SSRF-ish clauses
    if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(codeMasked)) {
        throw new SqlGuardError("`INTO OUTFILE` / `INTO DUMPFILE` 会写文件，已拒绝执行。");
    }
    // 5) FORMAT clause would collide with the FORMAT the driver appends
    if (/\bFORMAT\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i.test(codeMasked) ||
        /\bFORMAT\s+[A-Za-z_][A-Za-z0-9_]*\s+SETTINGS\b/i.test(codeMasked)) {
        throw new SqlGuardError("请不要在 SQL 里写 `FORMAT ...`：结果格式由插件统一控制。");
    }
    // 6) SETTINGS clause can weaken the server-side caps
    if (!options.allowQuerySettings && /\bSETTINGS\s+[\w.]+\s*=/i.test(codeMasked)) {
        throw new SqlGuardError("请不要在 SQL 里写 `SETTINGS ...`（会绕过行数/超时上限）。" +
            "确需放开时把插件配置 allowQuerySettings 设为 true。");
    }
    // 7) external data sources
    if (!options.allowExternalSources) {
        const externalPattern = new RegExp(`\\b(${EXTERNAL_SOURCE_FUNCTIONS.join("|")})\\s*\\(`, "i");
        const externalMatch = externalPattern.exec(codeMasked);
        if (externalMatch?.[1]) {
            throw new SqlGuardError(`表函数 ${externalMatch[1]}() 可以访问 ClickHouse 之外的数据源，默认被禁用。` +
                "确需使用时把插件配置 allowExternalSources 设为 true。");
        }
    }
    // 8) 单表策略：JOIN 与「引用多张表」默认禁止
    if (!options.allowCrossTable) {
        // `ARRAY JOIN` 是单表内的数组展开，不算跨表，放行。
        if (/(?<!array\s)\bJOIN\b/i.test(codeMasked)) {
            throw new SqlGuardError("默认只允许单表查询：SQL 里出现了 JOIN。" +
                "请拆成单表查询；确需跨表时把插件配置 allowCrossTable 设为 true。");
        }
        const tables = extractTableReferences(code, options.defaultDatabase ?? "");
        if (tables.length > 1) {
            throw new SqlGuardError(`默认只允许单表查询：这条 SQL 引用了 ${tables.length} 张表（${tables.join("、")}）。` +
                "同一张表内的多条件、多字段 OR、子查询都是允许的；" +
                "确需跨表时把插件配置 allowCrossTable 设为 true。");
        }
    }
    return {
        sql: code.replace(/;+$/, "").trim(),
        masked: codeMasked,
        statement,
        hasLimit: /\bLIMIT\b/i.test(codeMasked),
        warnings,
    };
}
/** True when the statement can be wrapped into `SELECT * FROM (<sql>) LIMIT n`. */
export function isWrappable(statement) {
    return statement.statement === "SELECT" || statement.statement === "WITH";
}
/** Append a `LIMIT` when the statement has none. Used by the fallback path. */
export function applyRowLimit(statement, limit) {
    const safeLimit = Math.max(1, Math.floor(limit));
    if (statement.hasLimit || !isWrappable(statement))
        return statement.sql;
    return `${statement.sql} LIMIT ${safeLimit}`;
}
/** Hard row cap at the SQL level: `SELECT * FROM (<sql>) LIMIT n + 1`. */
export function wrapWithRowLimit(statement, limit) {
    const safeLimit = Math.max(1, Math.floor(limit));
    return `SELECT * FROM (\n${statement.sql}\n) LIMIT ${safeLimit}`;
}
//# sourceMappingURL=sql-guard.js.map