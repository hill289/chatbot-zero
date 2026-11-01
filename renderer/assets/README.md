# renderer/assets —— 前端资源目录（模块化说明）

本目录是 `renderer/index.html` 拆分出来的**应用级 CSS / JS**。拆分目标只有一个：
**把 24k 行的单文件巨石降下来，同时保持「零构建、双击 index.html 可直开」不破坏。**

---

## 1. 目录约定

```
assets/
├── css/                         # 全部为 <link rel="stylesheet"> 引用（按下面顺序）
│   ├── app-base.css             # 基础/布局/组件（原 <style> #1，2,227 行）
│   ├── theme.css                # :root 设计令牌
│   ├── office-docx.css          # 内嵌 DOCX 编辑器
│   ├── office-xlsx.css          # 内嵌 XLSX 编辑器
│   ├── office-pptx.css          # 内嵌 PPTX 编辑器
│   ├── office-modal.css         # Office 弹窗
│   └── pgpy.css                 # 工作台/编辑器局部样式
└── js/                          # 全部为经典 <script src>（非 ES module！）
    ├── office-libs-boot.js      # head 引导：require('xlsx'/'pptxgenjs') → window.XLSX / PptxGenJS
    ├── docx-editor.js           # 内嵌 DOCX 编辑器（IIFE，暴露 window.__docxEditor）
    ├── xlsx-editor.js           # 内嵌 XLSX 编辑器（IIFE）
    ├── pptx-editor.js           # 内嵌 PPTX 编辑器（IIFE）
    ├── lsp-boot.js              # LSP/tsserver 诊断集成（IIFE）
    └── 01-core.js … 17-pgpy-fsui.js   # 工作台主逻辑（原单个巨大内联 <script>，按功能拆 17 块）
```

`index.html` 现在只剩：`<head>` 第三方库引用 + 应用资源引用 + 内联 UI 标记（`<div>/<dialog>/<template>`）+ 底部各模块 `<script src>`。

---

## 2. 三条硬规则（改动前务必遵守）

1. **必须零构建、file:// 可直开** ⇒ **只能用经典 `<script src>` / `<link>`，禁止 ES module、禁止 import/export。**
   （ES module 在 `file://` 下会被 CORS 拦截；经典脚本可以。）

2. **加载顺序即执行顺序，且共享同一个全局作用域。**
   - 应用主逻辑的 17 个 `NN-*.js` **按序号加载**；它们不是 IIFE，顶层 `const/let/function` 落在**全局词法环境**，可跨文件互相引用——和拆分前单文件里的行为一致。
   - 因此：**不要重排 `<script>` 顺序**，也**不要在文件顶层写「立即执行且依赖靠后文件符号」的语句**（拆分前靠自身脚本内的函数提升能跑，拆开后跨文件不再提升）。

3. **拆/并文件时，切口要落在「顶层声明之间」**（例如两段 `// ═══` 横幅之间）。
   校验手段：`node --check <file>` 或 `new (require('vm').Script)(源码)` —— 切口若落在函数体中间会立即报语法错误。

---

## 3. 这 17 个主逻辑模块是什么

| 序号 | 文件 | 职责 |
|---|---|---|
| 01 | core.js | 原生 DOM 工具（qs/qsa/elFromHTML）、i18n 文案、persist |
| 02 | agent-tools.js | run_subagent / reopen_session / ask_user / rewriter / edit_file / read_url |
| 03 | node-tools.js | almostnode 本地工具、run_node 真实执行与失败诊断 |
| 04 | doc-tools.js | markdown_to_pdf、html_to_ppt |
| 05 | fs-tools.js | 文件读取工具（read_file / list_dir / read_file_line_slice + 汇总分支） |
| 06 | orchestration.js | planStore（计划）、createLoopGuard（执行护栏） |
| 07 | mcp.js | 外部 MCP 客户端 + 可插拔工具注册表接线 |
| 08 | ui-store.js | snackbar 等 UI 状态 |
| 09 | chat-store.js | messageStore（对话状态机） |
| 10 | prefix-cache.js | 前缀缓存管理器（字节稳定 / 指纹 / 命中统计） |
| 11 | completion.js | 发送前清洗 + createCompletion（流式请求 / 工具循环 / 溢出恢复） |
| 12 | render.js | 消息渲染 + 增量渲染（防长对话卡死） |
| 13 | subagent-ui.js | 子代理多窗口 + 结果回灌 |
| 14 | ui-dialogs.js | 输入区 / 多模态图片 / 各对话框 / 工具注册面板 / 事件绑定 |
| 15 | pgpy-runtime.js | almostnode 运行时封装、真实路径映射、Web 版文件比较（diff） |
| 16 | pgpy-editor.js | 编辑器初始化 / 运行 / 结果渲染 / 脚本历史 / FS ZIP |
| 17 | pgpy-fsui.js | 文件删除 / 导出 ZIP·目录 / 拖放上传 / 历史导入 / 工具函数 |
| 18 | session-log.js | ★ 会话事件日志（append-only 事实源）：fold/sync/fork/replay，落盘「应用目录/messages/」 |

> `15 / 12 / 17` 仍偏大（1.3–1.6k 行），后续可继续在各自内部的 `// ═══` 横幅间再切分，方法同上。

---

## 4. 兼容性提示

- 页面里引用的 `almostnode.global.js`、`anydoc_wasm_b64.js`、`mermaid.min.js` 在当前仓库快照中**缺失**（属拆分前既有问题，与本次模块化无关）；补齐这些文件后页面才能完整运行。
- 迁移备份：`renderer/index.html.bak`（拆分前原文件，可校验/回滚后删除）。
