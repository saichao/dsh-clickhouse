/**
 * 插件层测试：**不启动 DSH**，用一个假的 ctx 直接跑 `apply()`。
 *
 * 这层测试专门覆盖真正的风险点：
 *  1. 工具定义是否符合注册表契约（name/description/parameters/output/execute 齐备）；
 *  2. 输出 schema 是否真的能约束住工具返回值（用一个最小 JSON Schema 校验器核对）；
 *  3. 参数校验、SQL 护栏、库白/黑名单是否按预期拦截；
 *  4. 面向模型的渲染文本是否可读。
 *
 * 真实连库的检查在 plugin-live.test.ts 里，两者共用同一套工具定义。
 *
 * @module dsh-clickhouse/test/plugin
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { apply, inject, name as pluginName } from "../src/index.js";
import { createClickHouseTools } from "../src/tools.js";
import { ClickHouseGateway } from "../src/clickhouse.js";
import { resolveConfig } from "../src/config.js";
import { validate } from "./schema-check.js";
import type { ToolDefinitionLike } from "../src/types.js";

interface RegisteredTool extends ToolDefinitionLike {
  name: string;
}

function makeContext(): {
  ctx: Parameters<typeof apply>[0];
  registered: RegisteredTool[];
  sections: { name: string; text: string }[];
  warnings: string[];
} {
  const registered: RegisteredTool[] = [];
  const sections: { name: string; text: string }[] = [];
  const warnings: string[] = [];
  const ctx = {
    tools: {
      register(definition: ToolDefinitionLike) {
        registered.push(definition as RegisteredTool);
      },
    },
    inject(names: string[], callback: (inner: unknown) => void) {
      assert.deepEqual(names, ["systemPrompt"]);
      callback({ systemPrompt: { section: (section: { name: string; text: string }) => sections.push(section) } });
    },
    logger: {
      warn: (message: string) => warnings.push(message),
      info: () => undefined,
    },
  };
  return { ctx: ctx as unknown as Parameters<typeof apply>[0], registered, sections, warnings };
}

const liveConfig = resolveConfig({
  url: "http://127.0.0.1:8123",
  readonly: true,
  maxRows: 50,
});

/** 一个不真的联网的执行上下文。 */
const fakeExec = { signal: undefined, callId: "test", name: "test", arguments: {} };

test("插件导出 DSH 契约要求的字段", () => {
  assert.equal(pluginName, "clickhouse");
  assert.deepEqual(inject, ["tools"]);
  assert.equal(typeof apply, "function");
});

test("apply() 注册 7 个工具，并把说明注入系统提示", () => {
  const { ctx, registered, sections } = makeContext();
  apply(ctx, { url: "http://localhost:8123", database: "default" });

  const names = registered.map((tool) => tool.name);
  assert.deepEqual(names, [
    "clickhouse_query",
    "clickhouse_list_databases",
    "clickhouse_list_tables",
    "clickhouse_describe_table",
    "clickhouse_sample_rows",
    "clickhouse_explain",
    "clickhouse_search_columns",
  ]);

  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.name, "plugin:clickhouse");
  // 注入的提示里应带上本次配置的地址（这里就是上面传进去的那个），而不是写死某个部署地址。
  assert.match(sections[0]?.text ?? "", /连接：http:\/\/localhost:8123/);
  assert.match(sections[0]?.text ?? "", /单条只读语句/);
});

test("每个工具都符合注册表契约：schema 齐备、输出声明存在、只读工具可并发", () => {
  const { ctx, registered } = makeContext();
  apply(ctx, {});

  for (const tool of registered) {
    assert.ok(tool.name.length > 0, "工具名不能为空");
    assert.ok(tool.description.length > 40, `${tool.name} 的描述太短，模型难以正确选择`);
    assert.equal(tool.parameters.type, "object", `${tool.name}.parameters 必须是对象根`);
    assert.ok(tool.parameters.properties, `${tool.name}.parameters 需要 properties`);
    assert.equal(tool.output.schema.type, "object", `${tool.name}.output.schema 必须是对象根`);
    assert.equal(tool.output.schema.additionalProperties, false, `${tool.name}.output.schema 必须封闭`);
    assert.equal(typeof tool.output.render, "function");
    assert.equal(typeof tool.execute, "function");
    assert.ok((tool.timeoutMs ?? 0) > 0, `${tool.name} 应声明协作式超时预算`);
    assert.equal(tool.isConcurrencySafe?.({}), true, `${tool.name} 是只读查询，应允许并发`);
  }
});

test("每个工具的 parameters 里声明的必填项都在 properties 中", () => {
  const { ctx, registered } = makeContext();
  apply(ctx, {});
  for (const tool of registered) {
    const properties = Object.keys((tool.parameters.properties ?? {}) as Record<string, unknown>);
    for (const required of (tool.parameters.required as string[] | undefined) ?? []) {
      assert.ok(properties.includes(required), `${tool.name}: required 里的 ${required} 没有对应 properties`);
    }
  }
});

test("参数校验：缺 sql / 非法 kind / 非法 rows 都给出中文提示", async () => {
  const { ctx, registered } = makeContext();
  apply(ctx, liveConfig);
  const query = registered.find((tool) => tool.name === "clickhouse_query");
  const explain = registered.find((tool) => tool.name === "clickhouse_explain");
  const sample = registered.find((tool) => tool.name === "clickhouse_sample_rows");
  assert.ok(query && explain && sample);

  await assert.rejects(() => query.execute({}, fakeExec), /参数 sql 必填/);
  await assert.rejects(() => query.execute({ sql: "   " }, fakeExec), /参数 sql 必填/);
  await assert.rejects(() => query.execute({ sql: "SELECT 1", max_rows: 0 }, fakeExec), /不能小于 1/);
  await assert.rejects(() => explain.execute({ sql: "SELECT 1", kind: "magic" }, fakeExec), /kind 只能是/);
  await assert.rejects(() => sample.execute({ table: "" }, fakeExec), /参数 table 必填/);
});

test("库白/黑名单在参数层就被拦截（不会发出请求）", async () => {
  const config = resolveConfig({ denyDatabases: ["secret"], allowDatabases: ["default"] });
  const gateway = new ClickHouseGateway(config);
  const tools = createClickHouseTools(gateway, config);
  const tables = tools.find((tool) => tool.name === "clickhouse_list_tables");
  const describe = tools.find((tool) => tool.name === "clickhouse_describe_table");
  assert.ok(tables && describe);

  await assert.rejects(
    () => tables.execute({ database: "secret" }, fakeExec),
    /denyDatabases/,
  );
  await assert.rejects(
    () => tables.execute({ database: "other" }, fakeExec),
    /allowDatabases/,
  );
  await assert.rejects(
    () => describe.execute({ table: "secret.t" }, fakeExec),
    /denyDatabases/,
  );
});

test("SQL 护栏在工具层生效：写入语句、多语句、SETTINGS 都被拒绝", async () => {
  const { ctx, registered } = makeContext();
  apply(ctx, liveConfig);
  const query = registered.find((tool) => tool.name === "clickhouse_query");
  assert.ok(query);

  await assert.rejects(() => query.execute({ sql: "DROP TABLE default.t" }, fakeExec), /只允许只读语句/);
  await assert.rejects(() => query.execute({ sql: "SELECT 1; SELECT 2" }, fakeExec), /单条语句/);
  await assert.rejects(() => query.execute({ sql: "SELECT 1 SETTINGS max_threads=1" }, fakeExec), /SETTINGS/);
  await assert.rejects(() => query.execute({ sql: "SELECT * FROM url('http://x')" }, fakeExec), /表函数 url/);
});

test("输出 schema 能约束真实返回值形状（用一个仿造的 outcome 走一遍渲染）", async () => {
  // 直接构造 gateway 的子类，避免联网：只覆盖 metadata 查询。
  class StubGateway extends ClickHouseGateway {
    override async executeMetadataQuery(): Promise<never> {
      throw new Error("not used");
    }
    override async executeUserQuery(): Promise<never> {
      throw new Error("not used");
    }
  }
  const gateway = new StubGateway(liveConfig);
  const tools = createClickHouseTools(gateway, liveConfig);
  assert.equal(tools.length, 7);

  // 用 toValue 的真实路径无法直接调用（未导出），改为核对 schema 与渲染器的配合：
  const query = tools.find((tool) => tool.name === "clickhouse_query");
  assert.ok(query);
  const value = {
    summary: "查询完成：1 行 / 3 ms",
    columns: ["a"],
    columnTypes: ["UInt8"],
    rows: [[1]],
    rowCount: 1,
    truncated: false,
    limit: 50,
    elapsedMs: 3,
    queryId: "test-1",
    executedSql: "SELECT 1",
    sqlWasRewritten: false,
    notes: [],
  };
  assert.deepEqual(validate(query.output.schema, value), []);

  const rendered = query.output.render({}, value);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0]?.type, "text");
  assert.match(rendered[0]?.text ?? "", /\| a \|/);
  assert.match(rendered[0]?.text ?? "", /查询完成：1 行/);

  // 少了必填字段必须被 schema 判出来（证明校验器有效，而不是恒真）。
  const broken: Record<string, unknown> = { ...value };
  delete broken.rowCount;
  assert.ok(validate(query.output.schema, broken).length > 0);

  // 多了未声明字段也必须判出来。
  assert.ok(validate(query.output.schema, { ...value, extra: 1 }).length > 0);

  // format: "json" 走另一条渲染分支。
  const asJson = query.output.render({ format: "json" }, value);
  assert.match(asJson[0]?.text ?? "", /"rowCount": 1/);
});
