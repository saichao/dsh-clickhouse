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

import { describeError, UserError } from "./errors.js";
import { renderOutcome } from "./format.js";
import {
  assertDatabaseAllowed,
  ClickHouseGateway,
  quoteIdentifier,
  resolveTableName,
  type QueryOutcome,
} from "./clickhouse.js";
import type { ClickHousePluginConfig } from "./config.js";
import type { ContentBlock, JsonSchemaNode, ToolDefinitionLike, ToolRunContextLike } from "./types.js";

/** 工具的规范返回值（与 RESULT_SCHEMA 一一对应）。 */
interface QueryResultValue {
  summary: string;
  columns: string[];
  columnTypes: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  limit: number;
  elapsedMs: number;
  queryId: string;
  executedSql: string;
  sqlWasRewritten: boolean;
  notes: string[];
  statistics?: { rows_read?: number; bytes_read?: number; elapsed?: number };
}

/** 所有工具共用的输出 schema：注册表会按它校验并冻结返回值。 */
const RESULT_SCHEMA: JsonSchemaNode = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "columns",
    "columnTypes",
    "rows",
    "rowCount",
    "truncated",
    "limit",
    "elapsedMs",
    "queryId",
    "executedSql",
    "sqlWasRewritten",
    "notes",
  ],
  properties: {
    summary: { type: "string", description: "一句话结论，供模型直接复述。" },
    columns: { type: "array", items: { type: "string" }, description: "列名，顺序与 rows 内数组一致。" },
    columnTypes: { type: "array", items: { type: "string" }, description: "ClickHouse 列类型。" },
    rows: { type: "array", items: { type: "array", items: {} }, description: "行数据，按 columns 顺序排列。" },
    rowCount: { type: "integer", description: "返回的行数。" },
    truncated: { type: "boolean", description: "是否因为行数上限被截断。" },
    limit: { type: "integer", description: "本次生效的行数上限。" },
    elapsedMs: { type: "integer", description: "服务端耗时（毫秒）。" },
    queryId: { type: "string", description: "ClickHouse query_id，便于在 system.query_log 里追溯。" },
    executedSql: { type: "string", description: "真正提交给 ClickHouse 的 SQL。" },
    sqlWasRewritten: { type: "boolean", description: "是否为了加行数上限改写了 SQL。" },
    notes: { type: "array", items: { type: "string" }, description: "提示、降级说明与护栏告警。" },
    statistics: {
      type: "object",
      additionalProperties: false,
      properties: {
        rows_read: { type: "integer" },
        bytes_read: { type: "integer" },
        elapsed: { type: "number" },
      },
    },
  },
};

/** 把内部结果转成规范值。 */
function toValue(outcome: QueryOutcome, summary: string): QueryResultValue {
  const value: QueryResultValue = {
    summary,
    columns: outcome.columns,
    columnTypes: outcome.columnTypes,
    rows: outcome.rows.map((row) => outcome.columns.map((column) => row[column] ?? null)),
    rowCount: outcome.rows.length,
    truncated: outcome.truncated,
    limit: outcome.limit,
    elapsedMs: outcome.elapsedMs,
    queryId: outcome.queryId,
    executedSql: outcome.executedSql,
    sqlWasRewritten: outcome.sqlWasRewritten,
    notes: outcome.notes,
  };
  if (outcome.statistics) value.statistics = { ...outcome.statistics };
  return value;
}

/** 由 value 还原出渲染器需要的结果对象。 */
function toOutcome(value: QueryResultValue): QueryOutcome {
  const outcome: QueryOutcome = {
    columns: value.columns,
    columnTypes: value.columnTypes,
    rows: value.rows.map((row) => {
      const record: Record<string, unknown> = {};
      value.columns.forEach((column, index) => {
        record[column] = row[index] ?? null;
      });
      return record;
    }),
    truncated: value.truncated,
    limit: value.limit,
    elapsedMs: value.elapsedMs,
    queryId: value.queryId,
    executedSql: value.executedSql,
    sqlWasRewritten: value.sqlWasRewritten,
    notes: value.notes,
  };
  if (value.statistics) outcome.statistics = { ...value.statistics };
  return outcome;
}

function renderValue(value: QueryResultValue, maxCellChars: number, format: "markdown" | "json"): string {
  return renderOutcome(toOutcome(value), { format, maxCellChars, title: value.summary });
}

/** 统一的输出声明：默认 Markdown 表格，`format: "json"` 时给完整 JSON。 */
function resultOutput(maxCellChars: number): ToolDefinitionLike["output"] {
  return {
    schema: RESULT_SCHEMA,
    render(args, value) {
      const requested = asRecord(args).format;
      const format = requested === "json" ? "json" : "markdown";
      return [{ type: "text", text: renderValue(value as QueryResultValue, maxCellChars, format) }];
    },
  };
}

function asRecord(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) throw new UserError("工具参数必须是一个对象。");
  return args as Record<string, unknown>;
}

function requireString(args: unknown, key: string): string {
  const value = asRecord(args)[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UserError(`参数 ${key} 必填，且必须是非空字符串。`);
  }
  return value.trim();
}

function optionalString(args: unknown, key: string): string | undefined {
  const value = asRecord(args)[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new UserError(`参数 ${key} 必须是字符串。`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalInteger(args: unknown, key: string, min: number, max: number): number | undefined {
  const value = asRecord(args)[key];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new UserError(`参数 ${key} 必须是数字。`);
  const rounded = Math.floor(parsed);
  if (rounded < min) throw new UserError(`参数 ${key} 不能小于 ${min}。`);
  return Math.min(rounded, max);
}

function optionalBoolean(args: unknown, key: string): boolean | undefined {
  const value = asRecord(args)[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UserError(`参数 ${key} 必须是布尔值。`);
}

function optionalStringArray(args: unknown, key: string): string[] | undefined {
  const value = asRecord(args)[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return items.length > 0 ? items : undefined;
  }
  if (!Array.isArray(value)) throw new UserError(`参数 ${key} 必须是字符串数组。`);
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new UserError(`参数 ${key} 里含有非字符串项。`);
    const trimmed = item.trim();
    if (trimmed.length > 0) items.push(trimmed);
  }
  return items.length > 0 ? items : undefined;
}

/** SQL 字符串字面量转义（参数里的库名/表名/模式都以字面量拼进系统表查询）。 */
function sqlLiteral(text: string): string {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** LIKE 模式：用户通常只给关键词，所以两端补 %，并统一转小写做大小写不敏感匹配。 */
function likePattern(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("%") || trimmed.includes("_")) return trimmed.toLowerCase();
  return `%${trimmed.toLowerCase()}%`;
}

/** 把库过滤条件拼成 SQL 片段（deny 优先，allow 白名单非空时生效）。 */
function databaseFilter(config: ClickHousePluginConfig, column: string): string {
  const parts: string[] = [];
  if (config.denyDatabases.length > 0) {
    parts.push(`${column} NOT IN (${config.denyDatabases.map(sqlLiteral).join(", ")})`);
  }
  if (config.allowDatabases.length > 0) {
    parts.push(`${column} IN (${config.allowDatabases.map(sqlLiteral).join(", ")})`);
  }
  return parts.length > 0 ? ` AND ${parts.join(" AND ")}` : "";
}

/** 统一把异常转成可直接展示的用户可读消息。 */
async function guarded<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw new UserError(describeError(error));
  }
}

function summarize(outcome: QueryOutcome, prefix: string): string {
  const truncated = outcome.truncated ? `（已截断，仅前 ${outcome.rows.length} 行）` : "";
  return `${prefix}：${outcome.rows.length} 行 / ${outcome.elapsedMs} ms${truncated}`;
}

function signalOf(exec: ToolRunContextLike): AbortSignal | undefined {
  return exec?.signal;
}

/**
 * 构造全部工具定义。
 *
 * @param gateway - 已配置好的 ClickHouse 客户端。
 * @param config - 规范化后的插件配置。
 * @returns 可直接交给 `ctx.tools.register()` 的工具定义数组。
 */
export function createClickHouseTools(
  gateway: ClickHouseGateway,
  config: ClickHousePluginConfig,
): ToolDefinitionLike[] {
  const output = resultOutput(config.maxCellChars);
  const timeoutMs = (config.timeoutSeconds + 20) * 1_000;
  const databaseNote = `当前默认库：${config.database}`;

  return [
    {
      name: "clickhouse_query",
      description:
        "对 ClickHouse 执行一条**只读** SQL 并返回结果（Markdown 表格）。" +
        "只接受单条语句，且必须以 SELECT / WITH / SHOW / DESCRIBE / EXPLAIN / EXISTS 开头；" +
        "写入类关键字、`FORMAT`、`SETTINGS` 一律拒绝。结果默认最多返回 " +
        `${config.maxRows} 行，超出会截断并在结果里标记 truncated。` +
        "大表请先用 count()/聚合/时间范围收窄；`uniq()` 比 `uniqExact()` 快得多。",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "要执行的只读 SQL，单条语句，不要带结尾分号。" },
          max_rows: {
            type: "integer",
            minimum: 1,
            description: `本次最多返回多少行（上限 ${config.maxRows}，默认 ${config.maxRows}）。`,
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "结果呈现方式：markdown（默认，省 token）或 json（需要精确结构时）。",
          },
        },
        required: ["sql"],
      },
      output,
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return guarded(async () => {
          const sql = requireString(args, "sql");
          const maxRows = optionalInteger(args, "max_rows", 1, config.maxRows);
          const outcome = await gateway.executeUserQuery(sql, { signal: signalOf(exec), maxRows });
          if (config.readonly && outcome.rows.length === 0 && outcome.columns.length === 0) {
            outcome.notes.push(`查询没有返回任何列。${databaseNote}`);
          }
          return toValue(outcome, summarize(outcome, "查询完成"));
        });
      },
    },

    {
      name: "clickhouse_list_databases",
      description:
        "列出 ClickHouse 上的数据库，以及每个库的表数/字段数（可选磁盘占用）。" +
        "做数据问答时先用它确定目标库，再用 clickhouse_list_tables 看表。" +
        "注意：`system`、`INFORMATION_SCHEMA` 是系统库，`default` 往往是业务库之一。",
      parameters: {
        type: "object",
        properties: {
          like: { type: "string", description: "按库名过滤，支持 SQL LIKE 通配符（默认两端自动加 %）。" },
          with_sizes: { type: "boolean", description: "是否统计每个库的磁盘占用（需要扫 system.parts，越大越慢）。" },
        },
      },
      output,
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return guarded(async () => {
          const like = optionalString(args, "like");
          const withSizes = optionalBoolean(args, "with_sizes") ?? false;
          const where: string[] = [];
          if (like) where.push(`lower(d.name) LIKE ${sqlLiteral(likePattern(like))}`);
          // 21.12 不支持 SELECT 列表里的相关子查询（会报 Missing columns: 'd.name'），
          // 因此先各自聚合再 LEFT JOIN 回来。
          const sizeJoin = withSizes
            ? "\nLEFT JOIN (\n" +
              "    SELECT database, sum(bytes_on_disk) AS bytes_on_disk\n" +
              "    FROM system.parts WHERE active GROUP BY database\n" +
              ") AS p ON p.database = d.name"
            : "";
          const sql =
            "SELECT\n" +
            "    d.name AS database,\n" +
            "    d.engine AS engine,\n" +
            "    t.table_count AS table_count,\n" +
            "    c.column_count AS column_count" +
            (withSizes ? ",\n    p.bytes_on_disk AS bytes_on_disk" : "") +
            "\nFROM system.databases AS d\n" +
            "LEFT JOIN (\n" +
            "    SELECT database, count() AS table_count FROM system.tables GROUP BY database\n" +
            ") AS t ON t.database = d.name\n" +
            "LEFT JOIN (\n" +
            "    SELECT database, count() AS column_count FROM system.columns GROUP BY database\n" +
            ") AS c ON c.database = d.name" +
            sizeJoin +
            (where.length > 0 ? `\nWHERE ${where.join(" AND ")}` : "") +
            databaseFilter(config, "d.name").replace(/^ AND /, where.length > 0 ? " AND " : "\nWHERE ") +
            "\nORDER BY table_count DESC, d.name";
          const outcome = await gateway.executeMetadataQuery(sql, { signal: signalOf(exec), label: "databases" });
          if (outcome.rows.length === 0) outcome.notes.push("没有匹配的数据库，或插件配置的库白名单/黑名单把它过滤掉了。");
          return toValue(outcome, summarize(outcome, "数据库列表"));
        });
      },
    },

    {
      name: "clickhouse_list_tables",
      description:
        "列出某个库里的表：表名、引擎、排序键、行数、磁盘占用、表注释，按占用从大到小排序。" +
        "这是了解一个库的最快入口——先看哪张表大、哪张表名字相关，再 clickhouse_describe_table。" +
        "默认隐藏物化视图的内部表（.inner.*）。",
      parameters: {
        type: "object",
        properties: {
          database: { type: "string", description: `库名，默认 ${config.database}。` },
          like: { type: "string", description: "按表名过滤，支持 SQL LIKE 通配符（默认两端自动加 %）。" },
          include_internal: { type: "boolean", description: "是否包含 .inner.* 内部表（默认 false）。" },
          limit: { type: "integer", minimum: 1, description: `最多返回多少张表（上限 ${config.maxRows}）。` },
        },
      },
      output,
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return guarded(async () => {
          const database = optionalString(args, "database") ?? config.database;
          assertDatabaseAllowed(config, database);
          const like = optionalString(args, "like");
          const includeInternal = optionalBoolean(args, "include_internal") ?? false;
          const limit = optionalInteger(args, "limit", 1, config.maxRows) ?? config.maxRows;

          const where = [`database = ${sqlLiteral(database)}`];
          if (like) where.push(`lower(name) LIKE ${sqlLiteral(likePattern(like))}`);
          if (!includeInternal) where.push("name NOT LIKE '.inner%'");

          const sql =
            "SELECT database, name, engine, sorting_key, total_rows, total_bytes, comment\n" +
            "FROM system.tables\n" +
            `WHERE ${where.join(" AND ")}\n` +
            "ORDER BY total_bytes DESC\n" +
            `LIMIT ${limit}`;
          const outcome = await gateway.executeMetadataQuery(sql, {
            signal: signalOf(exec),
            limit,
            label: "tables",
          });
          if (outcome.rows.length === 0) {
            outcome.notes.push(
              like
                ? `库 ${database} 里没有名字匹配 ${JSON.stringify(like)} 的表；可以去掉 like 再试。`
                : `库 ${database} 里没有可见的表（可能库名写错，或该库确实为空）。`,
            );
          } else {
            outcome.notes.push(
              `total_rows / total_bytes 来自 system.tables 的元数据估计，MergeTree 家族之外的表（如 View、Distributed）可能为 NULL。`,
            );
          }
          return toValue(outcome, summarize(outcome, `库 ${database} 的表`));
        });
      },
    },

    {
      name: "clickhouse_describe_table",
      description:
        "查看一张表的字段定义：字段名、类型、默认值、主键/排序键成员、字段注释，按字段顺序排列。" +
        "写 SQL 前必须先用它确认字段名与类型，不要凭猜测写字段。",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "表名，建议写成 `库.表`。" },
          database: { type: "string", description: `库名（table 没写库前缀时使用），默认 ${config.database}。` },
        },
        required: ["table"],
      },
      output,
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return guarded(async () => {
          const raw = requireString(args, "table");
          const database = optionalString(args, "database");
          const resolved = resolveTableName(raw, database, config.database);
          assertDatabaseAllowed(config, resolved.database);
          const sql =
            "SELECT name, type, default_kind, default_expression, is_in_primary_key, is_in_sorting_key, comment\n" +
            "FROM system.columns\n" +
            `WHERE database = ${sqlLiteral(resolved.database)} AND table = ${sqlLiteral(resolved.table)}\n` +
            "ORDER BY position";
          const outcome = await gateway.executeMetadataQuery(sql, {
            signal: signalOf(exec),
            limit: config.maxRows,
            label: "describe",
          });
          if (outcome.rows.length === 0) {
            throw new UserError(
              `表 ${resolved.database}.${resolved.table} 不存在，或当前用户看不到它的字段。` +
                `先用 clickhouse_list_tables（database: "${resolved.database}"）确认表名。`,
            );
          }
          return toValue(outcome, summarize(outcome, `${resolved.database}.${resolved.table} 的字段`));
        });
      },
    },

    {
      name: "clickhouse_sample_rows",
      description:
        "抽样看一张表的真实数据（默认 20 行），用来确认字段含义、取值风格、时间格式、枚举值。" +
        "没有 ORDER BY，返回的是存储顺序上的任意若干行，不代表分布；需要统计请用 clickhouse_query 做聚合。",
      parameters: {
        type: "object",
        properties: {
          table: { type: "string", description: "表名，建议写成 `库.表`。" },
          database: { type: "string", description: `库名（table 没写库前缀时使用），默认 ${config.database}。` },
          rows: { type: "integer", minimum: 1, description: `抽样行数，默认 ${config.sampleRows}，上限 ${config.maxRows}。` },
          columns: {
            type: "array",
            items: { type: "string" },
            description: "只取这些字段（字段名数组）；省略则取全部字段（SELECT *）。",
          },
        },
        required: ["table"],
      },
      output,
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return guarded(async () => {
          const raw = requireString(args, "table");
          const database = optionalString(args, "database");
          const resolved = resolveTableName(raw, database, config.database);
          assertDatabaseAllowed(config, resolved.database);
          const rows = optionalInteger(args, "rows", 1, config.maxRows) ?? Math.min(config.sampleRows, config.maxRows);
          const columns = optionalStringArray(args, "columns");
          const projection = columns && columns.length > 0 ? columns.map(quoteIdentifier).join(", ") : "*";
          const sql =
            `SELECT ${projection}\nFROM ${quoteIdentifier(resolved.database)}.${quoteIdentifier(resolved.table)}\n` +
            `LIMIT ${rows}`;
          const outcome = await gateway.executeMetadataQuery(sql, {
            signal: signalOf(exec),
            limit: rows,
            label: "sample",
          });
          if (outcome.rows.length === 0) outcome.notes.push("该表目前没有数据行。");
          return toValue(outcome, summarize(outcome, `${resolved.database}.${resolved.table} 抽样`));
        });
      },
    },

    {
      name: "clickhouse_explain",
      description:
        "查看一条 SQL 的执行计划（EXPLAIN），用于判断查询为什么慢、有没有走索引/主键、会不会全表扫。" +
        "kind: plan（默认，执行计划）| estimate（行数/耗时估算）| syntax | ast | pipeline。",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "要分析的只读 SQL（单条语句）。" },
          kind: {
            type: "string",
            enum: ["plan", "estimate", "syntax", "ast", "pipeline"],
            description: "EXPLAIN 类型，默认 plan。",
          },
        },
        required: ["sql"],
      },
      output,
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return guarded(async () => {
          const sql = requireString(args, "sql");
          const kind = (optionalString(args, "kind") ?? "plan").toLowerCase();
          const allowed = ["plan", "estimate", "syntax", "ast", "pipeline"];
          if (!allowed.includes(kind)) throw new UserError(`参数 kind 只能是 ${allowed.join(" / ")}。`);
          const outcome = await gateway.executeUserQuery(`EXPLAIN ${kind.toUpperCase()} ${sql}`, {
            signal: signalOf(exec),
          });
          return toValue(outcome, summarize(outcome, `EXPLAIN ${kind.toUpperCase()}`));
        });
      },
    },

    {
      name: "clickhouse_search_columns",
      description:
        "按字段名关键词搜索整个实例（或某个库）的字段，返回它在哪些库.表里、类型是什么。" +
        "当你不确定某个业务概念存在哪张表时（比如「订单号」「手机号」「合同编号」），先用它定位表，" +
        "再 clickhouse_describe_table。搜表名请改用 clickhouse_list_tables 的 like 参数。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "字段名关键词，支持 SQL LIKE 通配符（默认两端自动加 %）。" },
          database: { type: "string", description: `只在该库内搜索；省略则搜索所有库。` },
          limit: { type: "integer", minimum: 1, description: `最多返回多少个字段（上限 ${config.maxRows}）。` },
        },
        required: ["pattern"],
      },
      output,
      timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return guarded(async () => {
          const pattern = requireString(args, "pattern");
          const database = optionalString(args, "database");
          if (database) assertDatabaseAllowed(config, database);
          const limit = optionalInteger(args, "limit", 1, config.maxRows) ?? config.maxRows;
          const where = [`lower(name) LIKE ${sqlLiteral(likePattern(pattern))}`];
          if (database) where.push(`database = ${sqlLiteral(database)}`);
          const sql =
            "SELECT database, table, name, type, position, comment\n" +
            "FROM system.columns\n" +
            `WHERE ${where.join(" AND ")}` +
            databaseFilter(config, "database") +
            "\nORDER BY database, table, position\n" +
            `LIMIT ${limit}`;
          const outcome = await gateway.executeMetadataQuery(sql, {
            signal: signalOf(exec),
            limit,
            label: "search-columns",
          });
          if (outcome.rows.length === 0) {
            outcome.notes.push(
              `没有字段名匹配 ${JSON.stringify(pattern)}。可以换更短的关键词（例如「name」「id」「code」），或用 clickhouse_list_tables 按表名找。`,
            );
          }
          return toValue(outcome, summarize(outcome, `字段名匹配 ${JSON.stringify(pattern)}`));
        });
      },
    },
  ];
}
