/**
 * 模型可见的 7 个 ClickHouse 工具。
 *
 * 这里用**原始注册**（不是 dsh-tools 的 `defineTool`）：插件因此零运行时依赖。
 * 代价是参数校验由本文件负责（`defineTool` 才会自动校验）；收益是插件在 profile 里
 * 不需要任何 node_modules 就能加载，启动路径上没有依赖解析风险。
 *
 * 返回值一律符合规范的 `output.schema`，面向模型的内容由 `output.render` 纯函数产出。
 *
 * @module dsh-clickhouse/tools
 */
import { ClickHouseGateway } from "./clickhouse.js";
import type { ClickHousePluginConfig } from "./config.js";
import type { ToolDefinitionLike } from "./types.js";
/**
 * 构造全部工具定义。
 *
 * @param gateway - 已配置好的 ClickHouse 客户端。
 * @param config - 规范化后的插件配置。
 * @returns 可直接交给 `ctx.tools.register()` 的工具定义数组。
 */
export declare function createClickHouseTools(gateway: ClickHouseGateway, config: ClickHousePluginConfig): ToolDefinitionLike[];
