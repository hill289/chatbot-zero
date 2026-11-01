/*!
 * memory-bootstrap.js — 把本地记忆层「零侵入」接入工作台
 * =============================================================================
 * 依赖（均已在工作台内可用）：
 *   · renderer/memory/memory-layer.js   → window.AgentMemory（核心引擎）
 *   · renderer/tool-registry.js         → window.registerTool（可插拔工具注册）
 *   · renderer/index.html 的 promptMessage 钩子 → window.AgentMemoryBridge.enhance
 *
 * 本文件做三件事：
 *   1) 按配置 chatbotStore.memory.enabled（默认 false = 不启用）决定是否创建并初始化记忆引擎
 *      （IndexedDB 持久化，失败/超时自动降级内存），挂到 window.agentMemory；
 *      关闭时不初始化数据库、不注册工具、不召回、不索引（零副作用）；
 *   2) 启用后注册 MCP 工具：memory_search / memory_write / memory_recall /
 *      memory_profile_get / memory_profile_set / memory_forget / session_search；
 *   3) 暴露 AgentMemoryBridge.enhance(base, conversation)：
 *        · 把本轮对话增量索引进「会话记忆」（幂等去重）；
 *        · 对最新一条 user 消息做「自动召回 + 画像注入」；
 *        · 只改对话尾部（最后一条 user 消息），**不动** prefixManager 缓存的
 *          system+tools 前缀，避免破坏前缀缓存命中。
 * =============================================================================
 */
(function () {
  'use strict';

  var CORE = (typeof window !== 'undefined' && window.AgentMemory) || null;
  if (!CORE) { try { console.warn('[memory] memory-layer.js 未加载，跳过记忆层接线'); } catch (_) {} return; }

  // ── 配置：是否启用 memory（默认「不启用」）───────────────────────────────
  // 读取顺序：chatbotStore.memory → localStorage['chatbotStore'].memory → 兼容顶层 memoryEnabled。
  // 未配置 / 未显式 true 一律视为关闭：不初始化 IndexedDB、不注册工具、不自动召回、不索引会话。
  function readConfig() {
    var cfg = { enabled: false, autoRecall: true, autoIndexTurns: true, recallLimit: 6 };
    var src = null, legacy = null;
    try {
      if (typeof chatbotStore !== 'undefined' && chatbotStore) {
        src = chatbotStore.memory || null;
        legacy = chatbotStore.memoryEnabled;
      }
    } catch (_) {}
    if (!src) {
      try {
        var raw = (typeof localStorage !== 'undefined') && localStorage.getItem('chatbotStore');
        if (raw) {
          var saved = JSON.parse(raw) || {};
          src = saved.memory || null;
          if (legacy == null) legacy = saved.memoryEnabled;
        }
      } catch (_) {}
    }
    if (src && typeof src === 'object') {
      if (src.enabled != null) cfg.enabled = src.enabled === true;
      if (src.autoRecall != null) cfg.autoRecall = !!src.autoRecall;
      if (src.autoIndexTurns != null) cfg.autoIndexTurns = !!src.autoIndexTurns;
      if (src.recallLimit != null) {
        var n = Number(src.recallLimit) | 0;
        if (n > 0) cfg.recallLimit = n;
      }
    } else if (legacy != null) {
      cfg.enabled = legacy === true;
    }
    return cfg;
  }

  var CONFIG = readConfig();
  var ENABLED = CONFIG.enabled;       // 总开关：默认 false（不启用）
  var AUTO_RECALL = CONFIG.autoRecall;      // 是否开启「自动召回」
  var AUTO_INDEX_TURNS = CONFIG.autoIndexTurns; // 是否自动索引会话
  var RECALL_LIMIT = CONFIG.recallLimit;
  var MIN_QUERY_LEN = 2;          // 过短的输入不召回（如“好”）

  var ENGINE_OPTS = { rrfK: 60, vectorWeight: 1.0, keywordWeight: 1.0 };
  var engine = null;
  var ready = null;               // 懒初始化：只有「启用」后才真正打开 IndexedDB

  function makeMemoryEngine() {
    return CORE.createEngine(Object.assign({}, ENGINE_OPTS, { storage: CORE.storage.memory() }));
  }

  // 初始化带超时降级：某些环境（如浏览器内 Node 运行时）indexedDB 存在但 open() 不回调，
  // 超时后回退到内存存储，保证记忆层始终可用（浏览器正常时 IDB 会立即就绪）。
  function ensureReady() {
    if (ready) return ready;
    if (!engine) engine = CORE.createEngine(ENGINE_OPTS);
    ready = Promise.race([
      engine.init().then(function () { return engine; }),
      new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 2500); })
    ]).then(function (eng) {
      if (eng) return eng;
      try { console.warn('[memory] IndexedDB 初始化超时，降级为内存存储（本次会话有效）'); } catch (_) {}
      engine = makeMemoryEngine();
      return engine.init().then(function () { return engine; });
    }).catch(function (e) {
      try { console.warn('[memory] 初始化失败，降级为内存存储', e); } catch (_) {}
      engine = makeMemoryEngine();
      return engine.init().then(function () { return engine; });
    }).then(function (eng) {
      engine = eng || engine;
      if (typeof window !== 'undefined') window.agentMemory = engine;
      try { console.log('[memory] 本地记忆层就绪：', engine.stats()); } catch (_) {}
      return engine;
    });
    if (typeof window !== 'undefined') window.agentMemoryReady = ready;
    return ready;
  }

  if (typeof window !== 'undefined') {
    // 未启用时给一个已兑现的占位，避免等待方（如「清空记忆」）永久挂起
    window.agentMemoryReady = Promise.resolve(null);
  }

  // ── 文本抽取（兼容多模态 content 数组）───────────────────────────────────
  function messageText(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(function (p) {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (p.type === 'text') return p.text || '';
        return '';
      }).join('\n');
    }
    return String(content);
  }
  function isPlainTextMessage(m) { return m && typeof m.content === 'string'; }

  // ── 工具执行体 ───────────────────────────────────────────────────────────
  function fmtResults(res) {
    if (!res || !res.length) return '（无匹配记忆）';
    return res.map(function (r, i) {
      return (i + 1) + '. [' + r.kind + '] ' + r.text + (r.sessionId ? '  «session:' + r.sessionId + '»' : '');
    }).join('\n');
  }

  async function tool_search(args) {
    await ready;
    var res = await engine.search(args.query || '', {
      kinds: args.kinds || null,
      limit: args.limit || 8,
      expand: true
    });
    return { results: res, formatted: fmtResults(res) };
  }
  async function tool_recall(args) {
    await ready;
    var out = await engine.recall(args.query || '', {
      limit: args.limit || RECALL_LIMIT,
      includeSessions: args.with_sessions !== false,
      kinds: args.kinds || null
    });
    return { block: out.block || '', items: out.items, profile: out.profile, sessions: out.sessions };
  }
  async function tool_write(args) {
    await ready;
    var rec = await engine.add({
      kind: args.kind || 'memory',
      text: args.text || '',
      tags: args.tags || [],
      meta: { source: 'memory_write' }
    });
    return { id: rec.id, kind: rec.kind };
  }
  async function tool_profile_get() {
    await ready;
    return { facts: await engine.getProfile() };
  }
  async function tool_profile_set(args) {
    await ready;
    var facts = args.facts;
    if (typeof facts === 'string') {
      facts = facts.split(/\n+/).map(function (line) {
        var i = line.indexOf(':');
        if (i < 0) i = line.indexOf('：');
        return i > 0 ? { key: line.slice(0, i).trim(), text: line.slice(i + 1).trim() } : { key: '', text: line.trim() };
      });
    }
    var saved = await engine.setProfile(facts || []);
    return { count: saved.length, facts: saved };
  }
  async function tool_forget(args) {
    await ready;
    if (args.id) { await engine.remove(args.id); return { removed: 1 }; }
    if (args.query) {
      var hits = await engine.search(args.query, { limit: args.limit || 5 });
      for (var i = 0; i < hits.length; i++) await engine.remove(hits[i].id);
      return { removed: hits.length };
    }
    return { removed: 0 };
  }
  async function tool_session_search(args) {
    await ready;
    var res = await engine.sessionSearch(args.query || '', { limit: args.limit || 5, merge: false });
    return { results: res, formatted: fmtResults(res) };
  }

  var SCHEMA = {
    query: { type: 'string', description: '查询文本' },
    limit: { type: 'integer', description: '返回条数上限' },
    kinds: { type: 'array', items: { type: 'string' }, description: '限定记忆类型，如 ["memory","fact","note","preference"]' },
    text: { type: 'string', description: '要记住的文本' },
    kind: { type: 'string', description: '记忆类型（默认 memory）' },
    tags: { type: 'array', items: { type: 'string' } },
    facts: { description: '画像条目：数组 [{key,text}] 或 "key: value" 多行字符串' },
    id: { type: 'string', description: '要删除的记忆 id' },
    with_sessions: { type: 'boolean', description: '召回时是否附带历史会话片段' }
  };

  var TOOLS = [
    {
      name: 'memory_search', description: '在本地长期记忆（IndexedDB）中做「向量+关键词」混合检索，返回最相关的记忆条目。用于回忆用户偏好、既往结论、设定等。',
      inputSchema: { type: 'object', properties: { query: SCHEMA.query, limit: SCHEMA.limit, kinds: SCHEMA.kinds }, required: ['query'] },
      handler: tool_search, tags: ['memory']
    },
    {
      name: 'memory_recall', description: '自动召回：返回「用户画像 + 相关长期记忆 + 历史会话片段」组装成的上下文块（与每轮自动注入同源）。适合需要完整记忆上下文时调用。',
      inputSchema: { type: 'object', properties: { query: SCHEMA.query, limit: SCHEMA.limit, kinds: SCHEMA.kinds, with_sessions: SCHEMA.with_sessions }, required: ['query'] },
      handler: tool_recall, tags: ['memory']
    },
    {
      name: 'memory_write', description: '写入一条长期记忆（跨会话持久）。当用户透露稳定偏好、事实、决策时调用。',
      inputSchema: { type: 'object', properties: { text: SCHEMA.text, kind: SCHEMA.kind, tags: SCHEMA.tags }, required: ['text'] },
      handler: tool_write, tags: ['memory']
    },
    {
      name: 'memory_profile_get', description: '读取「用户画像」（一组 key→value 的事实）。',
      inputSchema: { type: 'object', properties: {} },
      handler: tool_profile_get, tags: ['memory']
    },
    {
      name: 'memory_profile_set', description: '写入/覆盖「用户画像」。facts 可传 [{key,text}] 数组，或 "key: value" 多行字符串。',
      inputSchema: { type: 'object', properties: { facts: SCHEMA.facts }, required: ['facts'] },
      handler: tool_profile_set, tags: ['memory']
    },
    {
      name: 'memory_forget', description: '删除记忆：按 id 精确删除，或按 query 检索后删除最相关的若干条。',
      inputSchema: { type: 'object', properties: { id: SCHEMA.id, query: SCHEMA.query, limit: SCHEMA.limit } },
      handler: tool_forget, tags: ['memory']
    },
    {
      name: 'session_search', description: '跨会话检索历史对话（把过往 user/assistant 轮次当作记忆检索），返回相关片段及其会话来源。',
      inputSchema: { type: 'object', properties: { query: SCHEMA.query, limit: SCHEMA.limit }, required: ['query'] },
      handler: tool_session_search, tags: ['memory']
    }
  ];

  // 等两种全局就绪再注册（toolRegistry 由 index.html 注入）。
  // 仅当「启用」时才注册：默认关闭时工具根本不下发给模型，避免无谓的前缀指纹变化。
  var toolsRegistered = false;

  function registerTools() {
    if (toolsRegistered) return true;
    if (typeof window.registerTool !== 'function') return false;
    var opts = { source: 'memory-layer', builtin: true, override: true };
    try {
      if (typeof window.registerTools === 'function') window.registerTools(TOOLS, opts);
      else TOOLS.forEach(function (t) { window.registerTool(t, opts); });
    } catch (e) {
      TOOLS.forEach(function (t) { try { window.registerTool(t); } catch (_) {} });
    }
    toolsRegistered = true;
    try { console.log('[memory] 已注册记忆工具：', TOOLS.map(function (t) { return t.name; }).join(', ')); } catch (_) {}
    return true;
  }

  function unregisterTools() {
    toolsRegistered = false;
    if (typeof window === 'undefined' || typeof window.unregisterTool !== 'function') return;
    TOOLS.forEach(function (t) { try { window.unregisterTool(t.name); } catch (_) {} });
    try { console.log('[memory] 已注销记忆工具（memory 已关闭）'); } catch (_) {}
  }

  function registerToolsWhenReady(attempt) {
    attempt = attempt || 0;
    if (!ENABLED) return;
    if (typeof window.registerTool !== 'function') {
      if (attempt < 100) return setTimeout(function () { registerToolsWhenReady(attempt + 1); }, 100);
      try { console.warn('[memory] window.registerTool 始终不可用，记忆工具未注册'); } catch (_) {}
      return;
    }
    registerTools();
  }

  // ── 自动召回 / 画像注入 + 会话索引钩子 ────────────────────────────────────
  function enhance(base, conversation) {
    if (!ENABLED) return Promise.resolve(base);   // 默认关闭：完全不注入、不索引
    if (!AUTO_RECALL && !AUTO_INDEX_TURNS) return Promise.resolve(base);
    return ensureReady().then(function () {
      var conv = conversation || [];
      // 1) 增量索引本轮对话（幂等）
      if (AUTO_INDEX_TURNS) {
        try { engine.indexTurns(conv, { sessionId: 'main' }); } catch (_) {}
      }
      if (!AUTO_RECALL) return base;
      // 2) 找最后一条纯文本 user 消息
      var lastUser = null;
      for (var i = conv.length - 1; i >= 0; i--) {
        if (conv[i] && conv[i].role === 'user' && isPlainTextMessage(conv[i])) { lastUser = conv[i]; break; }
      }
      if (!lastUser) return base;
      var q = messageText(lastUser.content);
      if (!q || q.trim().length < MIN_QUERY_LEN) return base;

      // 3) 召回 → 注入到「最后一条 user 消息」的尾部（保持前缀缓存不变）
      return engine.recall(q, { limit: RECALL_LIMIT, includeSessions: false }).then(function (out) {
        var block = out && out.block;
        if (!block) return base;
        var messages = base.slice();
        for (var j = messages.length - 1; j >= 0; j--) {
          if (messages[j] && messages[j].role === 'user') {
            messages[j] = Object.assign({}, messages[j], { content: block + '\n\n' + messageText(messages[j].content) });
            return messages;
          }
        }
        return base;
      }).catch(function () { return base; });
    }).catch(function () { return base; });
  }

  // 运行时开关：配置面板保存后立即生效（启用 → 懒初始化 + 注册工具；关闭 → 注销工具 + 停止注入/索引）
  function applyEnabled(next) {
    next = next === true;
    if (next === ENABLED) {
      if (next) registerToolsWhenReady();
      return ENABLED;
    }
    ENABLED = next;
    if (ENABLED) {
      ensureReady();
      registerToolsWhenReady();
    } else {
      unregisterTools();
    }
    // 工具集变化 = 前缀（system+tools）变化：显式失效，下一轮一次 cache miss
    try {
      if (typeof prefixManager !== 'undefined' && prefixManager && typeof prefixManager.invalidateTools === 'function') {
        prefixManager.invalidateTools();
      }
    } catch (_) { /* 尚未初始化 */ }
    return ENABLED;
  }

  window.AgentMemoryBridge = {
    enhance: enhance,
    get engine() { return engine; },
    tools: TOOLS.map(function (t) { return t.name; }),
    isEnabled: function () { return ENABLED; },
    getConfig: function () {
      return { enabled: ENABLED, autoRecall: AUTO_RECALL, autoIndexTurns: AUTO_INDEX_TURNS, recallLimit: RECALL_LIMIT };
    },
    setEnabled: applyEnabled,
    config: function (patch) {
      patch = patch || {};
      if (patch.enabled != null) applyEnabled(patch.enabled);
      if (patch.autoRecall != null) AUTO_RECALL = !!patch.autoRecall;
      if (patch.autoIndexTurns != null) AUTO_INDEX_TURNS = !!patch.autoIndexTurns;
      if (patch.recallLimit != null) {
        var n = patch.recallLimit | 0;
        if (n > 0) RECALL_LIMIT = n;
      }
      return { enabled: ENABLED, autoRecall: AUTO_RECALL, autoIndexTurns: AUTO_INDEX_TURNS, recallLimit: RECALL_LIMIT };
    }
  };

  // 启动：只有启用时才初始化引擎 + 注册工具（默认关闭 → 零副作用）
  if (ENABLED) {
    ensureReady();
    registerToolsWhenReady();
  } else {
    try { console.log('[memory] 本地记忆未启用（默认关闭）；可在「⚙️ 配置 → Advanced」开启'); } catch (_) {}
  }
})();
