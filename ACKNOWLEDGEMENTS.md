# 🙏 参考与致谢 / Acknowledgements & References

## 关于本项目（AI 生成说明）

**chatbot-zero 的代码、文档与测试完全由 AI Agent 生成。** AI 产出可能存在错误、过时或不一致之处，**采用前请自行审阅、测试与安全评估**。欢迎通过 Issue / PR 反馈与修正。

## 一、思路借鉴参考的开源项目

本项目在**设计思路与方法**上参考/对齐了以下开源项目。此处仅致谢「思路层面」的借鉴；凡涉及**代码级**沿用，均遵循原项目的许可证与署名约定（**具体以其各自仓库的 `LICENSE` 为准**）。思路借鉴不主张对原项目著作权的任何权利。

| 项目 | 借鉴内容 | 本项目对应实现 | 许可证 / 约定 |
|---|---|---|---|
| **dsh**（Agent 框架） | 子代理控制（list_agents / send_message / interrupt_agent）、工具审批（tools/pre-execute）、执行守卫（deadline）、工作区上下文注入、会话事实源（append-only 事件日志） | `renderer/agent-control.js`、`renderer/approval.js`、`renderer/guard.js`、`renderer/context/workspace-context.js`、`renderer/assets/js/18-session-log.js` | 设计思路参考；以原项目许可为准 |
| **Reasonix**（DeepSeek 原生终端编程 Agent，`esengine/deepseek-reasonix`） | 前缀缓存（CacheFirstLoop / ImmutablePrefix / agent.CaptureShape·CompareShape）、上下文压缩（agent.compact）、发送前消息清洗（SanitizeToolPairing） | `renderer/assets/js/10-prefix-cache.js`、`renderer/assets/js/09-chat-store.js`、`renderer/assets/js/11-completion.js` | 以原仓库 LICENSE 为准 |
| **OpenCode**（`opencode.ai`） | 子进程控制台输出智能解码（`smartDecodeOutput`：严格 UTF-8 → GB18030 回退） | `renderer/console-encoding.js` | MIT（以原仓库为准） |
| **玉衡 Yuheng**（Go 版企业 RAG 知识平台） | 混合检索（向量 + BM25）、RRF 融合、查询扩展、相邻分块合并 | `renderer/memory/memory-layer.js`、`renderer/knowledge/` | 设计思路参考；以原项目许可为准 |
| **GoNavi 0.5.0**（`Syngnat/GoNavi`） | PostgreSQL 客户端的视觉与交互复刻 | `dbclient/`、`renderer/dbview/` | Apache-2.0 |
| **Puppeteer** | CDP 点击命中点坐标换算（`clickablePoint`） | `renderer/CDP-BROWSER-CONTROL.md`、`browser-cdp.js` | Apache-2.0 |
| **mcp-browser-client** | MCP Streamable HTTP 传输实现参考（JSON-RPC 2.0 / mcp-session-id） | `renderer/assets/js/07-mcp.js` | 以原项目许可为准 |
| **chat-ui** | 会话持续持久化思路 | `renderer/assets/js/09-chat-store.js` | 以原项目许可为准 |

> 若你认为某处借鉴应补充署名，或存在许可证兼容性问题，请提交 Issue，我们会及时补正。

## 二、实际捆绑的第三方代码 / 资源

项目**实际捆绑**的第三方前端库与资源（CodeMirror、marked、highlight.js、JSZip、mammoth、ripgrep-wasm、@iyulab/anydoc、KaTeX、markdown-it、texmath、Mermaid、html2canvas、jsPDF、PptxGenJS、SheetJS(xlsx)、docx-preview、html-docx、FileSaver.js、Underscore 等，多为 MIT / BSD / Apache-2.0）各自按其许可证分发。完整清单与版权声明见 `renderer/LICENSE.txt`，本仓库根目录的 `NOTICE` 也做了指向说明。

## 三、许可证

本项目自身以 **Apache License 2.0** 发布，见根目录 [`LICENSE`](./LICENSE)。
