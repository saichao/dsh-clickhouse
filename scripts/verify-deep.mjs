/**
 * 深度预检：直接调用**市场自己的组装分析**（dshmarket 的 `analyzeProfile`），
 * 拿到和 DSH 启动同源的判断 —— 包括每个 bundle 的层、composed row、重复 entry id、
 * 失效引用等。比 verify.mjs 的静态检查更强，重启前跑一遍最稳。
 *
 * 用法：node scripts/verify-deep.mjs [--profile <目录>]
 *
 * @module dsh-clickhouse/scripts/verify-deep
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const profileFlag = args.indexOf("--profile");
const profileDir = resolve(
  profileFlag >= 0 && args[profileFlag + 1]
    ? args[profileFlag + 1]
    : join(process.env.USERPROFILE ?? homedir(), ".dsh", "profiles", "desktop"),
);

const checkUrl = pathToFileURL(join(profileDir, "node_modules", "dshmarket", "lib", "check.js")).href;
if (!existsSync(new URL(checkUrl))) {
  console.error(`找不到市场的校验模块：${checkUrl}`);
  process.exit(2);
}

const { analyzeProfile } = await import(checkUrl);
const report = analyzeProfile(profileDir);

console.log(`profile: ${profileDir}`);
console.log(`返回字段: ${Object.keys(report).join(", ")}\n`);

function dump(label, value, maxChars = 4000) {
  if (value === undefined || value === null) return;
  const text = JSON.stringify(value, null, 2);
  console.log(`--- ${label} ---`);
  console.log(text.length > maxChars ? `${text.slice(0, maxChars)}\n…(截断，共 ${text.length} 字符)` : text);
  console.log("");
}

dump("bundle 顺序", report.bundles ?? report.bundleNames);
dump("层", report.layers);
for (const key of Object.keys(report)) {
  if (/problem|duplicate|conflict|fatal|error|orphan|residual|missing|warn/i.test(key)) {
    dump(`['${key}']`, report[key]);
  }
}

// 我关心的结论：dsh-clickhouse 是否出现在组装结果里。
const text = JSON.stringify(report);
console.log(`组装结果里提到 dsh-clickhouse: ${text.includes("dsh-clickhouse") ? "是" : "否"}`);
console.log(`组装结果里提到 row id clickhouse: ${text.includes('"clickhouse"') ? "是" : "否"}`);
