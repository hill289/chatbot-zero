/*!
 * 23-hard-cut.js — 硬切窗口（Hard-Cut Window）
 * =============================================================================
 * 设计原则：上下文 ≠ 记忆。上下文只是「工作台」，记忆由三部分组成：
 *
 *      工作状态（Working State） + 指针（Pointer） + 可查询历史（Transcript）
 *
 *   · 上下文接近上限时 **不再压缩**（不生成摘要、不折叠旧消息）；
 *   · 先把重要信息写进「笔记」（notes），再把旧对话归档为磁盘上的「转录历史」，
 *     然后直接清空上下文，开一个干净的新窗口；
 *   · 新窗口只带：工作状态 + 字段清晰的笔记 + 一个指向归档转录的「指针」；
 *   · 之后任何需要回忆的细节，都可以用 `search_transcript` / `read_transcript`
 *     按需回查 —— 就像人类程序员「清空脑内缓存、翻看聊天记录 / git log」。
 *
 * 模块内提供：
 *   1) 纯函数：token 估算 / 压力判定 / 安全边界判定 / 工作状态抽取 / 交接文本渲染；
 *   2) notesStore：跨窗口持久的工作笔记（localStorage，可注入存储便于单测）；
 *   3) transcriptStore：归档转录的检索（优先走主进程 msg:search，无 Electron 时降级）；
 *   4) 工具注册（note_write / note_read / search_transcript / read_transcript / hard_cut）。
 *
 * 全部逻辑与 DOM 解耦；Node 下可直接 require 做单测。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory(root || {});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.HardCut = api;
    try { api._registerTools(); } catch (_) {}
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = 1;

  // ══════════════════════════════════════════════════════════════════════
  // 0. 配置（默认值可被 chatbotStore / configure() 覆盖）
  // ══════════════════════════════════════════════════════════════════════
  var DEFAULTS = {
    enabled: true,
    limitTokens: 1048576, // 模型上下文窗口（token，默认 1024K）
    ratio: 0.85,          // 达到窗口的 85% 即硬切
    minMessages: 4,       // 少于这么多条不切（没什么可归档）
    notesLimit: 120,      // 工作笔记最多保留条数
    transcriptLimit: 5    // 转录检索默认返回条数
  };
  var overrides = {};

  function appConfig() {
    var s = null;
    try { if (typeof chatbotStore !== 'undefined') s = chatbotStore; } catch (_) {}
    if (!s) { try { s = root.chatbotStore; } catch (_) {} }
    return s || {};
  }

  function config(extra) {
    var s = appConfig();
    var cfg = {
      enabled: DEFAULTS.enabled,
      limitTokens: DEFAULTS.limitTokens,
      ratio: DEFAULTS.ratio,
      minMessages: DEFAULTS.minMessages,
      notesLimit: DEFAULTS.notesLimit,
      transcriptLimit: DEFAULTS.transcriptLimit
    };
    if (s.hardCut && typeof s.hardCut === 'object') Object.assign(cfg, s.hardCut);
    if (s.hardCutEnabled != null) cfg.enabled = !!s.hardCutEnabled;
    if (isFinite(Number(s.contextWindowTokens)) && Number(s.contextWindowTokens) > 0) {
      cfg.limitTokens = Number(s.contextWindowTokens);
    }
    if (isFinite(Number(s.hardCutRatio)) && Number(s.hardCutRatio) > 0) {
      cfg.ratio = Math.min(0.98, Math.max(0.3, Number(s.hardCutRatio)));
    }
    Object.assign(cfg, overrides, extra || {});
    return cfg;
  }

  function configure(patch) {
    if (patch && typeof patch === 'object') Object.assign(overrides, patch);
    return config();
  }

  // ══════════════════════════════════════════════════════════════════════
  // 1. 纯函数：消息文本 / token 估算 / 压力与边界
  // ══════════════════════════════════════════════════════════════════════
  function clip(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function messageText(m) {
    if (!m) return '';
    var c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(function (p) { return (p && typeof p.text === 'string') ? p.text : ''; }).join('\n');
    }
    return '';
  }

  // 系统注入类消息（计划提醒 / 压缩摘要 / 护栏 / 本模块的交接种子）
  var SYS_TAG_RE = /^\s*<(compaction-summary|hard-cut-handoff|plan-reminder|loop-guard|exec-mode|working-notes)/i;
  function isSystemNote(m) {
    if (!m) return true;
    if (m._sysNote || m._hardCut) return true;
    return m.role === 'user' && SYS_TAG_RE.test(messageText(m));
  }

  function countTokens(str) {
    str = String(str == null ? '' : str);
    var cjk = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      // CJK 统一表意文字 / 假名 / 全角标点：约 0.6 token/字
      if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
    }
    var ascii = str.length - cjk;
    return Math.ceil(cjk / 1.6 + ascii / 4);
  }

  function estimateMessageTokens(m) {
    if (!m) return 0;
    var n = countTokens(messageText(m)) + 4; // 4 ≈ 角色/分隔符开销
    if (Array.isArray(m.tool_calls)) {
      try { n += countTokens(JSON.stringify(m.tool_calls)); } catch (_) {}
    }
    if (m.role === 'tool') n += 4;
    return n;
  }

  function estimateTokens(messages) {
    var sum = 0;
    for (var i = 0; i < (messages || []).length; i++) sum += estimateMessageTokens(messages[i]);
    return sum;
  }

  // 最近一次真实请求的 usage（prompt_tokens 含 system+tools，比字符估算准）
  var lastUsage = { promptTokens: 0, msgCount: 0, at: 0 };

  function noteUsage(usage, msgCount) {
    if (!usage) return;
    var p = Number(usage.prompt_tokens || usage.input_tokens || 0);
    if (!isFinite(p) || p <= 0) return;
    lastUsage = { promptTokens: p, msgCount: Math.max(0, msgCount | 0), at: Date.now() };
  }
  function resetUsage() { lastUsage = { promptTokens: 0, msgCount: 0, at: 0 }; }
  function lastUsageInfo() { return Object.assign({}, lastUsage); }

  function pressure(messages, cfgOverride) {
    var cfg = config(cfgOverride);
    var est = estimateTokens(messages);
    var basis = 'estimate';
    if (lastUsage.promptTokens > 0 && lastUsage.msgCount <= (messages || []).length) {
      try {
        est = lastUsage.promptTokens + estimateTokens((messages || []).slice(lastUsage.msgCount));
        basis = 'usage';
      } catch (_) {}
    }
    return {
      tokens: est,
      limit: cfg.limitTokens,
      ratio: cfg.ratio,
      pct: cfg.limitTokens > 0 ? est / cfg.limitTokens : 0,
      basis: basis,
      shouldCut: cfg.enabled !== false && est >= cfg.limitTokens * cfg.ratio
    };
  }

  function shouldCut(messages, cfgOverride) {
    if (!messages || messages.length < config(cfgOverride).minMessages) return false;
    return pressure(messages, cfgOverride).shouldCut;
  }

  // 只在「回合边界」切：尾部不能是孤立的 tool 结果 / 待配对的 assistant.tool_calls。
  //   · 空对话 → 可以（相当于重置）
  //   · 最后一条是 user（用户新指令已入列）→ 可以
  //   · 最后一条是 final assistant（tool_calls 为空）→ 可以
  function isSafeBoundary(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return true;
    var last = messages[messages.length - 1];
    if (!last) return true;
    if (last.role === 'tool') return false;
    if (last.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) return false;
    return last.role === 'user' || last.role === 'assistant';
  }

  // ══════════════════════════════════════════════════════════════════════
  // 2. 工作状态抽取（确定性，不做 LLM 摘要）
  // ══════════════════════════════════════════════════════════════════════
  var CONSTRAINT_RE = /(不要|不得|禁止|切勿|务必|必须|坚决|绝对|永远不要|别\s|never\s|must\s|do\s+not|don'?t|avoid\s|required?|only\s)/i;
  var FILE_KEY_RE = /"(?:path|file_path|filePath|dir_path|dirPath|output_path|file)"\s*:\s*"([^"]{1,300})"/g;

  function splitSentences(text) {
    return String(text || '')
      .split(/[\n\r。！？!?；;]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }

  function firstUserText(conv) {
    for (var i = 0; i < (conv || []).length; i++) {
      var m = conv[i];
      if (m && m.role === 'user' && !isSystemNote(m)) {
        var t = messageText(m).trim();
        if (t) return t;
      }
    }
    return '';
  }

  function lastUserText(conv) {
    for (var i = (conv || []).length - 1; i >= 0; i--) {
      var m = conv[i];
      if (m && m.role === 'user' && !isSystemNote(m)) {
        var t = messageText(m).trim();
        if (t) return t;
      }
    }
    return '';
  }

  function extractConstraints(conv, max) {
    max = max || 10;
    var out = [], seen = {};
    for (var i = 0; i < (conv || []).length && out.length < max; i++) {
      var m = conv[i];
      if (!m || m.role !== 'user' || isSystemNote(m)) continue;
      var parts = splitSentences(messageText(m));
      for (var j = 0; j < parts.length && out.length < max; j++) {
        var s = parts[j];
        if (s.length < 3 || s.length > 220) continue;
        if (!CONSTRAINT_RE.test(s)) continue;
        var k = s.toLowerCase();
        if (seen[k]) continue;
        seen[k] = 1;
        out.push(s);
      }
    }
    return out;
  }

  function extractFiles(conv, max) {
    max = max || 12;
    var out = [], seen = {};
    function push(p) {
      if (!p || out.length >= max) return;
      if (seen[p]) return;
      seen[p] = 1;
      out.push(p);
    }
    for (var i = 0; i < (conv || []).length; i++) {
      var m = conv[i];
      if (!m || !Array.isArray(m.tool_calls)) continue;
      for (var j = 0; j < m.tool_calls.length; j++) {
        var a = m.tool_calls[j] && m.tool_calls[j].function && m.tool_calls[j].function.arguments;
        if (typeof a !== 'string') continue;
        FILE_KEY_RE.lastIndex = 0;
        var mt;
        while ((mt = FILE_KEY_RE.exec(a))) push(mt[1]);
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  function extractTodos(plan, max) {
    max = max || 10;
    var out = [];
    var steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
    for (var i = 0; i < steps.length && out.length < max; i++) {
      var s = steps[i];
      if (!s || !s.content) continue;
      if (s.status === 'completed' || s.status === 'skipped') continue;
      out.push((s.status === 'in_progress' ? '[进行中] ' : '[待办] ') + clip(s.content, 160));
    }
    return out;
  }

  function buildWorkingState(input) {
    input = input || {};
    var conv = input.conversation || [];
    var plan = input.plan || null;
    var notesApi = input.notes || notes;
    var pointer = input.pointer || null;

    var objective = (plan && plan.objective) ? String(plan.objective) : '';
    if (!objective) objective = clip(firstUserText(conv), 400);

    var latest = clip(lastUserText(conv), 500);
    if (latest && latest === clip(objective, 500)) latest = '';

    var notesList = [];
    try {
      notesList = notesApi.list ? notesApi.list() : [];
    } catch (_) { notesList = []; }

    var decisions = [], facts = [];
    for (var i = 0; i < notesList.length; i++) {
      var n = notesList[i];
      if (!n) continue;
      if (n.kind === 'decision') decisions.push(n.text);
      else if (n.kind === 'fact' || n.kind === 'constraint') facts.push(n.text);
    }

    return {
      objective: objective,
      latestInstruction: latest,
      constraints: extractConstraints(conv),
      decisions: decisions.slice(-8).map(function (s) { return clip(s, 220); }),
      facts: facts.slice(-8).map(function (s) { return clip(s, 220); }),
      files: extractFiles(conv),
      todos: extractTodos(plan),
      notes: notesList.slice(-12).map(function (n) { return clip(n.text, 240); }),
      pointer: pointer,
      stats: {
        messages: conv.length,
        tokens: estimateTokens(conv),
        at: Date.now()
      }
    };
  }

  function renderHandoff(state, pointer, opts) {
    opts = opts || {};
    state = state || {};
    var L = [];
    L.push('<hard-cut-handoff>');
    L.push('【窗口切换 / Hard-cut】上一个窗口的上下文已清空并归档为「转录历史」。');
    L.push('下面是保留下来的「工作状态」与「历史指针」。需要回忆细节时，用工具按需检索，不要臆造。');
    L.push('');
    L.push('【工作状态 / Working State】');
    if (state.objective) L.push('· 目标：' + state.objective);
    if (state.latestInstruction) L.push('· 最近指令：' + state.latestInstruction);
    if (state.constraints && state.constraints.length) {
      L.push('· 硬约束（必须继续遵守）：');
      state.constraints.forEach(function (s) { L.push('   - ' + s); });
    }
    if (state.decisions && state.decisions.length) {
      L.push('· 已定决策：');
      state.decisions.forEach(function (s) { L.push('   - ' + s); });
    }
    if (state.facts && state.facts.length) {
      L.push('· 关键事实：');
      state.facts.forEach(function (s) { L.push('   - ' + s); });
    }
    if (state.files && state.files.length) {
      L.push('· 相关文件：');
      state.files.forEach(function (s) { L.push('   - ' + s); });
    }
    if (state.todos && state.todos.length) {
      L.push('· 未完成事项：');
      state.todos.forEach(function (s) { L.push('   - ' + s); });
    }
    if (state.notes && state.notes.length) {
      L.push('· 工作笔记（最近）：');
      state.notes.forEach(function (s) { L.push('   - ' + s); });
    }
    L.push('');
    L.push('【历史指针 / Transcript Pointer】');
    if (pointer && (pointer.sid || pointer.localId)) {
      L.push('· 归档会话：' + (pointer.sid || ('local:' + pointer.localId)) +
        '（' + (pointer.messages || 0) + ' 条消息' +
        (pointer.toSeq ? '，事件序号 1-' + pointer.toSeq : '') + '）');
      L.push('· 归档时间：' + new Date(pointer.ts || Date.now()).toLocaleString());
      if (pointer.title) L.push('· 会话标题：' + clip(pointer.title, 120));
    } else {
      L.push('· （本次未能落盘归档；旧对话仅存在于 Query History 快照中）');
    }
    L.push('· 检索方式：`search_transcript(query="关键词")` 全文检索旧窗口；');
    L.push('  `read_transcript(session_id="' + (pointer && (pointer.sid || pointer.localId) || '<sid>') + '", from_seq=1)` 按指针读取原文。');
    L.push('');
    L.push('【纪律】');
    L.push('1) 目标与硬约束以上文为准，禁止因为「看不到旧对话」而擅自改变需求；');
    L.push('2) 需要旧细节先检索转录，不要凭空编造；');
    L.push('3) 产生新的重要结论 / 决策 / 待办时，先 `note_write` 记下来，再做下一步。');
    L.push('</hard-cut-handoff>');
    return L.join('\n');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 3. 存储适配（localStorage / persist / 内存降级）
  // ══════════════════════════════════════════════════════════════════════
  var memoryStore = {};

  function rawStorage() {
    try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (_) {}
    try { if (root && root.localStorage) return root.localStorage; } catch (_) {}
    return null;
  }

  function loadJSON(key, fallback) {
    try {
      if (typeof persist !== 'undefined' && persist && typeof persist.load === 'function') {
        return persist.load(key, fallback);
      }
    } catch (_) {}
    var s = rawStorage();
    if (!s) return memoryStore[key] !== undefined ? memoryStore[key] : fallback;
    try {
      var raw = s.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }

  function saveJSON(key, val) {
    try {
      if (typeof persist !== 'undefined' && persist && typeof persist.save === 'function') {
        persist.save(key, val);
        return;
      }
    } catch (_) {}
    var s = rawStorage();
    if (!s) { memoryStore[key] = val; return; }
    try { s.setItem(key, JSON.stringify(val)); } catch (_) { memoryStore[key] = val; }
  }

  function hash(s) {
    s = String(s == null ? '' : s);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 4. notesStore —— 工作笔记（跨窗口持久）
  // ══════════════════════════════════════════════════════════════════════
  var NOTES_KEY = 'hardCutNotes';
  var notes = {
    KEY: NOTES_KEY,
    list: function () {
      var arr = loadJSON(NOTES_KEY, []);
      return Array.isArray(arr) ? arr : [];
    },
    add: function (text, meta) {
      text = String(text == null ? '' : text).trim();
      if (!text) return null;
      meta = meta || {};
      var arr = this.list();
      var h = hash(text);
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].hash === h) {
          arr[i].ts = Date.now();
          arr[i].pinned = !!(meta.pinned || arr[i].pinned);
          saveJSON(NOTES_KEY, arr);
          return arr[i];
        }
      }
      var note = {
        id: 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        ts: Date.now(),
        text: clip(text, 2000),
        kind: meta.kind || 'note',
        tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 8) : [],
        sid: meta.sid || null,
        hash: h,
        pinned: !!meta.pinned
      };
      arr.push(note);
      var cap = config().notesLimit || 120;
      if (arr.length > cap) arr = arr.slice(arr.length - cap);
      saveJSON(NOTES_KEY, arr);
      return note;
    },
    search: function (query, limit) {
      var q = String(query == null ? '' : query).trim().toLowerCase();
      var arr = this.list();
      if (!q) return arr.slice(-(limit || 10));
      var terms = q.split(/\s+/).filter(Boolean);
      var scored = [];
      for (var i = 0; i < arr.length; i++) {
        var n = arr[i];
        var t = (n.text || '').toLowerCase();
        var score = 0;
        for (var j = 0; j < terms.length; j++) if (t.indexOf(terms[j]) >= 0) score++;
        if (score > 0) scored.push({ note: n, score: score, ts: n.ts });
      }
      scored.sort(function (a, b) { return b.score - a.score || b.ts - a.ts; });
      return scored.slice(0, limit || 10).map(function (x) { return x.note; });
    },
    snapshot: function (limit) {
      var arr = this.list();
      if (!arr.length) return '';
      var picked = [];
      var pinned = arr.filter(function (n) { return n && n.pinned; });
      picked = picked.concat(pinned);
      for (var i = arr.length - 1; i >= 0 && picked.length < (limit || 8); i--) {
        if (arr[i] && picked.indexOf(arr[i]) < 0) picked.push(arr[i]);
      }
      return picked.map(function (n) { return '- [' + (n.kind || 'note') + '] ' + clip(n.text, 300); }).join('\n');
    },
    remove: function (id) {
      var arr = this.list();
      var next = arr.filter(function (n) { return !n || n.id !== id; });
      saveJSON(NOTES_KEY, next);
      return arr.length - next.length;
    },
    clear: function () { saveJSON(NOTES_KEY, []); }
  };

  // ══════════════════════════════════════════════════════════════════════
  // 5. 转录归档与检索
  // ══════════════════════════════════════════════════════════════════════
  var ARCHIVE_KEY = 'hardCutArchive';
  var ARCHIVE_MAX = 10;

  function messagesAPI() {
    try { if (typeof messagesAPI !== 'undefined' && messagesAPI) return messagesAPI; } catch (_) {}
    try { return root.messagesAPI || null; } catch (_) { return null; }
  }

  function toPlainTranscript(conv) {
    var out = [];
    for (var i = 0; i < (conv || []).length; i++) {
      var m = conv[i];
      if (!m) continue;
      var role = m.role || 'unknown';
      var text = messageText(m);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        text += (text ? '\n' : '') + '[tool_calls] ' + m.tool_calls.map(function (tc) {
          return (tc && tc.function && tc.function.name || '?') + '(' + (tc && tc.function && tc.function.arguments || '') + ')';
        }).join('; ');
      }
      out.push({ role: role, text: clip(text, 4000), ts: m.ts || null });
    }
    return out;
  }

  function saveLocalArchive(conv, meta) {
    var arr = loadJSON(ARCHIVE_KEY, []);
    if (!Array.isArray(arr)) arr = [];
    var id = 'local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    var entry = {
      id: id,
      ts: Date.now(),
      title: clip((meta && meta.title) || firstUserText(conv), 120),
      messages: toPlainTranscript(conv).slice(-300)
    };
    arr.push(entry);
    if (arr.length > ARCHIVE_MAX) arr = arr.slice(arr.length - ARCHIVE_MAX);
    saveJSON(ARCHIVE_KEY, arr);
    return id;
  }

  // 归档当前对话：优先写「会话事件日志」（磁盘 append-only），失败则降级本地
  function archive(conversation, meta) {
    var out = { ok: false, sid: null, localId: null, fromSeq: 1, toSeq: 0, messages: 0, ts: Date.now(), title: '' };
    try {
      if (typeof sessionLog !== 'undefined' && sessionLog && typeof sessionLog.sync === 'function') {
        var r = sessionLog.sync(conversation);
        if (r && r.ok && r.sid) {
          out.sid = r.sid;
          out.ok = true;
          try {
            var st = sessionLog.stateOf ? sessionLog.stateOf(r.sid) : null;
            out.toSeq = (st && st.maxSeq) || 0;
            out.messages = (st && st.messages && st.messages.length) || (conversation || []).length;
            out.title = (st && st.title) || clip(firstUserText(conversation), 120);
          } catch (_) {}
          try { if (sessionLog.setMeta) sessionLog.setMeta(r.sid, { title: out.title, archivedAt: out.ts, hardCut: true }); } catch (_) {}
        }
      }
    } catch (_) {}
    if (!out.ok) {
      out.localId = saveLocalArchive(conversation, meta);
      out.ok = true;
      out.messages = (conversation || []).length;
      out.title = clip(firstUserText(conversation), 120);
    }
    return out;
  }

  function scoreText(text, terms) {
    var t = String(text == null ? '' : text).toLowerCase();
    var score = 0;
    for (var i = 0; i < terms.length; i++) {
      if (!terms[i]) continue;
      var idx = t.indexOf(terms[i]);
      if (idx >= 0) score += 1 + Math.max(0, 0.2 - idx / Math.max(1, t.length));
    }
    return score;
  }

  function makeSnippet(text, terms, width) {
    text = String(text == null ? '' : text);
    width = width || 160;
    var lower = text.toLowerCase();
    var at = -1;
    for (var i = 0; i < terms.length; i++) {
      var idx = lower.indexOf(terms[i]);
      if (idx >= 0 && (at < 0 || idx < at)) at = idx;
    }
    if (at < 0) at = 0;
    var start = Math.max(0, at - Math.floor(width / 3));
    var end = Math.min(text.length, start + width);
    return (start > 0 ? '…' : '') + clip(text.slice(start, end), width + 20) + (end < text.length ? '…' : '');
  }

  function localArchiveSearch(query, limit) {
    var terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    var arr = loadJSON(ARCHIVE_KEY, []);
    var results = [];
    if (!Array.isArray(arr)) arr = [];
    for (var i = 0; i < arr.length; i++) {
      var entry = arr[i];
      var msgs = (entry && entry.messages) || [];
      var hits = [];
      for (var j = 0; j < msgs.length; j++) {
        var m = msgs[j];
        var s = scoreText(m.text, terms);
        if (s > 0) hits.push({ index: j + 1, role: m.role, score: s, snippet: makeSnippet(m.text, terms) });
      }
      hits.sort(function (a, b) { return b.score - a.score; });
      if (hits.length) {
        results.push({
          sid: entry.id,
          title: entry.title,
          ts: entry.ts,
          score: hits.reduce(function (n, h) { return n + h.score; }, 0),
          hits: hits.slice(0, 3)
        });
      }
    }
    results.sort(function (a, b) { return b.score - a.score || (b.ts || 0) - (a.ts || 0); });
    return { ok: true, source: 'local', total: results.length, results: results.slice(0, limit || 5) };
  }

  var transcripts = {
    enabled: function () {
      var api = messagesAPI();
      return !!(api && typeof api.search === 'function');
    },
    search: function (query, opts) {
      opts = opts || {};
      var limit = opts.limit || config().transcriptLimit;
      var q = String(query == null ? '' : query).trim();
      if (!q) return Promise.resolve({ ok: false, error: 'empty query', results: [] });
      var api = messagesAPI();
      if (api && typeof api.search === 'function') {
        return Promise.resolve(api.search({ query: q, limit: limit, sids: opts.sids || null, roles: opts.roles || null }))
          .then(function (r) {
            if (r && r.ok) return r;
            return localArchiveSearch(q, limit);
          })
          .catch(function () { return localArchiveSearch(q, limit); });
      }
      return Promise.resolve(localArchiveSearch(q, limit));
    },
    read: function (sid, opts) {
      opts = opts || {};
      var api = messagesAPI();
      if (api && typeof api.read === 'function' && sid) {
        return Promise.resolve(api.read(sid, { fromSeq: opts.fromSeq || 0 }))
          .then(function (r) {
            if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'read failed', messages: [] };
            return { ok: true, sid: sid, events: r.events || [], messages: foldTranscript(r.events || []) };
          })
          .catch(function (e) { return { ok: false, error: String((e && e.message) || e), messages: [] }; });
      }
      // 本地归档兜底
      var arr = loadJSON(ARCHIVE_KEY, []);
      if (!Array.isArray(arr)) arr = [];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].id === sid) {
          return Promise.resolve({ ok: true, sid: sid, source: 'local', messages: arr[i].messages || [] });
        }
      }
      return Promise.resolve({ ok: false, error: 'unknown session', messages: [] });
    }
  };

  // 从事件流折叠出「消息视图」（与主进程 msg:read 输出配合）
  function foldTranscript(events) {
    var msgs = [];
    for (var i = 0; i < (events || []).length; i++) {
      var ev = events[i];
      if (!ev || !ev.type) continue;
      if (ev.type === 'msg.append' && Array.isArray(ev.msgs)) msgs = msgs.concat(ev.msgs);
      else if (ev.type === 'msg.truncate') msgs = msgs.slice(0, Math.max(0, ev.toLen | 0));
      else if (ev.type === 'msg.replace') msgs = Array.isArray(ev.msgs) ? ev.msgs.slice() : [];
    }
    return msgs.map(function (m, idx) {
      return { index: idx + 1, role: m.role, text: messageText(m), ts: m.ts || null };
    });
  }

  function formatSearchResults(res) {
    if (!res || !res.results || !res.results.length) return '未找到匹配的历史片段。';
    var lines = [];
    lines.push('找到 ' + res.results.length + ' 个相关会话片段（来源：' + (res.source || 'session-log') + '）：');
    res.results.forEach(function (r, i) {
      lines.push('');
      lines.push((i + 1) + ') 会话 ' + r.sid + (r.title ? '｜' + clip(r.title, 60) : '') +
        (r.ts ? '｜' + new Date(r.ts).toLocaleString() : ''));
      (r.hits || []).forEach(function (h) {
        lines.push('   #' + h.index + ' [' + h.role + '] ' + h.snippet);
      });
    });
    return lines.join('\n');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 6. 工具注册
  // ══════════════════════════════════════════════════════════════════════
  var TOOLS = [
    {
      name: 'note_write',
      description: '把重要信息写进「工作笔记」（跨窗口持久，切换窗口后仍可用 note_read 读回）。' +
        '在上下文即将切换窗口前、或产生了新的决策/约束/关键事实/待办时调用。文本要自包含、可独立读懂。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容（自包含，含足够上下文）' },
          kind: { type: 'string', description: 'note | fact | decision | constraint | todo' },
          tags: { type: 'array', items: { type: 'string' } },
          pinned: { type: 'boolean', description: '是否置顶（每次交接必带）' }
        },
        required: ['text']
      },
      tags: ['hard-cut'],
      handler: async function (args) {
        var n = notes.add(args && args.text, args || {});
        if (!n) return { ok: false, error: 'empty text' };
        return { ok: true, note: n, total: notes.list().length };
      }
    },
    {
      name: 'note_read',
      description: '读取工作笔记。不传 query 返回最近的笔记；传 query 做关键词检索。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' }
        }
      },
      tags: ['hard-cut'],
      handler: async function (args) {
        args = args || {};
        var list = args.query ? notes.search(args.query, args.limit || 10) : notes.list().slice(-(args.limit || 20));
        return { ok: true, count: list.length, notes: list };
      }
    },
    {
      name: 'search_transcript',
      description: '检索「转录历史」：按关键词在已归档的旧窗口对话中做全文检索，返回片段与会话指针。' +
        '当你需要回忆上下文切换之前发生的事时使用（切换窗口后旧对话已不在上下文里）。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词（可空格分隔多个）' },
          limit: { type: 'integer', description: '返回会话数上限' }
        },
        required: ['query']
      },
      tags: ['hard-cut'],
      handler: async function (args) {
        var res = await transcripts.search((args && args.query) || '', { limit: (args && args.limit) || config().transcriptLimit });
        return Object.assign({ formatted: formatSearchResults(res) }, res);
      }
    },
    {
      name: 'read_transcript',
      description: '按指针读取某个归档会话的原文（可用 search_transcript 返回的 session_id）。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          from_seq: { type: 'integer', description: '起始事件序号（默认 0 = 全部）' },
          offset: { type: 'integer', description: '消息偏移（默认 0）' },
          limit: { type: 'integer', description: '最多返回多少条消息（默认 60）' }
        },
        required: ['session_id']
      },
      tags: ['hard-cut'],
      handler: async function (args) {
        args = args || {};
        var r = await transcripts.read(args.session_id, { fromSeq: args.from_seq || 0 });
        var list = (r.messages || []).slice(args.offset || 0, (args.offset || 0) + (args.limit || 60));
        return {
          ok: !!r.ok,
          session_id: args.session_id,
          total: (r.messages || []).length,
          error: r.error,
          messages: list.map(function (m) { return { index: m.index, role: m.role, text: clip(m.text, 1200) }; })
        };
      }
    },
    {
      name: 'hard_cut',
      description: '主动切换窗口：先把当前工作状态归档，然后在一个干净的新窗口继续执行。' +
        '当任务告一段落、或上下文很长且明显开始跑偏时调用。调用前建议先用 note_write 记录关键结论。',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '切换原因（会显示给用户）' },
          next_task: { type: 'string', description: '新窗口要接着做的事' }
        }
      },
      tags: ['hard-cut'],
      handler: async function (args) {
        args = args || {};
        var conv = null;
        try { if (typeof messageStore !== 'undefined' && messageStore) conv = messageStore.conversation; } catch (_) {}
        conv = conv || [];
        var pointer = archive(conv);
        var state = buildWorkingState({ conversation: conv, plan: (function () { try { return typeof planStore !== 'undefined' ? planStore : null; } catch (_) { return null; } })(), notes: notes, pointer: pointer });
        if (args.next_task) state.latestInstruction = String(args.next_task);
        var seed = renderHandoff(state, pointer, { reason: args.reason || '模型主动切换窗口' });
        return {
          content: [{ type: 'text', text: '窗口切换已安排：当前回合结束后将归档旧对话并开新窗口继续。' }],
          structuredContent: {
            sessionRestart: { hardCut: true, seed: seed, reason: args.reason || 'model-requested', requestedAt: Date.now() }
          }
        };
      }
    }
  ];

  function registerTools() {
    if (typeof window === 'undefined') return false;
    if (typeof window.registerTool !== 'function') {
      // 07-mcp.js 可能尚未执行完（脚本顺序）→ 稍后重试
      var attempt = 0;
      var tick = function () {
        if (typeof window.registerTool === 'function') { doRegister(); return; }
        if (++attempt < 100) setTimeout(tick, 100);
      };
      setTimeout(tick, 0);
      return false;
    }
    doRegister();
    return true;
  }

  function doRegister() {
    var opts = { source: 'hard-cut', builtin: true, override: true };
    try {
      if (typeof window.registerTools === 'function') window.registerTools(TOOLS, opts);
      else TOOLS.forEach(function (t) { window.registerTool(t, opts); });
      console.log('[hard-cut] 已注册工具：', TOOLS.map(function (t) { return t.name; }).join(', '));
    } catch (e) {
      TOOLS.forEach(function (t) { try { window.registerTool(t); } catch (_) {} });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // 7. 对外 API
  // ══════════════════════════════════════════════════════════════════════
  var api = {
    VERSION: VERSION,
    DEFAULT_LIMIT_TOKENS: DEFAULTS.limitTokens,
    config: config,
    configure: configure,

    // token / 压力
    countTokens: countTokens,
    estimateMessageTokens: estimateMessageTokens,
    estimateTokens: estimateTokens,
    pressure: pressure,
    shouldCut: shouldCut,
    isSafeBoundary: isSafeBoundary,
    noteUsage: noteUsage,
    resetUsage: resetUsage,
    lastUsage: lastUsageInfo,

    // 工作状态
    buildWorkingState: buildWorkingState,
    renderHandoff: renderHandoff,

    // 存储
    notes: notes,
    transcripts: transcripts,
    archive: archive,
    formatSearchResults: formatSearchResults,

    // 内部（测试 / 调试）
    _registerTools: registerTools,
    _tools: TOOLS,
    _internals: {
      messageText: messageText,
      isSystemNote: isSystemNote,
      extractConstraints: extractConstraints,
      extractFiles: extractFiles,
      extractTodos: extractTodos,
      firstUserText: firstUserText,
      lastUserText: lastUserText,
      foldTranscript: foldTranscript,
      scoreText: scoreText,
      makeSnippet: makeSnippet,
      clip: clip,
      hash: hash
    }
  };

  return api;
});
