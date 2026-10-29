# dsh-clickhouse

ClickHouse query tools for **DSH / DeepSeek Harness**: seven `clickhouse_*` tools that let an agent explore databases, tables and columns, then answer data questions with single, read-only SQL statements. Zero runtime dependencies (Node's built-in `fetch` only), so nothing has to resolve inside your profile.

- **Read-only by construction** — a client-side guard allows one statement whose leading keyword is `SELECT` / `WITH` / `SHOW` / `DESCRIBE` / `EXPLAIN` / `EXISTS`, rejects write keywords anywhere in the statement, and refuses `INTO OUTFILE`, `FORMAT`, `SETTINGS` and external table functions; every query also carries server-side `max_result_rows` (with `result_overflow_mode=break`), `max_execution_time` and `max_memory_usage`.
- **Built for data Q&A** — the tools are ordered the way a person actually works: list databases → list tables → describe a table → sample rows → run the query, plus a column-name search for when you don't know which table holds a concept.
- **Old-server friendly** — verified against ClickHouse 21.12, including the `system.tables` columns that changed after it, and it tells the model to backtick non-ASCII aliases instead of failing with a bare syntax error.

```sh
dsh plugin --profile <profile> add github:<owner>/dsh-clickhouse
```

配置、工具清单、只读护栏的范围、以及本机验证记录见下文。

## 三步上手（新用户）

1. **装**：DSH 里 **设置 → 插件**（插件市场）搜 `clickhouse` → 选 `dsh-clickhouse` → 安装。
   命令行等价写法：`dsh plugin --profile <profile> add github:saichao/dsh-clickhouse`
2. **启用 + 重启**：装完在市场里点「启用」，然后重启 DSH。
3. **配连接**：把下面这段写进 profile 的用户补丁层，再重启一次（写法详见「配置」一节）：

```yaml
- id: clickhouse
  name: dsh-clickhouse
  config: { url: http://<主机>:8123, user: default, password: '' }
```

漏了第 3 步会得到很明确的报错，而不是一句 `fetch failed`：

```
无法连接 ClickHouse（http://localhost:8123）：连接被拒绝。请确认服务已启动、端口是 HTTP 接口（默认 8123）而不是原生 TCP 端口（9000）。
还没配置 ClickHouse 连接。请在 profile 的用户补丁层写连接信息：
  ~/.dsh/profiles/<profile>/cordis.patch.yml
  - id: clickhouse
    name: dsh-clickhouse
    config: { url: http://<主机>:8123, user: default, password: '' }
```

## 它是什么

给 **DSH / DeepSeek Harness** 用的 ClickHouse 数据问答插件：把「库表结构探查 + 带护栏的只读 SQL 执行」变成 agent 可以直接调用的工具，用来做自然语言问数。

- **零运行时依赖**：只用 Node 内置的 `fetch`，装进 profile 后不需要任何 `node_modules`。
- **只读**：客户端 SQL 护栏 + 可选的服务端 `readonly=1`，双层拦住写操作。
- **为数据问答设计**：7 个工具按「先摸清结构、再问数」的顺序编排，并支持按字段名反查表。

## 安装（写进 profile）

包本身是一个 **bundle**：自带 `cordis.patch.yml`，内容是一行 `insert: [{ id: clickhouse, name: dsh-clickhouse, config: … }]`。

一条命令（幂等，可反复跑）：

```powershell
pnpm install
pnpm build
node scripts/install.mjs
```

`install.mjs` 做四件事：

1. 把 `package.json` / `README.md` / `lib` 复制到 `<profile>/node_modules/dsh-clickhouse` 与 `~/.dsh/node_modules/dsh-clickhouse`（后者是 profile 的 `node_modules` 被 pnpm 清理时的兜底解析路径）；
2. 把部署配置写进两份拷贝的 `cordis.patch.yml`（源仓库那份保持通用、不带 config）；
3. 确保 `dsh-clickhouse` 在 profile `package.json` 的 `dsh.profile.bundles` 里（**改动前备份到 `backups/`**，临时文件 + rename 原子写）；
4. 跑 `scripts/verify.mjs` 预检。

然后重启 DSH。补丁文件是外部改的，宿主不会热加载它（实测桌面端改完不重启，插件仍按旧配置工作），配置改动一律重启后确认。

**回滚**：`node scripts/uninstall.mjs`（从 `dsh.profile.bundles` 摘掉 + 删两份拷贝；删目录前会核对 `package.json.name`，`--dry-run` 只看不做）。

### 手工安装（不想跑脚本时）

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force -Path "$profile\node_modules\dsh-clickhouse" | Out-Null
Copy-Item package.json, cordis.patch.yml, README.md, lib -Recurse -Force "$profile\node_modules\dsh-clickhouse"
```

再把 `"dsh-clickhouse"` 追加到 `$profile\package.json` 的 `dsh.profile.bundles`（**先备份这个文件**）。

## 配置

连接信息属于部署方，推荐写在 **profile 的用户补丁层**（`~/.dsh/profiles/<name>/cordis.patch.yml`），按 id 覆盖 bundle 里那一行：

```yaml
- id: clickhouse
  name: dsh-clickhouse
  config:
    url: http://localhost:8123
    user: default
    password: ''
    database: default
    readonly: true
```

两处配置的关系：`install.mjs` 会把同样一份写进**已安装拷贝**的 `cordis.patch.yml`（裸装即可用）；用户补丁层在组装顺序里靠后，按 id **整份替换**该行的 `config`（Loader 的语义就是 `target[key] = value`）。写进用户补丁层还有个好处：**DSH 的 HMR 会立即重组整棵树，不用重启**——实测写完覆盖行后，对话里的工具立刻连到新地址。

> 改这个文件前务必备份：它同时存放着模型/密钥等配置，写坏会让 DSH 启动失败并触发桌面端的恢复流程（把该文件改名藏起来）。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `url` | `http://localhost:8123` | ClickHouse **HTTP** 接口地址。也接受 JDBC 写法：`jdbc:clickhouse://host:8123/db?x=y`（自动转成 `http://host:8123`，路径段当作默认库）。 |
| `user` / `password` | `default` / 空 | 也兼容 `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` 这类环境变量命名，方便从 MCP 配置直接搬。 |
| `database` | `default` | 未指定库时的默认库。 |
| `readonly` | `true` | 为 true 时给每个查询加服务端 `readonly=1`。老版本（如 21.12）上 `numbers()` 等表函数在只读模式下会被拒；确需时设为 `false`（客户端护栏仍然生效）。 |
| `maxRows` | `200` | 单次返回给模型的最大行数（硬上限 10000）。 |
| `timeoutSeconds` | `60` | 服务端 `max_execution_time`（硬上限 600）。 |
| `maxMemoryGb` | `4` | 服务端 `max_memory_usage`。 |
| `maxCellChars` | `400` | 单个单元格保留的最大字符数。 |
| `allowQuerySettings` | `false` | 是否允许 SQL 自带 `SETTINGS ...`。 |
| `allowExternalSources` | `false` | 是否允许 `file()`/`url()`/`s3()` 等外部数据源表函数。 |
| `allowCrossTable` | `false` | 是否允许 JOIN / UNION / 一次引用多张表。默认 `false`：本插件按**单表查询**使用——用户给什么参数就用什么参数，跨表的业务判断不写进插件。 |
| `allowDatabases` | `[]` | 只允许访问这些库（空 = 不限制）。 |
| `denyDatabases` | `[]` | 禁止访问的库（优先级高于白名单）。 |
| `sampleRows` | `20` | `clickhouse_sample_rows` 的默认抽样行数。 |
| `guidance` | `true` | 是否往系统提示里注入一段本插件的使用说明。 |

## 工具

| 工具 | 用途 |
| --- | --- |
| `clickhouse_query` | 执行单条只读 SQL（`SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN`/`EXISTS`），返回 Markdown 表格或 JSON。 |
| `clickhouse_list_databases` | 列出库 + 每库表数/字段数（可选磁盘占用）。 |
| `clickhouse_list_tables` | 列出某库的表：引擎、排序键、行数、占用、注释，按占用倒序。 |
| `clickhouse_describe_table` | 表的字段、类型、默认值、主键/排序键成员、注释。 |
| `clickhouse_sample_rows` | 抽样看真实数据，可只取指定字段。 |
| `clickhouse_explain` | `EXPLAIN` 执行计划（plan / estimate / syntax / ast / pipeline）。 |
| `clickhouse_search_columns` | 按**字段名**关键词反查「这个字段在哪张表」，不确定数据在哪时用。 |

模型看到的每个工具返回值都是结构化的（`summary` / `columns` / `rows` / `rowCount` / `truncated` / `elapsedMs` / `queryId` / `executedSql` / `notes`），并由工具自己渲染成 Markdown 表格。

## 实际效果

模型在对话里看到的就是这样的内容（`docs/demo-output.txt` 是完整演示输出）：

```
### clickhouse_query
SELECT database AS `库`, count() AS `表数` FROM system.tables
WHERE database LIKE 'system%' GROUP BY database ORDER BY `表数` DESC LIMIT 5

查询完成：1 行 / 2 ms

- rows: 1 | limit: 200 | elapsed: 2 ms
- query_id: dsh-clickhouse-query-mvqd5pyu-8-qcc351
- statistics: rows_read=75, bytes_read=1125, server_elapsed=0.001761516s

| 库 | 表数 |
| --- | --- |
| system | 75 |
```

（演示刻意只用任何实例都有的 `system` 库，方便你在自己机器上复现；`docs/demo-output.txt` 是完整输出。）

护栏不引入额外开销：SQL 直接下推给 ClickHouse，千万行级的 group by 是百毫秒级。中文别名能正常用（**必须加反引号**——老版本 ClickHouse 不接受未加引号的非 ASCII 标识符，插件在这种情况下会直接给出改法提示）。

> 踩过的坑（已在 `test/sql-guard.test.ts` 里加了回归测试）：SQL 护栏早先用「把引号内容抹成空格」的掩码去找最后一个代码字符，导致 `SELECT 1 AS \`行数\`` 这类**以引号结尾**的语句被截断成 `SELECT 1 AS`。现在改成只抹注释、保留引号内容。

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `node scripts/install.mjs` | 构建产物安装/更新到 profile（幂等；保留已安装的 config；自动维护 `dsh.profile.bundles` 并备份；最后自动跑 `verify.mjs`）。`--config deploy.json` 可指定连接配置，`--no-home` 跳过兜底拷贝。 |
| `node scripts/uninstall.mjs` | 从 `dsh.profile.bundles` 摘掉它并删除拷贝（删目录前会核对 `package.json.name`）。`--dry-run` 只看不做。 |
| `node scripts/verify.mjs` | **重启前预检**：bundle 栈能否解析、插件包是否就位、loader 行是否声明、`apply()` 能否注册出 7 个工具。 |
| `node scripts/verify-deep.mjs` | 直接调用**市场自己的组装分析**（`dshmarket` 的 `analyzeProfile`），看层栈/重复 entry id/失效引用。 |
| `node scripts/demo.mjs` | 用已安装的那份配置真跑几个工具，打印模型可见的渲染结果。 |
| `scripts/inspect-composition.cjs` | 用 **loader 自己的代码**打印组装后的行（含每个插件的最终 `config`），等于「重启后插件实际拿到什么」的离线证据。需 Electron 的 `ELECTRON_RUN_AS_NODE` 模式跑。 |

连接信息写在**已安装拷贝**的 `cordis.patch.yml` 里（`install.mjs` 会保留），源仓库那份不带 config；正式的部署配置建议写进 profile 的用户补丁层。

## 验证（这台机器上的实测）

| 验证项 | 做法 | 结果 |
| --- | --- | --- |
| 离线测试 | `pnpm test` | 47/47 通过 |
| 真机联调 | `pnpm test:live`（连一个 ClickHouse 21.12 实例） | 14/14 通过 |
| 组装预检 | `node scripts/verify.mjs` | 通过（bundle 栈可解析、行已声明、7 个工具能注册） |
| 市场侧的组装分析 | `node scripts/verify-deep.mjs`、`GET /dsh-market/check` | `duplicates` / `orderConflicts` / `residuals` 全空，解析错误 0 |
| **config 是否真进了组装** | `scripts/inspect-composition.cjs`（调 loader 自己的 `loadProfile` + `composeEntries`） | 组装出的行里 `config.url` 就是部署时写进去的那个地址 |
| **活实例可用性** | 在对话里直接调 `clickhouse_*` 工具 | 能列库列表、能对千万行级大表 group by、中文别名提示到位 |
| 热生效（不重启） | 往用户补丁层写覆盖行 → DSH 的 HMR 重组 | 工具立刻连到新地址 |

`inspect-composition.cjs` 需要 asar 感知的 node（Loader 在 `app.asar` 内），所以用 Electron 的 node 模式跑：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" scripts\inspect-composition.cjs --row clickhouse
```

> 一个值得记住的坑：desktop host 是**长驻进程**，插件是热加载进去的。如果它在补丁文件写入 config **之前**就已经加载过这个插件，内存里的行会一直是旧配置（表现：工具去连 `localhost:8123`），而磁盘上的组装结果其实已经是对的。往用户补丁层写覆盖会触发 HMR 重组并立即生效，否则重启一次也会好。

## 只读护栏

`clickhouse_query` 与 `clickhouse_explain` 的 SQL 会先过一遍客户端护栏：

1. 只允许**单条**语句；
2. 首关键字必须是 `SELECT` / `WITH` / `SHOW` / `DESCRIBE` / `DESC` / `EXPLAIN` / `EXISTS`；
3. 任何位置出现 `INSERT`/`UPDATE`/`DELETE`/`ALTER`/`CREATE`/`DROP`/`TRUNCATE`/`RENAME`/`ATTACH`/`DETACH`/`OPTIMIZE`/`GRANT`/`REVOKE`/`KILL` 等写关键字即拒绝（同名标识符可用反引号包起来）；
4. 拒绝 `INTO OUTFILE` / `INTO DUMPFILE`；
5. 拒绝 SQL 自带的 `FORMAT ...`（结果格式由插件控制）与 `SETTINGS ...`（除非 `allowQuerySettings`）；
6. 默认拒绝 `file()`/`url()`/`remote()`/`s3()`/`jdbc()`/`mysql()` 等外部数据源表函数（除非 `allowExternalSources`）；
7. 默认**只允许单表查询**：出现 `JOIN`、或引用了第二张不同的表（含跨表子查询、跨表 `UNION`）即拒绝（除非 `allowCrossTable`）。

第 7 条是按「SQL 引用了哪些表」判定的，**不是按 WHERE 条件个数**：

```sql
-- ✅ 放行：一张表，多个字段、多个条件
SELECT patent_no, title FROM open_api_patent.dim_patent_main
WHERE title LIKE '%地址%' AND holder_first LIKE '%畅远%'
   OR abstr LIKE '%地址%';

-- ✅ 放行：同一张表的子查询、ARRAY JOIN、`t1, t2` 同表两次
SELECT patent_no FROM t WHERE patent_no IN (SELECT patent_no FROM t WHERE title LIKE '%x%');

-- ⛔ 拒绝：JOIN / 第二条不同的表 / 跨表子查询
SELECT p.title FROM open_api_patent.dim_patent_main AS p
JOIN open_api_enterprise.db_enterprise_t_enterprise AS e ON p.patent_no = e.credit_no;
```

设计取舍：单表限制让「查什么表」完全由用户给的参数决定，插件不预设任何业务流程（比如「企业名先换信用代码再查别的表」）。代价是名称类字段没有索引，`LIKE '%参数%'` 会是全表扫——这是**透明 > 聪明**的有意选择；确实需要跨表时把 `allowCrossTable` 设为 `true`。

另外每个查询都会带上服务端上限：`max_result_rows`（配合 `result_overflow_mode=break` 直接截断）、`max_execution_time`、`max_memory_usage`。

> 护栏是「防手滑」，不是权限边界。真正的权限请用 ClickHouse 账号本身控制（建一个只有 `SELECT` 权限的账号给这个插件用）。

## 开发

```powershell
pnpm install
pnpm typecheck        # 类型检查
pnpm test             # 离线测试（52 项：护栏、格式化、插件契约、参数校验）
pnpm test:live        # 真机联调（14 项，默认连 http://localhost:8123 的 system.tables）
pnpm test:all
```

真机测试用环境变量覆盖连接信息：`CLICKHOUSE_TEST_URL` / `CLICKHOUSE_TEST_USER` / `CLICKHOUSE_TEST_PASSWORD` / `CLICKHOUSE_TEST_DATABASE` / `CLICKHOUSE_TEST_TABLE`。

## 为什么不依赖 `@deepseek-ai/dsh-tools`

`dsh-tools` 的 peer 依赖图里有未发布到 npm 的内部包（`@deepseek-ai/dsh-type-meta`），从 registry 装不上；而 profile 插件运行时也不需要它——工具定义是纯数据结构。所以本插件按其官方文档支持的**原始注册**方式注册工具，自己负责参数校验与输出声明，代价是几十行校验代码，收益是插件在 profile 里零依赖、加载路径上没有依赖解析风险。参数与输出都用标准 JSON Schema（`output.schema` 会被注册表强制执行）。

## 不支持 / 边界

- 护栏是「防手滑」，不是权限边界（见文末）。
- 单次最多 200 行（可配，硬上限 10000）；要更多请自己聚合，别拉明细。
- 结果以 `JSONCompact` 取回后在内存里渲染，超大结果不适合。

## License

MIT © 2026 赛超，见 [LICENSE](./LICENSE)。
