# 上架 dsh-market 插件市场

目标仓库：[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（市场目录 `plugins.json` 的 `source` 字段就是它）。
规范来源：该仓库的 [`contributing.md`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

## 收录条件与现状

| 要求 | 现状 |
| --- | --- |
| `package.json` 声明 `dsh.bundle` manifest | ✅ `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| 仓库根有 `cordis.patch.yml` | ✅ |
| 仓库里有真实可用的代码（非占位/纯 README） | ✅ 7 个工具、52 个文件、离线 47 + 真机 14 项测试 |
| **仓库创建满 1 天** | ⏳ CI 自动检查——今天建仓，PR 要等满 24 小时 |
| 给仓库打 `dsh-plugin` topic | ⏳ 建仓后在仓库 About 里加 |
| 描述属实、不夸大 | ✅ 条目文案里每条都能在代码里对上 |
| 一个 PR 最多 3 条 | ✅ 只加 1 条 |

> 还要注意：条目文案会被**逐句对照源码**核对（评审清单第 1 条）。所以描述里不要写代码里没有的东西。

## 一、把代码推上 GitHub（今天做）

先在 GitHub 建一个**公开**空仓库（不要勾选 README/.gitignore，名字建议 `dsh-clickhouse`），然后：

```powershell
cd 'E:\桌面备份\sjwd\dsh-clickhouse'
git remote add origin https://github.com/saichao/dsh-clickhouse.git
git branch -M main
git push -u origin main
```

推完在 GitHub 仓库页面 → About 齿轮 → Topics 加 **`dsh-plugin`**。

> 本仓库已经 `git init` 并完成首次提交（commit `70107bc`）。`.gitignore` 已排除 `node_modules/`、`backups/`、`_ref/`（后者是从 app.asar 反解出来的参考资料，含 DeepSeek 专有代码，**不能公开**）。

## 二、条目文件（等仓库满 1 天后提 PR）

Fork `awesome-dsh-plugin/awesome-dsh-plugin`，新建文件
`data/plugins/saichao__dsh-clickhouse.yml`：

```yaml
url: https://github.com/saichao/dsh-clickhouse
name: saichao/dsh-clickhouse
category: tools
description:
  en: ClickHouse query tools for DSH, and the only entry here that targets ClickHouse alone: seven tools that list databases, tables and columns, sample rows, search columns by name, show EXPLAIN plans, and run single read-only SQL statements behind a client-side guard that rejects writes, multi-statement SQL and external table functions. Zero runtime dependencies; it tells the model to backtick non-ASCII aliases instead of failing with a bare syntax error on older servers.
  zh: DSH 的 ClickHouse 数据问答工具：七个工具负责列库表字段、抽样、按字段名反查、看 EXPLAIN 计划，以及执行带客户端只读护栏的单条 SQL（拒绝写操作、多语句与外部表函数）。零运行时依赖；遇到老版本服务器会提示中文别名要加反引号，而不是只报一个语法错误。
```

要点：

- 文件名必须是 `saichao__<repo>.yml`（两个下划线）。
- `description` 里含 `: `（ASCII 冒号+空格）必须加引号——上面的文案是中文全角冒号，没有这个问题。
- **不要**写 `npm:` 字段：映射由 registry 自动采集，手写会被校验拒绝。
- 仓库满 1 天前提 PR 会被 CI 拦（`Repo age`）。

PR 标题与说明：

```
Add saichao/dsh-clickhouse — ClickHouse query tools for DSH

- 7 tools: list databases / list tables / describe table / sample rows / search columns / EXPLAIN / read-only SQL
- declares dsh.bundle in package.json with cordis.patch.yml at the repo root
- zero runtime dependencies (Node's built-in fetch only)
- read-only in two layers: client-side SQL guard (single statement, leading keyword allowlist, write-keyword rejection, no INTO OUTFILE / FORMAT / SETTINGS / external table functions) + server-side max_result_rows / max_execution_time / max_memory_usage
- verified against ClickHouse 21.12; 47 offline tests and 14 live tests pass

Tested with `dsh plugin --profile desktop add github:saichao/dsh-clickhouse` on DSH 0.2.1-rc.2 (Windows).
```

## 三、可选：发布到 npm

不发布也能收录（条目照常工作，只是没有下载量数字），发布后市场会按下载量排序。要发的话：

1. `npm login`（本机当前未登录；默认 registry 是 npmmirror 镜像，发布走 npmjs 需要对应账号）。
2. ⚠️ **`dsh-clickhouse` 这个名字在 npm 上已被 `dushaobindoudou` 占用**（0.0.1，2026-08-19，尚未收录进市场目录）。所以要改一个空闲名字，例如 `dsh-clickhouse-plugin` / `dsh-clickhouse-tools` / `dsh-plugin-clickhouse`（都已确认未被占用）；改名的同时要改 `package.json.name` 与 `cordis.patch.yml` 里的 `name:`。
3. `package.json` 的 `repository` 必须指回被收录的那个仓库，否则 npm 包不会与条目关联（`contributing.md` 的明确规则）。
4. 发布后**不需要**通知维护者，也**不要**往条目里加 `npm:`。

## 四、兜底：不发 GitHub 也能装

```powershell
pnpm build
npm pack          # 产出 dsh-clickhouse-0.1.0.tgz（63 KB，只含 lib/src/cordis.patch.yml/README/LICENSE）
```

把这个 tgz 拷到别的机器，用 `dsh plugin --profile <profile> add file:<路径>/dsh-clickhouse-0.1.0.tgz` 安装。
