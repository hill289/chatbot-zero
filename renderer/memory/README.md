# 本地记忆层（Local Memory Layer）

给「chatbot-zero」补上**零后端、本地持久化**的长期记忆能力：
**自动召回 + 画像注入 + 会话检索**。检索链路的算法提炼自 `Yuheng-main`
（玉衡，Go 版企业 RAG 知识平台），改造成纯前端实现，数据落在浏览器
**IndexedDB**，不经过任何服务器。

```
renderer/memory/
├── memory-layer.js          # 核心引擎（纯逻辑，UMD：浏览器 window.AgentMemory / Node module.exports）
├── memory-bootstrap.js      # 接线层（注册 MCP 工具 + 自动召回/画像注入钩子）
├── memory-layer.test.js     # Node 自检（25 项断言，零依赖）
└── README.md                # 本文档
```

---

## 1. 从 Yuheng 提取了哪些关键逻辑

| Yuheng（Go）源码 | 关键逻辑 | 本模块对应实现 |
|---|---|---|
| `internal/application/service/knowledgebase_search_fusion.go` | 向量 + 关键词**混合检索**；`fuseWithRRF`：`score = w/(k+rank)`；单模 `deduplicateByScore` | `hybridSearch`（`search()`）、`rrfFuse()`、`dedupeByScore()` |
| `chat_pipeline/filter_top_k.go` | 确定性排序后再截断 TopK（分数→知识ID→分块序） | `deterministicSort()` + `filterTopK()` |
| `chat_pipeline/query_expansion.go` | 低召回时的本地查询扩展：停用词、短语、分隔符、疑问词 | `expandQueries()` |
| `chat_pipeline/merge_overlap.go` | 相邻分块的时序合并（重叠/相邻） | `mergeAdjacent()` |
| `chat_pipeline/references.go` | 把检索上下文注入到**最后一条 user 消息**（不改前缀） | `composeRecall()` → bootstrap 注入 |
| `internal/application/service/message.go` | 跨会话消息检索（`SearchMessages` / `message search`） | `sessionSearch()` / `indexTurns()` |
| dsh 记忆插件的「用户画像注入」思想 | 结构化用户画像（key→value）随轮注入 | `profile` 存储 + `recall()` |

> 说明：Yuheng 把「检索 → 重排 → 融合 → 过滤 → 组装上下文」拆成事件驱动插件管线；
> 本项目是单文件纯前端应用，故把其中**与记忆最相关的四个环节**
> （查询扩展、混合检索+RRF、TopK、上下文注入）本地化重实现，并加了
> IndexedDB 持久化与「会话/画像」两类记忆。

---

## 2. 检索流水线

```
用户输入
  │
  ├─(可选) 查询扩展 expandQueries()           ← 关键词串 / 引号短语 / 长片段 / 去疑问词
  │
  ├─ 向量召回  cosine(hashEmbed(q), item.vec)  ┐
  │                                           ├─ RRF 融合 rrfFuse(k=60, w=1,1)
  ├─ 关键词召回 BM25(qtf, doc, df, N, avgdl)   ┘
  │
  ├─ 去重 dedupeByScore() → 确定性排序 deterministicSort() → 截断 filterTopK()
  │
  └─ 组装 composeRecall(画像 + 记忆 + 会话片段) → 注入「最后一条 user 消息」
```

- **向量器**：默认内置「哈希 n-gram 向量器」`hashEmbed()`（signed hashing trick +
  词频对数加权 + L2 归一化），**离线可用、中英文通用、确定性**。可通过
  `createEngine({ embedder })` 换成真正的 WASM 神经嵌入（如 transformers.js），
  接口保持 `(text) => Float32Array | Promise<Float32Array>` 不变。
- **分词**：中文按「单字 + 二元组」，英文/数字按词（下划线再拆），兼顾召回与排序。
- **前缀缓存友好**：召回内容只注入对话尾部，**绝不**改动被 `prefixManager`
  缓存的 `system + tools` 前缀，因此**不破坏前缀缓存命中**。

---

## 3. 数据模型（IndexedDB）

数据库 `agent-memory`（v1），两个对象仓库：

| 仓库 | keyPath | 记录 |
|---|---|---|
| `items` | `id` | `{ id, kind, text, ts, sessionId, role, tags, meta, hash, vec:Float32Array, dim }` |
| `meta` | `key` | `{ key:'profile', facts:[{key,text,updatedAt}] }` |

`kind` 取值约定：`memory`（长期记忆）、`fact`、`note`、`preference`、`doc`、
`turn`（会话轮次，自动索引）。`id` 为**内容寻址**稳定哈希（`stableId`），重复写入同内容自动幂等。

> 无 IndexedDB 的环境（Node / 浏览器内 Node 运行时异常）自动降级为内存存储；
> 初始化还带 2.5s 超时保护，避免个别环境 `indexedDB.open()` 不回调导致挂起。

---

## 4. 三类能力

### 4.1 自动召回（Auto Recall）
每轮对话前，对最新一条 user 消息做混合检索，把「用户画像 + 相关长期记忆」拼成
一个块，追加到**最后一条 user 消息的开头**（保持前缀缓存与历史消息字节不变）。

### 4.2 画像注入（Profile Injection）
一组结构化事实（key→value），存在 `meta.profile`，随召回一并注入。可由模型调用
`memory_profile_set` 维护，也可由界面手动设置。

### 4.3 会话检索（Session Search）
把每轮 `user/assistant` 内容增量索引进 `items(kind='turn')`（内容哈希去重），
`session_search` 对**跨会话历史对话**检索，并可对同会话相邻片段做时序合并。

---

## 5. 接入方式

### 5.0 启用开关（默认不启用）
记忆层由 `chatbotStore.memory` 控制，**默认关闭**：

```js
chatbotStore.memory = {
  enabled: false,          // 总开关：默认 false（不启用）
  autoRecall: true,        // 启用后是否自动召回
  autoIndexTurns: true,    // 启用后是否自动索引会话
  recallLimit: 6           // 自动召回条数上限
};
```

- 关闭时：**不初始化 IndexedDB**、不自动召回 / 画像注入、不索引会话，
  `memory_*` / `session_search` 工具也不会下发给模型（零副作用）。
- 开启方式：「⚙️ 配置 → Advanced → 🗂️ 本地记忆」勾选「启用 memory」；保存后立即生效
  （懒初始化引擎 + 注册工具，并触发一次工具前缀缓存失效）。
- 也可运行时切换：`window.AgentMemoryBridge.config({ enabled: true })`（或 `setEnabled(true)`）。

### 5.1 加载脚本（已改 `renderer/index.html`，在 `</body>` 前）
```html
<script src="./memory/memory-layer.js"></script>
<script src="./memory/memory-bootstrap.js"></script>
```

### 5.2 自动召回钩子（已改 `renderer/index.html` 的 `agentStore.promptMessage`）
```js
const base = [{ content: prefixManager.getSystem(), role: "system" }, ...conversation];
try {
  if (window.AgentMemoryBridge && typeof window.AgentMemoryBridge.enhance === 'function') {
    return await window.AgentMemoryBridge.enhance(base, conversation);   // 自动召回 + 画像注入
  }
} catch (_) { /* 记忆层故障不影响对话 */ }
return base;
```

### 5.3 工具注册（`memory-bootstrap.js` 通过 `window.registerTool` 零侵入注册）
注册后自动进入既有工具调用循环与 `prefixManager` 工具指纹（首次注册引发一次
`invalidateTools()` 缓存失效，属预期的一次 cache miss）。

| 工具 | 作用 |
|---|---|
| `memory_search` | 长期记忆混合检索 |
| `memory_recall` | 自动召回块（画像+记忆+会话片段） |
| `memory_write` | 写入一条长期记忆 |
| `memory_profile_get` / `memory_profile_set` | 读写用户画像 |
| `memory_forget` | 按 id 或 query 删除记忆 |
| `session_search` | 跨会话历史对话检索 |

---

## 6. API 参考（`window.AgentMemory` / `engine`）

```js
const eng = window.agentMemory;              // 已初始化
await eng.add({ kind:'memory', text:'…' });  // 写入
await eng.addMany([…]);
await eng.search('前缀缓存', { kinds:['memory'], limit:8 });   // 混合检索
await eng.recall('我该怎么写注释？', { limit:6 });               // → { block, items, profile }
await eng.getProfile(); await eng.setProfile([{key,text}]); await eng.upsertProfile({key,text});
await eng.indexTurns(conversation, { sessionId:'main' });        // 幂等
await eng.sessionSearch('多标签', { limit:5 });
await eng.stats(); await eng.exportJSON();
await eng.clear();                               // 清空全部（条目 + 会话索引 + 画像）
window.AgentMemoryBridge.config({ enabled: true, autoRecall:true, recallLimit:6 });  // 总开关 + 细项
```

一键清空入口：输入区 **More(⋯) 菜单 → 🧹 Clear memory (清空全部记忆)**，
先弹确认框列出条目数/分类/画像数，确认后调用 `engine.clear()` 并给出 snackbar 反馈
（实现见 `renderer/assets/js/08-ui-store.js` 的 `clearAllMemory`）。

引擎构造：
```js
AgentMemory.createEngine({
  storage: AgentMemory.storage.indexedDB(), // 或 .memory()；缺省自动选择
  dim: 256,                                  // 哈希向量维度
  rrfK: 60, vectorWeight: 1.0, keywordWeight: 1.0,
  embedder: async (text) => myWasmEmbedder(text)  // 可选：接 WASM 神经嵌入
});
```

---

## 7. 测试

```bash
node renderer/memory/memory-layer.test.js   # 25 项断言：分词/向量/RRF/BM25/画像/会话检索/召回组装…
```

自检覆盖：分词、向量归一化与相似度、RRF 公式与排序、去重/TopK、查询扩展、
BM25、混合检索（中/英/类型过滤）、画像读写、会话检索、召回组装、相邻合并、导入导出。

---

## 8. 隐私与安全

- 记忆全部存于**浏览器本地 IndexedDB**，不出本机、不经服务器；
- **一键清空**：More(⋯) 菜单 → 🧹 Clear memory，确认后彻底清空本地记忆与画像，不可撤销；
- 召回内容标注「可能与当前问题无关，冲突以用户输入为准」，降低幻觉与串扰；
- 记忆层任何异常都**静默回退**，绝不影响主对话（见钩子 try/catch）；
- 关于密钥/沙箱：记忆层不涉及密钥存储；工作台自身的 Node 沙箱安全边界不变。

---

## 9. 后续可扩展

- 用 WASM 神经嵌入（transformers.js / ONNX）替换 `hashEmbed`，提升语义召回；
- 记忆的遗忘/衰减策略（按 `ts` + 命中次数做 TTL/降权）；
- 由模型在对话中自动抽取「值得记住的事实」写入 `memory_write`（自动记忆沉淀）；
- 记忆的冲突消解与来源引用（对齐 Yuheng 的 references 与知识健康）。
