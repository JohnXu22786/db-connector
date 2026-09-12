# dsh-db-connector

[![npm version](https://img.shields.io/npm/v/dsh-db-connector)](https://www.npmjs.com/package/dsh-db-connector)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[English](./README.md)

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
（`dsh`，基于 Cordis 的「一切皆是插件」框架）的数据库连接器 bundle。

它通过五个面向模型的工具，加上一个人类可用的 `/db` 命令，为你的 agent 提供对
**SQLite**、**PostgreSQL**、**MySQL** 的安全且可审计的访问，并刻意聚焦于
**只读安全、schema 智能、写操作审批门、持久化 SQL 审计**——这正是官方 dsh 工具目录尚未覆盖的领域。

> 本 bundle 为全新独立实现，未照搬任何现有开源 dsh 工具代码；工具名、参数结构与结果格式均属本 bundle 自身设计，与任何官方 dsh schema 无关。

---

## 功能总览

| 关注点 | 说明 |
| --- | --- |
| **连接管理** | 命名连接（SQLite / PostgreSQL / MySQL）；惰性打开、复用、显式关闭，每个连接一行脱敏状态。 |
| **凭据处理** | 密钥来自 **环境变量**（`${VAR}` 占位、`passwordEnv`）或 **dsh 凭据服务**（`passwordRef`）。绝不写入日志或审计。 |
| **Schema 内省** | 表 / 视图 / 列（名称/类型/可空/默认值/主键）/ 索引 / 外键；按连接缓存快照（TTL），支持刷新与过滤。 |
| **只读查询** | `db_query` **只**执行 SELECT / EXPLAIN 类语句，其余在接触数据库之前即被拒绝；带结果行数上限、SELECT 前置 LIMIT、JSON 化结果。 |
| **写操作审批门** | INSERT / UPDATE / DELETE / DDL 必须显式传入 `allowWrite: true` 确认；写入在事务中执行：成功 COMMIT，失败 ROLLBACK。 |
| **SQL 审计** | 每次调用（含被拒与失败）追加一条 JSONL 记录：时间、连接、语句摘要+摘要哈希、类型、行数、耗时、状态、错误、来源（tool/command/cli）。 |
| **注入防护** | 值一律以参数绑定（`?` 或 `:name`）下发，从不拼接进 SQL 文本。 |
| **超时** | 基于 AbortSignal 的语句级截止时间，对同步 SQLite 也能真实终止（子进程隔离）。 |

---

## 最低要求

- Node.js **≥ 22.13**（使用内置、无需 flag 的 `node:sqlite`）。
- 一个运行中的 `dsh` profile，工具才会出现在 `ctx.tools` 上。
- **可选** 服务器驱动（peer 依赖，仅在需要相应引擎时装）：
  - PostgreSQL：`npm i pg`
  - MySQL：`npm i mysql2`

SQLite 无需任何额外安装。开发（`npm test`）建议使用 Node ≥ 23.6，可原生运行类型剥离的测试文件。

---

## 如何接入 dsh（bundle 规范）

本包是一个 **bundle**：`package.json` 声明了 `dsh.bundle.patch → ./cordis.patch.yml`，补丁按包含包名的方式插入一行插件，由 Node 解析安装后的代码。入口模块导出标准 `name` / `inject` / `apply(ctx, config)`。

将 bundle 安装进某个 profile：

```bash
dsh plugin --profile <name> add /path/to/dsh-db-connector
```

该包也已发布到 npm，可单独使用引擎 / 编程式 API：

```bash
npm install -g dsh-db-connector   # 全局安装，CLI 方式使用引擎
npm install dsh-db-connector      # 或作为本地依赖加入
```

（等价地：把 `"dsh-db-connector": "link:/path/to/dsh-db-connector"` 加入 profile 的 `dependencies`，并把 `"dsh-db-connector"` 追加到 `dsh.profile.bundles`。）

启动时 `apply(ctx, config)` 依次：

1. 读取插件配置（`apply` 的第二个参数，支持 `$DSH_HOME` 与 `DSH_DB_CONNECTOR_*` 环境变量兜底）；
2. 预注册配置中的 `connections`（首次使用时惰性打开）；
3. 在 `ctx.tools` 上注册五个工具；
4. 若该服务存在，在 `ctx.commands` 上注册 `/db` 命令；
5. 上下文销毁时关闭全部连接并刷新审计日志。

所有注册均为 effect 式，卸载该行即自动撤销。

---

## 插件配置

配置写在插件行的 `config:` 块中（或后续补丁层按 `id: db-connector` 覆盖）。

```yaml
- insert:
    - id: db-connector
      name: 'dsh-db-connector'
      inject: [tools, commands]
      config:
        # 启动时预注册的连接；各自惰性打开。
        connections:
          appdata:
            driver: sqlite
            database: ./data/app.db
          warehouse:
            driver: postgres
            host: db.internal
            database: warehouse
            user: readonly
            passwordEnv: WAREHOUSE_PG_PASSWORD   # 环境变量名，而非值
            # ...或 passwordRef: WAREHOUSE_PG_PASSWORD（dsh 凭据服务）

        audit:
          enabled: true
          path: .dsh-db/audit.jsonl
          # path 默认即此值；支持 ${ENV}

        query:
          maxRows: 1000
          timeoutMs: 30000
          maxSqlChars: 512

        schema:
          ttlMs: 60000

        defaultAllowWrite: false
```

环境变量覆盖：`DSH_DB_CONNECTOR_AUDIT_PATH`、`DSH_DB_CONNECTOR_MAX_ROWS`、
`DSH_DB_CONNECTOR_TIMEOUT_MS`。字符串值中的 `${VAR}` 占位会在连接时从环境展开。

### 凭据——绝不进日志

安全姿势：**密钥按名引用，绝不内嵌。**

- `passwordEnv: PG_PASSWORD` 表示从同名环境变量读取值。
- `passwordRef: MY_REF` 通过 dsh 凭据服务（`ctx.credentials`）解析，回退为普通环境变量。
- 任意字段可使用 `${VAR}` 占位。
- 内联 `password` 虽可用，但强烈不建议。

本 bundle 从不记录连接配置、密码或连接串：连接摘要只含名称 / 驱动 /
host:port / 库名与 `auth=env|credentials|inline|none`；错误信息只报环境变量
**名字**；审计记录只有语句摘要/哈希与计数，不含任何连接配置。

---

## 工具

五个工具均返回规范 JSON，并以格式化文本呈现给模型。

### `db_connect`

注册、打开、列出或关闭一个命名连接。

```json
{ "action": "connect", "name": "app",
  "config": { "driver": "sqlite", "database": "./data/app.db" } }

{ "action": "connect", "name": "wh",
  "config": { "driver": "postgres", "host": "db.local", "database": "wh",
              "user": "readonly", "passwordEnv": "WH_PASSWORD" } }

{ "action": "list" }
{ "action": "close", "name": "app" }
```

对已定义（来自配置或先前连接）的名称再次 connect 会重新打开而非报错；全新名称连接失败会大声报错。`list` 返回脱敏状态。

### `db_schema`

内省某连接：表 / 视图、列、索引、外键。按连接缓存 `schema.ttlMs` 毫秒；
`refresh: true` 绕过缓存，`filter` 只保留名称包含该子串的表/视图。

```json
{ "name": "app", "refresh": false, "filter": "user" }
```

### `db_query`

运行**只读**查询（SELECT / EXPLAIN / DESCRIBE / SHOW）。

- **强制只读**：任何写/DDL 语句都会以 `READ_ONLY_VIOLATION` 拒绝，并在接触驱动前记录为 `denied` 审计。涵盖 INSERT/UPDATE/DELETE/DDL/PRAGMA，以及隐蔽形式：`EXPLAIN ANALYZE <dml>`（会真实执行其语句）与数据修改型 CTE（`WITH x AS (DELETE ...) SELECT ...`）。
- **结果上限**：行数以 `limit`（或 `query.maxRows`）封顶；对无自身 LIMIT 的顶层 SELECT 会追加 guard `LIMIT`。
- **超时**：`timeoutMs`（或默认值）通过 AbortSignal 执行；SQLite 通过子进程拆解实现真实终止。

```json
{ "name": "app", "sql": "SELECT id, email FROM users WHERE age >= ? AND age < ?",
  "params": [26, 40], "limit": 100 }
```

值支持位置参数（`params` 数组对应 `?`）或命名参数（`namedParams` 对象对应 `:name`），一律参数绑定。占位符数量与值数量不匹配会给出友好的 `INVALID_PARAMS`。

### `db_exec`

执行**可能写入**的语句（INSERT / UPDATE / DELETE / DDL，以及分类器无法判读的内容）。

- **写审批门默认开启**：非纯读语句必须传 `"allowWrite": true`（即显式确认），否则以 `WRITE_NOT_ALLOWED` 拒绝并审计。
- 语句在事务内执行：成功 **COMMIT**，失败 **ROLLBACK**（错误不会留下部分行）。结果含受影响行数与回滚说明。
- DDL 会自动使该连接的 schema 缓存失效。

```json
{ "name": "app", "sql": "UPDATE users SET age = age + 1 WHERE id = ?",
  "params": [1], "allowWrite": true }
```

### `db_audit`

回读审计（元数据 + 语句摘要/哈希；不含凭据）。过滤：`name`（连接）、`kind`、`since`（ISO）、`limit`（最新的在前，默认 200）。

```json
{ "kind": "denied", "limit": 50 }
```

---

## 人类命令（/db）

当命令服务存在（dsh-base 会挂载）时，本 bundle 注册一个 `/db` 斜杠命令，与工具共用同一引擎与安全门。

```
/db status
/db connect <name> --driver sqlite --db ./data/app.db
/db connect pg --driver postgres --host h --database d --user u --password-env PG_PASSWORD
/db close <name>
/db schema <name> [--refresh] [--filter sub]
/db query <name> --sql "SELECT ..." [--limit n] [--timeout ms] [--params a,b,c]
/db exec <name> --sql "UPDATE ..." --allow-write [--params a,b,c] [--timeout ms]
/db audit [name] [--kind k] [--limit n] [--since ISO]
/db help
```

---

## SQL 审计

每条记录为一行 JSON：

```json
{"id":"m2x3st-abc123-1","ts":"2026-08-20T00:00:00.000Z","connection":"app",
 "kind":"write","way":"tool",
 "statement":{"summary":"UPDATE users SET age = age + 1 WHERE id = ?",
              "digest":"<sha256>","chars":47},
 "rows":1,"durationMs":14,"status":"ok"}
```

`kind` 取 `query | write | ddl | read | schema | denied`；`status` 取
`ok | error | denied`。被拒与失败也会记录。文件为追加式 JSONL，位于
`audit.path`（默认工作目录下 `.dsh-db/audit.jsonl`；支持
`DSH_DB_CONNECTOR_AUDIT_PATH` 与 `${VAR}`）。

---

## 驱动说明

- **SQLite** — 内置 `node:sqlite`，零安装。每个连接持有独立子进程，因此超时可**硬终止**一条失控的同步语句（卡在原生 SQLite 代码里的 worker 线程无法 join，会把宿主挂死）。文件型库在超时拆解后可重生恢复；`:memory:` 连接意在测试、尽力而为。
- **PostgreSQL** — `npm i pg`（可选 peer）。读走 `BEGIN TRANSACTION READ ONLY … ROLLBACK`，写走 `BEGIN/COMMIT/ROLLBACK`，全部以 `$1..$n` 参数化；AbortSignal 取消通过 pg 的查询取消 API 处理。
- **MySQL** — `npm i mysql2`（可选 peer）。读走 `READ ONLY` 事务；写走 `beginTransaction/commit/rollback`，使用服务端预处理语句；取消时销毁连接并在下次使用时重连。

---

## 开发

```bash
npm install            # 开发依赖（typescript、@types/node）；服务器驱动可选：npm i pg / mysql2
npm run build          # tsc -> dist/
npm test               # build + 全套测试（node --test）——80+ 项
npm run check          # build + src 与 test 的类型检查
```

测试覆盖：语句分类 / 只读拒绝、写审批门、事务回滚、参数注入防护、结果上限与 SELECT guard-LIMIT、超时、审计、连接生命周期、工具、`/db` 命令以及插件入口。

---

## 局限与说明

- 每次调用仅一条语句；多语句输入会被拒绝。
- SQL 扫描遵循 ANSI 字符串转义（`''`），支持双引号标识符、反引号标识符、PostgreSQL 美元引用字符串、`--` / `/* */` 注释与 `::` / `:=`。MySQL 单引号字符串内的反斜杠转义仅近似识别；由于分类只用于**拒绝**写入而不会放行写入，故不会扩大写面。
- 当查询恰有 `limit` 行且 guard `LIMIT` 生效时，`truncated: true` 也可能为真（已在文档中说明的歧义）。
- PostgreSQL/MySQL 的内省与执行已实现但仅能对真实服务器验证；SQLite 路径已被测试完整覆盖。

## 许可证

MIT——见 [LICENSE](./LICENSE)。遇到问题或希望新增驱动？欢迎在
[github.com/JohnXu22786/db-connector](https://github.com/JohnXu22786/db-connector/issues) 提交 issue。
