/**
 * 卸载插件：从 `dsh.profile.bundles` 里摘掉它，并删除两份拷贝。
 *
 * 删除前会确认目标目录里的 `package.json.name` 确实是 `dsh-clickhouse`，
 * 避免路径算错删到别的东西。profile 清单改动前会备份。
 *
 * 用法：node scripts/uninstall.mjs [--profile <目录>] [--keep-home] [--dry-run]
 *
 * @module dsh-clickhouse/scripts/uninstall
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_NAME = "dsh-clickhouse";
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
const targets = [
  join(profileDir, "node_modules", PLUGIN_NAME),
  ...(has("--keep-home") ? [] : [join(process.env.USERPROFILE ?? homedir(), ".dsh", "node_modules", PLUGIN_NAME)]),
];
const dryRun = has("--dry-run");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// --- 清单 ---
const manifestPath = join(profileDir, "package.json");
if (!existsSync(manifestPath)) {
  console.error(`找不到 profile 清单：${manifestPath}`);
  process.exit(2);
}
const manifest = readJson(manifestPath);
const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
if (!bundles.includes(PLUGIN_NAME)) {
  console.log(`${PLUGIN_NAME} 不在 dsh.profile.bundles 里，无需修改清单。`);
} else if (dryRun) {
  console.log(`[dry-run] 会从 dsh.profile.bundles 移除 ${PLUGIN_NAME}`);
} else {
  const backupsDir = join(projectRoot, "backups");
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(backupsDir, `profile-package.json.${stamp}.bak`);
  cpSync(manifestPath, backup);
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN_NAME);
  const temp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temp, manifestPath);
  console.log(`已从 dsh.profile.bundles 移除（原文件备份：${backup}）`);
}

// --- 目录 ---
for (const target of targets) {
  if (!existsSync(target)) {
    console.log(`跳过（不存在）：${target}`);
    continue;
  }
  const manifestFile = join(target, "package.json");
  let name = null;
  try {
    name = readJson(manifestFile).name;
  } catch {
    name = null;
  }
  if (name !== PLUGIN_NAME) {
    console.error(`拒绝删除 ${target}：里面的 package.json.name 是 ${String(name)}，不是 ${PLUGIN_NAME}`);
    process.exitCode = 1;
    continue;
  }
  if (dryRun) {
    console.log(`[dry-run] 会删除 ${target}`);
    continue;
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`已删除 ${target}`);
}

console.log("\n完成。重启 DSH 后插件不再加载。");
