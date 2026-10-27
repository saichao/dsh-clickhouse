/**
 * 演示：加载**已安装**的那份插件，用它的真实配置跑几个工具，
 * 打印面向模型渲染出来的文本（也就是 agent 在对话里看到的内容）。
 *
 * 用法：node scripts/demo.mjs [--profile <目录>]
 *
 * @module dsh-clickhouse/scripts/demo
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const profileFlag = args.indexOf("--profile");
const profileDir = resolve(
  profileFlag >= 0 && args[profileFlag + 1]
    ? args[profileFlag + 1]
    : join(process.env.USERPROFILE ?? homedir(), ".dsh", "profiles", "desktop"),
);

const patchFile = join(profileDir, "node_modules", "dsh-clickhouse", "cordis.patch.yml");
if (!existsSync(patchFile)) {
  console.error(`找不到已安装的插件：${patchFile}`);
  process.exit(2);
}

/** 从已安装的 patch 文件里抠出 config 块（够用就行，不做完整 YAML 解析）。 */
function readInstalledConfig(text) {
  const config = {};
  let inConfig = false;
  let configIndent = -1;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "");
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^config:\s*$/.test(trimmed)) {
      inConfig = true;
      configIndent = indent;
      continue;
    }
    if (!inConfig) continue;
    if (indent <= configIndent) {
      inConfig = false;
      continue;
    }
    const match = /^([A-Za-z][\w]*):\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (/^'.*'$/.test(value) || /^".*"$/.test(value)) value = value.slice(1, -1);
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (value !== "" && !Number.isNaN(Number(value))) value = Number(value);
    config[key] = value;
  }
  return config;
}

/** `--redact`：把主机名/口令打码，方便把输出直接贴进公开文档。 */
const redact = args.includes("--redact");
const config = readInstalledConfig(readFileSync(patchFile, "utf8"));
const shown = redact
  ? {
      ...config,
      url: String(config.url ?? "").replace(/\/\/[^/]+/, "//<host>"),
      password: config.password ? "***" : "",
    }
  : config;
console.log(`插件目录: ${redact ? "<profile>\\node_modules\\dsh-clickhouse" : dirname(patchFile)}`);
console.log(`生效配置: ${JSON.stringify(shown, null, 2)}\n`);

const pluginUrl = pathToFileURL(join(profileDir, "node_modules", "dsh-clickhouse", "lib", "index.js")).href;
const plugin = await import(pluginUrl);

const registered = new Map();
plugin.apply(
  {
    tools: { register: (definition) => registered.set(definition.name, definition) },
    inject: () => {},
    logger: { info: () => {}, warn: (message) => console.log(`[warn] ${message}`) },
  },
  config,
);

const calls = [
  // 只用任何 ClickHouse 实例都有的 system 库演示，不依赖具体业务数据。
  ["clickhouse_list_databases", { like: "system" }],
  ["clickhouse_list_tables", { database: "system", like: "table", limit: 5 }],
  ["clickhouse_search_columns", { pattern: "engine", limit: 5 }],
  ["clickhouse_describe_table", { table: "system.tables" }],
  ["clickhouse_sample_rows", { table: "system.tables", rows: 2, columns: ["name", "engine", "total_rows"] }],
  // 中文别名不加反引号会被老版本拒绝——这里正好演示插件给出的改法提示。
  ["clickhouse_query", { sql: "SELECT 1 AS 行数" }],
  ["clickhouse_query", { sql: "SELECT 1 AS `行数`" }],
  [
    "clickhouse_query",
    {
      sql:
        "SELECT database AS `库`, count() AS `表数` FROM system.tables " +
        "WHERE database LIKE 'system%' GROUP BY database ORDER BY `表数` DESC LIMIT 5",
    },
  ],
  ["clickhouse_explain", { sql: "SELECT count() FROM system.tables" }],
];

const maxLines = Number(process.env.DEMO_MAX_LINES ?? 22);
for (const [name, toolArgs] of calls) {
  const definition = registered.get(name);
  if (!definition) {
    console.log(`### ${name} —— 未注册\n`);
    continue;
  }
  const label = Object.keys(toolArgs).length > 0 ? ` ${JSON.stringify(toolArgs)}` : "";
  console.log(`### ${name}${label}`);
  try {
    const value = await definition.execute(toolArgs, { signal: undefined, callId: "demo", name, arguments: toolArgs });
    const blocks = definition.output.render(toolArgs, value);
    const text = blocks.map((block) => block.text).join("\n");
    const lines = text.split("\n");
    console.log(lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n…（共 ${lines.length} 行）` : text);
  } catch (error) {
    console.log(`执行失败：${error instanceof Error ? error.message : String(error)}`);
  }
  console.log("");
}
