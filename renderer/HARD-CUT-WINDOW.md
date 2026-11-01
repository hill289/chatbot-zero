# 硬切窗口（Hard-Cut Window）

> 核心观念变更：**上下文 ≠ 记忆**。
> 上下文只是「工作台」；记忆由三部分组成：**工作状态 + 指针 + 可查询历史**。

以前的做法是「上下文就是记忆」——快满时把旧对话压缩成摘要，摘要仍然塞回上下文。
硬切窗口换了一种做法：**不压缩，直接清空**；但在清空之前把重要信息落到可以重新找到的地方。

这和人类程序员的工作方式一致：脑内工作记忆有限，满了就写到 TODO / 笔记里，
需要细节时回去翻聊天记录、git log、issue —— 而不是把所有东西都硬背在脑子里。

---

## 1. 三个阶段

```
上下文接近上限（>= 85% 窗口）
        │
        ├─① 写笔记   note_write(text, kind)      ← 模型主动记录（可选）
        │            buildWorkingState()          ← 确定性抽取兜底（目标/硬约束/文件/未完成计划）
        │
        ├─② 归档     sessionLog.sync(conversation)
        │            → messages/<sid>/events.jsonl（append-only，完整转录）
        │            → 返回「指针」{sid, toSeq, messages, ts, title}
        │
        └─③ 硬切     丢弃整个 conversation 数组
                    新窗口 = 一条 <hard-cut-handoff> 消息（工作状态 + 笔记 + 指针 + 纪律）
                    新数组 => 新 sid；旧数组仍被 Query History 条目引用，历史不丢
```

新窗口的请求量立刻降回「system + tools + 一条交接消息」的量级，
后续任何回忆都按需走工具，不再占用常驻上下文。

---

## 2. 四类信息分别放在哪

| 内容 | 存放位置 | 生命周期 |
|------|----------|----------|
| **工作状态**（目标 / 硬约束 / 相关文件 / 未完成计划） | 交接消息 `<hard-cut-handoff>` + `planStore` | 随新窗口注入；计划变化时重新注入 |
| **工作笔记**（决策 / 事实 / 待办 / 约束） | `localStorage['hardCutNotes']`（`notesStore`） | 跨窗口持久；可 `note_write` / `note_read` |
| **历史指针** | 交接消息里的 `sid + 事件序号 + 时间 + 标题` | 指向磁盘归档 |
| **完整转录历史** | `messages/<sid>/events.jsonl`（append-only） | 永久；`search_transcript` / `read_transcript` 检索 |

> 注意：硬切**不生成大模型摘要**（那仍然是「压缩」）。`buildWorkingState` 只是
> 对消息做确定性抽取；语义级的「该记什么」由模型自己用 `note_write` 决定。

---

## 3. 触发点

| 触发 | 位置 | 行为 |
|------|------|------|
| 用户发送新消息前 | `messageStore.sendMessage → _maybeHardCutBeforeTurn` | 压力 ≥ 阈值且处于安全边界 → 先归档硬切，本轮新指令作为新窗口首条真实 user 消息 |
| 上下文超长报错 | `messageStore.autoRecoverContextOverflow` | 首选硬切（`_pendingRestart = {hardCut:true}`）→ 新窗口接管；失败才回退到旧的裁剪/交接两级兜底 |
| 其它入口（继续对话 / 子代理） | `startInference` 每轮开头 | 已由 `_maybeHardCutBeforeTurn` 覆盖主路径；循环内溢出由 `_pendingRestart` 结束本轮 |
| 模型主动 | `hard_cut` 工具 | 返回 `structuredContent.sessionRestart` → 回合结束后切换窗口 |
| 菜单手动 | More → `✂️ Hard cut window` | 立即归档并切换（非生成中、且处于安全边界） |

**安全边界**：尾部不能是孤立的 `tool` 结果，也不能是等待配对的 `assistant.tool_calls`。
否则会破坏工具调用链（`sanitizeToolPairing` 只能补占位结果，语义会丢）。

---

## 4. 工具

| 工具 | 作用 |
|------|------|
| `note_write(text, kind, tags, pinned)` | 写工作笔记（去重、有上限、可置顶） |
| `note_read(query?, limit?)` | 读回 / 检索笔记 |
| `search_transcript(query, limit?)` | 全文检索归档转录，返回会话指针 + 命中片段 |
| `read_transcript(session_id, from_seq?, offset?, limit?)` | 按指针读取归档原文 |
| `hard_cut(reason?, next_task?)` | 模型主动切换窗口（先归档再交接） |

`search_transcript` / `read_transcript` 优先走主进程 IPC（`msg:search` / `msg:read`），
在纯浏览器直开（无 Electron）时降级到本地归档 `localStorage['hardCutArchive']`。

---

## 5. 配置

`chatbotStore`（⚙️ 配置 / localStorage）新增：

```js
hardCutEnabled: true,        // 总开关
contextWindowTokens: 1048576, // 模型上下文窗口大小（默认 1024K；按实际模型填，64K 模型请写 64000）
hardCutRatio: 0.85,          // 达到窗口的多少比例触发
```

真实用量优先：最近一次请求的 `usage.prompt_tokens` 作为基准，加上之后新增消息的估算；
没有 usage 时退化为字符估算（中文约 0.6 token/字，英文约 4 字符/token）。

---

## 6. 代码位置

| 文件 | 改动 |
|------|------|
| `assets/js/23-hard-cut.js` | **新增**：纯函数（估算/压力/边界/工作状态/渲染）+ `notesStore` + `transcripts` + 工具注册 |
| `assets/js/09-chat-store.js` | `hardCutContext` / `_composeHardCut` / `_maybeHardCutBeforeTurn`；溢出改走硬切；`startNewSession` 支持 `hardCut` |
| `assets/js/08-ui-store.js` | More 菜单项；`chatbotStore` 默认配置 |
| `assets/js/12-render.js` | 交接消息的系统提示条样式（✂️ 橙色） |
| `main.js` / `preload.js` | `msg:search`：跨 `messages/<sid>/events.jsonl` 的转录全文检索 |
| `index.html` | 加载 `23-hard-cut.js` |
| `renderer/hard-cut.test.js` | 14 个单测（估算 / 阈值 / 边界 / 抽取 / 渲染 / 笔记 / 归档检索） |

---

## 7. 与旧机制的关系

- `compactContext()`（摘要式压缩）**保留为显式入口**（More 菜单 / 手动调用），但不再是自动路径。
- `_hardTrimContext()`（溢出时原地裁剪）降级为**兜底**：仅当硬切模块不可用或构造失败时使用。
- `reopen_session`（模型主动重开）继续可用；其新会话首条消息现在会附带工作笔记快照。
- `sessionLog`（append-only 事件日志）是归档的底座：硬切依赖它把旧对话完整落盘，
  并保证「model-visible ⟺ logged」不变量不被破坏（切换后新数组分配新 `sid`）。
