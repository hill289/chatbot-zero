<div align="center">

# 🤖 chatbot-zero

**Zero-backend · Pure frontend · Self-hostable AI agent workbench**

A single page that packs in “LLM chat · tool calling · in-browser Node.js sandbox · virtual file system · parallel subagents · Office/document processing”,
plus an Electron multi-tab browser shell that bridges the **browser ↔ the real local disk**.

[![Electron](https://img.shields.io/badge/Electron-31-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6)](#-quick-start)
[![Runtime](https://img.shields.io/badge/Runtime-almostnode%20(Node.js%20in%20browser)-339933?logo=nodedotjs&logoColor=white)](#-architecture--how-it-works)
[![MCP](https://img.shields.io/badge/Protocol-MCP-8A2BE2)](#-built-in-tools-mcp-tools)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue)](#-license)

</div>

> [简体中文](./README.md) | **English**
>
> ⚠️ **Documentation note**: This README reflects the repository's **current actual code**. The workbench's main file is `renderer/index.html` (~**1,548 lines**; modularized — HTML shell ~1.3k lines + CSS/JS under `renderer/assets/`); its built-in code editor currently uses the **almostnode (Node.js in the browser)** runtime and is labeled **🟩 Node.js** in the UI (the historical "PGPy / Pyodide / Python" descriptions no longer apply).

---

## 📖 Table of Contents

- [✨ Introduction](#-introduction)
- [🚀 Core Features](#-core-features)
- [⚡ Quick Start](#-quick-start)
- [⚙️ Configuration](#️-configuration)
- [🧰 Built-in Tools (MCP Tools)](#-built-in-tools-mcp-tools)
- [🔌 Pluggable Tool Registry](#-pluggable-tool-registry)
- [⌨️ Keyboard Shortcuts](#️-keyboard-shortcuts)
- [🏗 Architecture & How It Works](#-architecture--how-it-works)
- [📁 Project Structure](#-project-structure)
- [🔒 Privacy & Security](#-privacy--security)
- [🧩 Compatibility](#-compatibility)
- [🛣 Roadmap](#-roadmap)
- [🤝 Contributing](#-contributing)
- [🙏 Acknowledgements & References](#-acknowledgements--references)
- [📄 License](#-license)

---

## ✨ Introduction

**chatbot-zero** is a **backend-free** AI agent workbench:

- **Model chat** is requested directly from the browser to any **OpenAI-compatible endpoint** (you supply URL / Path / Model / auth), and the API key is stored locally only;
- **All tool execution happens inside the browser** — code runs on **almostnode (Node.js in the browser)**, files are written to a **virtual file system (persisted in IndexedDB)**, search uses **ripgrep-wasm**, and document conversion uses **WASM**;
- Optionally pair it with the bundled **Electron shell** to use the workbench as a **multi-tab browser**, and additionally gain the ability to “drag a file in → obtain its real disk path → edit with AI → write back to the original file”.

> **In one sentence**: with the lowest possible deployment barrier and data risk, put a "genuinely capable AI agent" into an offline-capable, self-hostable page — and bring the token cost down in a measurable way.
>
> 🤖 **Fully AI-agent generated**: this project's code, docs, and tests are all produced by AI agents; AI output may be wrong — review, test, and assess before use.

---

## 🚀 Core Features

### 💬 AI Chat
- Works with any **OpenAI-compatible endpoint** (`URL` + `Path` + `Model`; customizable HTTP method / Content-Type / auth prefix)
- **SSE streaming** with multi-byte UTF-8-safe decoding
- Renders the model's **reasoning** (`reasoning_content`) and **reply body** (`content`) separately
- **Function calling multi-round loop**, with per-tool execution progress
- Markdown rendering + code highlighting + one-click copy; messages support **copy / edit / regenerate / continue / truncate / delete / raw⇄Markdown toggle**
- Smart “stick-to-bottom” scrolling: reading history upward won't be yanked back down
- Conversation run timer (`running x s / end x s`) and per-turn token usage / cost breakdown
- **Multimodal input**: paste / drag / pick image attachments

### ⚡ Prefix-Cache Cost Engineering
- `system` prompt and `tools` list are **byte-stable turn over turn** → continuously hits the provider's prefix cache
- An **FNV-1a fingerprint** over the full `{system, tools}` spec detects prefix drift (even changes to `description / parameters`), with explicit `invalidateSystem / invalidateTools` on change
- The main session (`main`) and subagents (`sub`) each run their **own cache line**, with no cross-contamination
- Live stats: hit / miss tokens, hit rate, and **estimated savings** (accumulated across sessions, persisted in `localStorage`)
- `stripForSend` normalizes message shape and strips internal fields before sending, keeping requests byte-stable

### 🧠 Context Management
- Continue / regenerate / clear history / truncate
- **Prefix-cache-friendly context compaction**: folds earlier turns into a summary while preserving the `system + tools` prefix to keep cache hits
- **Query History**: locally persisted, single/bulk download, JSON import & replay

### 🟩 In-Browser Node.js Editor (almostnode)
- CodeMirror 5 editing + **almostnode (Node.js compiled to WebAssembly)** for local execution
- **Virtual file system `/home/pyodide`**: natively persisted by almostnode VirtualFS to **IndexedDB** — files survive a page refresh
- Tabular query results: column sorting, NULL / number styling
- **Import / export**: file / folder (preserving directory structure) / ZIP; drag-and-drop upload (File System Access API first, `webkitdirectory` fallback)
- Double-click a file row to load it into the editor and save back; script history (`localStorage`)
- **AI Mode**: send the current code to the AI chat area in one click
- **🔁 Sync**: **batch-write AI changes back to their real disk paths** (changes are staged, then landed together when you click “Sync”)
- **⇄ File compare (web Beyond Compare)**: after the AI edits files, one-click diff of **before ⇄ after** — side-by-side / unified views, line- and **word-level** highlighting, prev/next change, show-changes-only, ignore whitespace, copy before/after text; the “before” baseline is persisted alongside the pending-sync queue (IndexedDB) and cleared after “Sync”. Changed rows show a “⇄” entry, and selecting two files compares them directly. The dialog also shows a **pending-sync checklist** (select all / none) so you can **one-click sync every checked file** without leaving the dialog.

### 🔌 Local MCP Client & Toolset
- A built-in **MCP client framework** (`mcpStore`) that reads and renders MCP `tools / resources / prompts`
- The built-in `filesystem-service` provides **23 tools** (see the [table below](#-built-in-tools-mcp-tools)), **all executed locally in the browser — no data passes through any intermediary server**
- **Multi-MCP-server management**: add multiple **Streamable HTTP** MCP services (including the `/mcp` path) in the configuration dialog
- **🔌 Pluggable tool registry**: third-party / custom tools plug in **without touching the source** (register from the panel, or via `window.registerTool` from a script); supports `handler` / `code` / `http` executors — see [Pluggable Tool Registry](#-pluggable-tool-registry)

### 🤖 Parallel Subagents
- Open multiple **independent session windows** at once (each with its own model conversation and tool context)
- Windows support drag / resize / hide / close; task queue + Promise-based `runTask`
- When the main window sends a message, each subagent's **latest final result is incrementally folded into the main conversation**, and synced windows close automatically
- `reopen_session`: the model can end the current session and continue in a **brand-new session** carrying a handoff summary

### 🗂️ Agents / Prompts / Resources
- **Agent board**: PROMPT / BACKUP columns with drag-and-drop cards; card contents are auto-assembled into the `system` prompt (reference files supported; docx text is auto-extracted)
- **Prompt templates**: loaded via MCP `prompts/list`, with a parameterized form for one-click Get
- **Resources browser**: displays via MCP `resources/list` / `templates/list`

### 📄 Office & Document Processing
- **Built-in Office editor**: **docx / xlsx / pptx** — double-click to view and edit, then save back to the Node FS / Save As / download
- Document reading: `@iyulab/anydoc` (WASM) + `mammoth` convert **Office / PDF → Markdown / text**
- **Markdown → PDF**: the `markview-web` pure-frontend typesetting engine (justified A4 pagination + KaTeX formulas + Mermaid diagrams) outputs a real PDF file
- **HTML → PPTX**: convert HTML slides into `.pptx` (PptxGenJS)

### 🖥️ Desktop Shell & Local Disk (Electron)
- **Multi-tab browser**: tab strip + address bar + back / forward / reload / home / devtools; `target=_blank` opens a new tab inside the app
- The address bar auto-detects **URLs / local paths / search terms**
- **Dropped files yield their real disk path** (`webUtils.getPathForFile`), and edits are **written back to the original file**, byte-for-byte (images / PDFs stay intact)
- Native menu and shortcuts (new / close tab, open file, zoom, fullscreen, etc.)

### 🌍 Miscellaneous
- **i18n**: English / 简体中文
- **Zero build**: no jQuery, plain native DOM, deployable as static assets
- **Responsive on mobile** (`@media` breakpoints) and optimized for desktop

---

## ⚡ Quick Start

### Requirements
- **Node.js ≥ 18** (for Electron and packaging)
- An OS with a modern browser: Windows / macOS / Linux

### 1. Clone & install

```bash
git clone https://github.com/chatbot-zero/chatbot-zero.git
cd chatbot-zero
npm install
```

### 2. Launch the desktop app

```bash
npm start        # launches the Electron multi-tab shell (home page = the workbench)
```

> **Browser-only works too**: deploy the `renderer/` directory as a static site (e.g. `npx serve renderer`) and open `index.html` in a browser to use chat, the Node sandbox, MCP tools, and other local capabilities.
> Difference: without the Electron shell, capabilities such as **“get the real disk path from a dropped file / write back to the original file / sync to disk”** are unavailable (use directory import/export via the File System Access API instead).

### 3. Build & package

```bash
npm run dist         # current platform
npm run dist:win     # Windows → nsis / portable
npm run dist:mac     # macOS   → dmg
npm run dist:linux   # Linux   → AppImage
```

Artifacts are written to `dist/`.

---

## ⚙️ Configuration

Click the **⚙️** to the left of the input box to open “Interface Configuration”:

| Group | Options |
|---|---|
| Basic | **API Key** (stored in browser `localStorage` only), **Endpoint**: `URL` + `Path` + `Model` |
| Advanced | HTTP method, Content-Type, **Stream**, **Prefix Cache**, **MCP** (toggle + multi-MCP-server list), Max Tokens, Temperature, Top P, Auth Prefix |

- Support for **importing / exporting a JSON config file**, or click 🔄 to restore defaults.
- UI language, the Agent board, Resources, History, Subagent, etc. are all reached from the ⚙️ menu.
- The **🛠️ toolbox** in the bottom-right: reset all config / force-refresh the tool list (triggers one cache miss).

---

## 🧰 Built-in Tools (MCP Tools)

The built-in `filesystem-service` provides **23 tools**, all executed locally in the browser:

| Tool | Description |
|---|---|
| `read_file` | Read a file (optionally a line range); the window is clipped by a **token budget (~6000) + line cap**, and an unfinished read always ends with `[continue] start_line=<n>`; auto-detects binary / oversized files; supports text, images, PDF, and Office documents |
| `list_dir` | List directory entries (`[DIR]` / `[FILE]`); defaults to `/home/pyodide` |
| `read_file_line_slice` | Read a character slice of an over-long single line (pairs with a truncated `read_file`); returns `next_offset` |
| `read_file_char_range` | Read text **by character offset** (not by line) — the right tool for single-line huge files / `min.js` / a one-line data URL; works up to 64 MB |
| `write_file` | Write a file (creates parent directories as needed) |
| `delete_file` | Delete a file or directory (recursive) |
| `add_content` | Insert content by line number |
| `delete_content` | Delete content by line-number range |
| `replace_lines` | Replace / delete content by line-number range (preserves CRLF/LF style) |
| `edit_file` | Exact string-match editing (more robust than line numbers); supports a uniqueness check / `replace_all` / `expected_replacements` |

| `search_content` | Regex full-text search powered by **ripgrep-wasm** |
| `read_url` | Fetch an http/https/data URL → readable text (HTML→article text, JSON prettified); binary (PDF/Office) saved to the workspace and parsed via anydoc |

| `run_node` | Execute code on **almostnode (Node.js in the browser)** |
| `run_subagent` | Launch an independent subagent window to run a subtask (can be parallel) |
| `reopen_session` | End the current session and continue in a new one carrying a handoff summary |
| `ask_user` | Ask the user a question / request approval and **pause for the answer**; supports preset options, free text, and a timeout |

| `todo_write` | Maintain the current session's todo list |
| `markdown_to_pdf` | Markdown → paginated A4 PDF (local typesetting engine) |
| `html_to_ppt` | HTML slides → `.pptx` (PptxGenJS) |
| `web_search` | Web search: defaults to **Bing** (RSS→HTML parsing), falls back to DuckDuckGo; fetched by the main process under Electron to bypass CORS, auto-degrades in a plain browser |
| `run_shell` | Run a shell command in the workspace (real subprocess, gated by approval / sandbox); supports `run_in_background` jobs |
| `run_tests` | Auto-detect and run tests / type-check / lint, returning structured failure diagnostics (file:line:col + rule/code) |
| `rewriter` | Rewrite a problem into a more solvable, more verifiable form (clarify / decompose / reverse / change-view strategies) |

> The `Prompts` and `Resources` dialogs are generic MCP-client UI; they show content only after connecting an external MCP server or extending the registration.

---

## 🔌 Pluggable Tool Registry

Beyond the built-in `filesystem-service`, the workbench ships a **pluggable tool registry** so **third-party / custom tools** can join the LLM tool-calling loop **without modifying the source**.

**How to open it**: bottom-right **🛠️ → 🔌** (Tool Registry).

**Two ways to register**:

1. **Panel registration** (no code): fill in “name / description / JSON Schema / executor” and click “Register”; supports enable/disable, delete, load examples (🧪), and JSON import/export.
2. **Script registration** (third-party plugins): global APIs are exposed so any standalone script can self-register (see `renderer/tools/example-plugin.js`):

```js
// ① Function handler (may close over plugin state; in-memory only, not persisted)
window.registerTool({
  name: 'my_tool',
  description: 'What it does and when to use it…',
  inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  handler: async (args, ctx) => ({ ok: true, echoed: args.x })
});

// ② Inline JS source (persisted to localStorage; survives reloads)
window.registerTool({ name: 'js_tool', description: '…', inputSchema: { /* … */ },
  code: "return String(args.x).toUpperCase();" });

// ③ Declarative HTTP (persisted; url / headers support {arg} interpolation)
window.registerTool({ name: 'http_tool', description: '…', inputSchema: { /* … */ },
  http: { url: 'https://api.example.com/search?q={q}', method: 'GET' } });

// Other public APIs:
// window.registerTools([...])           batch register
// window.unregisterTool(name)           unregister one
// window.listRegisteredTools()          list registered tools
// window.callRegisteredTool(name, args) call directly (for local testing)
// window.ToolRegistry.unregisterByTag('my-plugin')  bulk unregister on plugin unload
```

**How it works (zero-intrusion)**:

- The registry (`renderer/tool-registry.js`, a pure-logic module — unit-testable under Node) is mapped to a **built-in MCP server** (service key `tool-registry`) injected into `window.mcpServers`;
- As a result the existing `mcpStore.listTools / getTool / callTool`, the multi-round tool-calling loop (`runToolCalls`), the tool-trace replay and subagents all pick up new tools **with no changes**;
- Every register / unregister / enable / disable calls `prefixManager.invalidateTools()`, explicitly invalidating the `system + tools` prefix cache (a **one-time cache miss next turn**); it is byte-stable afterwards, so later cache hits are unaffected;
- Registration validates naming (`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`), guards against duplicates (with an `override` option), and checks the executor; failures come back as `isError` and render as a red “failure” tag without breaking the conversation.

**Three executor forms**:

| Executor | Form | Persisted | Notes |
|---|---|---|---|
| `handler` | function `(args, ctx) => any` | No | Most flexible; can close over plugin state; usually registered by scripts |
| `code` | inline JS source string | Yes | Runs in a function body with `args` / `ctx` (`ctx.call` can call other tools); `return` the result |
| `http` | `{ url, method, headers, bodyTemplate }` | Yes | Declarative request; GET builds the query string automatically; non-2xx is a failure |

> Tool return values are normalized to an MCP result: a string becomes text, an object is JSON-serialized; a `{ content: [...] }` shape is also accepted.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Enter` | Insert newline (does not send) |
| `Shift + Enter` | Insert newline |
| `Ctrl / Cmd + Enter` | Send message (chat input); run code in the editor |
| `Ctrl / Cmd + T` | New tab |
| `Ctrl / Cmd + W` | Close tab |
| `Ctrl / Cmd + O` | Open file |
| `Ctrl / Cmd + L` | Focus the address bar |
| `Ctrl / Cmd + R` | Reload the page |
| `Ctrl / Cmd + Shift + I` | DevTools |

---

## 🏗 Architecture & How It Works

```
┌──────────────────────────────────────────────────────────────────────┐
│ Electron shell (main.js + preload.js)                                 │
│  ├─ BaseWindow + WebContentsView multi-tab browser                    │
│  │    ├─ chrome view (renderer/browser-chrome.html): tab strip + bar  │
│  │    └─ tab view: loads renderer/index.html by default (workbench)   │
│  └─ preload.fileAPI: webUtils.getPathForFile + fs read/write/stat/…   │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Workbench renderer/index.html (HTML shell ~1.5k lines + assets/js 01..32)            │
│  ├─ AI chat layer: fetch → OpenAI-compatible SSE → incremental render │
│  │     └─ prefixManager (FNV-1a fingerprint) + cacheStatsStore        │
│  ├─ MCP layer: mcpStore (tools/resources/prompts) + multi-server(HTTP)│
│  │     ├─ filesystem-service: 23 built-in tools                       │
│  │     └─ tool-registry: pluggable third-party / custom tools         │
│  ├─ Runtime: almostnode (Node.js in the browser)                      │
│  │     └─ VirtualFS(/home/pyodide) → IndexedDB persistence            │
│  ├─ Docs: anydoc+mammoth (Office/PDF→MD); markview-web (MD→PDF);      │
│  │        html_to_ppt (HTML→PPTX); docx/xlsx/pptx editors             │
│  └─ Subagents: multi-window sessions + task queue + result feedback   │
└──────────────────────────────────────────────────────────────────────┘
```

**Data flow**: model request (with `tools`) → receive `tool_calls` → `mcpStore.callTool` **executes locally** → result written back as `role: tool` → loop until the model produces the final answer.

**Persistence locations (all browser-local)**:

| Data | Storage |
|---|---|
| `chatbotStore` / `defaultChoiceStore` / `historyStore` / `cacheStatsStore` / script history | `localStorage` |
| Agent board `agentStore` | `sessionStorage` |
| Workspace file system `/home/pyodide` | **IndexedDB** (native almostnode VirtualFS persistence) |

---

## 📁 Project Structure

```
.
├── package.json              # Electron app & electron-builder packaging config
├── main.js                   # Main process: multi-tab browser shell + filesystem IPC
├── preload.js                # Injected into the workbench: exposes fileAPI (real paths + disk I/O)
└── renderer/                 # Render layer (workbench + all local static assets)
    ├── index.html            # ★ Workbench home page (HTML shell ~1.5k lines; app JS/CSS under assets/)
    ├── tool-registry.js      # ★ pluggable tool registry (pure-logic, Node-testable)
    ├── tools/example-plugin.js  # third-party "pluggable registration" example plugin
    ├── almostnode.global.js  # Node.js-in-the-browser runtime (VirtualFS + IndexedDB)
    ├── browser-chrome.html / browser-chrome.js / browser-chrome-preload.js
    ├── marked / highlight / codemirror(+show-hint/matchbrackets/closebrackets)
    ├── jszip / mammoth / docx-preview / html-docx / FileSaver
    ├── ripgrep_wasm_b64.js / ripgrep_wasm_nomodule.js     # full-text search
    ├── anydoc_wasm_b64.js / anydoc_wasm_bg_nomodule.js / anydoc-init.js
    ├── markview-web.js / .css + katex + markdown-it + texmath + mermaid
    │                                  + html2canvas + jspdf
    ├── fonts/                # local fonts
    ├── LICENSE.txt           # third-party asset licenses
    └── README.md / README.en.md
```

> **Load order**: the script order in `renderer/index.html`'s `<head>` is deliberate (e.g. Office dependencies are injected into `window.XLSX / window.PptxGenJS` on demand via the almostnode runtime's `require`). Please do not reorder them casually.

---

## 🔒 Privacy & Security

- This project is **backend-free**: model requests go directly from the browser to the API address you configure; **the API key is stored in local `localStorage` only**.
- Tool execution (code / files / search / document conversion) **happens entirely inside the browser** — **files never leave your machine**.
- ⚠️ **Security notes**:
  - Do not save your API key on an untrusted or shared computer;
  - An in-browser Node sandbox is **not** OS-level security isolation — do not execute untrusted code;
  - For multi-user deployments, provide your own server-side proxy to hold the key and add access control.

---

## 🧩 Compatibility

- **Browsers**: latest Chrome / Edge / Firefox / Safari recommended (relies on `fetch` streaming, WASM, IndexedDB, `ResizeObserver`).
- **Model endpoints**: OpenAI-compatible `/chat/completions` style; example model names with built-in pricing: `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner` (add unit prices for other models in `CACHE_PRICING`).
- **Local models**: point `URL` at `http://127.0.0.1` (e.g. Ollama / LM Studio OpenAI-compatible gateways).

---

## 🛣 Roadmap

- [x] Released under **Apache-2.0** (root `LICENSE` / `NOTICE`)
- [x] Split into modules (CSS → `assets/css/*`, main logic → `assets/js/01..32`; `index.html` reduced to ~1,548 lines, still zero-build)
- [ ] Add unit tests (stream parsing, SSE buffering, cache fingerprinting)
- [ ] Add `CHANGELOG` / `CONTRIBUTING`
- [ ] Provide dual CDN / offline modes for static assets to shrink the initial bundle
- [ ] Add more model presets and pricing tables, and multi-provider switching
- [x] Turn the MCP toolset into a **pluggable registry** (custom third-party tools) — see [🔌 Pluggable Tool Registry](#-pluggable-tool-registry)
- [ ] Fill in resources / prompts for the built-in server, or provide an external MCP server integration example

---

## 🤝 Contributing

1. Fork this repository;
2. Create a feature branch (`feat/xxx` or `fix/xxx`);
3. Commit your changes (keep the existing Chinese comment style and naming conventions);
4. Open a Pull Request.

---

## 🙏 Acknowledgements & References

> 🤖 **This project is entirely generated by AI agents** (code, docs, and tests alike); AI output may contain errors or be outdated — please review, test, and security-assess before use.

This project references / aligns with the following open-source projects at the level of **design ideas and approach**. Only idea-level borrowings are credited here; any **code-level** reuse follows the original project's license and attribution terms (see each repository's `LICENSE`):

| Project | Idea borrowed | License / terms |
|---|---|---|
| **dsh** (agent framework) | Subagent control, tool approval (tools/pre-execute), execution guard (deadline), workspace-context injection, session source-of-truth (append-only log) | Design reference; see original license |
| **Reasonix** (`esengine/deepseek-reasonix`) | Prefix cache (CacheFirstLoop / ImmutablePrefix / CaptureShape), context compaction (agent.compact), pre-send message sanitizing (SanitizeToolPairing) | See original repo LICENSE |
| **OpenCode** | Smart child-process console decoding (`smartDecodeOutput`: strict UTF-8 → GB18030 fallback) | MIT (see original repo) |
| **Yuheng (玉衡)** (Go enterprise RAG platform) | Hybrid retrieval (vector + BM25), RRF fusion, query expansion, chunk merging | Design reference; see original license |
| **GoNavi 0.5.0** | PostgreSQL client UI/interaction clone | Apache-2.0 |
| **Puppeteer** | CDP hit-point coordinate math (`clickablePoint`) | Apache-2.0 |
| **mcp-browser-client** | MCP Streamable HTTP transport implementation reference | See original license |
| **chat-ui** | Continuous session persistence idea | See original license |

> Note: The above are **idea/approach** references and claim no rights over the original projects' copyright. If any attribution is missing or a license-compatibility issue exists, please open an Issue. **Bundled third-party code/assets** (CodeMirror, marked, highlight.js, JSZip, mammoth, ripgrep-wasm, @iyulab/anydoc, KaTeX, markdown-it, texmath, Mermaid, html2canvas, jsPDF, PptxGenJS, SheetJS, docx-preview, html-docx, FileSaver.js, Underscore, etc.) are distributed under their respective licenses — see [`renderer/LICENSE.txt`](./renderer/LICENSE.txt), [`NOTICE`](./NOTICE), and [`ACKNOWLEDGEMENTS.md`](./ACKNOWLEDGEMENTS.md).

## 📄 License

This project is released under the **Apache License 2.0** (see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE) at the repository root).

- You may freely **use, modify, and distribute** this software (including commercially);
- When distributing or creating derivative works, you must **retain the copyright and license notices** and note changes in modified files;
- Provided **AS IS**, **without any express or implied warranty** (Apache-2.0 §7/§8).

### 🙏 Third-party Assets

Copyright for the third-party assets referenced by the project belongs to their respective authors; please follow their respective licenses:

**CodeMirror, Highlight.js, Marked.js, JSZip, mammoth, ripgrep-wasm, @iyulab/anydoc, KaTeX, markdown-it, texmath, Mermaid, html2canvas, jsPDF, PptxGenJS, SheetJS(xlsx), docx-preview, html-docx, FileSaver.js**, etc. (mostly MIT / BSD / Apache-2.0 — see `renderer/LICENSE.txt` for details).

---

<div align="center"><sub>This README is compiled from the repository's current code; feature details are subject to the actual code.</sub></div>
