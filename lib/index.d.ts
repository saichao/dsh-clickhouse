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
import type { PluginContextLike } from "./types.js";
/** 插件名（profile 补丁层里的 `name` 字段是本包的包名 dsh-clickhouse）。 */
export declare const name = "clickhouse";
/** 依赖工具注册表服务；缺它就没有意义，因此用静态注入。 */
export declare const inject: string[];
/**
 * 注册 ClickHouse 工具，并把一段使用说明注入系统提示。
 *
 * @param ctx - 带 `tools` 服务的插件上下文。
 * @param rawConfig - loader 传来的原始配置（任意形状，内部会规范化）。
 */
export declare function apply(ctx: PluginContextLike, rawConfig: unknown): void;
export { resolveConfig, describeConnection } from "./config.js";
export type { ClickHousePluginConfig } from "./config.js";
