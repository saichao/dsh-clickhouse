/**
 * ClickHouse HTTP 接口客户端（零依赖，只用全局 fetch）。
 *
 * 选型说明：不用 `@clickhouse/client`。插件装进 DSH profile 后应当**零依赖**，
 * 否则每次启动都要解析一遍 node_modules；而 HTTP 接口本身足够简单——
 * POST SQL 到 `http://host:8123/?<settings>`，用 `default_format=JSON` 拿结构化结果。
 *
 * @module dsh-clickhouse/clickhouse
 */
import { UserError } from "./errors.js";
import { type ClickHousePluginConfig } from "./config.js";
/** 服务端返回的查询统计。 */
export interface QueryStatistics {
    rows_read?: number;
    bytes_read?: number;
    elapsed?: number;
}
/** 一次查询的完整结果（字段与 `format.ts` 的渲染器对齐）。 */
export interface QueryOutcome {
    columns: string[];
    columnTypes: string[];
    rows: Record<string, unknown>[];
    truncated: boolean;
    limit: number;
    elapsedMs: number;
    queryId: string;
    statistics?: QueryStatistics;
    rowsBeforeLimitAtLeast?: number;
    executedSql: string;
    sqlWasRewritten: boolean;
    notes: string[];
}
export interface ExecuteOptions {
    /** 单次返回的最大行数（服务端按 limit+1 取，多出的那一行仅用来判断是否被截断）。 */
    limit: number;
    signal?: AbortSignal | undefined;
    /** 调用用途，仅用于 query_id / log_comment，便于在 system.query_log 里追溯。 */
    label?: string;
}
/** ClickHouse 服务端返回的错误（带错误码），消息已整理成可直接展示的形式。 */
export declare class ClickHouseQueryError extends UserError {
    readonly code: number;
    readonly errorType: string;
    /** 该错误是否由“服务端只读 + 本插件的设置”引起。 */
    readonly readonlyHint: boolean;
    readonly name: string;
    constructor(code: number, errorType: string, detail: string, 
    /** 该错误是否由“服务端只读 + 本插件的设置”引起。 */
    readonlyHint?: boolean);
}
/** 把服务端的纯文本错误体解析成带错误码的异常。 */
export declare function parseServerError(text: string): ClickHouseQueryError | null;
/**
 * 连接层失败的友好提示。
 *
 * `text` 已经展开过 `error.cause`（见 `describeThrown`），所以这里能认出 undici 藏在
 * cause 里的 ECONNREFUSED / ENOTFOUND / 超时，而不是一律落到最后那句 "fetch failed"。
 * 用着默认地址时再补一段「去哪儿写配置」——新用户就是卡在这里。
 *
 * 导出仅为便于测试。
 */
export declare function describeNetworkError(error: unknown, config: ClickHousePluginConfig): UserError;
/** 把库级/库名非法等错误统一成可读提示。 */
export declare function assertDatabaseAllowed(config: ClickHousePluginConfig, database: string): void;
/** 生成 ClickHouse 的反引号标识符，同时挡住注入。 */
export declare function quoteIdentifier(name: string): string;
/** 把 `db.table` / `table` 解析成 `{ database, table }`。 */
export declare function resolveTableName(table: string, database: string | undefined, fallbackDatabase: string): {
    database: string;
    table: string;
};
/**
 * 单次查询的 HTTP 客户端。
 *
 * 每个查询都会带上服务端护栏：`max_result_rows` + `result_overflow_mode=break`
 * （超限直接截断而不是报错）、`max_execution_time`、`max_memory_usage`，以及配置允许时的
 * `readonly=1`。
 */
export declare class ClickHouseGateway {
    private readonly config;
    constructor(config: ClickHousePluginConfig);
    /** 组装 URL 参数（即 ClickHouse 的查询设置）。 */
    private buildParams;
    /** 真正发一次 HTTP 请求，返回原始文本。 */
    private post;
    /** 把 JSON 信封转成 QueryOutcome。 */
    private materialize;
    /**
     * 执行一条内部构造的 SQL（不含护栏；调用方负责只读）。
     *
     * 若服务端因只读模式拒绝了本插件附加的设置，会去掉这些设置重试一次——护栏仍在
     * 客户端生效。
     */
    private run;
    /** 执行模型给的 SQL：先过只读护栏，再加行数上限。 */
    executeUserQuery(sql: string, options: {
        signal?: AbortSignal | undefined;
        maxRows?: number | undefined;
    }): Promise<QueryOutcome>;
    /** 执行插件自己拼的元数据查询（如 system.tables）。 */
    executeMetadataQuery(sql: string, options?: {
        signal?: AbortSignal | undefined;
        limit?: number | undefined;
        label?: string | undefined;
    }): Promise<QueryOutcome>;
    /** 连通性 + 版本信息。 */
    serverInfo(signal?: AbortSignal): Promise<{
        version: string;
        timezone: string;
        uptimeSeconds: number;
    }>;
}
