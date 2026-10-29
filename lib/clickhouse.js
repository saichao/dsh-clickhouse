/**
 * ClickHouse HTTP 接口客户端（零依赖，只用全局 fetch）。
 *
 * 选型说明：不用 `@clickhouse/client`。插件装进 DSH profile 后应当**零依赖**，
 * 否则每次启动都要解析一遍 node_modules；而 HTTP 接口本身足够简单——
 * POST SQL 到 `http://host:8123/?<settings>`，用 `default_format=JSON` 拿结构化结果。
 *
 * @module dsh-clickhouse/clickhouse
 */
import { ClickHouseErrorCode, describeThrown, UserError } from "./errors.js";
import { applyRowLimit, inspectStatement, isWrappable, wrapWithRowLimit } from "./sql-guard.js";
import { configurationHint, isDefaultConnection } from "./config.js";
/** ClickHouse 服务端返回的错误（带错误码），消息已整理成可直接展示的形式。 */
export class ClickHouseQueryError extends UserError {
    code;
    errorType;
    readonlyHint;
    name = "ClickHouseQueryError";
    constructor(code, errorType, detail, 
    /** 该错误是否由“服务端只读 + 本插件的设置”引起。 */
    readonlyHint = false) {
        super(`ClickHouse 错误 ${code}（${errorType}）\n${detail.trim()}`);
        this.code = code;
        this.errorType = errorType;
        this.readonlyHint = readonlyHint;
    }
}
const CODE_PATTERN = /Code:\s*(\d+)/i;
const TYPE_PATTERN = /\(([A-Z][A-Z0-9_]{3,})\)/;
let queryCounter = 0;
function nextQueryId(label) {
    queryCounter += 1;
    const random = Math.random().toString(36).slice(2, 8);
    return `dsh-clickhouse-${label}-${Date.now().toString(36)}-${queryCounter}-${random}`;
}
/** 把服务端的纯文本错误体解析成带错误码的异常。 */
export function parseServerError(text) {
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return null;
    const codeMatch = CODE_PATTERN.exec(trimmed);
    if (!codeMatch?.[1])
        return null;
    const code = Number(codeMatch[1]);
    const typeMatch = TYPE_PATTERN.exec(trimmed);
    const errorType = typeMatch?.[1] ?? "UNKNOWN";
    const readonly = code === 164 || /readonly mode/i.test(trimmed);
    return new ClickHouseQueryError(code, errorType, trimmed, readonly);
}
/**
 * 连接层失败的友好提示。
 *
 * `text` 已经展开过 `error.cause`（见 `describeThrown`），所以这里能认出 undici 藏在
 * cause 里的 ECONNREFUSED / ENOTFOUND / 超时，而不是一律落到最后那句 "fetch failed"。
 * 用着默认地址时再补一段「去哪儿写配置」——新用户就是卡在这里。
 *
 * 导出仅为便于测试。
 */
export function describeNetworkError(error, config) {
    const text = describeThrown(error);
    const url = config.url;
    let message;
    if (/ECONNREFUSED/i.test(text)) {
        message = `无法连接 ClickHouse（${url}）：连接被拒绝。请确认服务已启动、端口是 HTTP 接口（默认 8123）而不是原生 TCP 端口（9000）。`;
    }
    else if (/ENOTFOUND|EAI_AGAIN/i.test(text)) {
        message = `无法解析 ClickHouse 主机名（${url}）：${text}`;
    }
    else if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|CONNECT_TIMEOUT/i.test(text)) {
        message = `连接 ClickHouse 超时（${url}）：${text}`;
    }
    else if (/aborted|AbortError/i.test(text)) {
        message = `ClickHouse 查询已中断（${url}）：${text}`;
    }
    else {
        message = `访问 ClickHouse 失败（${url}）：${text}`;
    }
    return new UserError(isDefaultConnection(config) ? `${message}\n${configurationHint()}` : message);
}
/** 去掉反引号/引号里的内容后，SQL 里是否还有非 ASCII 字符。 */
function hasUnquotedNonAscii(sql) {
    const stripped = sql.replace(/`(?:[^`]|``)*`|'(?:[^']|'')*'|"(?:[^"]|"")*"/g, " ");
    // eslint-disable-next-line no-control-regex
    return /[^\u0000-\u007F]/.test(stripped);
}
/** 把库级/库名非法等错误统一成可读提示。 */
export function assertDatabaseAllowed(config, database) {
    if (config.denyDatabases.includes(database)) {
        throw new UserError(`库 ${database} 在插件配置 denyDatabases 中，已拒绝访问。`);
    }
    if (config.allowDatabases.length > 0 && !config.allowDatabases.includes(database)) {
        throw new UserError(`库 ${database} 不在插件配置 allowDatabases 白名单内（当前白名单：${config.allowDatabases.join(", ")}）。`);
    }
}
/** 生成 ClickHouse 的反引号标识符，同时挡住注入。 */
export function quoteIdentifier(name) {
    const trimmed = name.trim();
    if (!/^[A-Za-z0-9_$.\-\u4e00-\u9fa5]+$/.test(trimmed)) {
        throw new UserError(`标识符 ${JSON.stringify(name)} 含非法字符，只允许字母、数字、下划线、$、- 和 .`);
    }
    return `\`${trimmed.replace(/`/g, "``")}\``;
}
/** 把 `db.table` / `table` 解析成 `{ database, table }`。 */
export function resolveTableName(table, database, fallbackDatabase) {
    const trimmed = table.trim();
    if (trimmed.length === 0)
        throw new UserError("参数 table 不能为空。");
    const separator = trimmed.indexOf(".");
    if (separator > 0) {
        return { database: trimmed.slice(0, separator).trim(), table: trimmed.slice(separator + 1).trim() };
    }
    return { database: database?.trim() || fallbackDatabase, table: trimmed };
}
/**
 * 单次查询的 HTTP 客户端。
 *
 * 每个查询都会带上服务端护栏：`max_result_rows` + `result_overflow_mode=break`
 * （超限直接截断而不是报错）、`max_execution_time`、`max_memory_usage`，以及配置允许时的
 * `readonly=1`。
 */
export class ClickHouseGateway {
    config;
    constructor(config) {
        this.config = config;
    }
    /** 组装 URL 参数（即 ClickHouse 的查询设置）。 */
    buildParams(options, queryId, includeSettings) {
        const params = new URLSearchParams();
        params.set("database", this.config.database);
        params.set("default_format", "JSON");
        // nan/inf 默认以裸字面量输出，会让 JSON 解析失败；显式加引号。
        params.set("output_format_json_quote_denormals", "1");
        params.set("query_id", queryId);
        if (options.label)
            params.set("log_comment", `dsh-clickhouse:${options.label}`);
        if (includeSettings) {
            if (this.config.readonly)
                params.set("readonly", "1");
            params.set("max_result_rows", String(options.limit + 1));
            params.set("result_overflow_mode", "break");
            params.set("max_execution_time", String(this.config.timeoutSeconds));
            if (this.config.maxMemoryGb > 0) {
                params.set("max_memory_usage", String(Math.round(this.config.maxMemoryGb * 1024 ** 3)));
            }
        }
        return params;
    }
    /** 真正发一次 HTTP 请求，返回原始文本。 */
    async post(sql, params, signal) {
        const controller = new AbortController();
        const timeoutMs = (this.config.timeoutSeconds + 15) * 1000;
        const timer = setTimeout(() => controller.abort(new Error("dsh-clickhouse client timeout")), timeoutMs);
        const forward = () => controller.abort(signal?.reason);
        if (signal) {
            if (signal.aborted)
                controller.abort(signal.reason);
            else
                signal.addEventListener("abort", forward, { once: true });
        }
        const headers = { "content-type": "text/plain; charset=utf-8" };
        if (this.config.user.length > 0)
            headers["X-ClickHouse-User"] = this.config.user;
        if (this.config.password.length > 0)
            headers["X-ClickHouse-Key"] = this.config.password;
        try {
            const response = await fetch(`${this.config.url}/?${params.toString()}`, {
                method: "POST",
                headers,
                body: sql,
                signal: controller.signal,
            });
            const text = await response.text();
            if (!response.ok) {
                const serverError = parseServerError(text);
                if (serverError)
                    throw serverError;
                throw new UserError(`ClickHouse 返回 HTTP ${response.status}：${text.slice(0, 500)}`);
            }
            if (text.trim().length === 0) {
                throw new UserError("ClickHouse 返回了空响应：请确认该地址后面是 HTTP 接口（默认 8123）。");
            }
            return text;
        }
        catch (error) {
            if (error instanceof UserError)
                throw error;
            if (signal?.aborted)
                throw new UserError("查询已被调用方取消。");
            if (controller.signal.aborted) {
                throw new UserError(`查询超过客户端上限 ${this.config.timeoutSeconds + 15}s 仍未返回，已中止。请缩小数据范围或改用聚合。`);
            }
            throw describeNetworkError(error, this.config);
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", forward);
        }
    }
    /** 把 JSON 信封转成 QueryOutcome。 */
    materialize(text, options, queryId, executedSql, sqlWasRewritten, notes) {
        let envelope;
        try {
            envelope = JSON.parse(text);
        }
        catch {
            const serverError = parseServerError(text);
            if (serverError)
                throw serverError;
            throw new UserError(`无法解析 ClickHouse 的 JSON 响应：${text.slice(0, 300)}`);
        }
        const columns = (envelope.meta ?? []).map((column) => String(column.name ?? ""));
        const columnTypes = (envelope.meta ?? []).map((column) => String(column.type ?? ""));
        const rawRows = Array.isArray(envelope.data) ? envelope.data : [];
        const truncated = rawRows.length > options.limit;
        const rows = truncated ? rawRows.slice(0, options.limit) : rawRows;
        const statistics = envelope.statistics;
        const outcome = {
            columns,
            columnTypes,
            rows,
            truncated,
            limit: options.limit,
            elapsedMs: 0,
            queryId,
            executedSql,
            sqlWasRewritten,
            notes: [...notes],
        };
        if (statistics) {
            const parsed = {};
            if (typeof statistics.elapsed === "number")
                parsed.elapsed = statistics.elapsed;
            if (typeof statistics.rows_read === "number")
                parsed.rows_read = statistics.rows_read;
            if (typeof statistics.bytes_read === "number")
                parsed.bytes_read = statistics.bytes_read;
            if (Object.keys(parsed).length > 0)
                outcome.statistics = parsed;
            outcome.elapsedMs = Math.round((parsed.elapsed ?? 0) * 1000);
        }
        if (typeof envelope.rows_before_limit_at_least === "number") {
            outcome.rowsBeforeLimitAtLeast = envelope.rows_before_limit_at_least;
        }
        return outcome;
    }
    /**
     * 执行一条内部构造的 SQL（不含护栏；调用方负责只读）。
     *
     * 若服务端因只读模式拒绝了本插件附加的设置，会去掉这些设置重试一次——护栏仍在
     * 客户端生效。
     */
    async run(sql, options) {
        const label = options.label ?? "internal";
        const queryId = nextQueryId(label);
        const notes = [];
        try {
            const text = await this.post(sql, this.buildParams(options, queryId, true), options.signal);
            return this.materialize(text, options, queryId, sql, false, notes);
        }
        catch (error) {
            const retryable = error instanceof ClickHouseQueryError &&
                error.readonlyHint &&
                /setting in readonly mode/i.test(error.message);
            if (!retryable)
                throw error;
            notes.push("服务端只读模式拒绝附加设置，已去掉本插件的设置重试一次（客户端护栏仍然生效）。");
            const text = await this.post(sql, this.buildParams(options, queryId, false), options.signal);
            return this.materialize(text, options, queryId, sql, false, notes);
        }
    }
    /** 执行模型给的 SQL：先过只读护栏，再加行数上限。 */
    async executeUserQuery(sql, options) {
        const guarded = inspectStatement(sql, {
            allowExternalSources: this.config.allowExternalSources,
            allowQuerySettings: this.config.allowQuerySettings,
            allowCrossTable: this.config.allowCrossTable,
            defaultDatabase: this.config.database,
        });
        const limit = Math.max(1, Math.min(options.maxRows ?? this.config.maxRows, this.config.maxRows));
        let executedSql = guarded.sql;
        let sqlWasRewritten = false;
        if (isWrappable(guarded)) {
            // 取 limit + 1 行：多出来的那一行只用来判断“是否还有更多数据”，
            // materialize() 会把它切掉并置 truncated。
            executedSql = wrapWithRowLimit(guarded, limit + 1);
            sqlWasRewritten = true;
        }
        else {
            executedSql = applyRowLimit(guarded, limit);
            sqlWasRewritten = executedSql !== guarded.sql;
        }
        let outcome;
        try {
            outcome = await this.run(executedSql, { limit, signal: options.signal, label: "query" });
        }
        catch (error) {
            // 老版本 ClickHouse 不接受未加引号的非 ASCII 标识符（中文别名是最常见的写法），
            // 报的是 SYNTAX_ERROR，提示里直接把改法说出来，省得模型反复试。
            if (error instanceof ClickHouseQueryError &&
                error.code === ClickHouseErrorCode.SYNTAX_ERROR &&
                hasUnquotedNonAscii(guarded.sql)) {
                throw new UserError(`${error.message}\n提示：ClickHouse 不接受未加引号的非 ASCII（中文）标识符或别名——请用反引号包起来，` +
                    "例如 SELECT count() AS [反引号]行数[反引号] FROM t。");
            }
            throw error;
        }
        for (const warning of guarded.warnings)
            outcome.notes.push(warning);
        outcome.executedSql = executedSql;
        outcome.sqlWasRewritten = sqlWasRewritten;
        return outcome;
    }
    /** 执行插件自己拼的元数据查询（如 system.tables）。 */
    async executeMetadataQuery(sql, options = {}) {
        const limit = Math.max(1, Math.min(options.limit ?? this.config.maxRows, this.config.maxRows));
        return this.run(sql, { limit, signal: options.signal, label: options.label ?? "metadata" });
    }
    /** 连通性 + 版本信息。 */
    async serverInfo(signal) {
        const outcome = await this.executeMetadataQuery("SELECT version() AS version, timezone() AS timezone, uptime() AS uptime_seconds", { signal, limit: 1, label: "server-info" });
        const row = outcome.rows[0] ?? {};
        return {
            version: String(row.version ?? "unknown"),
            timezone: String(row.timezone ?? "unknown"),
            uptimeSeconds: Number(row.uptime_seconds ?? 0),
        };
    }
}
//# sourceMappingURL=clickhouse.js.map