/**
 * DSH profile 预检：在重启 DSH 之前，确认这套插件不会把启动搞挂。
 *
 * 检查四件事：
 *  1. profile 的 `dsh.profile.bundles` 里**每一个**名字都能解析出可加载的入口文件
 *     （宿主启动时会读这个列表，任何一个解析不了都会卡在 profile 组装上）；
 *  2. `dsh-clickhouse` 能从 profile 解析到，并打印实际生效的那份拷贝；
 *  3. bundle 的 `cordis.patch.yml` 里声明了 `id: clickhouse → name: dsh-clickhouse`
 *     这一行，且没有第二个 bundle 抢同一个 row id；
 *  4. `apply()` 在假 ctx 上能跑通，并注册出 7 个工具。
 *
 * 用法：
 *   node scripts/verify.mjs [--profile <profile 目录>] [--quiet]
 *
 * 退出码 0 = 可以重启；非 0 = 先修问题。
 *
 * @module dsh-clickhouse/scripts/verify
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_NAME = "dsh-clickhouse";
const EXPECTED_ROW_ID = "clickhouse";
/** 宿主自带的 bundle：从 DSH 安装目录（app.asar）解析，不在 profile 的 node_modules 里。 */
const INBOX_BUNDLES = new Set([
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-headless",
]);
const EXPECTED_TOOLS = [
  "clickhouse_query",
  "clickhouse_list_databases",
  "clickhouse_list_tables",
  "clickhouse_describe_table",
  "clickhouse_sample_rows",
  "clickhouse_explain",
  "clickhouse_search_columns",
];

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const profileFlag = args.indexOf("--profile");
const profileDir = resolve(
  profileFlag >= 0 && args[profileFlag + 1]
    ? args[profileFlag + 1]
    : join(process.env.USERPROFILE ?? homedir(), ".dsh", "profiles", "desktop"),
);

const problems = [];
const notes = [];

function say(line) {
  if (!quiet) console.log(line);
}

function fail(message) {
  problems.push(message);
  say(`  ✗ ${message}`);
}

function ok(message) {
  say(`  ✓ ${message}`);
}

/** 从 `name` 解析出包目录（先看 profile 自己的 node_modules，再退回 Node 解析）。 */
function resolvePackageDir(name) {
  const direct = join(profileDir, "node_modules", name, "package.json");
  if (existsSync(direct)) return { dir: dirname(direct), via: "profile/node_modules" };
  try {
    const require = createRequire(join(profileDir, "package.json"));
    const manifest = require.resolve(`${name}/package.json`);
    return { dir: dirname(manifest), via: "node resolution" };
  } catch {
    try {
      const require = createRequire(join(profileDir, "package.json"));
      const entry = require.resolve(name);
      let dir = dirname(entry);
      while (dir !== dirname(dir)) {
        if (existsSync(join(dir, "package.json"))) return { dir, via: "node resolution" };
        dir = dirname(dir);
      }
    } catch {
      /* 下面统一报错 */
    }
  }
  return null;
}

/** 包的可加载入口（main / exports["."]）。 */
function entryFileOf(manifest) {
  const exported = manifest.exports?.["."];
  const candidates = [
    typeof exported === "string" ? exported : undefined,
    typeof exported === "object" && exported !== null ? exported.default : undefined,
    manifest.main,
    "index.js",
  ].filter((value) => typeof value === "string");
  for (const candidate of candidates) {
    const file = join(manifest.__dir, candidate.replace(/^\.\//, ""));
    if (existsSync(file)) return file;
  }
  return null;
}

/** 极简解析：收集 patch 文件里 `- insert:` 块下的 `{ id, name }` 行。 */
function parseInsertedRows(text) {
  const rows = [];
  let inInsert = false;
  let insertIndent = -1;
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "");
    if (line.trim().length === 0) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^-?\s*insert:\s*$/.test(trimmed)) {
      inInsert = true;
      insertIndent = indent;
      continue;
    }
    if (inInsert && indent <= insertIndent) {
      inInsert = false;
      if (current) rows.push(current);
      current = null;
    }
    if (!inInsert) continue;
    const idMatch = /^-?\s*id:\s*(.+)$/.exec(trimmed);
    if (idMatch) {
      if (current) rows.push(current);
      current = { id: idMatch[1].trim().replace(/^['"]|['"]$/g, "") };
      continue;
    }
    const nameMatch = /^name:\s*(.+)$/.exec(trimmed);
    if (nameMatch && current) current.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");
  }
  if (current) rows.push(current);
  return rows;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

say(`profile: ${profileDir}`);
if (!existsSync(join(profileDir, "package.json"))) {
  console.error(`找不到 profile 清单：${join(profileDir, "package.json")}`);
  process.exit(2);
}

const profileManifest = readJson(join(profileDir, "package.json"));
const bundles = Array.isArray(profileManifest.dsh?.profile?.bundles)
  ? profileManifest.dsh.profile.bundles.filter((name) => typeof name === "string")
  : [];

say(`\n[1/4] bundle 栈解析（${bundles.length} 个）`);
const rowOwners = new Map();
for (const name of bundles) {
  const resolvedPackage = resolvePackageDir(name);
  if (resolvedPackage === null) {
    if (INBOX_BUNDLES.has(name)) {
      ok(`${name} → 宿主自带（由 DSH 安装目录提供，profile 里查不到是正常的）`);
      continue;
    }
    fail(`bundle ${name} 无法从 profile 解析 —— 启动会卡在 profile 组装`);
    continue;
  }
  const manifest = { ...readJson(join(resolvedPackage.dir, "package.json")), __dir: resolvedPackage.dir };
  const entry = entryFileOf(manifest);
  if (entry === null) {
    fail(`bundle ${name} 没有可加载的入口文件（main / exports 指向的文件不存在）`);
    continue;
  }
  ok(`${name} → ${entry}（${resolvedPackage.via}）`);

  const patchRelative = manifest.dsh?.bundle?.patch;
  if (typeof patchRelative === "string") {
    const patchFile = join(resolvedPackage.dir, patchRelative.replace(/^\.\//, ""));
    if (!existsSync(patchFile)) {
      fail(`bundle ${name} 声明了 patch ${patchRelative}，但文件不存在`);
      continue;
    }
    for (const row of parseInsertedRows(readFileSync(patchFile, "utf8"))) {
      if (!row.name) continue;
      const owners = rowOwners.get(row.id) ?? [];
      owners.push({ bundle: name, name: row.name });
      rowOwners.set(row.id, owners);
    }
  }
}

say(`\n[2/4] 插件包是否已就位`);
const profileCopy = join(profileDir, "node_modules", PLUGIN_NAME, "package.json");
const homeCopy = join(process.env.USERPROFILE ?? homedir(), ".dsh", "node_modules", PLUGIN_NAME, "package.json");
let pluginDir = null;
if (existsSync(profileCopy)) {
  pluginDir = dirname(profileCopy);
  const manifest = { ...readJson(profileCopy), __dir: pluginDir };
  ok(`${PLUGIN_NAME}@${manifest.version} → ${pluginDir}（profile/node_modules）`);
} else if (existsSync(homeCopy)) {
  pluginDir = dirname(homeCopy);
  const manifest = { ...readJson(homeCopy), __dir: pluginDir };
  ok(`${PLUGIN_NAME}@${manifest.version} → ${pluginDir}（~/.dsh/node_modules 兜底拷贝）`);
  notes.push(`profile/node_modules 里没有拷贝，只找到了兜底拷贝；建议按 README 复制到 profile 内。`);
} else {
  fail(`解析不到 ${PLUGIN_NAME}：把包复制到 ${join(profileDir, "node_modules", PLUGIN_NAME)} 或 ${dirname(homeCopy)}`);
}
if (pluginDir !== null) {
  if (bundles.includes(PLUGIN_NAME)) ok(`${PLUGIN_NAME} 已列入 dsh.profile.bundles`);
  else fail(`${PLUGIN_NAME} 还没加进 dsh.profile.bundles —— 插件不会被加载`);
  if (existsSync(profileCopy) && existsSync(homeCopy)) {
    notes.push(`两处拷贝都在：${dirname(profileCopy)} 与 ${dirname(homeCopy)}（后者是 pnpm 清理时的兜底）`);
  }
}

say(`\n[3/4] loader 行声明`);
const owners = rowOwners.get(EXPECTED_ROW_ID) ?? [];
if (owners.length === 0) {
  if (pluginDir !== null && !bundles.includes(PLUGIN_NAME)) {
    fail(`没有任何 bundle 声明 row id "${EXPECTED_ROW_ID}" —— 插件不会被实例化（把它加进 dsh.profile.bundles 即可）`);
  } else {
    fail(`没有任何 bundle 声明 row id "${EXPECTED_ROW_ID}" —— 插件不会被实例化`);
  }
} else if (owners.length > 1) {
  const detail = owners.map((owner) => `${owner.bundle}`).join(", ");
  fail(`row id "${EXPECTED_ROW_ID}" 被多个 bundle 声明（${detail}）—— 会冲突`);
} else if (owners[0].name !== PLUGIN_NAME) {
  fail(`row id "${EXPECTED_ROW_ID}" 指向的是 ${owners[0].name}，不是 ${PLUGIN_NAME}`);
} else {
  ok(`row "${EXPECTED_ROW_ID}" → ${PLUGIN_NAME}（由 ${owners[0].bundle} 声明）`);
}
if (pluginDir !== null) {
  const ownPatch = join(pluginDir, "cordis.patch.yml");
  if (!existsSync(ownPatch)) {
    fail(`${PLUGIN_NAME} 自己缺少 cordis.patch.yml —— 也不会有 loader 行`);
  } else {
    const declared = parseInsertedRows(readFileSync(ownPatch, "utf8"));
    const own = declared.find((row) => row.id === EXPECTED_ROW_ID);
    if (!own) fail(`${PLUGIN_NAME} 的 cordis.patch.yml 里没有 id: ${EXPECTED_ROW_ID} 这一行`);
    else if (own.name !== PLUGIN_NAME) fail(`该行 name 是 ${own.name}，应为 ${PLUGIN_NAME}`);
    else ok(`自带 patch 声明了 row "${EXPECTED_ROW_ID}" → ${own.name}`);
  }
}
const collisions = [...rowOwners.entries()].filter(([, list]) => new Set(list.map((item) => item.name)).size > 1);
for (const [id] of collisions) notes.push(`注意：row id "${id}" 被多个包声明，宿主可能报冲突（与本次改动无关的话可忽略）`);

say(`\n[4/4] 插件能否加载并注册工具`);
if (pluginDir !== null) {
  const manifest = readJson(join(pluginDir, "package.json"));
  const entry = entryFileOf({ ...manifest, __dir: pluginDir });
  try {
    const module = await import(pathToFileURL(entry).href);
    if (module.name !== EXPECTED_ROW_ID) fail(`导出的 name 是 ${String(module.name)}，期望 ${EXPECTED_ROW_ID}`);
    else ok(`导出 name = ${module.name}`);
    if (!Array.isArray(module.inject) || !module.inject.includes("tools")) fail("inject 里没有 tools");
    else ok(`导出 inject = [${module.inject.join(", ")}]`);
    if (typeof module.apply !== "function") {
      fail("没有导出 apply()");
    } else {
      const registered = [];
      const sections = [];
      module.apply(
        {
          tools: { register: (definition) => registered.push(definition) },
          inject: (names, callback) => {
            if (names.includes("systemPrompt")) {
              callback({ systemPrompt: { section: (section) => sections.push(section) } });
            }
          },
          logger: { info: () => {}, warn: (message) => notes.push(`插件日志: ${message}`) },
        },
        { url: "http://127.0.0.1:8123", guidance: true },
      );
      const names = registered.map((definition) => definition.name);
      const missing = EXPECTED_TOOLS.filter((tool) => !names.includes(tool));
      if (missing.length > 0) fail(`缺少工具：${missing.join(", ")}`);
      else ok(`注册了 ${names.length} 个工具：${names.join(", ")}`);
      for (const definition of registered) {
        if (typeof definition.output?.render !== "function" || !definition.output?.schema) {
          fail(`工具 ${definition.name} 缺少规范的 output 声明`);
        }
      }
      if (sections.length > 0) ok(`注入了系统提示说明（${sections[0].name}）`);
      else notes.push("没有注入系统提示说明（guidance 为 false，或宿主没有 systemPrompt 服务）");
    }
  } catch (error) {
    fail(`加载插件失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

if (notes.length > 0) {
  say(`\n提示：`);
  for (const note of notes) say(`  - ${note}`);
}

if (problems.length > 0) {
  say(`\n结论：有 ${problems.length} 个问题，先别重启。`);
  process.exit(1);
}
say(`\n结论：预检通过，可以重启 DSH 让插件生效。`);
