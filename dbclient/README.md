# GoNavi · PostgreSQL（参考 GoNavi-0.5.0 复刻）

一个与 **GoNavi-0.5.0** 视觉/交互一致的轻量 PostgreSQL 客户端 Web 版：

- **PostgreSQL 按钮**：打开后**一键自动连接**本机 Postgres（无需填写任何账号密码 / 主机端口）。
- **左侧**：展示「已连接的 Postgres」+「已存查询」+ 数据库对象分类 —— **表 / 视图 / 函数 / 触发器**。
- **右侧**：**操作区**（SQL 编辑器，含语法高亮、运行 / 格式化 / 保存查询）+ **结果区**（结果网格、状态栏：命令 / 行数 / 耗时）。
- 深色 **Ant Design 5** 风格，与 GoNavi 保持一致；对象树图标（数据库 / 表 / 视图 / 函数 / 触发器）与 GoNavi 一一对应。

## 运行方式

```bash
# 1) 确保本机 Postgres 可用（默认连 127.0.0.1:5432）
#    本项目自带 PGlite 的 Electron 环境会在应用启动时监听 5432；
#    也可以用任意真实 Postgres，通过下面环境变量覆盖：
#    PGHOST / PGPORT / PGUSER / PGDATABASE / PORT(HTTP 端口)

# 2) 启动（零第三方依赖，仅用 Node 标准库）
node server.js
#   → 控制台打印： HTTP 服务已启动： http://127.0.0.1:8791

# 3) 浏览器打开
#    http://127.0.0.1:8791/          （点击 PostgreSQL 按钮自动连接）
#    http://127.0.0.1:8791/?auto=1   （进入即自动连接）
```

Windows 可直接双击 `start.cmd`。

## 目录结构

```
dbclient/
├── server.js          # Node 后端：最小 PG Wire 协议客户端 + HTTP API + 静态托管
├── public/
│   ├── index.html     # 启动页(数据源选择/PostgreSQL 按钮) + 工作台骨架
│   ├── styles.css     # 深色 Ant Design 5 风格
│   └── app.js         # 对象树 / 标签页 / 编辑器 / 结果网格 / 交互
├── start.cmd          # Windows 启动脚本
└── README.md
```

## 后端 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/api/status`  | 连接状态（host/port/user/database/serverVersion） |
| GET  | `/api/objects` | 对象树数据：tables(含列) / views / functions / triggers |
| GET  | `/api/saved`   | 已存查询列表 |
| POST | `/api/query`   | `{ "sql": "..." }` → `{ columns, rows, command, rowCount, durationMs, error? }` |
| GET  | `/api/table?name=` | 快速查看某表前 200 行 |

## 实现要点

- **零依赖直连真实 Postgres**：`server.js` 用 Node `net` 手写最小 Postgres Wire 协议（Startup + Simple Query），直接读取
  `RowDescription / DataRow / CommandComplete / ErrorResponse`，因此不需要 `pg` 等任何 npm 包，也不消耗 WASM 内存。
- **自动建演示 schema**：首次启动会 `CREATE TABLE IF NOT EXISTS` 建 `customers / products / orders / order_audit`，
  并创建视图 `v_order_summary`、函数 `fn_customer_total / log_order_change`、触发器 `trg_orders_audit`，
  保证左侧「表 / 视图 / 函数 / 触发器」四类对象都有真实内容。
- **对象树交互**：点击箭头展开列 / 折叠；点击表 / 视图 / 函数 / 触发器 / 已存查询的**名称**即打开对应标签页并自动执行。
- **状态栏**：显示 `命令 · 行数 · 耗时(ms)`，与 GoNavi 一致；错误在结果区以红框展示（如 `relation "x" does not exist`）。
