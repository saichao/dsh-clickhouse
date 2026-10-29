/**
 * dsh-clickhouse —— ClickHouse 数据问答插件（DeepSeek Harness / DSH）。
 *
 * 契约与 `dshmarket` 这类 profile 插件一致：只导出 `name` / `inject` / `apply`，
 * **不导入任何 `@deepseek-ai/*` 运行时模块**，因此装进 profile 后无需任何依赖即可加载。
 * 配置由 `apply()` 自行规范化；`apply()` 不会抛错，避免影响宿主启动。
 *
 * 用法（profile 的 `cordis.patch.yml`）：
 * ```yaml
 * - id: clickhouse
 *   name: dsh-clickhouse
 *   config:
 *     url: http://localhost:8123
 *     user: default
 *     password: ''
 *     database: default
 * ```
 *
 * @module dsh-clickhouse
 */
import { ClickHouseGateway } from "./clickhouse.js";
import { describeConnection, isDefaultConnection, resolveConfig, } from "./config.js";
import { createClickHouseTools } from "./tools.js";
/** 插件名（profile 补丁层里的 `name` 字段是本包的包名 dsh-clickhouse）。 */
export const name = "clickhouse";
/** 依赖工具注册表服务；缺它就没有意义，因此用静态注入。 */
export const inject = ["tools"];
/** 注入系统提示的说明文字（随部署配置变化，因此在注入回调里生成）。 */
function guidance(config) {
    return [
        "## ClickHouse 数据问答（插件 dsh-clickhouse）",
        `连接：${describeConnection(config)}。`,
        // 默认连接 = 部署方还没配。提前告诉模型，别等第一次查询失败才发现。
        ...(isDefaultConnection(config)
            ? [
                "⚠️ 上面这个是默认连接，说明插件还没配置。查询报连接失败时不要反复重试：直接告诉用户去 profile 的用户补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）加一段 `- id: clickhouse` / `name: dsh-clickhouse` / `config: { url: http://<主机>:8123, user: default, password: '' }`，改完重启 DSH。",
            ]
            : []),
        "",
        "怎么查：",
        "- 用户给什么参数就查什么：公司名就按名称字段查，专利名/商标名就按各自的名称字段查。不要替用户把参数改写成别的标识（例如先查信用代码、再拿它去查另一张表）。",
        "- 一次只查一张表：专利只碰专利表，商标只碰商标表。JOIN、UNION、跨表子查询都被客户端护栏拒绝（确需放开时改插件配置 allowCrossTable）。",
        "- 「单表」按引用的表算，不按条件个数算：`WHERE 字段A LIKE '%参数%' AND 字段B LIKE '%参数%'`、多字段 OR、同一张表的子查询都允许，鼓励用它们提高召回。",
        "- 先 describe 认字段名与类型，再用 LIKE / IN / = 直接查；不知道看哪张表时，用 clickhouse_search_columns 按字段名搜（例如「订单号」「手机号」），clickhouse_list_tables 的 like 按表名搜。",
        "- 确认表结构后直接 clickhouse_query 聚合；慢查询用 clickhouse_explain 看计划。",
        "",
        "硬性规则：",
        "- 只允许单条只读语句（SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / EXISTS）；写入语句、`FORMAT`、`SETTINGS` 会被客户端护栏拒绝。",
        "- 只允许单表查询（见上）；把参数原样用进 WHERE，不要自建多步业务流程。",
        `- 单次最多返回 ${config.maxRows} 行，超出会截断；大表先 count() 或加时间范围/聚合，不要直接拉明细。`,
        "- ClickHouse 是老版本（如 21.12）时，不要用 mcp-clickhouse 的 list_tables，它会因 system.tables 缺列（active_parts 等）报错；本插件的 list_tables 直接用 system.tables。",
        "- 字段名和类型必须先 describe，不要凭猜测写 SQL。",
        "- 中文（非 ASCII）的别名或标识符必须用反引号包起来：写成 SELECT count() AS [反引号]行数[反引号] FROM t；不加反引号，老版本会直接报 SYNTAX_ERROR。",
    ].join("\n");
}
/**
 * 注册 ClickHouse 工具，并把一段使用说明注入系统提示。
 *
 * @param ctx - 带 `tools` 服务的插件上下文。
 * @param rawConfig - loader 传来的原始配置（任意形状，内部会规范化）。
 */
export function apply(ctx, rawConfig) {
    const config = resolveConfig(rawConfig);
    for (const warning of config.warnings)
        ctx.logger?.warn?.(`[dsh-clickhouse] ${warning}`);
    const gateway = new ClickHouseGateway(config);
    const tools = createClickHouseTools(gateway, config);
    for (const tool of tools)
        ctx.tools.register(tool);
    ctx.logger?.info?.(`[dsh-clickhouse] 已注册 ${tools.length} 个只读工具：${tools.map((tool) => tool.name).join(", ")} → ${describeConnection(config)}`);
    if (config.guidance) {
        ctx.inject?.(["systemPrompt"], (promptContext) => {
            promptContext.systemPrompt?.section({ name: "plugin:clickhouse", order: 200, text: guidance(config) });
        });
    }
}
export { resolveConfig, describeConnection } from "./config.js";
//# sourceMappingURL=index.js.map