# 知识库层 · Knowledge Base（知识摄取 + 引用问答 + 知识健康）

给「chatbot-zero」补上**零后端、本地持久化**的团队知识库能力：
文档摄取 → 混合检索（向量 + BM25）→ 带引用的问答 → **知识健康闭环**
（重复/近重复检测 + 差异高亮、复审周期提醒、差评归因、分配到人）。

检索链路的算法提炼自 **Yuheng**（玉衡，Go 版企业 RAG 知识平台），
**知识健康**部分高保真移植自其 `internal/application/service/findings/`；
数据全部落在浏览器 **IndexedDB**，不经任何服务器。

```
renderer/knowledge/
├── kb-store.js               # 存储层（IndexedDB: agent-kb）：知识库/文档/分块/发现项/反馈/引用/成员
├── kb-ingest.js              # 摄取：分块(标题感知/500字/80重叠) → 向量化 → 入库 → 触发体检
├── kb-search.js              # 混合检索：向量+BM25 → RRF → TopK；含 superseded 排除、近邻检索
├── kb-qa.js                  # 引用问答：[S1..Sn] 注入块、引用解析、引用关系落库、反馈落行
├── kb-steward.js             # 负责人/背书/复审到期/AssignRule 路由
├── kb-todo.js                # 个人知识待办、徽标计数、到期清单、摘要
├── kb-source.js              # 本地路径数据源：文件夹扫描 → 摄取入库 → 停用缺失（提问即在此作答）
├── kb-health/
│   ├── divergence.js         # Myers diff + 锚点对齐（区分「复制」与「有出入」）+ 差异高亮分段
│   ├── duplicate.js          # 近重复检测器（双向对称最近邻 → duplicate/divergent）
│   ├── detector.js           # 发现项运行器（指纹幂等 / Reconcile / 路由）
│   ├── review.js             # 复审周期检测器 + sweep（小时级/启动即扫）
│   ├── dispute.js            # 差评归因检测器（since lastVouchedAt）
│   └── settle.js             # 结案：取代 / 确认 / 忽略(带理由) / 改派
├── kb-bootstrap.js           # 接线：注册 kb_* 工具 + 对话钩子 + sweep + 通知
├── kb-ui.js / kb-ui.css      # 面板：📚 知识库 / 🩺 知识健康 / ✅ 我的待办
├── kb-layer.test.js          # Node 自检（100 项断言，零依赖）
└── README.md
```

---

## 1. 从 Yuheng 移植了哪些关键逻辑

| Yuheng（Go）源码 | 关键逻辑 | 本模块对应实现 |
|---|---|---|
| `types/knowledge_finding.go` | finding 三型（duplicate/divergent/stale）+ severity + status 状态机 | `kb-store.FINDING` 常量 + `findings` 仓库 |
| `findings/duplicate.go` | 双向对称最近邻、minRunes=40、maxRelated=20、overlap 0.5 阈值、证据 N=3 | `kb-health/duplicate.js` |
| `findings/divergence.go` | normalizeSpace、锚点≥8、maxEdits=600、Myers 回溯、excerptAround | `kb-health/divergence.js`（逐行对应） |
| `findings/review.go` | 到期即检测、双周期升 warning、evidenceHash=dueAt、sweep 每小时 | `kb-health/review.js` |
| `findings/dispute.go` | since lastVouchedAt 计数、≥3 升 warning、hash(计数+最新反馈) | `kb-health/dispute.js` |
| `findings/runner.go` | 指纹去重取最强证据、AssignRule 路由、回退另一侧 | `kb-health/detector.js` |
| `repository.Reconcile` | upsert 幂等 + dismissed 保持（证据不变）+ 未上报 → resolved(system/cleared) | `kb-health/detector.js#reconcile` |
| `service/message_feedback.go` | 👎 → 被引文档逐篇落行（≤10）→ 触发复检；👍 不驱动维护 | `kb-qa.recordFeedback` + `dispute.recheckFeedback` |
| `knowledge_stewardship.go` | owner / lastVouchedAt / reviewDueAt / 背书重启时钟 | `kb-steward.js` |
| `knowledgebase_search_fusion.go`、`chat_pipeline/*` | 混合检索、RRF、TopK、查询扩展 | `kb-search.js`（与 `memory-layer.js` 同源） |

---

## 2. 知识健康：三个检测器 + 一个运行器

```
文档新增/更新（ingest）
   │  changed → debounce 触发
   ▼
Runner.run(kbId, docId)
   ├─ duplicate 检测器：对每个分块在同库其他文档找 top-5 近邻
   │     · 【双向】再从对方跑一次，取并集（NN 非对称，单向结果会漂移）
   │     · 文本比对：有出入 → divergent(warning)；逐字相同 → duplicate(info/warning)
   │     · 证据：≤3 对分块，差异对优先，带摘录 + overlapRatio
   ├─ review 检测器：lastVouchedAt + interval 已过 → stale（逾期 2 周期升 warning）
   └─ feedback 检测器：since lastVouchedAt 的差评数 ≥1 → disputed（≥3 升 warning）
   │
   ├─ 指纹去重（同问题取最强证据）→ AssignRule 路由到具体负责人
   └─ Reconcile 幂等对账：
        上报 → upsert（open 保持 / resolved 重开 / dismissed 证据变才重开）
        未上报 → resolved（resolvedBy=system，问题自己好了）
```

**差异高亮**：`divergence.diffSegments(a,b)` 产出 `eq/del/ins` 分段，面板把
`del` 渲染成红色删除、`ins` 渲染成绿色插入，**并排对照**——这正是
「15 天 vs 10 天」这类「改个数字」差异的呈现方式（embedding 分不出，
必须文本级比对）。

---

## 3. 数据模型（IndexedDB `agent-kb` v1）

| 对象仓库 | keyPath | 记录 |
|---|---|---|
| `kbs` | `id` | 知识库（`reviewIntervalDays`、`defaultOwnerId`） |
| `documents` | `id` | 文档（`ownerId`/`lastVouchedAt`/`status`/`supersededBy`/`version`/`contentHash`/`text`） |
| `chunks` | `id` | 分块（`text`/`vec`:Float32Array/`enabled`/`seq`/`heading`） |
| `findings` | `id` | 发现项（`fingerprint`/`type`/`severity`/`status`/`subjectDocId`/`relatedDocId`/`details{evidence,overlapRatio,evidenceHash}`/`assigneeId`/`assignedBy`） |
| `feedback` | `id` | 反馈（按 `messageId+docId` upsert，逐篇被引文档一行；`question` 仅在用户选择共享时带出） |
| `citations` | `id` | 引用关系（消息 → 被引 chunk/doc —— 差评归因的数据前提） |
| `members` | `id` | 成员（负责人） |
| `meta` | `key` | 杂项 |

> **supersede 不删除**：旧文档标 `status='superseded'` + 分块 `enabled=false` →
> 检索自动排除，历史引用仍可回溯（这是「过期制度不再被引用」的落点）。

---

## 4. 六条核心链路

1. **摄取**：`kb-ingest.ingest()` 内容寻址幂等（内容变才 `version+1`）；标题/段落
   感知分块（目标 500 字 / 重叠 80 / 短于 40 字丢弃）；向量化（默认 `hashEmbed`，
   可注入神经嵌入）；变更即触发体检。
2. **检索**：向量 cosine + BM25 → RRF(k=60) → 去重 → 确定性排序 → TopK；
   仅 `active` 文档、仅 `enabled` 分块。
3. **引用问答**：检索片段编号 `[S1..Sn]` 注入最后一条 user 消息；回答渲染
   **引用角标 + 来源列表**（悬停看摘录）；把「消息 → 被引文档」回写。
4. **近重复**：见上；`dismissed` 状态在证据不变期间保持，证据变自动重开。
5. **复审 + 差评**：`review.startSweep()` 启动即扫 + 每小时；`👎` → 落行 → 触发
   dispute 复检 → 负责人待办出现；**确认/修改即背书，时钟重启、争议归零**。
6. **路由与结案**：`AssignRule`（latest_hand / stalest_owner / subject_owner）+
   缺人回退 + 默认负责人兜底；三种结案（取代 / 确认仍有效 / 忽略带理由）+
   手工改派（`assignedBy` 置位后自动路由不覆盖）。

---

## 5. 接入方式（已改 `renderer/index.html`）

```html
<!-- </body> 前，memory 层之后 -->
<script src="./knowledge/kb-store.js"></script>
... (见 index.html)
<script src="./knowledge/kb-bootstrap.js"></script>
<script src="./knowledge/kb-ui.js"></script>
```

三处钩子（均静默回退，失败不影响对话）：

```js
// 1) agentStore.promptMessage：引用注入（只改对话尾部，不碰前缀缓存）
base = await window.KBBridge.enhance(base, conversation);
// 2) createCompletion 流结束：回写 [Sn] 引用关系
window.KBBridge.finalizeTurnAnswer(messageStore.conversation);
// 3) renderMessage：引用角标 / 来源列表 / 👍👎
window.KBUi.decorate(message, msg);
```

入口：工具箱（🛠️）里的 **📚**（带未处理数徽标）。

### 注册的工具（`kb_*`）

| 工具 | 作用 |
|---|---|
| `kb_search` | 混合检索（带来源） |
| `kb_ingest` | 摄取（分块+向量化+触发体检）：`text` 正文，或 `file_path` 读本地文件——Office/PDF 自动经 anydoc 转 Markdown |
| `kb_health_check` | 全库/单文档体检，返回发现清单 |
| `kb_findings` | 列出发现项（按状态/负责人过滤） |
| `kb_settle` | 处理发现项：confirm / dismiss / supersede / assign |
| `kb_todo` | 我的知识待办 |
| `kb_source` | 配置/同步「本地知识库路径」：status / set_path / scan / sync |
| `kb_members` | 成员（负责人）管理 |

---

## 6. 本地知识库路径（kb-source）

把磁盘上的某个文件夹直接配置为某知识库的数据源，**提问即在该路径内容上作答**。

- **选择 / 扫描**：面板「📁 本地知识库路径」→「📂 选择文件夹」（Electron 系统对话框）
  或手填绝对路径；「🔄 扫描并同步」递归扫描（按扩展名过滤）→ 逐篇读取正文
  → 摄取入库（`sourceKey = 文件绝对路径`，内容寻址幂等）。
- **正文提取**：`.md/.txt/.csv/.json/.html…` 直接解码（HTML 去标签）；
  `.pdf/.docx/.pptx/.xlsx…` 走 `anydoc` → Markdown（与拖拽解析同一后端）。
  **Office/PDF 三条摄取入口（本地路径同步 / 面板「📄 本地文件…」/ `kb_ingest`
  的 `file_path`）统一先 `whenAnydocReady()` 等 WASM 就绪再转 Markdown**——
  启动即同步不误报「不支持该格式」，且二进制绝不按 UTF-8 硬解（不乱码入库）。
- **增量**：重复同步安全无副作用（内容不变 = 跳过）；文件内容变化 → `version+1`；
  文件被删除 → 对应文档 `status='disabled'`（**不删除**，检索自动排除，文件回来即自动重新生效）；
  **扫描被截断时不判定「缺失」**，避免误停用。
- **提问作答**：本地文档与手工摄取 / URL 文档同库同检索（向量 + BM25 + RRF）；
  设为「当前知识库」后每轮自动注入 `[S1..Sn]` 引用 → 带来源回答；该选择持久化到
  `meta.activeKbId`，重载后仍作用于同一路径。
- **可选自动同步**：勾选「启动时自动同步」后，应用启动即扫描一次该路径。

配置按知识库维度存在 IndexedDB `agent-kb` 的 `meta`（key = `kb.source.<kbId>`）：
`rootPath / includeExts / subdirs / maxFiles / maxFileBytes / autoSyncOnStart /
lastScanAt / lastSyncAt / lastSummary`。

```js
// 面板 / 工具等价入口
await KBBridge.setLocalPath(kbId, 'D:\\公司制度', { subdirs: true, autoSyncOnStart: true });
await KBBridge.syncSource(kbId);          // 扫描并同步
await KBBridge.sourceStatus(kbId);        // 查看配置与计数
// 或让模型调用 kb_source 工具：{ action: 'set_path', path: 'D:\\公司制度' }
```

**主进程接线**（见 `main.js` / `preload.js`）：`kb:pick-dir`（文件夹选择）、
`kb:scan`（递归扫描 + 扩展名过滤 + 上限，自动跳过隐藏目录与 `node_modules/.git`），
仅受信来源（工作台主页）可调用；渲染层经 `fileAPI.pickDirectory / fileAPI.scanDir /
fileAPI.read` 使用。非 Electron 环境在面板中标注「无文件系统访问」。

---

## 7. 通知（到期提醒）

`kb-bootstrap.remindDue()` 在启动后与 sweep 时检查到期文档，经
`KBBridge.onNotify` → `fileAPI.notify(title, body)` → 主进程
`ipcMain.handle('app:notify')` → Electron `Notification`；非 Electron 环境
回退浏览器 `Notification`，再退回面板内 toast。

---

## 8. 测试

```bash
node renderer/knowledge/kb-layer.test.js     # 100 项断言，零依赖（内存后端）
```

覆盖：分块/幂等摄取、混合检索与 superseded 排除、`[Sn]` 引用解析与落库、
**15天/10天 divergent 检测 + diff 高亮分段**、逐字复制 duplicate、双向近邻对称、
指纹幂等（重复检查不产生重复发现）、evidenceHash「忽略保持 / 证据变重开」、
复审判定（双周期、关闭周期）、差评归因（info→warning、背书归零、问题仅共享时入证据）、
AssignRule 三规则 + 回退、四种结案状态机、待办与摘要、
**本地路径数据源（扫描/过滤/首次入库/幂等/变更更新/删除停用/恢复重生效/截断不误停用/HTML 去标签）**、
存储统计与门面转发。

---

## 9. 隐私与安全

- 知识、引用、反馈全部存**浏览器本地 IndexedDB**，不出本机、不经服务器；
- 差评的**原始问题仅在用户勾选「附上我的问题」时才写入证据**（默认不带，对齐 Yuheng）；
- 知识层任何异常**静默回退**，绝不影响主对话与工具循环；
- 引用注入只追加到对话尾部，**不破坏前缀缓存**（与记忆层同一纪律）。
