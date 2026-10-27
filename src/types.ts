/**
 * DSH 插件契约的本地最小类型声明。
 *
 * 这里刻意不从 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm` 导入类型：那些包的
 * peer 依赖图里含有未发布到 npm 的内部包（例如 `@deepseek-ai/dsh-type-meta`），装不上；
 * 而插件在 profile 里加载时也不需要它们——工具定义是纯数据结构，注册表会自行校验并
 * 强制执行输出声明。`dshmarket` 这个真实装在 profile 里的插件同样没有任何
 * `@deepseek-ai/*` 运行时导入，只导出 `name` 和 `apply`。
 *
 * @module dsh-clickhouse/types
 */

/** 面向模型的内容块；本插件只产出文本。 */
export interface ContentBlock {
  type: "text";
  text: string;
}

/**
 * 原始 JSON Schema 节点。
 *
 * 注册表支持的子集：任意 JSON 根、仅含 annotation 的无约束节点、恰好匹配一个分支的
 * `oneOf`，以及常规的 `type` / `properties` / `required` / `items` / `enum` /
 * `additionalProperties`。原始 JSON Schema 默认保持开放，只有显式写出
 * `additionalProperties: false` 才收紧。
 */
export type JsonSchemaNode = Record<string, unknown>;

/**
 * 模型可见的工具 schema。
 *
 * `parameters` 用原始 JSON Schema：隐式参数根是开放的（模型多传的键会被忽略），
 * 因此参数校验由工具自身负责。
 */
export interface ToolSchemaLike {
  name: string;
  description: string;
  parameters: JsonSchemaNode;
}

/** 单次调用的执行上下文；本插件只依赖协作式取消信号与调用标识。 */
export interface ToolRunContextLike {
  /** 调用方拥有的取消信号：必须转发给 fetch，才能被用户的 Ctrl-C 中断。 */
  readonly signal?: AbortSignal;
  readonly callId?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

/** 规范输出声明：注册表在呈现前会按 `schema` 校验并冻结返回值。 */
export interface ToolOutputDefinitionLike {
  readonly schema: JsonSchemaNode;
  render(args: unknown, value: unknown): ContentBlock[];
}

/** 注册表接受的工具定义（对应 dsh-tools 的 `ToolDefinition`）。 */
export interface ToolDefinitionLike extends ToolSchemaLike {
  readonly output: ToolOutputDefinitionLike;
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>;
  /** 协作式超时预算（毫秒）；本插件把信号转发给 fetch，因此可以安全声明。 */
  timeoutMs?: number;
  /** 只读查询之间互不影响，可以并发分发。 */
  isConcurrencySafe?(args: unknown): boolean;
}

/** 系统提示服务的可选面。 */
export interface SystemPromptServiceLike {
  section(section: { name: string; order?: number; text: string }): unknown;
}

/** 可选注入的回调上下文。 */
export interface OptionalServiceContextLike {
  systemPrompt?: SystemPromptServiceLike;
}

/** 本插件用到的最小 cordis 上下文面。 */
export interface PluginContextLike {
  tools: { register(definition: ToolDefinitionLike): unknown };
  inject?(names: string[], callback: (ctx: OptionalServiceContextLike) => void): unknown;
  logger?: {
    debug?(message: string): void;
    info?(message: string): void;
    warn?(message: string): void;
  };
}
