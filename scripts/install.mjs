/**
 * 安装 / 更新插件到 DSH profile（幂等，可反复跑）。
 *
 *  1. 检查构建产物 `lib/index.js` 是否存在（没有就提示先 `pnpm build`）；
 *  2. 确定部署配置：`--config <json>` > 已安装拷贝里现有的 config > 不写 config；
 *  3. 把 `package.json` / `README.md` / `lib/` 复制到
 *     `<profile>/node_modules/dsh-clickhouse`（主）与 `~/.dsh/node_modules/dsh-clickhouse`（兜底）；
 *  4. 给两份拷贝写 `cordis.patch.yml`（带 config 的 insert 行）；
 *  5. 若 `<profile>/package.json` 的 `dsh.profile.bundles` 还没列出它，先备份再追加（临时文件 + rename 原子写）；
 *  6. 自动跑 `scripts/verify.mjs`。
 *
 * 用法：
 *   node scripts/install.mjs [--profile <目录>] [--config <deploy.json>] [--no-home] [--no-enable] [--skip-verify]
 *
 * @module dsh-clickhouse/scripts/install
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PLUGIN_NAME = "dsh-clickhouse";
const ROW_ID = "clickhouse";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name) => argv.includes(name);

const profileDir = resolve(
  flag("--profile") ?? join(process.env.USERPROFILE ?? homedir(), ".dsh", "profiles", "desktop"),
);
const homeTarget = join(process.env.USERPROFILE ?? homedir(), ".dsh", "node_modules", PLUGIN_NAME);
const profileTarget = join(profileDir, "node_modules", PLUGIN_NAME);
const backupsDir = join(projectRoot, "backups");

function log(message) {
  console.log(message);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeFileAtomic(file, content) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content);
  renameSync(temp, file);
}

/**
 * 递归复制目录。
 *
 * 不用 `fs.cpSync(..., {recursive:true})`：在本机（Node 24.2.0 / Windows）它会以
 * 0xC0000409 硬崩，连异常都抛不出来。手写递归反而稳定。
 */
function copyTree(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else copyFileSync(from, to);
  }
}

/** 从已安装的 patch 文件里抠出 config（够用即可）。 */
function readConfigFromPatch(file) {
  if (!existsSync(file)) return null;
  const config = {};
  let inConfig = false;
  let configIndent = -1;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
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
  return Object.keys(config).length > 0 ? config : null;
}

/** 渲染 patch 文件内容（有 config 就写进 insert 行）。 */
function renderPatch(config) {
  const head =
    "# dsh bundle patch：把本插件的 loader 行插进 profile 的层栈。\n" +
    "#\n" +
    "# 由 scripts/install.mjs 生成。连接信息属于部署方，改这里或改 profile 的用户补丁层都行。\n";
  if (config === null) return `${head}- insert:\n    - id: ${ROW_ID}\n      name: '${PLUGIN_NAME}'\n`;
  const lines = Object.entries(config).map(([key, value]) => {
    const rendered =
      typeof value === "string" ? (value === "" ? "''" : value) : String(value);
    return `        ${key}: ${rendered}`;
  });
  return (
    `${head}- insert:\n` +
    `    - id: ${ROW_ID}\n` +
    `      name: '${PLUGIN_NAME}'\n` +
    `      config:\n` +
    `${lines.join("\n")}\n`
  );
}

// --- 1. 构建产物 ---
if (!existsSync(join(projectRoot, "lib", "index.js"))) {
  console.error("缺少构建产物 lib/index.js，请先运行：pnpm build");
  process.exit(2);
}
log(`源目录: ${projectRoot}`);

// --- 2. 配置 ---
let config = null;
const configFlag = flag("--config");
if (configFlag !== undefined) {
  const configFile = resolve(configFlag);
  if (!existsSync(configFile)) {
    console.error(`找不到配置文件：${configFile}`);
    process.exit(2);
  }
  config = readJson(configFile);
  log(`配置来源: ${configFile}`);
} else {
  config = readConfigFromPatch(join(profileTarget, "cordis.patch.yml")) ?? readConfigFromPatch(join(homeTarget, "cordis.patch.yml"));
  log(config === null ? "配置来源: 无（使用插件内置默认值）" : "配置来源: 已安装拷贝（保持不变）");
}
if (config !== null) log(`生效配置: ${JSON.stringify(config)}`);

// --- 3/4. 复制 + 写 patch ---
const targets = has("--no-home") ? [profileTarget] : [profileTarget, homeTarget];
const patchText = renderPatch(config);
for (const target of targets) {
  mkdirSync(target, { recursive: true });
  for (const file of ["package.json", "README.md"]) {
    // Windows 上用 cpSync 覆盖已存在的文件会报 ESRCH（Node 的 cp 实现问题），
    // 单文件复制一律走 copyFileSync。
    copyFileSync(join(projectRoot, file), join(target, file));
  }
  rmSync(join(target, "lib"), { recursive: true, force: true });
  copyTree(join(projectRoot, "lib"), join(target, "lib"));
  writeFileAtomic(join(target, "cordis.patch.yml"), patchText);
  log(`已安装 → ${target}`);
}

// --- 5. bundles 条目 ---
const manifestPath = join(profileDir, "package.json");
if (!existsSync(manifestPath)) {
  console.error(`找不到 profile 清单：${manifestPath}`);
  process.exit(2);
}
const manifest = readJson(manifestPath);
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
if (bundles.includes(PLUGIN_NAME)) {
  log(`${PLUGIN_NAME} 已在 dsh.profile.bundles 中`);
} else if (has("--no-enable")) {
  log(`--no-enable：跳过 dsh.profile.bundles 修改（记得手动加 ${PLUGIN_NAME}）`);
} else {
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(backupsDir, `profile-package.json.${stamp}.bak`);
  cpSync(manifestPath, backup);
  bundles.push(PLUGIN_NAME);
  manifest.dsh.profile.bundles = bundles;
  writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`已加入 dsh.profile.bundles（原文件备份：${backup}）`);
}

// --- 6. 校验 ---
if (!has("--skip-verify")) {
  log("\n--- 预检 ---");
  const result = spawnSync(process.execPath, [join(projectRoot, "scripts", "verify.mjs"), "--profile", profileDir], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error("\n预检未通过，先别重启 DSH。");
    process.exit(result.status ?? 1);
  }
}
log(`\n完成。重启 DSH 后即可在对话里使用 ${ROW_ID}_* 这 7 个工具。`);
