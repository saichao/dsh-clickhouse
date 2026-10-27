/**
 * 打印 profile 组装后的 loader 行——包括每个插件**最终会收到的 config**。
 *
 * 用的是 DSH 启动用的同一套代码（`@deepseek-ai/dsh-app-boot` 的
 * `loadProfile` + `composeEntries`），所以这是「重启后插件实际拿到什么配置」的离线证据，
 * 不用真的重启。
 *
 * 它必须跑在 asar 感知的 node 里（Loader 在 app.asar 内），也就是 Electron 的
 * `ELECTRON_RUN_AS_NODE` 模式；入口用 .cjs（该模式不接受 .mjs 入口）：
 *
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
 *       scripts\inspect-composition.cjs [--profile desktop] [--row clickhouse] [--app <dsh 目录>]
 *
 * @module dsh-clickhouse/scripts/inspect-composition
 */

const path = require("node:path");

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const profileName = argOf("--profile", "desktop");
const rowId = argOf("--row", "clickhouse");
const appRoot = argOf(
  "--app",
  path.join(
    process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local",
    "Programs",
    "DeepSeek Harness",
    "resources",
    "app.asar",
    "dsh",
  ),
);

const toUrl = (file) => new URL(`file:///${file.replace(/\\/g, "/").replace(/ /g, "%20")}`).href;

(async () => {
  const bootUrl = toUrl(path.join(appRoot, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js"));
  const boot = await import(bootUrl);
  const installAnchor = path.join(appRoot, "package.json");
  const profile = await boot.loadProfile("dsh", profileName, installAnchor);
  const rows = boot.composeEntries(profile.layers.flatMap((layer) => layer.patches));

  console.log(`profile: ${profileName}`);
  console.log(`层数: ${profile.layers.length}, 组装后的顶层行: ${rows.length}`);
  console.log(`各层: ${profile.layers.map((layer) => `${layer.label}(${layer.patches.length})`).join(", ")}\n`);

  const row = rows.find((entry) => entry.id === rowId);
  if (row === undefined) {
    console.log(`没有找到 id=${rowId} 的行。`);
    process.exitCode = 1;
    return;
  }
  console.log(`id=${rowId} 这一行的最终形态：`);
  console.log(JSON.stringify(row, null, 2));
})();
