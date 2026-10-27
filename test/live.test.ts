/**
 * 真机联调测试（会真的连 ClickHouse，因此用 `pnpm test:live` 单独跑）。
 *
 * 覆盖：7 个工具端到端可用、返回值符合 output.schema、老版本 21.12 的 system.tables
 * 查询不再踩 active_parts 缺列的坑、截断标记、渲染文本可读、护栏拦截写操作。
 *
 * 环境变量：
 *   CLICKHOUSE_TEST_URL（默认 http://localhost:8123）
 *   CLICKHOUSE_TEST_USER / CLICKHOUSE_TEST_PASSWORD
 *   CLICKHOUSE_TEST_DATABASE（默认 default）
 *   CLICKHOUSE_TEST_TABLE（默认 system.tables——任何实例都有，不依赖具体业务表）
 *   CLICKHOUSE_TEST_READONLY=false 可在排查 numbers() 一类查询时关掉服务端只读
 *
 * @module dsh-clickhouse/test/live
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ClickHouseGateway } from "../src/clickhouse.js";
import { resolveConfig } from "../src/config.js";
import { createClickHouseTools } from "../src/tools.js";
import { validate } from "./schema-check.js";
import type { ToolDefinitionLike } from "../src/types.js";

const config = resolveConfig({
  url: process.env.CLICKHOUSE_TEST_URL ?? "http://localhost:8123",
  user: process.env.CLICKHOUSE_TEST_USER ?? "default",
  password: process.env.CLICKHOUSE_TEST_PASSWORD ?? "",
  database: process.env.CLICKHOUSE_TEST_DATABASE ?? "default",
  readonly: process.env.CLICKHOUSE_TEST_READONLY !== "false",
  maxRows: 100,
  sampleRows: 3,
});

const testTable = process.env.CLICKHOUSE_TEST_TABLE ?? "system.tables";
const tools = createClickHouseTools(new ClickHouseGateway(config), config);
const byName = new Map(tools.map((tool) => [tool.name, tool]));

function tool(name: string): ToolDefinitionLike {
  const found = byName.get(name);
  assert.ok(found, `缺少工具 ${name}`);
  return found;
}

const exec = { signal: undefined, callId: "live", name: "live", arguments: {} };

/** 跑一次工具，核对返回值合规，并返回 render 后的模型可见文本。 */
async function call(name: string, args: Record<string, unknown>): Promise<{ value: any; text: string }> {
  const definition = tool(name);
  const value = await definition.execute(args, exec);
  assert.deepEqual(validate(definition.output.schema, value), [], `${name} 的返回值不符合 output.schema`);
  const blocks = definition.output.render(args, value);
  assert.equal(blocks.length, 1);
  const text = blocks[0]?.text ?? "";
  assert.ok(text.length > 0, `${name} 渲染出了空文本`);
  return { value, text };
}

test("先看连接是否可用（serverInfo）", async () => {
  const gateway = new ClickHouseGateway(config);
  const info = await gateway.serverInfo();
  assert.ok(info.version.length > 0);
  console.log(
    `[live] 连接 ${config.url} 成功：ClickHouse ${info.version}，时区 ${info.timezone}，运行 ${info.uptimeSeconds}s`,
  );
});

test("clickhouse_list_databases 能列出库并带表数", async () => {
  const { value, text } = await call("clickhouse_list_databases", {});
  assert.ok(value.rowCount > 0, "至少应有一个库");
  assert.ok(value.columns.includes("table_count"));
  assert.match(text, /\| database \|/);
  console.log(`[live] 数据库数量：${value.rowCount}`);
});

test("clickhouse_list_tables 在 21.12 上不会踩 active_parts 缺列", async () => {
  const { value } = await call("clickhouse_list_tables", { database: config.database, limit: 5 });
  assert.ok(value.rowCount > 0, `库 ${config.database} 应有表`);
  assert.ok(value.columns.includes("total_bytes"));
});

test("clickhouse_list_tables 的 like 过滤生效（大小写不敏感）", async () => {
  const all = await call("clickhouse_list_tables", { database: config.database, limit: 100 });
  const firstName = String(all.value.rows[0]?.[1] ?? "");
  assert.ok(firstName.length > 0, "取不到表名，无法验证 like");
  const keyword = firstName.slice(0, 3);
  const { value } = await call("clickhouse_list_tables", { database: config.database, like: keyword.toUpperCase() });
  assert.ok(value.rowCount > 0, `like=${keyword} 应能匹配到 ${firstName}`);
});

test("clickhouse_describe_table 能列出字段与类型", async () => {
  const { value } = await call("clickhouse_describe_table", { table: testTable });
  assert.ok(value.rowCount > 0, `${testTable} 应有字段`);
  assert.ok(value.columns.includes("type"));
  console.log(`[live] ${testTable} 字段数：${value.rowCount}`);
});

test("clickhouse_describe_table 对不存在的表给出可读错误", async () => {
  await assert.rejects(
    () => tool("clickhouse_describe_table").execute({ table: "default.definitely_not_a_table_xyz" }, exec),
    /不存在/,
  );
});

test("clickhouse_sample_rows 返回真实数据并支持列投影", async () => {
  const described = await call("clickhouse_describe_table", { table: testTable });
  const firstColumn = String(described.value.rows[0]?.[0] ?? "");
  assert.ok(firstColumn.length > 0);
  const { value } = await call("clickhouse_sample_rows", { table: testTable, rows: 2, columns: [firstColumn] });
  assert.deepEqual(value.columns, [firstColumn]);
  assert.ok(value.rowCount <= 2);
});

test("clickhouse_query 能跑聚合，并按 max_rows 截断", async () => {
  const { value } = await call("clickhouse_query", {
    sql: "SELECT name, engine, total_rows FROM system.tables ORDER BY name",
    max_rows: 3,
  });
  assert.equal(value.truncated, true, "结果明显超过 3 行，应标记 truncated");
  assert.equal(value.rowCount, 3);
  assert.match(value.executedSql, /^SELECT \* FROM \(/);
});

test("clickhouse_query 对大表做 count() 不拉明细", async () => {
  const { value, text } = await call("clickhouse_query", {
    sql: `SELECT count() AS rows FROM ${testTable}`,
  });
  assert.equal(value.rowCount, 1);
  const rows = Number(value.rows[0]?.[0] ?? 0);
  assert.ok(rows > 0, "行数应大于 0");
  assert.match(text, /rows/);
  console.log(`[live] ${testTable} 行数：${rows.toLocaleString("en-US")}`);
});

test("clickhouse_explain 能给出执行计划", async () => {
  const { value } = await call("clickhouse_explain", {
    sql: `SELECT count() FROM ${testTable}`,
    kind: "plan",
  });
  assert.ok(value.rowCount > 0, "执行计划不应为空");
});

test("clickhouse_search_columns 能按字段名定位表", async () => {
  const { value } = await call("clickhouse_search_columns", { pattern: "name", limit: 10 });
  assert.ok(value.columns.includes("table"));
  console.log(`[live] 字段名含 name 的字段数（上限 10）：${value.rowCount}`);
});

test("截断、空结果、错误码都有可读输出", async () => {
  const empty = await call("clickhouse_query", { sql: "SELECT 1 AS x WHERE 0" });
  assert.equal(empty.value.rowCount, 0);

  await assert.rejects(
    () => tool("clickhouse_query").execute({ sql: "SELECT * FROM default.no_such_table_xyz" }, exec),
    /ClickHouse 错误 60|UNKNOWN_TABLE|不存在/,
  );

  await assert.rejects(() => tool("clickhouse_query").execute({ sql: "DROP TABLE default.t" }, exec), /只允许只读语句/);
});

test("format: json 输出可解析的 JSON", async () => {
  const { text } = await call("clickhouse_query", { sql: "SELECT 1 AS x", format: "json" });
  const start = text.indexOf("{");
  const parsed = JSON.parse(text.slice(start));
  assert.equal(parsed.rowCount, 1);
  assert.deepEqual(parsed.columns, ["x"]);
});

test("中文别名：不加反引号给出改法提示，加了反引号正常返回", async () => {
  await assert.rejects(
    () => tool("clickhouse_query").execute({ sql: "SELECT 1 AS 行数" }, exec),
    /反引号/,
  );
  const { value } = await call("clickhouse_query", { sql: "SELECT 1 AS `行数`" });
  assert.deepEqual(value.columns, ["行数"]);
});
