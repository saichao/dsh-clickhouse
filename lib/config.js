/**
 * 插件配置：规范化 + 校验。
 *
 * 插件不导出 schemastery 的 `Config`（那会引入运行时依赖），而是在 `apply()` 里自行
 * 规范化。`resolveConfig` 是**全函数**：它绝不抛错——因为 `apply()` 在 DSH 启动时运行，
 * 抛错可能连带影响宿主启动。非法值会退回默认值，并把原因记进 `warnings`，由 `apply()`
 * 写进宿主日志。
 */
/** 默认配置：默认连本机、默认只读、默认 200 行。 */
export const DEFAULT_CONFIG = {
    url: "http://localhost:8123",
    user: "default",
    password: "",
    database: "default",
    readonly: true,
    maxRows: 200,
    timeoutSeconds: 60,
    maxMemoryGb: 4,
    maxCellChars: 400,
    allowQuerySettings: false,
    allowExternalSources: false,
    allowDatabases: [],
    denyDatabases: [],
    sampleRows: 20,
    guidance: true,
};
/** 单次查询的取消/超时上限，避免模型写出一条跑不完的查询把界面卡死。 */
export const HARD_MAX_TIMEOUT_SECONDS = 600;
export const HARD_MAX_ROWS = 10_000;
function readString(raw, key, fallback, warnings) {
    const value = raw[key];
    if (value === undefined || value === null)
        return fallback;
    if (typeof value !== "string") {
        warnings.push(`配置项 ${key} 应为字符串，已忽略（收到 ${typeof value}）`);
        return fallback;
    }
    return value.trim();
}
function readBoolean(raw, key, fallback, warnings) {
    const value = raw[key];
    if (value === undefined || value === null)
        return fallback;
    if (typeof value === "boolean")
        return value;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    warnings.push(`配置项 ${key} 应为布尔值，已忽略（收到 ${JSON.stringify(value)}）`);
    return fallback;
}
function readNumber(raw, key, fallback, bounds, warnings) {
    const value = raw[key];
    if (value === undefined || value === null || value === "")
        return fallback;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        warnings.push(`配置项 ${key} 应为数字，已忽略（收到 ${JSON.stringify(value)}）`);
        return fallback;
    }
    if (parsed < bounds.min || parsed > bounds.max) {
        warnings.push(`配置项 ${key} 超出范围 [${bounds.min}, ${bounds.max}]，已改为 ${fallback}`);
        return fallback;
    }
    return parsed;
}
function readStringArray(raw, key, warnings) {
    const value = raw[key];
    if (value === undefined || value === null)
        return [];
    if (typeof value === "string") {
        return value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }
    if (!Array.isArray(value)) {
        warnings.push(`配置项 ${key} 应为字符串数组，已忽略（收到 ${typeof value}）`);
        return [];
    }
    const items = [];
    for (const item of value) {
        if (typeof item === "string" && item.trim().length > 0)
            items.push(item.trim());
        else
            warnings.push(`配置项 ${key} 里含有非字符串项，已忽略`);
    }
    return items;
}
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
export function normalizeUrl(input, fallbackDatabase, warnings) {
    let text = input.trim();
    if (text.length === 0)
        return { url: DEFAULT_CONFIG.url, database: fallbackDatabase };
    text = text.replace(/^jdbc:/i, "");
    if (/^clickhouse:\/\//i.test(text))
        text = text.replace(/^clickhouse:\/\//i, "http://");
    if (!/^https?:\/\//i.test(text)) {
        warnings.push(`连接地址缺少 http:// 或 https:// 前缀，已按 http:// 处理：${input}`);
        text = `http://${text}`;
    }
    let parsed;
    try {
        parsed = new URL(text);
    }
    catch {
        warnings.push(`连接地址无法解析，已退回 ${DEFAULT_CONFIG.url}：${input}`);
        return { url: DEFAULT_CONFIG.url, database: fallbackDatabase };
    }
    const port = parsed.port.length > 0 ? `:${parsed.port}` : "";
    const url = `${parsed.protocol}//${parsed.hostname}${port}`;
    const pathDatabase = parsed.pathname.replace(/^\/+|\/+$/g, "");
    return { url, database: pathDatabase.length > 0 ? pathDatabase : fallbackDatabase };
}
/** 把 loader 传来的任意配置规范化成完整配置。永不抛错。 */
export function resolveConfig(raw) {
    const warnings = [];
    if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
        warnings.push(`插件配置应为对象，已全部使用默认值（收到 ${Array.isArray(raw) ? "数组" : typeof raw}）`);
    }
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    // 兼容 mcp-clickhouse 的 CLICKHOUSE_* 环境变量命名习惯，方便从 MCP 配置直接迁移。
    const aliased = { ...source };
    const alias = {
        CLICKHOUSE_HOST: "host",
        CLICKHOUSE_PORT: "port",
        CLICKHOUSE_USER: "user",
        CLICKHOUSE_PASSWORD: "password",
        CLICKHOUSE_DATABASE: "database",
    };
    for (const [from, to] of Object.entries(alias)) {
        if (aliased[to] === undefined && typeof source[from] === "string")
            aliased[to] = source[from];
    }
    let urlInput = readString(aliased, "url", "", warnings);
    if (urlInput.length === 0) {
        const host = readString(aliased, "host", "", warnings);
        if (host.length > 0) {
            const port = readString(aliased, "port", "8123", warnings);
            urlInput = /^https?:\/\//i.test(host) ? host : `http://${host}:${port}`;
        }
    }
    const user = readString(aliased, "user", DEFAULT_CONFIG.user, warnings);
    const password = readString(aliased, "password", DEFAULT_CONFIG.password, warnings);
    const rawDatabase = readString(aliased, "database", "", warnings);
    const { url, database } = normalizeUrl(urlInput, rawDatabase.length > 0 ? rawDatabase : DEFAULT_CONFIG.database, warnings);
    const config = {
        url,
        user,
        password,
        database,
        readonly: readBoolean(aliased, "readonly", DEFAULT_CONFIG.readonly, warnings),
        maxRows: Math.floor(readNumber(aliased, "maxRows", DEFAULT_CONFIG.maxRows, { min: 1, max: HARD_MAX_ROWS }, warnings)),
        timeoutSeconds: Math.floor(readNumber(aliased, "timeoutSeconds", DEFAULT_CONFIG.timeoutSeconds, { min: 1, max: HARD_MAX_TIMEOUT_SECONDS }, warnings)),
        maxMemoryGb: readNumber(aliased, "maxMemoryGb", DEFAULT_CONFIG.maxMemoryGb, { min: 0.1, max: 512 }, warnings),
        maxCellChars: Math.floor(readNumber(aliased, "maxCellChars", DEFAULT_CONFIG.maxCellChars, { min: 8, max: 100_000 }, warnings)),
        allowQuerySettings: readBoolean(aliased, "allowQuerySettings", DEFAULT_CONFIG.allowQuerySettings, warnings),
        allowExternalSources: readBoolean(aliased, "allowExternalSources", DEFAULT_CONFIG.allowExternalSources, warnings),
        allowDatabases: readStringArray(aliased, "allowDatabases", warnings),
        denyDatabases: readStringArray(aliased, "denyDatabases", warnings),
        sampleRows: Math.floor(readNumber(aliased, "sampleRows", DEFAULT_CONFIG.sampleRows, { min: 1, max: HARD_MAX_ROWS }, warnings)),
        guidance: readBoolean(aliased, "guidance", DEFAULT_CONFIG.guidance, warnings),
        warnings,
    };
    for (const name of config.allowDatabases) {
        if (config.denyDatabases.includes(name))
            warnings.push(`库 ${name} 同时在 allowDatabases 和 denyDatabases 里，以 denyDatabases 为准`);
    }
    return config;
}
/** 一句话描述当前连接（用于工具输出与系统提示）。 */
export function describeConnection(config) {
    return `${config.url}（用户 ${config.user}，默认库 ${config.database}，${config.readonly ? "服务端只读" : "未启用服务端只读"}，单次最多 ${config.maxRows} 行）`;
}
/** 连接信息里不能泄露密码，日志展示用。 */
export function describeConnectionForLog(config) {
    // 密码为空时 String.replace 会在开头插进一个 ***，所以只在真有密码时替换。
    if (config.password.length === 0)
        return describeConnection(config);
    return describeConnection(config).split(config.password).join("***");
}
/**
 * 是否还在用「什么都没填」的默认连接。
 *
 * 默认连接意味着部署方大概率还没配置：这时连不上必须顺带告诉用户去哪儿写配置，
 * 否则新用户只会看到一句连接失败。
 */
export function isDefaultConnection(config) {
    return (config.url === DEFAULT_CONFIG.url &&
        config.user === DEFAULT_CONFIG.user &&
        config.password === DEFAULT_CONFIG.password);
}
/** 「还没配置连接」的指引：错误信息与系统提示共用同一段文字，避免两处走样。 */
export function configurationHint() {
    return [
        "还没配置 ClickHouse 连接。请在 profile 的用户补丁层写连接信息：",
        "  ~/.dsh/profiles/<profile>/cordis.patch.yml",
        "  - id: clickhouse",
        "    name: dsh-clickhouse",
        "    config: { url: http://<主机>:8123, user: default, password: '' }",
        "也可以给插件配置 host / port（或 CLICKHOUSE_HOST / CLICKHOUSE_PORT）；",
        "详见插件 README 的「配置」一节。改完需要重启 DSH。",
    ].join("\n");
}
//# sourceMappingURL=config.js.map