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
] as const;

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
] as const;

export interface GuardOptions {
  /** Allow file()/url()/remote()/s3()/... table functions. Default false. */
  allowExternalSources: boolean;
  /** Allow a trailing `SETTINGS ...` clause. Default false. */
  allowQuerySettings: boolean;
}

export interface GuardedStatement {
  /** Statement with trailing comments/whitespace removed and trailing `;` stripped. */
  sql: string;
  /** Comment/literal-free view of `sql`, used for keyword inspection. */
  masked: string;
  /** Uppercase first keyword, e.g. `SELECT`. */
  statement: string;
  /** True when the statement already carries a `LIMIT` clause. */
  hasLimit: boolean;
  /** Human-readable warnings produced by the guard (non fatal). */
  warnings: string[];
}

export class SqlGuardError extends UserError {
  override readonly name: string = "SqlGuardError";
}

const MASK_CHAR = " ";

/**
 * Replace comments and quoted literals/identifiers with spaces, keeping the rest
 * of the SQL intact so keywords can be located reliably.
 *
 * `keepQuoted: true` 时引号里的内容原样保留（只抹注释）。用于「找最后一个代码字符」，
 * 因为把引号内容也抹成空格会让以引号结尾的语句被误判为在引号之前就结束了。
 */
export function maskSql(sql: string, options: { keepQuoted?: boolean } = {}): string {
  const keepQuoted = options.keepQuoted === true;
  const chars = sql.split("");
  const output = new Array<string>(chars.length).fill(MASK_CHAR);
  const length = chars.length;
  let index = 0;

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < length; i += 1) {
      // Keep newlines so error offsets stay roughly readable.
      output[i] = chars[i] === "\n" ? "\n" : MASK_CHAR;
    }
  };

  while (index < length) {
    const char = chars[index] as string;
    const next = index + 1 < length ? (chars[index + 1] as string) : "";

    if (char === "-" && next === "-") {
      const start = index;
      while (index < length && chars[index] !== "\n") index += 1;
      blank(start, index);
      continue;
    }
    if (char === "#" && next === "!") {
      const start = index;
      while (index < length && chars[index] !== "\n") index += 1;
      blank(start, index);
      continue;
    }
    if (char === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < length && !(chars[index] === "*" && chars[index + 1] === "/")) index += 1;
      index = Math.min(length, index + 2);
      blank(start, index);
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      const start = index;
      index += 1;
      while (index < length) {
        const current = chars[index] as string;
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
        for (let i = start; i < index && i < length; i += 1) output[i] = chars[i] as string;
      } else {
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
function lastCodeIndex(masked: string): number {
  for (let i = masked.length - 1; i >= 0; i -= 1) {
    if (masked[i] !== " " && masked[i] !== "\n" && masked[i] !== "\t" && masked[i] !== "\r") return i;
  }
  return -1;
}

/** Drop trailing comments and whitespace: `SELECT 1 -- x` -> `SELECT 1`. */
export function stripTrailingComments(sql: string): string {
  // 必须用「保留引号内容」的掩码来找最后一个代码字符：maskSql 默认会把引号里的内容
  // 也抹成空格，于是 `SELECT 1 AS `行数``、`WHERE name = 'abc'` 这类以引号结尾的语句
  // 会被整段截断（这是一个真实踩过的 bug）。
  const codeMask = maskSql(sql, { keepQuoted: true });
  const end = lastCodeIndex(codeMask);
  if (end < 0) return "";
  return sql.slice(0, end + 1).trim();
}

/**
 * Validate a statement and return its normalized form.
 * @throws {SqlGuardError} when the statement is not a safe read-only query.
 */
export function inspectStatement(rawSql: string, options: GuardOptions): GuardedStatement {
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
    throw new SqlGuardError(
      `只允许只读语句（SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / EXISTS），收到的是 ${statement}。` +
        "本插件（dsh-clickhouse）不接受任何写操作。",
    );
  }

  const code = stripTrailingComments(rawSql);
  const codeMasked = maskSql(code);
  const warnings: string[] = [];

  // 3) nested write statements, e.g. `WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x`
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(codeMasked)) {
      throw new SqlGuardError(
        `查询里出现了写操作关键字 ${keyword}，已拒绝执行。` +
          "如果它只是一个同名的列/表名，请用反引号包起来，例如 `SELECT `" +
          keyword.toLowerCase() +
          "` FROM t`。",
      );
    }
  }

  // 4) data exfiltration / SSRF-ish clauses
  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(codeMasked)) {
    throw new SqlGuardError("`INTO OUTFILE` / `INTO DUMPFILE` 会写文件，已拒绝执行。");
  }

  // 5) FORMAT clause would collide with the FORMAT the driver appends
  if (
    /\bFORMAT\s+[A-Za-z_][A-Za-z0-9_]*\s*$/i.test(codeMasked) ||
    /\bFORMAT\s+[A-Za-z_][A-Za-z0-9_]*\s+SETTINGS\b/i.test(codeMasked)
  ) {
    throw new SqlGuardError("请不要在 SQL 里写 `FORMAT ...`：结果格式由插件统一控制。");
  }

  // 6) SETTINGS clause can weaken the server-side caps
  if (!options.allowQuerySettings && /\bSETTINGS\s+[\w.]+\s*=/i.test(codeMasked)) {
    throw new SqlGuardError(
      "请不要在 SQL 里写 `SETTINGS ...`（会绕过行数/超时上限）。" +
        "确需放开时把插件配置 allowQuerySettings 设为 true。",
    );
  }

  // 7) external data sources
  if (!options.allowExternalSources) {
    const externalPattern = new RegExp(`\\b(${EXTERNAL_SOURCE_FUNCTIONS.join("|")})\\s*\\(`, "i");
    const externalMatch = externalPattern.exec(codeMasked);
    if (externalMatch?.[1]) {
      throw new SqlGuardError(
        `表函数 ${externalMatch[1]}() 可以访问 ClickHouse 之外的数据源，默认被禁用。` +
          "确需使用时把插件配置 allowExternalSources 设为 true。",
      );
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
export function isWrappable(statement: GuardedStatement): boolean {
  return statement.statement === "SELECT" || statement.statement === "WITH";
}

/** Append a `LIMIT` when the statement has none. Used by the fallback path. */
export function applyRowLimit(statement: GuardedStatement, limit: number): string {
  const safeLimit = Math.max(1, Math.floor(limit));
  if (statement.hasLimit || !isWrappable(statement)) return statement.sql;
  return `${statement.sql} LIMIT ${safeLimit}`;
}

/** Hard row cap at the SQL level: `SELECT * FROM (<sql>) LIMIT n + 1`. */
export function wrapWithRowLimit(statement: GuardedStatement, limit: number): string {
  const safeLimit = Math.max(1, Math.floor(limit));
  return `SELECT * FROM (\n${statement.sql}\n) LIMIT ${safeLimit}`;
}
