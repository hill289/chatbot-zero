/*!
 * 19-plan-mode.js — Plan 模式（Ask / Plan / Craft）+ 可编辑步骤卡 + 风险审批门
 * -----------------------------------------------------------------------------
 * 在既有 planStore（06-orchestration.js）之上「加层」，不重写它：
 *   · planStore 已有：objective / steps[{content,status,activeForm}] / 持久化 /
 *     注入对话尾部（前缀缓存友好）/ 计划条 UI / 护栏 lastTrip。
 *   · 本模块补齐：三种执行模式、结构化步骤（工具/风险/依赖/产物）、
 *     执行前的风险审批门（复用 ask_user 模态）、可编辑步骤卡面板。
 *
 * 设计约束（与仓库一致）：
 *   1) 零构建、经典 <script> 顺序加载（本文件在 06/07 之后加载）；
 *   2) 只往对话【尾部】注入 <exec-mode>，绝不动 system/tools 前缀 → 前缀缓存不失效；
 *   3) 纯浏览器直开（无 Electron / 无 ask_user）时静默降级，不影响主对话；
 *   4) 纯逻辑（归一化 / 风险判定 / 依赖校验）与 DOM 分离，可 node --test 单测。
 *
 * UMD：浏览器挂 globalThis.PlanMode；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PlanMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ══════════════════════════════════════════════════════════════════
  // 一、纯逻辑（无 DOM / 无副作用，可单测）
  // ══════════════════════════════════════════════════════════════════

  var STATUS = {
    PENDING: 'pending',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    SKIPPED: 'skipped',
    FAILED: 'failed',
    BLOCKED: 'blocked'
  };

  // 状态别名（大小写 / 连字符 / 中英文不敏感），兼容模型各种写法
  var STATUS_ALIASES = {
    pending: ['pending', 'todo', 'open', 'unstarted', 'not_started', 'not-started', 'notstarted', 'waiting', 'queued', 'backlog', 'new', '未开始', '待办', '待定', '未处理'],
    in_progress: ['in_progress', 'in-progress', 'inprogress', 'in progress', 'doing', 'active', 'started', 'ongoing', 'wip', 'running', '进行中', '处理中', '正在处理', '执行中'],
    completed: ['completed', 'complete', 'done', 'finished', 'finish', 'success', 'succeeded', 'resolved', 'closed', '已完成', '完成', '搞定', '结束'],
    skipped: ['skipped', 'skip', 'ignored', '已跳过', '跳过'],
    failed: ['failed', 'fail', 'error', 'errored', '失败', '出错'],
    blocked: ['blocked', 'block', 'stuck', '受阻', '阻塞', '被阻断']
  };
  var STATUS_MAP = (function () {
    var m = {};
    Object.keys(STATUS_ALIASES).forEach(function (canonical) {
      STATUS_ALIASES[canonical].forEach(function (alias) { m[String(alias).toLowerCase()] = canonical; });
    });
    return m;
  })();

  var MODES = ['ask', 'plan', 'craft'];
  var MODE_LABELS = { ask: 'Ask（只回答）', plan: 'Plan（只规划）', craft: 'Craft（执行）' };

  // 写 / 删 / 执行类工具：被认为是「有副作用」，用于 Plan 模式拦截与高风险提示
  var MUTATING_TOOLS = {
    write_file: 1, delete_file: 1, add_content: 1, delete_content: 1, replace_lines: 1, edit_file: 1
  };
  // 这些工具会写文件，但只作用于工作区、可视为低风险
  var WORKSPACE_TOOLS = { markdown_to_pdf: 1, html_to_ppt: 1, chart: 1, data_to_chart: 1, markdown_to_docx: 1, markdown_to_pptx: 1, report_to_pptx: 1 };
  // run_node 内疑似写盘 / 删盘的代码特征
  var RUN_NODE_RISKY_RE = /\b(fs\s*\.\s*(write|unlink|rm|rmdir|rename|mkdir|createWriteStream|appendFile))|require\(\s*['"](node:)?fs['"]\s*\)|child_process|execSync|spawnSync|process\.exit/i;

  function isFn(x) { return typeof x === 'function'; }
  function pick(obj, keys) {
    if (!obj) return undefined;
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }
  function normStatus(s) {
    if (s === null || s === undefined) return STATUS.PENDING;
    if (typeof s === 'string') return STATUS_MAP[s.trim().toLowerCase()] || STATUS.PENDING;
    return STATUS.PENDING;
  }
  function asArray(x) {
    if (Array.isArray(x)) return x;
    if (x && typeof x === 'object') {
      var v = pick(x, ['steps', 'todos', 'todo', 'items', 'tasks', 'list']);
      if (Array.isArray(v)) return v;
    }
    return null;
  }

  // 单个步骤归一化为「富步骤」（保留旧字段 content/status/activeForm）
  function normalizeStep(raw, index, prev) {
    var item = raw;
    if (typeof item === 'string') item = { content: item };
    if (!item || typeof item !== 'object' || Array.isArray(item)) item = {};
    var content = pick(item, ['content', 'task', 'text', 'title', 'name', 'description', 'summary']);
    if (typeof content !== 'string') content = '';
    content = content.trim();
    var active = pick(item, ['activeForm', 'active_form', 'activeform', 'active']);
    var id = pick(item, ['id', 'key']);
    if (typeof id !== 'string' || !id.trim()) id = 'p' + (index + 1);
    var tool = pick(item, ['tool', 'expected_tool', 'toolName']);
    var risk = pick(item, ['risk', 'riskLevel', 'risk_level']);
    risk = (String(risk || '').toLowerCase() === 'high') ? 'high' : 'low';
    var deps = pick(item, ['dependsOn', 'depends_on', 'deps', 'after']);
    if (typeof deps === 'string') deps = [deps];
    if (!Array.isArray(deps)) deps = [];
    var artifacts = Array.isArray(item.artifacts) ? item.artifacts.slice() : [];
    var argsPreview = (item.argsPreview && typeof item.argsPreview === 'object') ? item.argsPreview : (item.args && typeof item.args === 'object' ? item.args : null);
    return {
      id: String(id).trim(),
      content: content,
      activeForm: (typeof active === 'string' && active.trim()) ? active.trim() : content,
      status: normStatus(pick(item, ['status', 'state'])),
      tool: (typeof tool === 'string' && tool.trim()) ? tool.trim() : '',
      argsPreview: argsPreview,
      risk: risk,
      dependsOn: deps.map(String),
      artifacts: artifacts,
      note: (typeof item.note === 'string') ? item.note : ''
    };
  }

  // 整表归一化：去空、补 id、去重 id、保证「同时只有一个 in_progress」
  function normalizeSteps(list) {
    var arr = asArray(list);
    if (!arr) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < arr.length; i++) {
      var st = normalizeStep(arr[i], i);
      if (!st.content) continue;                      // 丢弃空步骤
      while (seen[st.id]) st.id = st.id + '_' + (i + 1); // 去重 id
      seen[st.id] = 1;
      out.push(st);
    }
    // 只保留第一个 in_progress
    var doing = false;
    for (var j = 0; j < out.length; j++) {
      if (out[j].status === STATUS.IN_PROGRESS) {
        if (doing) out[j].status = STATUS.PENDING;
        else doing = true;
      }
    }
    return out;
  }

  function classifyRisk(toolName, args) {
    var name = String(toolName || '');
    if (name === 'run_node' && args && RUN_NODE_RISKY_RE.test(String(args.code || args.source || ''))) return 'high';
    if (MUTATING_TOOLS[name]) return 'high';
    if (name === 'delete_file') return 'high';
    return 'low';
  }

  // 依赖校验：返回错误列表（未知依赖 / 环形依赖）
  function validateDepends(steps) {
    var errs = [];
    var byId = {};
    (steps || []).forEach(function (s) { byId[s.id] = s; });
    (steps || []).forEach(function (s) {
      (s.dependsOn || []).forEach(function (d) {
        if (!byId[d]) errs.push('步骤 ' + s.id + ' 依赖了不存在的步骤 ' + d);
      });
    });
    // 环检测（DFS）
    var WHITE = 0, GRAY = 1, BLACK = 2, color = {};
    (steps || []).forEach(function (s) { color[s.id] = WHITE; });
    var cycle = false;
    function dfs(id) {
      color[id] = GRAY;
      var s = byId[id];
      if (s) {
        (s.dependsOn || []).forEach(function (d) {
          if (!byId[d]) return;
          if (color[d] === GRAY) cycle = true;
          else if (color[d] === WHITE) dfs(d);
        });
      }
      color[id] = BLACK;
    }
    (steps || []).forEach(function (s) { if (color[s.id] === WHITE) dfs(s.id); });
    if (cycle) errs.push('步骤依赖存在环形引用');
    return errs;
  }

  function modeLabel(m) { return MODE_LABELS[m] || MODE_LABELS.craft; }

  // 生成注入对话尾部的 <exec-mode> 文本（前缀缓存友好：内容只随模式变化）
  function buildModeNote(mode) {
    switch (mode) {
      case 'ask':
        return '<exec-mode>ask</exec-mode>\n' +
          '（执行模式：Ask —— 只回答用户问题，不要创建计划、不要调用任何有副作用的工具。）';
      case 'plan':
        return '<exec-mode>plan</exec-mode>\n' +
          '（执行模式：Plan —— 只产出执行计划，不执行任何有副作用的工具。' +
          '请调用 plan_write 提交结构化步骤（可含 tool/risk/dependsOn），等待用户确认后再执行。）';
      default:
        return '';
    }
  }

  function snapshotText(objective, steps) {
    var lines = [];
    if (objective) lines.push('目标: ' + objective);
    (steps || []).forEach(function (s, i) {
      var mark = s.status === STATUS.COMPLETED ? '[x]' : s.status === STATUS.IN_PROGRESS ? '[>]'
        : s.status === STATUS.SKIPPED ? '[-]' : s.status === STATUS.FAILED ? '[!]'
        : s.status === STATUS.BLOCKED ? '[~]' : '[ ]';
      var extra = [];
      if (s.tool) extra.push('tool=' + s.tool);
      if (s.risk === 'high') extra.push('risk=high');
      if (s.dependsOn && s.dependsOn.length) extra.push('after=' + s.dependsOn.join(','));
      lines.push((i + 1) + '. ' + mark + ' ' + s.content + (extra.length ? '  (' + extra.join('; ') + ')' : ''));
    });
    var total = (steps || []).length;
    var done = (steps || []).filter(function (s) { return s.status === STATUS.COMPLETED; }).length;
    if (total) lines.push('进度: ' + done + '/' + total + ' 已完成');
    return lines.join('\n');
  }

  // ══════════════════════════════════════════════════════════════════
  // 二、运行时（浏览器）—— 依赖外部的 planStore / persist / askUserStore
  //     全部经 typeof 守卫，Node 下自动跳过。
  // ══════════════════════════════════════════════════════════════════

  var MODE_KEY = 'planMode';
  var APPROVAL_KEY = 'planModeApproval';
  var _doc = null;
  function doc() { if (!_doc) { try { _doc = (root && root.document) || null; } catch (_) { _doc = null; } } return _doc; }
  function hasDom() { return !!doc(); }
  function PStore() { try { return (typeof planStore !== 'undefined') ? planStore : null; } catch (_) { return null; } }
  function doPersist() { try { return (typeof persist !== 'undefined') ? persist : null; } catch (_) { return null; } }
  function snack(msg, kind) {
    try {
      if (typeof snackbarStore === 'undefined' || !snackbarStore) return;
      if (kind === 'error' && snackbarStore.showErrorMessage) snackbarStore.showErrorMessage(msg);
      else if (snackbarStore.showInfoMessage) snackbarStore.showInfoMessage(msg);
    } catch (_) {}
  }
  function esc(s) {
    if (typeof escapeHtml === 'function') return escapeHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m];
    });
  }

  // ── 状态 ──
  var PlanMode = {
    version: 1,
    mode: 'craft',           // ask | plan | craft
    approval: false,         // 高风险步骤是否弹窗确认
    _injectedMode: null,
    _lastGate: null,
    __pure: {
      STATUS: STATUS, normalizeStep: normalizeStep, normalizeSteps: normalizeSteps,
      classifyRisk: classifyRisk, validateDepends: validateDepends,
      modeLabel: modeLabel, buildModeNote: buildModeNote, snapshotText: snapshotText,
      normStatus: normStatus
    },

    // ── 模式 ──
    setMode: function (m, opts) {
      if (MODES.indexOf(m) === -1) return this.mode;
      if (m === this.mode) return this.mode;
      this.mode = m;
      var p = doPersist(); if (p) p.save(MODE_KEY, m);
      this._injectedMode = null;                 // 强制下一轮重注入模式说明
      try { var ps = PStore(); if (ps) ps.forceReinject(); } catch (_) {}
      this.renderPlanBoard();
      if (!opts || opts.silent !== true) snack('执行模式：' + modeLabel(m));
      return this.mode;
    },
    getMode: function () { return this.mode; },
    setApproval: function (v) {
      this.approval = !!v;
      var p = doPersist(); if (p) p.save(APPROVAL_KEY, this.approval);
      this.renderPlanBoard();
      return this.approval;
    },

    // ── 富步骤写入（覆盖 planStore.setSteps，兼容 todo_write 的旧结构）──
    setRichSteps: function (steps) {
      var ps = PStore();
      var normalized = normalizeSteps(steps);
      var errs = validateDepends(normalized);
      if (ps) {
        ps.steps = normalized;
        ps.updatedAt = Date.now();
        ps.bump();
      }
      this.renderPlanBoard();
      return { steps: normalized, errors: errs };
    },

    addStep: function (step) {
      var ps = PStore(); if (!ps) return;
      var next = (ps.steps || []).slice();
      next.push(step || '');
      this.setRichSteps(next);
    },
    removeStep: function (key) {
      var ps = PStore(); if (!ps) return;
      var idx = this._indexOf(ps.steps, key);
      if (idx < 0) return;
      var next = ps.steps.slice(); next.splice(idx, 1);
      this.setRichSteps(next);
    },
    moveStep: function (key, delta) {
      var ps = PStore(); if (!ps) return;
      var idx = this._indexOf(ps.steps, key);
      if (idx < 0) return;
      var j = idx + delta;
      if (j < 0 || j >= ps.steps.length) return;
      var next = ps.steps.slice();
      var tmp = next[idx]; next[idx] = next[j]; next[j] = tmp;
      this.setRichSteps(next);
    },
    updateStep: function (key, patch) {
      var ps = PStore(); if (!ps) return;
      var idx = this._indexOf(ps.steps, key);
      if (idx < 0) return;
      var next = ps.steps.slice();
      var s = Object.assign({}, next[idx], patch || {});
      if (patch && patch.status) s.status = normStatus(patch.status);
      if (s.status === STATUS.IN_PROGRESS) {
        next = next.map(function (x, i) { return (i === idx) ? s : (x.status === STATUS.IN_PROGRESS ? Object.assign({}, x, { status: STATUS.PENDING }) : x); });
      } else {
        next[idx] = s;
      }
      this.setRichSteps(next);
    },
    markArtifact: function (key, artifact) {
      var ps = PStore(); if (!ps || !artifact) return;
      var idx = this._indexOf(ps.steps, key);
      if (idx < 0) idx = this._currentIndex();
      if (idx < 0) return;
      var next = ps.steps.slice();
      var arts = (next[idx].artifacts || []).slice();
      if (!arts.some(function (a) { return a && a.path && a.path === artifact.path; })) arts.push(artifact);
      next[idx] = Object.assign({}, next[idx], { artifacts: arts });
      ps.steps = next; ps.updatedAt = Date.now(); ps.bump();
      this.renderPlanBoard();
    },
    _indexOf: function (steps, key) {
      if (typeof key === 'number') return (key >= 0 && key < (steps || []).length) ? key : -1;
      for (var i = 0; i < (steps || []).length; i++) if (steps[i].id === key) return i;
      return -1;
    },
    _currentIndex: function () {
      var ps = PStore(); if (!ps) return -1;
      for (var i = 0; i < ps.steps.length; i++) if (ps.steps[i].status === STATUS.IN_PROGRESS) return i;
      for (var j = 0; j < ps.steps.length; j++) if (ps.steps[j].status === STATUS.PENDING) return j;
      return -1;
    },
    currentStep: function () {
      var ps = PStore(); if (!ps) return null;
      var i = this._currentIndex();
      return i < 0 ? null : ps.steps[i];
    },

    // ── 对话尾部注入 <exec-mode>（前缀缓存友好）──
    _injectModeNote: function (conv) {
      if (!Array.isArray(conv)) return false;
      var lastIdx = -1;
      for (var i = conv.length - 1; i >= 0; i--) {
        if (conv[i] && conv[i]._sysNote && conv[i]._sysNoteKind === 'exec-mode') { lastIdx = i; break; }
      }
      // Craft 模式不注入（保持与旧行为一致）；若之前注入过则移除
      if (this.mode === 'craft') {
        if (lastIdx >= 0) { conv.splice(lastIdx, 1); this._injectedMode = 'craft'; return true; }
        this._injectedMode = 'craft';
        return false;
      }
      if (lastIdx >= 0 && this._injectedMode === this.mode) return false;
      if (lastIdx >= 0) conv.splice(lastIdx, 1);
      var note = buildModeNote(this.mode);
      if (!note) return false;
      conv.push({
        role: 'user',
        content: note,
        _sysNote: true,
        _sysNoteKind: 'exec-mode',
        _sysNoteText: '执行模式已切换：' + modeLabel(this.mode)
      });
      this._injectedMode = this.mode;
      return true;
    },

    // ── 审批门：执行工具「之前」调用（返回 { allow })──
    gateFor: function (name, args) {
      if (this.mode === 'plan') {
        var mut = classifyRisk(name, args) === 'high';
        if (mut) return { kind: 'block', reason: 'Plan 模式下不执行有副作用的工具（' + name + '）' };
      }
      if (this.approval && classifyRisk(name, args) === 'high') {
        // 工具审批已由 Approval Gate（mcpStore.callTool → window.approvalStore）统一接管时，
        // 这里不再重复弹窗，避免同一调用被问两次。
        try {
          if (window.approvalStore && typeof window.approvalStore.isGuarded === 'function'
              && window.approvalStore.isGuarded(name)) return null;
        } catch (_) { /* 忽略：降级为旧行为 */ }
        return { kind: 'ask', reason: '高风险操作：' + name };
      }
      return null;
    },
    beforeToolCall: function (name, args, toolCall) {
      var self = this;
      try {
        var g = this.gateFor(name, args);
        if (!g) return Promise.resolve({ allow: true });
        if (g.kind === 'block') {
          snack('⛔ ' + g.reason, 'error');
          return Promise.resolve({ allow: false, reason: g.reason });
        }
        // kind === 'ask' → 复用 ask_user 模态
        var ask = (typeof askUserStore !== 'undefined') ? askUserStore : null;
        if (!ask || !isFn(ask.ask)) return Promise.resolve({ allow: true }); // 无 UI → 放行
        var preview = '';
        try { preview = JSON.stringify(args || {}).slice(0, 600); } catch (_) {}
        return Promise.resolve(ask.ask({
          title: '高风险操作确认 / Approve high-risk step',
          question: '即将执行 ' + name + '，是否允许？',
          context: preview,
          options: ['允许', '拒绝'],
          allow_free_text: false,
          timeout_seconds: 120
        })).then(function (res) {
          var ok = !!(res && res.answered && String(res.value) === '允许');
          if (ok) snack('已允许：' + name);
          else snack('已拒绝：' + name, 'error');
          return { allow: ok, reason: ok ? '' : ('用户拒绝了：' + name) };
        }).catch(function () { return { allow: false, reason: '审批未完成，已跳过：' + name }; });
      } catch (e) {
        return Promise.resolve({ allow: true }); // 审批门故障绝不阻断执行
      }
    },

    // ── 工具「之后」：把产物回贴到当前步骤 ──
    afterToolCall: function (name, args, resultStr) {
      try {
        var arts = artifactsFrom(name, args, resultStr);
        if (!arts.length) return;
        var step = this.currentStep();
        if (!step) return;
        var self = this;
        arts.forEach(function (a) { self.markArtifact(step.id, a); });
      } catch (_) {}
    },

    // ══════════════════════════════════════════════════════════════
    // 三、UI：可编辑步骤卡面板
    // ══════════════════════════════════════════════════════════════
    renderPlanBoard: function () {
      if (!hasDom()) return;
      var d = doc();
      var bar = d.getElementById('planBar');
      if (!bar) return;
      var ps = PStore();
      var steps = ps ? (ps.steps || []) : [];
      var showMode = this.mode !== 'craft';
      var show = steps.length > 0 || showMode;
      if (!show) { bar.style.display = 'none'; bar.innerHTML = ''; return; }

      var total = steps.length;
      var done = steps.filter(function (s) { return s.status === STATUS.COMPLETED; }).length;
      var pct = total ? Math.round(done / total * 100) : 0;

      var chips = ['ask', 'plan', 'craft'].map(function (m) {
        return '<button class="pm-chip' + (PlanMode.mode === m ? ' on' : '') + '" data-mode="' + m + '" title="' + esc(modeLabel(m)) + '">' + m.charAt(0).toUpperCase() + m.slice(1) + '</button>';
      }).join('');

      var obj = (ps && ps.objective) ? '<span class="pm-obj" title="' + esc(ps.objective) + '">🎯 ' + esc(ps.objective) + '</span>' : '';

      var stepsHtml = steps.map(function (s, i) {
        var icon = ({ completed: '✔', in_progress: '▶', skipped: '⤼', failed: '✖', blocked: '⛔' })[s.status] || '○';
        var cls = s.status || 'pending';
        var badges = '';
        if (s.tool) badges += '<span class="pm-badge tool" title="预期工具">' + esc(s.tool) + '</span>';
        if (s.risk === 'high') badges += '<span class="pm-badge risk" title="高风险">⚠ high</span>';
        (s.artifacts || []).forEach(function (a) {
          badges += '<span class="pm-badge art" title="' + esc(a.path || '') + '">📎 ' + esc(a.label || (a.path || '').split('/').pop()) + '</span>';
        });
        var note = s.note ? '<span class="pm-note" title="' + esc(s.note) + '">' + esc(s.note) + '</span>' : '';
        var up = '<button class="pm-mini" data-act="up" data-idx="' + i + '" title="上移">↑</button>';
        var down = '<button class="pm-mini" data-act="down" data-idx="' + i + '" title="下移">↓</button>';
        var del = '<button class="pm-mini" data-act="del" data-idx="' + i + '" title="删除">✕</button>';
        return '<div class="pm-step ' + cls + '" data-idx="' + i + '">' +
          '<span class="pm-mark" data-act="cycle" data-idx="' + i + '" title="点击切换状态">' + icon + '</span>' +
          '<span class="pm-text" data-act="cycle" data-idx="' + i + '">' + (i + 1) + '. ' + esc(s.content) + badges + note + '</span>' +
          '<span class="pm-ops">' + up + down + del + '</span>' +
          '</div>';
      }).join('');

      bar.style.display = 'flex';
      bar.classList.add('pm-bar');
      bar.innerHTML =
        '<div class="pm-head">' +
          '<span class="pm-modes">' + chips + '</span>' +
          '<span class="pm-progress" title="' + done + '/' + total + '">' + done + '/' + total + '</span>' +
          '<span class="pm-track"><i style="width:' + pct + '%"></i></span>' +
          obj +
          '<span class="spacer"></span>' +
          '<button class="pm-btn" data-act="approval" title="高风险步骤执行前弹窗确认">' + (PlanMode.approval ? '🛡 审批开' : '🛡 审批关') + '</button>' +
          '<button class="pm-btn" data-act="edit" title="编辑计划">✎ 编辑</button>' +
          '<button class="pm-btn" data-act="run" title="确认并开始执行（切到 Craft）">▶ 执行</button>' +
          '<button class="pm-btn danger" data-act="clear" title="清除计划">✕</button>' +
        '</div>' +
        (steps.length ? '<div class="pm-steps">' + stepsHtml + '</div>' : '<div class="pm-empty">还没有步骤。切到 <b>Plan</b> 让模型规划，或点 <b>✎ 编辑</b> 手动添加。</div>');

      // 事件（委托）
      bar.querySelectorAll('[data-mode]').forEach(function (b) {
        b.addEventListener('click', function () { PlanMode.setMode(b.getAttribute('data-mode')); });
      });
      bar.querySelectorAll('[data-act]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var act = b.getAttribute('data-act');
          var idx = parseInt(b.getAttribute('data-idx'), 10);
          if (act === 'approval') PlanMode.setApproval(!PlanMode.approval);
          else if (act === 'edit') PlanMode.openEditor();
          else if (act === 'run') PlanMode.confirmAndRun();
          else if (act === 'clear') { if (ps) { ps.clear(); } PlanMode.renderPlanBoard(); }
          else if (act === 'up') PlanMode.moveStep(idx, -1);
          else if (act === 'down') PlanMode.moveStep(idx, +1);
          else if (act === 'del') PlanMode.removeStep(idx);
          else if (act === 'cycle') PlanMode.cycleStatus(idx);
        });
      });
    },

    cycleStatus: function (idx) {
      var ps = PStore(); if (!ps) return;
      var s = ps.steps[idx]; if (!s) return;
      var order = [STATUS.PENDING, STATUS.IN_PROGRESS, STATUS.COMPLETED];
      var next = order[(order.indexOf(s.status) + 1) % order.length];
      if (order.indexOf(s.status) === -1) next = STATUS.IN_PROGRESS;
      this.updateStep(idx, { status: next });
    },

    confirmAndRun: function () {
      var ps = PStore(); if (!ps || !ps.steps.length) { snack('还没有可执行的计划步骤'); return; }
      var self = this;
      var ask = (typeof askUserStore !== 'undefined') ? askUserStore : null;
      var proceed = function () {
        // 把第一个 pending 置为 in_progress，并切到 Craft
        var first = -1;
        for (var i = 0; i < ps.steps.length; i++) if (ps.steps[i].status === STATUS.PENDING) { first = i; break; }
        if (first >= 0) self.updateStep(first, { status: STATUS.IN_PROGRESS });
        self.setMode('craft');
        snack('已确认计划，切到 Craft 开始执行');
      };
      if (ask && isFn(ask.ask)) {
        ask.ask({
          title: '确认执行计划 / Confirm plan',
          question: '确认按当前计划执行吗？（共 ' + ps.steps.length + ' 步）',
          options: ['执行', '取消'],
          allow_free_text: false, timeout_seconds: 120
        }).then(function (res) { if (res && res.answered && String(res.value) === '执行') proceed(); });
      } else proceed();
    },

    // ── 步骤编辑弹窗 ──
    openEditor: function () {
      if (!hasDom()) return;
      var d = doc();
      var ps = PStore();
      var old = d.getElementById('planEditorModal');
      if (old) old.remove();
      var steps = ps ? (ps.steps || []).slice() : [];
      var rows = steps.map(function (s, i) { return editorRowHtml(s, i); }).join('');

      var overlay = d.createElement('div');
      overlay.className = 'modal-overlay pm-editor-overlay';
      overlay.id = 'planEditorModal';
      overlay.innerHTML =
        '<div class="modal-card pm-editor">' +
          '<div class="modal-header">' +
            '<span class="modal-title">🧭 编辑计划 / Edit plan</span>' +
            '<button class="mh-btn modal-close" id="pmEdClose" title="关闭">✕</button>' +
          '</div>' +
          '<div class="modal-body">' +
            '<label class="pm-field">目标 objective' +
              '<input id="pmEdObjective" class="pm-input" type="text" placeholder="一句话目标" value="' + esc(ps ? ps.objective : '') + '">' +
            '</label>' +
            '<div class="pm-ed-steps" id="pmEdSteps">' + (rows || '<div class="pm-empty">（暂无步骤，点下方「+ 添加步骤」）</div>') + '</div>' +
            '<button class="pm-btn" id="pmEdAdd">＋ 添加步骤</button>' +
            '<div class="pm-hint" id="pmEdHint"></div>' +
          '</div>' +
          '<div class="modal-footer">' +
            '<span class="spacer"></span>' +
            '<button class="m-btn outline" id="pmEdCancel">取消</button>' +
            '<button class="m-btn primary" id="pmEdSave">保存</button>' +
          '</div>' +
        '</div>';
      d.body.appendChild(overlay);

      var close = function () { overlay.remove(); };
      overlay.querySelector('#pmEdClose').addEventListener('click', close);
      overlay.querySelector('#pmEdCancel').addEventListener('click', close);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

      var listEl = overlay.querySelector('#pmEdSteps');
      var bindRow = function (row) {
        row.querySelectorAll('[data-act]').forEach(function (b) {
          b.addEventListener('click', function () {
            var act = b.getAttribute('data-act');
            if (act === 'del') row.remove();
            else if (act === 'up' && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
            else if (act === 'down' && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
          });
        });
      };
      listEl.querySelectorAll('.pm-ed-row').forEach(bindRow);

      overlay.querySelector('#pmEdAdd').addEventListener('click', function () {
        var host = overlay.querySelector('#pmEdSteps');
        if (host.querySelector('.pm-empty')) host.innerHTML = '';
        var tmp = d.createElement('div');
        tmp.innerHTML = editorRowHtml(null, host.children.length);
        var row = tmp.firstElementChild;
        host.appendChild(row);
        bindRow(row);
        var inp = row.querySelector('.pm-ed-content'); if (inp) inp.focus();
      });

      overlay.querySelector('#pmEdSave').addEventListener('click', function () {
        var objective = (overlay.querySelector('#pmEdObjective').value || '').trim();
        var next = [];
        overlay.querySelectorAll('.pm-ed-row').forEach(function (row, i) {
          var content = (row.querySelector('.pm-ed-content').value || '').trim();
          if (!content) return;
          next.push({
            id: row.getAttribute('data-id') || ('p' + (i + 1)),
            content: content,
            status: row.querySelector('.pm-ed-status').value,
            risk: row.querySelector('.pm-ed-risk').value,
            tool: (row.querySelector('.pm-ed-tool').value || '').trim(),
            dependsOn: (row.querySelector('.pm-ed-deps').value || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean),
            activeForm: content
          });
        });
        if (ps && ps.setObjective) ps.setObjective(objective);
        var res = PlanMode.setRichSteps(next);
        if (res.errors && res.errors.length) {
          var hint = overlay.querySelector('#pmEdHint');
          if (hint) { hint.textContent = '⚠ ' + res.errors.join('；'); hint.style.color = '#ff7b72'; }
          return; // 有依赖错误 → 不关闭，便于修正
        }
        snack('计划已保存（' + next.length + ' 步）');
        close();
      });
    },

    // ── 生命周期 ──
    boot: function () {
      if (!hasDom()) return;
      var self = this;
      // 载入持久化
      var p = doPersist();
      try {
        var m = p && p.load(MODE_KEY, 'craft');
        if (MODES.indexOf(m) !== -1) this.mode = m;
        this.approval = !!(p && p.load(APPROVAL_KEY, false));
      } catch (_) {}

      this._augmentPlanStore();

      // 优先渲染（覆盖 06 的 renderPlanBar）
      try { if (root && root.renderPlanBar) root.renderPlanBar = function () { self.renderPlanBoard(); }; } catch (_) {}
      this.renderPlanBoard();

      // 注册 MCP 工具（走可插拔注册表 → 自动进入工具循环与前缀指纹）
      if (root && isFn(root.registerTool)) {
        root.registerTool({
          name: 'plan_write',
          description: '创建/替换执行计划（结构化步骤）。Args: { objective, steps:[{content,status?,tool?,risk?,dependsOn?,note?}], mode? }。Plan 模式下应只用它提交计划，不执行副作用工具。',
          tags: ['plan', 'builtin'],
          inputSchema: {
            type: 'object',
            properties: {
              objective: { type: 'string', description: '计划目标（一句话）' },
              steps: {
                type: 'array',
                description: '步骤数组；每项可为字符串，或 {content,status,tool,risk,dependsOn,note}',
                items: {}
              },
              mode: { type: 'string', description: '可选：ask|plan|craft；写入计划后切到的模式', enum: ['ask', 'plan', 'craft'] }
            },
            required: ['steps']
          },
          handler: function (args) { return toolPlanWrite(args); }
        });
        root.registerTool({
          name: 'plan_update',
          description: '更新计划中的某一步（状态/备注/产物）。Args: { index?|id?, status?, note?, artifacts? }。',
          tags: ['plan', 'builtin'],
          inputSchema: {
            type: 'object',
            properties: {
              index: { type: 'integer', description: '步骤序号（0 基）' },
              id: { type: 'string', description: '步骤 id（与 index 二选一）' },
              status: { type: 'string', description: 'pending|in_progress|completed|skipped|failed|blocked' },
              note: { type: 'string' },
              artifacts: { type: 'array', items: {} }
            },
            required: []
          },
          handler: function (args) { return toolPlanUpdate(args); }
        });
        root.registerTool({
          name: 'plan_get',
          description: '读取当前计划（目标 + 步骤 + 进度）。无需参数。',
          tags: ['plan', 'builtin'],
          inputSchema: { type: 'object', properties: {}, required: [] },
          handler: function () { return toolPlanGet(); }
        });
      }
    },

    _augmentPlanStore: function () {
      var ps = PStore();
      if (!ps || ps.__planModeAugmented) return;
      ps.__planModeAugmented = true;
      // 覆盖 setSteps：兼容旧结构，同时保留富字段（todo_write 也受益）
      ps.setSteps = function (steps) { return PlanMode.setRichSteps(steps); };
      ps.setRichSteps = function (steps) { return PlanMode.setRichSteps(steps); };
      ps.updateStep = function (key, patch) { return PlanMode.updateStep(key, patch); };
      ps.markArtifact = function (key, a) { return PlanMode.markArtifact(key, a); };
      // 包 injectInto：保留原计划注入，再补 <exec-mode> 模式说明
      var baseInject = ps.injectInto;
      ps.injectInto = function (conv) {
        var r = false;
        try { r = baseInject.call(this, conv) || r; } catch (_) {}
        try { r = PlanMode._injectModeNote(conv) || r; } catch (_) {}
        return r;
      };
    }
  };

  // ── 编辑弹窗的一行 ──
  function editorRowHtml(s, i) {
    var st = s ? s.status : 'pending';
    var statusOpts = ['pending', 'in_progress', 'completed', 'skipped', 'failed', 'blocked'].map(function (v) {
      return '<option value="' + v + '"' + (v === st ? ' selected' : '') + '>' + v + '</option>';
    }).join('');
    var risk = s && s.risk === 'high' ? 'high' : 'low';
    var riskOpts = ['low', 'high'].map(function (v) {
      return '<option value="' + v + '"' + (v === risk ? ' selected' : '') + '>' + v + '</option>';
    }).join('');
    var deps = s && s.dependsOn ? s.dependsOn.join(', ') : '';
    return '<div class="pm-ed-row" data-id="' + esc(s ? s.id : '') + '">' +
      '<input class="pm-input pm-ed-content" placeholder="步骤内容" value="' + esc(s ? s.content : '') + '">' +
      '<select class="pm-select pm-ed-status">' + statusOpts + '</select>' +
      '<select class="pm-select pm-ed-risk">' + riskOpts + '</select>' +
      '<input class="pm-input pm-ed-tool" placeholder="tool" value="' + esc(s ? s.tool : '') + '" style="max-width:120px;">' +
      '<input class="pm-input pm-ed-deps" placeholder="dependsOn(逗号)" value="' + esc(deps) + '" style="max-width:120px;">' +
      '<span class="pm-ed-ops">' +
        '<button class="pm-mini" data-act="up" title="上移">↑</button>' +
        '<button class="pm-mini" data-act="down" title="下移">↓</button>' +
        '<button class="pm-mini" data-act="del" title="删除">✕</button>' +
      '</span>' +
      '</div>';
  }

  // ── 工具实现：统一返回 MCP 结果 JSON 字符串 ──
  function mcpResult(ok, text, extra) {
    return JSON.stringify(Object.assign({ success: !!ok, content: [{ type: 'text', text: String(text) }] }, extra || {}));
  }
  function toolPlanWrite(args) {
    args = (args && typeof args === 'object') ? args : {};
    var steps = asArray(args) || args.steps;
    if (!Array.isArray(steps) && !Array.isArray(asArray(args))) {
      return mcpResult(false, 'plan_write 需要 `steps` 数组。');
    }
    if (args.objective && PStore() && PStore().setObjective) PStore().setObjective(String(args.objective));
    var res = PlanMode.setRichSteps(steps);
    if (res.errors && res.errors.length) {
      return mcpResult(false, '计划依赖有误：' + res.errors.join('；'));
    }
    if (args.mode && MODES.indexOf(args.mode) !== -1) PlanMode.setMode(args.mode, { silent: true });
    var ps = PStore();
    var obj = ps ? ps.objective : (args.objective || '');
    return mcpResult(true,
      '计划已创建（' + res.steps.length + ' 步）。' +
      (PlanMode.getMode() === 'plan'
        ? '当前为 Plan 模式：等待用户确认后再执行（不要调用副作用工具）。'
        : '可继续执行。') + '\n' +
      snapshotText(obj, res.steps));
  }
  function toolPlanUpdate(args) {
    args = (args && typeof args === 'object') ? args : {};
    var key = (args.id != null) ? args.id : (args.index != null ? Number(args.index) : PlanMode._currentIndex());
    if (key == null || key < 0) return mcpResult(false, '未找到要更新的步骤。');
    var patch = {};
    if (args.status) patch.status = args.status;
    if (args.note != null) patch.note = String(args.note);
    PlanMode.updateStep(key, patch);
    if (Array.isArray(args.artifacts)) {
      var ps = PStore();
      var idx = PlanMode._indexOf(ps ? ps.steps : [], key);
      var sid = (ps && ps.steps[idx]) ? ps.steps[idx].id : key;
      args.artifacts.forEach(function (a) { PlanMode.markArtifact(sid, a); });
    }
    var ps2 = PStore();
    return mcpResult(true, '已更新。\n' + snapshotText(ps2 ? ps2.objective : '', ps2 ? ps2.steps : []));
  }
  function toolPlanGet() {
    var ps = PStore();
    if (!ps || !ps.steps.length) return mcpResult(true, '当前没有计划。可调用 plan_write 创建。');
    return mcpResult(true, '执行模式：' + modeLabel(PlanMode.getMode()) + '\n' + snapshotText(ps.objective, ps.steps));
  }

  // 从工具调用推断产物（供 afterToolCall 回贴）
  function artifactsFrom(name, args, resultStr) {
    var out = [];
    var a = (args && typeof args === 'object') ? args : {};
    var path = a.output_path || a.file_path || a.path || a.markdown_path;
    if (path && /(markdown_to_pdf|html_to_ppt|chart|data_to_chart|markdown_to_docx|markdown_to_pptx|report_to_pptx|write_file|kb_ingest)/.test(String(name))) {
      out.push({ kind: 'file', path: String(path), label: String(path).split('/').pop() });
    }
    // 结果里显式带 artifacts（未来工具可返回）
    try {
      var parsed = (typeof resultStr === 'string') ? JSON.parse(resultStr) : resultStr;
      if (parsed && Array.isArray(parsed.artifacts)) {
        parsed.artifacts.forEach(function (x) { if (x && x.path) out.push({ kind: x.kind || 'file', path: x.path, label: x.label || String(x.path).split('/').pop() }); });
      }
    } catch (_) {}
    return out;
  }

  // 自动引导（浏览器）
  if (root && root.document && !root.__planModeBooted) {
    root.__planModeBooted = true;
    var kick = function () { try { PlanMode.boot(); } catch (e) { try { console.warn('[plan-mode] boot failed', e); } catch (_) {} } };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', kick);
    else setTimeout(kick, 0);
  }

  return PlanMode;
});
