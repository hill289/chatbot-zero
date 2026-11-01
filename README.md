<div align="center">

# 🤖 chatbot-zero

**零后端 · 纯前端 · 可自托管的 AI 智能体工作台**

一个页面装下「LLM 对话 · 工具调用 · 浏览器内 Node.js 沙箱 · 虚拟文件系统 · 并行子代理 · Office/文档处理」，
外加一个 Electron 多标签浏览器外壳，打通 **浏览器 ↔ 本机真实磁盘**。

[![Electron](https://img.shields.io/badge/Electron-31-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6)](#-快速开始)
[![Runtime](https://img.shields.io/badge/Runtime-almostnode%20(Node.js%20in%20browser)-339933?logo=nodedotjs&logoColor=white)](#-架构与工作原理)
[![MCP](https://img.shields.io/badge/Protocol-MCP-8A2BE2)](#-内置工具mcp-tools)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue)](#-license)

</div>

> **简体中文** | [English](./README.en.md)
>
> ⚠️ **文档口径说明**：本 README 依据仓库**当前实际代码**梳理。工作台入口为 `renderer/index.html`（**已模块化**：HTML 外壳约 **1.5k 行（1,548 行）**，应用 CSS/JS 拆到 `renderer/assets/`，仍为零构建、经典 `<script>` 按序加载）；其内置代码编辑器当前使用 **almostnode（浏览器内 Node.js）** 运行时，界面标识为 **🟩 Node.js**（历史上的 "PGPy / Pyodide / Python" 说明已不适用）。

---

## 📖 目录

- [✨ 项目简介](#-项目简介)
- [🚀 核心特性](#-核心特性)
- [⚡ 快速开始](#-快速开始)
- [⚙️ 配置说明](#️-配置说明)
- [🧰 内置工具（MCP Tools）](#-内置工具mcp-tools)
- [🔌 可插拔工具注册（Pluggable Tool Registry）](#-可插拔工具注册pluggable-tool-registry)
- [⌨️ 快捷键](#️-快捷键)
- [🏗 架构与工作原理](#-架构与工作原理)
- [📁 项目结构](#-项目结构)
- [🔒 隐私与安全](#-隐私与安全)
- [🧩 兼容性](#-兼容性)
- [🛣 Roadmap](#-roadmap)
- [🤝 贡献](#-贡献)
- [🙏 参考与致谢](#-参考与致谢acknowledgements)
- [📄 License](#-license)

---

## ✨ 项目简介

**chatbot-zero** 是一个 **无后端** 的 AI 智能体工作台：

- **模型对话**由浏览器直接请求任意 **OpenAI 兼容接口**（自填 URL / Path / Model / 鉴权），API Key 只存本地；
- **工具执行全部在浏览器内完成**——代码在 **almostnode（浏览器内 Node.js）** 中运行，文件写入 **虚拟文件系统（IndexedDB 持久化）**，检索使用 **ripgrep-wasm**，文档转换使用 **WASM**；
- 可选搭配随仓库自带的 **Electron 外壳**，把工作台当作一个 **多标签浏览器** 来用，并额外获得「拖入文件 → 拿到真实磁盘路径 → AI 编辑 → 写回原文件」的能力。

> **一句话价值**：用最低的部署门槛与数据风险，把"能真正干活的 AI Agent"装进一个可离线、可自托管的页面里，并让 Token 成本可量化地降下来。
>
> 🤖 **全 AI Agent 生成**：本项目的代码、文档与测试均由 AI Agent 生成；AI 产出可能有误，采用前请自行审阅、测试与安全评估。

---

## 🚀 核心特性

### 💬 AI 对话
- 对接任意 **OpenAI 兼容接口**（`URL` + `Path` + `Model`，可自定义 HTTP 方法 / Content-Type / 鉴权前缀）
- **SSE 流式输出**，多字节 UTF-8 安全解码（中文不乱码）
- 分别渲染模型**思考过程**（`reasoning_content`）与**回复正文**（`content`）
- **函数调用（Function Calling）多轮循环**，工具执行进度逐个刷新
- Markdown 渲染 + 代码高亮 + 一键复制；消息支持 **复制 / 编辑 / 重生成 / 继续 / 截断 / 删除 / 原文⇄Markdown 切换**
- 智能「粘底」滚动：向上阅读历史时不会被自动滚回底部
- 对话运行计时器（`running x s` 蓝色 / `end x s` 绿色表示正常结束）与单轮 Token 用量 / 费用明细
- **多模态输入**：粘贴 / 拖拽 / 选择图片附件

### ⚡ 前缀缓存成本工程
- `system` 提示词与 `tools` 工具列表**逐轮字节稳定** → 持续命中服务商前缀缓存
- 用 **FNV-1a 指纹** 覆盖完整 `{system, tools}` 规格监测前缀漂移（连 `description / parameters` 变化也能侦测），变更走 `invalidateSystem / invalidateTools` 显式失效
- 主会话（`main`）与子代理（`sub`）各走**独立缓存线**，互不污染
- 实时统计：命中 / 未命中 token、命中率、**折算节省金额**（跨会话累计、`localStorage` 持久化）
- 发送前 `stripForSend` 规整消息形状，剔除内部字段，保证请求字节稳定

### 🧠 上下文管理
- 继续对话 / 重新生成 / 清空历史 / 截断
- **硬切窗口（Hard-Cut Window，默认路径）**：**上下文 ≠ 记忆**。接近窗口上限时不再压缩，而是「工作笔记 + 历史指针 + 可查询转录历史」——先把重要信息写进 `note_write` 笔记，再把旧对话归档为磁盘上的转录历史（`messages/<sid>/events.jsonl`），然后直接清空上下文、开一个干净新窗口，只带「工作状态 + 笔记 + 指针」。之后用 `search_transcript` / `read_transcript` 按需回查。详见 [HARD-CUT-WINDOW.md](./renderer/HARD-CUT-WINDOW.md)
- **前缀缓存友好的上下文压缩（Compact）**：作为显式入口保留：把较早对话折叠为摘要，同时保留 `system + tools` 前缀以维持缓存命中
- **Query History**：本地持久化、单条 / 全部下载、JSON 导入回放
- **读取窗口（token 预算，不按行）**：`read_file` 按 **约 6000 tokens + 行数** 双限裁剪，未读完时末尾给出 `[继续] start_line=<n>`（顺着读即可，不必重头再来）；超长单行只给头尾摘要并指向 `read_file_char_range`；`min.js` 这类压缩文件不返回正文，只给结构摘要 + 替代工具。解码结果带 LRU 缓存（按 路径+大小+mtime 失效），重复切片不再重解整份文件

### 🟩 浏览器内 Node.js 编辑器（almostnode）
- CodeMirror 5 编辑 + **almostnode（WebAssembly 化的 Node.js）** 本地执行
- **虚拟文件系统 `/home/pyodide`**：由 almostnode VirtualFS 原生持久化到 **IndexedDB**，刷新页面文件仍在
- 查询结果表格化：列排序、NULL / 数字样式
- **导入 / 导出**：文件 / 文件夹（保留目录结构）/ ZIP；拖放上传（File System Access API 优先，`webkitdirectory` 兜底）
- 双击文件行载入编辑器、保存回写；脚本历史（`localStorage`）
- **AI Mode**：一键把当前代码发给 AI 对话区
- **🔁 同步**：把 AI 改动**批量写回磁盘真实路径**（改动先进暂存队列，点击「同步」统一落地）
- **⇄ 文件比较（Web 版 Beyond Compare）**：AI 改动文件后，可一键对比「**修改前 ⇄ 修改后**」——并排 / 统一两种视图、行级 + **词级**差异高亮、上一个 / 下一个差异、仅显示差异、忽略空白、复制修改前 / 后文本；改动基线随待同步队列持久化（IndexedDB），「同步」落地后自动清除。列表中有改动的文件行会显示「⇄ 对比」入口；勾选两个文件可直接互相比对。弹窗内还有「**待同步文件**」勾选清单（含**全选 / 全不选**），可直接在对比弹窗里**一键同步所有勾选的文件**，无需退回文件列表

### 🔌 本地 MCP 客户端与工具集
- 页面内置 **MCP 客户端框架**（`mcpStore`），可读取并渲染 MCP 的 `tools / resources / prompts`
- 内置 `filesystem-service` 提供 **23 个工具**（见[下表](#-内置工具mcp-tools)），**全部在本地浏览器执行，数据不经过任何中间服务器**
- **多 MCP Server 管理**：配置弹窗内可添加多个 **Streamable HTTP** MCP 服务（含 `/mcp` 路径）
- **🔌 可插拔工具注册**：第三方 / 自定义工具可**不改源码**接入（面板注册，或 `window.registerTool` 脚本注册），支持 `handler` / `code` / `http` 三种执行体，详见[可插拔工具注册](#-可插拔工具注册pluggable-tool-registry)

### 🤖 并行子代理（Subagent）
- 可同时打开多个**独立会话窗口**（各自独立的模型对话与工具上下文）
- 支持窗口拖拽 / 缩放 / 隐藏 / 关闭；任务队列 + Promise 化 `runTask`
- 主窗口发送消息时，自动把各子代理的**最新最终结果增量带入主对话**并同步关闭窗口
- `reopen_session`：模型可主动结束当前会话并在**全新会话**中携带交接摘要继续执行

### 🗂️ 智能体 / 提示词 / 资源
- **Agent 看板**：PROMPT / BACKUP 两列，拖拽管理卡片，卡片内容自动拼装为 `system` 提示词（可附参考文件，docx 自动提取文本）
- **Prompts 模板**：按 MCP `prompts/list` 加载，支持参数化表单填充后一键 Get
- **Resources 浏览**：按 MCP `resources/list` / `templates/list` 展示

### 📄 Office 与文档处理
- **内置 Office 编辑器**：**docx / xlsx / pptx** 双击浏览与编辑，可保存回 Node FS / 另存为 / 下载
- 文档读取：`@iyulab/anydoc`（WASM）+ `mammoth` 将 **Office / PDF → Markdown / 文本**
- **Markdown → PDF**：`markview-web` 纯前端排版引擎（justified A4 分页 + KaTeX 公式 + Mermaid 图），输出真正的 PDF 文件
- **HTML → PPTX**：把 HTML 幻灯片转换成 `.pptx`（PptxGenJS）

### 🛡️ 工具审批（Approval Gate）
- **写 / 改 / 删 / 执行**四类有副作用的工具（`write_file` / `edit_file` / `replace_lines` / `add_content` / `delete_content` / `delete_file` / `run_shell`）**执行前逐次征得同意**，只读工具不打扰
- 三种决定：**允许一次**（allow-once）/ **本会话允许**（allow-session）/ **拒绝**（deny）
- `allow-session` 按「工具 + 作用域」记忆：文件类按工具名，`run_shell` 按**命令首词**（授权 `git` 不会连带放行 `rm`）
- **拒绝即返回可读理由**：理由作为普通工具结果回给模型（含「请勿原样重试」的指引），不抛异常、不中断整轮 → 模型会换一种做法，而不是在同一个调用上死循环
- **fail-closed**：没有审批界面 / 审批服务异常 / 超时未响应，一律按拒绝处理，绝不静默执行
- 主会话与**并行子代理共用同一道闸门**（`mcpStore.callTool` 是唯一收敛点），多个请求排队依次弹出
- 可在「⚙️ 配置 → Advanced」开关、编辑白名单、设置超时，并**一键撤销本会话全部授权**

### 🖥️ 桌面外壳与本地磁盘（Electron）
- **多标签浏览器**：标签栏 + 地址栏 + 前进 / 后退 / 刷新 / 主页 / 开发者工具，`target=_blank` 在本应用内新开标签
- 地址栏支持 **URL / 本地路径 / 搜索词** 自动识别
- **拖拽文件拿到磁盘真实路径**（`webUtils.getPathForFile`），编辑后**写回原文件**，二进制字节保真（图片 / PDF 不失真）
- 原生菜单与快捷键（新建 / 关闭标签、打开文件、缩放、全屏等）

### 🌍 其他
- **多语言 i18n**：English / 简体中文
- **零构建**：无 jQuery，纯原生 DOM，静态资源即可部署
- **移动端自适应**（`@media` 断点）与桌面端优化

---

## ⚡ 快速开始

### 环境要求
- **Node.js ≥ 18**（用于 Electron 与打包）
- 支持现代浏览器的操作系统：Windows / macOS / Linux

### 1. 克隆与安装

```bash
git clone https://github.com/chatbot-zero/chatbot-zero.git
cd chatbot-zero
npm install
```

### 2. 启动桌面应用

```bash
npm start        # 启动 Electron 多标签外壳（主页即工作台）
```

> **仅用浏览器也可以**：把 `renderer/` 目录作为静态站点部署（如 `npx serve renderer`），浏览器打开 `index.html` 即可使用对话、Node 沙箱、MCP 工具等本地能力。
> 差异：脱离 Electron 外壳时，**「拖入文件拿真实磁盘路径 / 写回原文件 / 同步到磁盘」** 等能力不可用（改用 File System Access API 的目录导入导出）。

### 3. 打包发布

```bash
npm run dist         # 当前平台
npm run dist:win     # Windows → nsis / portable
npm run dist:mac     # macOS   → dmg
npm run dist:linux   # Linux   → AppImage
```

产物输出到 `dist/`。

### 4. 不打包 renderer（外部目录直接加载）

**renderer 不再打进 `app.asar`，也不生成 `app.asar`。** 打包后的
`dist/win-unpacked/chatbot-zero.exe` 会直接加载 **`dist` 同级的 `renderer/`**（即项目根
`renderer/`）；升级时改这个目录即可，重启应用生效，无需重新打包：

```bash
# 本机开发/升级：直接编辑或覆盖项目根 renderer/，然后重启 chatbot-zero.exe
# 只分发 dist 时（便携布局）：生成 dist/renderer，与 win-unpacked 同级
npm run build:renderer   # 复制到 dist/renderer（不打包、不生成 app.asar）
npm run upgrade          # 先清空目标再完整覆盖
```

- 解析顺序（`main.js`）：`CHATBOT_RENDERER_DIR` → **`dist` 同级 `renderer/`** →
  `dist/renderer/`（win-unpacked 同级）→ `win-unpacked/renderer/`。
  **明确不回退 `app.asar`**；找不到 `renderer/index.html` 会直接报错暴露部署问题。
- `build.asar` 已设为 `false`：打包只产出 `resources/app/`（`main.js`、`preload.js`、
  `sandbox` 与主进程所需的少量共享模块），**不会编译出 `app.asar`**。
- **已有旧安装包（resources/app.asar）一次性切换**：关闭 chatbot-zero.exe 后执行
  `npm run switch:unpacked`。脚本会解包出 `resources/app/`（只保留主进程文件，
  UI renderer 不放进去），并把 `app.asar` 改名为 `app.asar.bak`；之后启动即走外部 renderer。
  `npm run switch:unpacked -- --prepare` 只准备目录，不动 `app.asar`。
- 只有 `main.js / preload.js / sandbox` 这类**主进程**代码变更才需要重新打包一次外壳。

---

## ⚙️ 配置说明

点击输入框左侧 **⚙️** 打开「Interface Configuration」：

| 分组 | 配置项 |
|---|---|
| 基本 | **API Key**（仅存浏览器 `localStorage`）、**Endpoint**：`URL` + `Path` + `Model` |
| 高级 | HTTP 方法、Content-Type、**Stream**、**Prefix Cache（前缀缓存）**、**MCP**（开关 + 多 MCP Server 列表）、Max Tokens、Temperature、Top P、Auth Prefix |

- 支持**导入 / 导出 JSON 配置文件**，或点击 🔄 恢复默认。
- **配置文件固化**：接口配置会自动写入「应用目录」下的 `config/interface.json`（密钥仍由 safeStorage 加密保存，不落该文件）。既可**在页面设置后保存**（即时写入文件），也可**直接编辑该文件后点弹窗里的「🔁 从文件刷新」**（或刷新页面）回读生效——两条路径改的是同一份配置。
- 界面语言、Agent 看板、Resources、History、Subagent 等均从 ⚙️ 菜单进入。
- 右下角 **🛠️ 工具箱**：重置全部配置 / 强制刷新工具列表（触发一次缓存 miss）。

---

## 🧰 内置工具（MCP Tools）

内置 `filesystem-service` 共 **23 个工具**，均在本地浏览器执行：

| 工具 | 说明 |
|---|---|
| `read_file` | 读取文件（可指定行范围）；窗口按 **token 预算（约 6000）+ 行数** 双限裁剪，未读完时末尾给出 `[继续] start_line=<n>`；自动识别二进制 / 超大文件；支持文本、图片、PDF、Office 文档 |
| `list_dir` | 列出目录条目（`[DIR]` / `[FILE]`），默认 `/home/pyodide` |
| `read_file_line_slice` | 读取超长单行的字符片段（配合被截断的 `read_file`），返回 `next_offset` |
| `read_file_char_range` | **按字符偏移**读取文本片段（不按行）：单行巨文件 / `min.js` / 一行一个超长字符串的唯一正解，可读 64MB 以内文件 |
| `write_file` | 写入文件（自动创建父目录） |
| `delete_file` | 删除文件或目录（递归） |
| `add_content` | 按行号插入内容 |
| `delete_content` | 按行号区间删除内容 |
| `replace_lines` | 按行号区间替换 / 删除内容（保留 CRLF/LF 风格） |
| `edit_file` | 基于字符串精确匹配的编辑（比按行号更健壮）；支持唯一性校验 / `replace_all` / `expected_replacements` |

| `search_content` | 基于 **ripgrep-wasm** 的正则全文搜索 |
| `read_url` | 抓取 http/https/data URL → 可读文本（HTML 转正文、JSON 美化）；二进制（PDF/Office）落盘并可用 anydoc 解析为 Markdown |

| `run_node` | 在 **almostnode（浏览器内 Node.js）** 中执行代码 |
| `run_subagent` | 启动独立子代理窗口执行子任务（可并行） |
| `reopen_session` | 结束当前会话并在全新会话中携带交接摘要继续执行 |
| `ask_user` | 向用户提问 / 征求确认并**暂停等待答复**（人机交互）；支持预设选项、自由文本、超时 |

| `todo_write` | 维护当前会话的待办列表 |
| `markdown_to_pdf` | Markdown → 分页 A4 PDF（本地排版引擎） |
| `html_to_ppt` | HTML 幻灯片 → `.pptx`（PptxGenJS） |
| `web_search` | 联网搜索：默认 **Bing**（RSS→HTML 解析），失败回退 DuckDuckGo；Electron 内由主进程抓取绕过 CORS，纯浏览器自动降级 |
| `run_shell` | 在工作区执行 shell 命令（真实子进程，受审批 / 沙箱约束）；支持 `run_in_background` 后台任务 |
| `run_tests` | 自动探测并运行 测试 / 类型检查 / Lint，返回结构化失败诊断（file:line:col + 规则/错误码） |
| `rewriter` | 把问题重写为更可解、更可验证的问法（澄清 / 分解 / 逆向 / 换视角等策略） |

> `Prompts 模板` 与 `Resources` 对话框为通用 MCP 客户端 UI，需接入外部 MCP server 或扩展注册后才会显示内容。

---

## 🔌 可插拔工具注册（Pluggable Tool Registry）

除内置 `filesystem-service` 外，工作台提供一套**可插拔的工具注册机制**，让**第三方 / 自定义工具**在不修改源码的前提下接入 LLM 工具调用循环。

**打开方式**：右下角 **🛠️ → 🔌**（工具注册表）。

**两种注册途径**：

1. **面板注册**（零代码）：在弹窗里填「名称 / 说明 / 参数 JSON Schema / 执行体」，点「注册工具」即生效；支持启停、删除、载入示例（🧪）、导入 / 导出 JSON。
2. **脚本注册**（第三方插件）：页面暴露全局 API，任意独立脚本可自行注册（完整示例见 `renderer/tools/example-plugin.js`）：

```js
// ① 函数型 handler（可闭包引用插件内部状态；仅内存，不随持久化保存）
window.registerTool({
  name: 'my_tool',
  description: '这个工具做什么、什么时候该用…',
  inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  handler: async (args, ctx) => ({ ok: true, echoed: args.x })
});

// ② 内联 JS 源码（可持久化到 localStorage，刷新后仍在）
window.registerTool({ name: 'js_tool', description: '…', inputSchema: { /* … */ },
  code: "return String(args.x).toUpperCase();" });

// ③ 声明式 HTTP（可持久化；url / header 支持 {arg} 插值）
window.registerTool({ name: 'http_tool', description: '…', inputSchema: { /* … */ },
  http: { url: 'https://api.example.com/search?q={q}', method: 'GET' } });

// 其它公共 API：
// window.registerTools([...])           批量注册
// window.unregisterTool(name)           注销单个
// window.listRegisteredTools()          列举已注册工具
// window.callRegisteredTool(name, args) 直接调用（本地测试用）
// window.ToolRegistry.unregisterByTag('my-plugin')  插件卸载时按 tag 批量注销
```

**工作机制（零侵入）**：

- 注册表（`renderer/tool-registry.js`，纯逻辑模块，可用 Node 单测）被映射为一个**内置 MCP Server**（服务键 `tool-registry`）注入 `window.mcpServers`；
- 因此既有的 `mcpStore.listTools / getTool / callTool`、多轮工具调用循环（`runToolCalls`）、工具轨迹回放、子代理**全部无需改动**即可用上新增工具；
- 任何注册 / 注销 / 启停都会触发 `prefixManager.invalidateTools()`，显式失效 `system + tools` 前缀缓存（**下一轮一次 cache miss**），之后保持字节稳定，不影响后续缓存命中；
- 注册时校验命名（`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`）、重名保护（可 `override`）与执行体完整性；执行失败以 `isError` 回传，界面以红色「失败」标签呈现，不中断对话。

**三种执行体形态**：

| 执行体 | 写法 | 可持久化 | 说明 |
|---|---|---|---|
| `handler` | 函数 `(args, ctx) => any` | 否 | 最灵活，可闭包引用插件内部状态；通常由第三方脚本注册 |
| `code` | 内联 JS 源码字符串 | 是 | 在函数体内执行，可用 `args` / `ctx`（`ctx.call` 可调用其它工具），`return` 回传结果 |
| `http` | `{ url, method, headers, bodyTemplate }` | 是 | 声明式请求；GET 自动拼查询串；非 2xx 视为失败 |

> 工具返回值会被统一规整为 MCP 结果：返回字符串即文本，返回对象自动 JSON 序列化；也接受 `{ content: [...] }` 结构。

---

## ⌨️ 快捷键

| 快捷键 | 作用 |
|---|---|
| `Enter` | 输入换行（不发送） |
| `Shift + Enter` | 输入换行 |
| `Ctrl / Cmd + Enter` | 发送消息（对话输入框）；在编辑器中运行代码 |
| `Ctrl / Cmd + T` | 新建标签页 |
| `Ctrl / Cmd + W` | 关闭标签页 |
| `Ctrl / Cmd + O` | 打开文件 |
| `Ctrl / Cmd + L` | 定位地址栏 |
| `Ctrl / Cmd + R` | 刷新页面 |
| `Ctrl / Cmd + Shift + I` | 开发者工具 |

---

## 🏗 架构与工作原理

```
┌──────────────────────────────────────────────────────────────────────┐
│ Electron 外壳 (main.js + preload.js)                                  │
│  ├─ BaseWindow + WebContentsView 多标签浏览器                         │
│  │    ├─ chrome 视图 (renderer/browser-chrome.html)：标签栏 + 地址栏   │
│  │    └─ 标签页视图：默认加载 renderer/index.html（工作台主页）        │
│  └─ preload.fileAPI：webUtils.getPathForFile + fs 读/写/stat/remove…   │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 工作台 renderer/index.html（HTML 外壳 ~1.5k 行 + assets/js 01..32 模块）                     │
│  ├─ AI 对话层：fetch → OpenAI 兼容 SSE 流 → 增量渲染                   │
│  │     └─ prefixManager（FNV-1a 指纹）+ cacheStatsStore（命中率/省钱） │
│  ├─ MCP 层：mcpStore（tools/resources/prompts）+ 多 Server(HTTP)      │
│  │     ├─ filesystem-service：内置 19 个 tool                         │
│  │     └─ tool-registry：可插拔注册的第三方 / 自定义工具              │
│  ├─ 运行时：almostnode（浏览器内 Node.js）                            │
│  │     └─ VirtualFS(/home/pyodide) → IndexedDB 持久化                 │
│  ├─ 文档：anydoc+mammoth（Office/PDF→MD）；markview-web（MD→PDF）；    │
│  │        html_to_ppt（HTML→PPTX）；docx/xlsx/pptx 编辑器             │
│  └─ 子代理：多窗口独立会话 + 任务队列 + 结果回灌                       │
└──────────────────────────────────────────────────────────────────────┘
```

**数据流**：模型请求（带 `tools`）→ 收到 `tool_calls` → `mcpStore.callTool` **本地执行** → 结果以 `role: tool` 回写 → 循环直至模型产出最终答案。

**持久化位置（均为浏览器本地）**：

| 数据 | 存储 |
|---|---|
| `chatbotStore` / `defaultChoiceStore` / `historyStore` / `cacheStatsStore` / 脚本历史 | `localStorage` |
| Agent 看板 `agentStore` | `sessionStorage` |
| **会话事件日志（append-only 事实源）** | **应用目录 `messages/<sid>/events.jsonl`**（逐事件追加，可 replay / fork / 崩溃恢复） |
| 工作区文件系统 `/home/pyodide` | **IndexedDB**（almostnode VirtualFS 原生持久化） |

---

## 📁 项目结构

```
.
├── package.json              # Electron 应用与 electron-builder 打包配置
├── main.js                   # 主进程：多标签浏览器外壳 + 文件系统 IPC
├── preload.js                # 注入工作台：暴露 fileAPI（真实路径 + 磁盘读写）
└── renderer/                 # 渲染层（工作台 + 全部本地静态资源）
    ├── index.html            # ★ 工作台入口外壳（约 1.5k 行 / 1,548 行：head 库引用 + 内联 UI 标记 + 资源引用）
    ├── assets/
    │   ├── css/              # 应用样式：app-base / theme / office-docx|xlsx|pptx|modal / pgpy / plan-mode（8 个）
    │   └── js/               # 应用脚本（零构建，靠顺序加载共享全局作用域）
    │       ├── office-libs-boot.js                          # head 引导：注入 window.XLSX / PptxGenJS
    │       ├── docx-editor.js / xlsx-editor.js / pptx-editor.js / lsp-boot.js  # 内嵌编辑器 / LSP（IIFE 隔离）
    │       └── 01-core.js … 32-prompt-queue.js              # 工作台主逻辑，按功能拆为 01..32 共 30+ 个模块（缺 29）
    │           └── 18-session-log.js                        # ★ 会话事件日志（append-only 事实源：replay/fork/崩溃恢复）
    │       （应用目录另含 messages/<sid>/events.jsonl —— 会话事件日志落盘处，运行时生成）
    ├── tool-registry.js      # ★ 可插拔工具注册表（纯逻辑模块，支持 Node 单测）
    ├── tools/example-plugin.js  # 第三方工具「可插拔注册」示例插件
    ├── almostnode.global.js  # 浏览器内 Node.js 运行时（VirtualFS + IndexedDB）
    ├── browser-chrome.html / browser-chrome.js / browser-chrome-preload.js
    ├── marked / highlight / codemirror(+show-hint/matchbrackets/closebrackets)
    ├── jszip / mammoth / docx-preview / html-docx / FileSaver
    ├── ripgrep_wasm_b64.js / ripgrep_wasm_nomodule.js     # 全文检索
    ├── anydoc_wasm_b64.js / anydoc_wasm_bg_nomodule.js / anydoc-init.js
    ├── markview-web.js / .css + katex + markdown-it + texmath + mermaid
    │                                  + html2canvas + jspdf
    ├── fonts/                # 本地字体
    ├── LICENSE.txt           # 第三方资源许可
    └── README.md / README.en.md
```

> **加载顺序**：`renderer/index.html` 的 `<head>` 中脚本顺序经过编排（如 Office 依赖经 almostnode 运行时按需 `require` 注入 `window.XLSX / window.PptxGenJS`），请勿随意调整。

---

## 🛡️ 工具审批（Approval Gate）

把「模型说干就干」改成「逐次征得同意」，同时保证**拒绝也是可读的、可恢复的**。

### 决策模型

| 决定 | 含义 | 后续行为 |
|---|---|---|
| ✅ 允许一次 | 只放行这一次调用 | 下次同工具仍会询问 |
| 🔁 本会话允许 | 记住「工具 + 作用域」 | 文件类按工具名；`run_shell` 按命令首词（授权 `git` 不等于放行 `rm`） |
| ⛔ 拒绝 | 不执行，并附理由 | 理由作为工具结果回给模型，附「勿原样重试」指引 |

### 拒绝不是错误，是输入

被拒时 `mcpStore.callTool` 返回的是**普通工具结果**（不是异常、不中断整轮）：

```
{"success":false,"isError":true,"content":[{"type":"text",
 "text":"⛔ 用户拒绝执行 删除文件 / 目录 `delete_file`（/etc/nginx.conf）。拒绝理由：生产配置别动。…请勿原样重试同一调用。…"}]}
```

模型因此能读到「为什么不行」，进而缩小改动范围、换路径，或先说明意图再请求。

### 拦截点与作用范围

- `mcpStore.callTool()` 是主会话（`09-chat-store.runToolCalls`）与并行子代理（`13-subagent-ui.postToolCall`）**唯一**的收敛点 → 一道闸门覆盖全部工具调用；通过 `window.registerTool` 注册的第三方工具同样经过。
- 执行顺序：`禁用工具检查 → 审批闸门 → 工具执行`。
- 默认白名单：`write_file`、`edit_file`、`replace_lines`、`add_content`、`delete_content`、`delete_file`、`run_shell`。
  `run_node` 也能读写虚拟文件系统，但默认**不**拦（几乎每轮都用，逐次弹窗会淹没对话），需要时在配置里加入。
- 与 Plan 模式的关系：Plan 模式仍然「直接拦下有副作用工具」；它自带的「高风险弹窗」在审批接管后自动让位，避免同一调用被问两次。

### 失败姿态（fail-closed）

| 情形 | 处理 |
|---|---|
| 没有审批界面（headless / 旧构建） | 拒绝，`no-asker` |
| 审批服务抛异常 | 拒绝，`ask-error` |
| 超时未响应（默认 300 秒，可设 0 关闭） | 拒绝，理由为「审批超时」 |
| 返回无法识别的答案 | 拒绝 |

### 配置与审计

- 「⚙️ 配置 → Advanced → 🛡️ 工具审批」：开关 / 逗号分隔白名单 / 超时秒数 / 「撤销本会话全部授权」。
- 持久化在 `localStorage` 的 `chatbotStore.approval`（随配置 JSON 导入导出）。
- 内存审计流水：`window.approvalStore.history()`（最近 200 条，含工具、目标、作用域、决定、理由）。

### 实现

| 文件 | 职责 |
|---|---|
| `renderer/approval.js` | 纯逻辑（UMD，零依赖）：策略归一化、调用描述、三种决策、授权作用域、拒绝文案 |
| `renderer/assets/js/22-approval-ui.js` | 策略读写 + 模态队列 + 倒计时（`window.approvalStore`） |
| `renderer/assets/js/07-mcp.js` | `callTool` 中的闸门（拒绝 → 普通工具结果） |
| `renderer/assets/js/08-ui-store.js` | `chatbotStore.approval` 默认值与旧数据迁移 |
| `renderer/assets/js/14-ui-dialogs.js` | 配置面板读 / 写 / 撤销 |
| `renderer/approval.test.js` | 26 项单测（策略、描述、三种决策、超时、fail-closed、审计） |

---

## 🧯 健壮性与上下文工程（P0：低成本高回报）

对齐 dsh 的四项基础能力，全部以「纯逻辑模块 + 唯一收敛点接线」实现：

| 模块 | 作用 | 接入点 |
|---|---|---|
| `renderer/spill.js` | **工具结果溢出（Spill）**：单次结果文本超过阈值（默认 20000 字符）时，先把完整内容落盘到 `/home/pyodide/.spill/`，只回「前 4000 + 后 2000 + 说明 + 文件指针」；模型随后用 `read_file` / `read_file_char_range` / `search_content` 回读。避免一次 grep / 构建日志就撑爆上下文 | `mcpStore.callTool` 唯一收敛点 |
| `renderer/guard.js` | **执行截止（Deadline）**：任何工具超过 `deadlineMs`（默认 600000）未返回，就返回普通工具结果 + `isError`，而不是让 UI 永久转圈；默认豁免 `ask_user` / `run_shell` / `run_tests` / `run_subagent`（本身会长时间等待或自带超时） | `mcpStore.callTool` |
| `renderer/web-search.js` + `net:search` | **`web_search`**：默认 **Bing**（官方 Web Search API 已退役，改抓结果页：`format=rss` 优先 → HTML 解析 `li.b_algo`），失败回退 DuckDuckGo（HTML / Instant Answer）；Electron 内由主进程 `net.fetch` 抓取绕过 CORS，纯浏览器自动降级。`provider`：`auto`(默认) / `bing` / `bing-rss` / `bing-html` / `duckduckgo-html` / `duckduckgo-api`，另有 `lang` 透传 Bing `setlang` | 内置 MCP `filesystem-service` |
| `renderer/context/` | **工作区上下文**：把 `AGENTS.md` / `CLAUDE.md`、当前时间、工作目录注入到「最后一条 user 消息尾部」；并注册 `working_directory` 工具（影响 `run_shell` / `run_tests` 的默认执行目录） | `agentStore.promptMessage` + tool-registry |

- **配置**：`chatbotStore.spill / guard / workspaceContext`（随配置 JSON 导入导出；旧数据缺失时自动与默认值合并）。
- **前缀缓存**：以上动态内容全部只改对话尾部，**绝不改动** `system + tools` 前缀，因此前缀缓存命中不受影响。
- **单测**：`node renderer/spill.test.js`、`renderer/guard.test.js`、`renderer/web-search.test.js`（含 Bing RSS/HTML 解析 + auto 回退链，注入 `_fetchText` 零网络）、`renderer/context/workspace-context.test.js`。
- **注**：重复调用提醒 / 连续失败中止由既有 `createLoopGuard`（`chatbotStore.loopGuard`）负责；本次补齐的是「执行截止」这一层。`createLoopGuard` 的「步数触顶」中止后会**自动续跑**：等价于用户手动在输入框输入「继续，专注任务运行，不要跑偏。」并点发送（见「任务中心」一节的「护栏自动继续」）。

---

## 🧩 P1：控制面 / 后台任务 / 会话检索 / 模型路由

| 能力 | 文件 | 工具 |
|---|---|---|
| 子代理控制面 | `renderer/agent-control.js` + bootstrap | `list_agents` / `send_message` / `interrupt_agent` |
| 后台任务 | `renderer/jobs.js` + `run:start` / `job:*` IPC | `run_shell(run_in_background=true)` / `job_list` / `job_output` / `job_kill` |
| 会话检索（血缘 / trace） | `renderer/session-trace.js` + bootstrap | `session_list` / `session_trace` / `session_event_search` / `session_event_read` |
| 多 Provider / 模型路由 | `renderer/provider-config.js` + `11-completion.js` | `list_models`；配置 `chatbotStore.providers / activeProviderId / subagentProviderId / subagentModel` |

- **子代理控制面**：`list_agents` 查看窗口状态，`send_message` 向空闲子代理继续发消息，`interrupt_agent` 释放运行中的任务（可 `close` 关窗）。
- **后台任务**：`run_shell` 传 `run_in_background=true` 立即返回 `job_id`；输出在主进程缓冲，`job_output` 支持 offset 续读，`job_kill` 终止整棵进程树（dev server / watch / 长任务）。
- **会话检索**：在 append-only 事件日志上提供 `session_trace`（消息数 / 请求数 / fork 血缘 / 事件类型统计）与事件级全文检索、按 seq 读取。
- **多 Provider / 模型路由**：`providers` 为空时**完全回退**旧的 `url/path/model`；子代理可单独指定 `subagentProviderId / subagentModel`。
- 单测：`node renderer/agent-control.test.js`、`renderer/jobs.test.js`、`renderer/session-trace.test.js`、`renderer/provider-config.test.js`。

---

## 🛡 进程沙箱（L0 / L1 / L2）

- **L0 统一注入点**：所有真实命令都经 `main.js` 的 `spawnSandboxed()`（`run:exec` 与 `run:start` 共用）；环境变量清洗（剥离 `*_KEY / TOKEN / SECRET / AWS_ / OPENAI_ …`）、`HOME/TMP` 重定向到工作区、审计写 `workspace/<ws>/.sandbox/audit.jsonl`。
- **L1 命令策略**：`renderer/sandbox-policy.js` 在 `mcpStore.callTool` 中**先于审批**分类：`critical → deny`、`medium/high → approve`、`low → allow`；`npm/pnpm/yarn install` 默认追加 `--ignore-scripts`；网络命令在 `allowNetwork=false` 时至少需人工确认。
- **L2 进程沙箱（Windows）**：`sandbox/win-job.ps1` 通过 Win32 P/Invoke 创建 **Job Object**（`ProcessMemoryLimit` / `ActiveProcessLimit` / `PerJobUserTimeLimit` + `KILL_ON_JOB_CLOSE`），启动命令后立即 `AssignProcessToJobObject`，输出按**原始字节**转发给 Node 智能解码。父进程退出/被杀 → Job 句柄关闭 → 子进程树全杀（比 `taskkill /T` 更可靠）。
- **其它平台**：Linux 有 `bwrap` 时用 `--unshare-net` 等隔离；macOS 有 `sandbox-exec` 时用 seatbelt profile；否则降级为 `policy` 并在结果里标注 `sandbox.level`。
- **配置**：`chatbotStore.sandbox = { enabled, mode: 'auto'|'policy'|'off', allowNetwork, memoryMB, cpuSec, pidsLimit, ignoreScripts, restrictedToken, envAllowlist }`。
- **说明**：`restrictedToken`（`CreateRestrictedToken`）需要提权 helper，当前以 **Job Object 为强制层**，受限令牌预留（结果里 `tokenRestricted=false`）；网络隔离暂由 L1 策略承担（`allowNetwork` 默认 false）。
- **测试**：`node renderer/sandbox-policy.test.js`、`node sandbox/config.test.js`；Windows 启动器可用 `powershell -File sandbox/win-job.ps1` 单独自检。

---

## 🔒 隐私与安全

- 本项目**无后端**：模型请求由浏览器直接发往你配置的 API 地址；**API Key 只存本地**。
  自 v1.0.1 起密钥不再写 `localStorage`，而是经 `safeStorage`（DPAPI / Keychain / libsecret）加密后
  保存在 `<userData>/secrets.json`；系统不支持加密时仅保留在本次会话内存中。详见 [SECURITY.md](./SECURITY.md)。
- 工具执行（代码 / 文件 / 搜索 / 文档转换）**全部在浏览器内**完成，**文件不离开本机**。
- 磁盘读写默认「**零授权**」：只有你拖入工作台的文件 / 文件夹、或在系统对话框里选中的目录才会登记授权
  （未授权路径返回 `EPERM_NO_GRANT`）；系统目录、`.ssh/.aws` 等密钥路径与应用自身配置目录永远拒绝。
- Markdown / 文档 / 网页内容渲染前统一过 **HTML 白名单净化**（`renderer/sanitize.js`），
  `script/iframe/on*` 等一律剔除，防 XSS 窃取密钥或借 `fileAPI` 写盘。
- ⚠️ **安全提示**：
  - 请勿在不信任的共享设备上保存 API Key；
  - 浏览器内 Node 沙箱 **≠ 系统级安全隔离**，请勿执行不可信代码；
  - 如需多人部署，请自备服务端代理以托管密钥并加访问控制。

---

## 🧬 会话事实源（append-only 事件日志）

对话不再只活在内存 / `localStorage`，而是**磁盘上的 append-only 事件日志**（对齐 dsh 的「会话事实源」）：

- **位置**：应用目录下 `messages/<sid>/events.jsonl`（每会话一目录，逐行 JSON 事件，**只追加、永不覆盖**）；`meta.json` 存标题 / 创建时间 / 分支来源。

- **不变量 `model-visible ⟺ logged`**：发往模型的载荷（`body.messages`）在请求前先写入日志（`model.request` 事件带载荷指纹），因此「发给模型的」一定可从日志 replay 出来。

- **事件类型**：`session.create` / `session.branch` / `msg.append` / `msg.truncate` / `msg.replace` / `model.request`。

- **能力**：
  - **replay**：按事件顺序 fold 还原完整对话；刷新 / 崩溃后重启即从日志恢复（磁盘有日志时以日志为事实源覆盖 `localStorage`）；
  - **fork**：Query History 每条会话的 🍴 按钮，从该会话复制前缀开出新会话（保留 `model.request` 锚点）；
  - **崩溃恢复**：`events.jsonl` 逐行解析，损坏 / 半截行自动跳过；
  - **一次性迁移**：首次运行若磁盘无日志，把既有 `localStorage` 历史导入日志。

- **降级**：纯浏览器直开（无 `messagesAPI`）时自动 no-op，行为与从前一致。
- **实现**：主进程 `main.js`（`msg:append|read|list|meta|fork|remove` IPC，仅受信来源）＋ `preload.js`（`window.messagesAPI`）＋ `renderer/assets/js/18-session-log.js`（fold / sync / fork / replay 纯逻辑，附 `session-log.test.js` 单测）。

---

## 🧩 兼容性

- **浏览器**：建议最新版 Chrome / Edge / Firefox / Safari（依赖 `fetch` 流式读取、WASM、IndexedDB、`ResizeObserver`）。
- **模型接口**：OpenAI 兼容 `/chat/completions` 风格；内置定价的模型名示例：`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`（其他模型可在 `CACHE_PRICING` 中补充单价）。
- **本地模型**：可将 `URL` 指向 `http://127.0.0.1`（如 Ollama / LM Studio 等 OpenAI 兼容网关）。

---

## 🛣 Roadmap

- [x] 采用 **Apache-2.0** 许可证并发布（仓库根目录 `LICENSE` / `NOTICE`）
- [x] 拆分模块：CSS → `assets/css/*`，主逻辑 → `assets/js/01..32`（`index.html` 由 24,272 行降至 1,548 行，零构建直开保留）
- [ ] 继续收敛偏大的模块（`15-pgpy-runtime.js` 1.6k 行、`12-render.js` 1.4k 行、`17-pgpy-fsui.js` 1.3k 行）
- [ ] 补充单元测试（流式解析、SSE 缓冲、缓存指纹）
- [x] 会话事实源：append-only 事件日志落盘 `messages/`（replay / fork / 崩溃恢复，`model-visible ⟺ logged`）
- [ ] 补充 `CHANGELOG` / `CONTRIBUTING`
- [ ] 静态资源提供 CDN / 离线双模式，减小首包体积
- [ ] 增加更多模型预设与定价表、多 API 供应商切换
- [x] 将 MCP 工具集扩展为**可插拔注册**（第三方工具自定义）—— 见 [🔌 可插拔工具注册](#-可插拔工具注册pluggable-tool-registry)
- [x] **工具审批**：写 / 改 / 删 / 执行 走 allow-once / allow-session / deny，拒绝附可读理由（fail-closed）—— 见 [🛡️ 工具审批](#️-工具审批approval-gate)
- [ ] 为内置 server 补齐 resources / prompts 能力，或提供外部 MCP server 接入示例

---

## 🗂️ 任务中心（任务态 / 产物 / diff / 中断恢复）

把「一次对话」升级成「可验收、可恢复的任务」，实现为纯逻辑状态机 + 两个唯一收敛点钩子：

| 维度 | 实现 |
|---|---|
| 任务态 | `renderer/tasks.js`：`planning → executing → verifying → done/failed`，支持 `paused / interrupted`；每次工具调用 / 工具结果 / 验证结果都是事件，转移可单测 |
| 落盘 | `<APP_DIR>/tasks/<id>.json`（0600、原子写、4MB 上限、id 白名单）；纯浏览器降级 `localStorage` |
| 产物 + 变更 | 包装 `mcpStore.callTool`：写/改/删前读虚拟文件快照，按路径归并 `+/-` 行数并保存 **LCS 行级 diff**（上下文折叠；超大文件降级为统计；落盘截断 20k） |
| 三段式 | 包装 `agentStore.promptMessage`，**只改对话尾部**注入阶段指令（`system+tools` 前缀不动，前缀缓存不受影响）：planner 先 `todo_write` 拆步骤 → executor 逐步执行 → verifier 用 `run_tests / tsc --noEmit` 的真实结果作证据；不通过自动回 executing 并把原因写入下一轮提示，超过 `maxAttempts` 转 `failed` |
| 中断恢复 | 启动时把上次仍 `running` 的任务标为 `interrupted`；面板「▶ 继续」恢复阶段并注入 `resumePrompt`（目标 / 步骤进度 / 已改文件 / 最近验证反馈） |
| 护栏自动继续 | 执行护栏「步数触顶」中止后，自动发一条内容为「继续，专注任务运行，不要跑偏。」的 user 消息并开始下一轮推理（等价于在输入框输入该句再点发送）；默认每轮最多自动续跑 3 次（`chatbotStore.loopGuard.maxAutoContinues`），重复调用 / 连续失败不自动续跑；计数落在 `task.autoContinues / maxAutoContinues`，卡片显示「护栏自动继续 N/M」，人工 resume 重置预算 |
| UI | 右下角 🗂️ 面板：任务卡片、步骤清单、产物列表（点文件名看 diff 弹窗，`textContent` 渲染）、暂停/继续/验证/删除 |
| 清空沙箱 | 面板「🧹 清空沙箱」按钮 → `shellAPI.cleanupAll()`（主进程 `run:cleanupAll`）：终止全部后台任务并删除物化运行目录 `<APP_DIR>/workspace/`（含 `node_modules` 等依赖缓存，清完回显释放空间）；虚拟工作区 `/home/pyodide` 与已同步的真实文件不受影响，下次运行按需重新物化 |
| 执行后回收 | `run_shell` / `run_tests` / 工具栏「⚡ Run WS」执行完自动调 `shellAPI.collect()`（主进程 `run:collect`）：以物化清单的 sha1 为基线，把运行目录里新增 / 修改的文件写回虚拟工作区、删除的同步移除，命令产物因此能被文件树与后续 `read_file` 看到；`node_modules / .git / .sandbox` 永不回收，单文件 4MB / 单次 32MB / 最多 2000 个文件超限即跳过（下次物化用旧内容覆盖，不静默丢改动）。逻辑见 `renderer/run-collect.js`（含单测） |

## ⏳ 后台任务落盘与续跑

`run_shell(run_in_background=true)` 的 job 不再只活在内存：

- 记录与输出落到 `<APP_DIR>/jobs/`：`<id>.json` + `<id>.out.log` / `<id>.err.log`（追加写，单流上限 8MB）；
- `job_list` 合并内存与磁盘 → **关窗重启后仍可见**；`job_output` 支持按字符偏移续读磁盘日志；
- 启动时把上次 `running` 记录标为 `interrupted`；`job_resume`（面板「续跑」按钮）用原命令在原工作区重跑，输出继续追加到同一 job 的日志。

单测：`node --test renderer/tasks.test.js`、`node --test renderer/job-store.test.js`。

---

## 🤝 贡献

1. Fork 本仓库；
2. 创建功能分支（`feat/xxx` 或 `fix/xxx`）；
3. 提交代码（保持既有中文注释风格与命名约定）；
4. 发起 Pull Request。

---

## 🙏 参考与致谢（Acknowledgements）

> 🤖 **本项目完全由 AI Agent 生成**（代码、文档、测试皆然）；AI 产出可能存在错误或过时之处，采用前请自行审阅、测试与安全评估。

本项目在**设计思路与方法**上参考/对齐了以下开源项目。此处仅致谢「思路层面」的借鉴；凡涉及**代码级**沿用，均遵循原项目的许可证与署名约定（具体以其仓库 `LICENSE` 为准）：

| 项目 | 借鉴内容 | 许可证 / 约定 |
|---|---|---|
| **dsh**（Agent 框架） | 子代理控制、工具审批（tools/pre-execute）、执行守卫（deadline）、工作区上下文注入、会话事实源（append-only 日志） | 设计思路参考；以原项目许可为准 |
| **Reasonix**（`esengine/deepseek-reasonix`） | 前缀缓存（CacheFirstLoop / ImmutablePrefix / CaptureShape）、上下文压缩（agent.compact）、消息清洗（SanitizeToolPairing） | 以原仓库 LICENSE 为准 |
| **OpenCode** | 子进程控制台输出智能解码（`smartDecodeOutput`：UTF-8 → GB18030 回退） | MIT（以原仓库为准） |
| **玉衡 Yuheng**（Go 版企业 RAG 平台） | 混合检索（向量+BM25）、RRF 融合、查询扩展、分块合并 | 设计思路参考；以原项目许可为准 |
| **GoNavi 0.5.0** | PostgreSQL 客户端 UI/交互复刻 | Apache-2.0 |
| **Puppeteer** | CDP 点击命中点坐标换算（`clickablePoint`） | Apache-2.0 |
| **mcp-browser-client** | MCP Streamable HTTP 传输实现参考 | 以原项目许可为准 |
| **chat-ui** | 会话持续持久化思路 | 以原项目许可为准 |

> 说明：以上为**思路/方案**层面的参考，不主张对原项目著作权的任何权利。若认为某处应补充署名或存在许可证兼容问题，请提交 Issue 补正。**实际捆绑的第三方代码/资源**（CodeMirror、marked、highlight.js、JSZip、mammoth、ripgrep-wasm、@iyulab/anydoc、KaTeX、markdown-it、texmath、Mermaid、html2canvas、jsPDF、PptxGenJS、SheetJS、docx-preview、html-docx、FileSaver.js、Underscore 等）各自按其许可证分发，详见 [`renderer/LICENSE.txt`](./renderer/LICENSE.txt)、[`NOTICE`](./NOTICE) 与 [`ACKNOWLEDGEMENTS.md`](./ACKNOWLEDGEMENTS.md)。

## 📄 License

本项目采用 **Apache License 2.0** 发布（见仓库根目录 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)）。

- 可自由地**使用、修改、分发**本软件（含商业用途）；
- 分发或衍生作品时需**保留版权与许可声明**，并在修改文件中注明变更；
- 按 **AS IS** 提供，**不附带任何明示或默示担保**（Apache-2.0 第 7/8 条）。

### 🙏 第三方资源

项目引用的第三方资源版权归其各自作者所有，请分别遵循对应许可证：

**CodeMirror、Highlight.js、Marked.js、JSZip、mammoth、ripgrep-wasm、@iyulab/anydoc、KaTeX、markdown-it、texmath、Mermaid、html2canvas、jsPDF、PptxGenJS、SheetJS(xlsx)、docx-preview、html-docx、FileSaver.js** 等（多为 MIT / BSD / Apache-2.0，详见 `renderer/LICENSE.txt`）。

---

<div align="center"><sub>本 README 依据仓库当前代码梳理；功能细节以实际代码为准。</sub></div>
