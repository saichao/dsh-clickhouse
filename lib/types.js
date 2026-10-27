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
export {};
//# sourceMappingURL=types.js.map