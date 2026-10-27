/**
 * 插件配置：规范化 + 校验。
 *
 * 插件不导出 schemastery 的 `Config`（那会引入运行时依赖），而是在 `apply()` 里自行
 * 规范化。`resolveConfig` 是**全函数**：它绝不抛错——因为 `apply()` 在 DSH 启动时运行，
 * 抛错可能连带影响宿主启动。非法值会退回默认值，并把原因记进 `warnings`，由 `apply()`
 * 写进宿主日志。
 */
/** 生效的插件配置。 */
export interface ClickHousePluginConfig {
    /** ClickHouse HTTP 接口地址，例如 http://localhost:8123 。 */
    url: string;
    user: string;
    password: string;
    /** 未显式指定 database 的参数默认使用的库。 */
    database: string;
    /** 为 true 时给每个查询加上服务端 `readonly=1`。 */
    readonly: boolean;
    /** 单次返回给模型的最大行数。 */
    maxRows: number;
    /** 单次查询的服务端超时（秒）。 */
    timeoutSeconds: number;
    /** 单次查询的服务端内存上限（GB）。 */
    maxMemoryGb: number;
    /** 单个单元格保留的最大字符数。 */
    maxCellChars: number;
    /** 是否允许 SQL 自带 `SETTINGS ...`。 */
    allowQuerySettings: boolean;
    /** 是否允许 file()/url()/s3() 等外部数据源表函数。 */
    allowExternalSources: boolean;
    /** 只允许访问这些库（为空表示不限制）。 */
    allowDatabases: string[];
    /** 禁止访问这些库。 */
    denyDatabases: string[];
    /** `clickhouse_sample_rows` 未指定行数时取多少行。 */
    sampleRows: number;
    /** 是否往系统提示里插入一段本插件的使用说明。 */
    guidance: boolean;
    /** 配置规范化期间发现的问题（非致命）。 */
    warnings: string[];
}
/** 默认配置：默认连本机、默认只读、默认 200 行。 */
export declare const DEFAULT_CONFIG: Omit<ClickHousePluginConfig, "warnings">;
/** 单次查询的取消/超时上限，避免模型写出一条跑不完的查询把界面卡死。 */
export declare const HARD_MAX_TIMEOUT_SECONDS = 600;
export declare const HARD_MAX_ROWS = 10000;
/**
 * 规范化连接地址。
 *
 * 同时接受三种写法，方便直接把 JDBC 串粘过来：
 *   - `http://host:8123`
 *   - `https://host:8443`
 *   - `jdbc:clickhouse://host:8123/default?socket_timeout=3000000`（取 scheme/主机/端口，
 *     路径段作为默认库，查询串忽略）
 *
 * `clickhouse://`（无 jdbc: 前缀）按 JDBC 惯例视为 HTTP 协议。
 */
export declare function normalizeUrl(input: string, fallbackDatabase: string, warnings: string[]): {
    url: string;
    database: string;
};
/** 把 loader 传来的任意配置规范化成完整配置。永不抛错。 */
export declare function resolveConfig(raw: unknown): ClickHousePluginConfig;
/** 一句话描述当前连接（用于工具输出与系统提示）。 */
export declare function describeConnection(config: ClickHousePluginConfig): string;
/** 连接信息里不能泄露密码，日志展示用。 */
export declare function describeConnectionForLog(config: ClickHousePluginConfig): string;
/**
 * 是否还在用「什么都没填」的默认连接。
 *
 * 默认连接意味着部署方大概率还没配置：这时连不上必须顺带告诉用户去哪儿写配置，
 * 否则新用户只会看到一句连接失败。
 */
export declare function isDefaultConnection(config: ClickHousePluginConfig): boolean;
/** 「还没配置连接」的指引：错误信息与系统提示共用同一段文字，避免两处走样。 */
export declare function configurationHint(): string;
