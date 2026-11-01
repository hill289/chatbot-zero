/*!
 * approval.js — 工具调用审批闸门（Approval Gate）
 * -----------------------------------------------------------------------------
 * 目标：把「写 / 改 / 删 / 执行」四类有副作用的工具，从「模型说干就干」改成
 * 「逐次征得用户同意」，并让「拒绝」变成一条**模型能读懂的结构化结果**，
 * 而不是抛异常 / 静默失败。
 *
 * 设计要点（与 dsh 的 tools/pre-execute 审批语义对齐，但保持零依赖可单测）：
 *   1) 纯逻辑：不碰 DOM、不依赖应用内其它全局。UI 由宿主通过 `ask` 注入。
 *   2) 决策只有三种：allow-once / allow-session / deny，未知答案一律按 deny
 *      （fail-closed：宁可少做一步，也不要静默执行）。
 *   3) allow-session 的授权粒度是「工具 + 作用域」：
 *        - 文件类工具：按工具名（如 write_file）
 *        - run_shell：按命令首词（如 run_shell::git），避免一句 OK 放行所有命令
 *   4) 拒绝文案自带「不要原样重试」的指引，避免模型在同一个调用上死循环。
 *   5) 没有可用的 ask（headless / 单测环境）时按拒绝处理，而不是静默放行。
 *
 * 兼容 UMD：浏览器挂到 globalThis.ApprovalService；Node 下 module.exports 导出，
 * 便于对本文件做独立单元测试（见 renderer/approval.test.js）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ApprovalService = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;

  // ── 默认需要审批的工具 ────────────────────────────────────────────────
  // 写 / 改 / 删 / 执行。注意：
  //   · run_node 也能读写虚拟文件系统，但默认不拦（几乎每轮都用，逐次弹窗会烦死人）；
  //     需要时把它加进 policy.tools 即可（设置面板支持逗号分隔编辑）。
  //   · 只读类工具（read_file / list_dir / search_content / read_url …）永不拦。
  var DEFAULT_TOOLS = [
    'write_file', 'edit_file', 'replace_lines', 'add_content', 'delete_content',
    'delete_file', 'run_shell'
  ];

  var TOOL_LABELS = {
    write_file: '写入文件',
    edit_file: '编辑文件',
    replace_lines: '按行替换',
    add_content: '插入内容',
    delete_content: '删除内容',
    delete_file: '删除文件 / 目录',
    run_shell: '执行 shell 命令',
    run_node: '执行 Node 代码'
  };

  // ── 小工具 ────────────────────────────────────────────────────────────
  function str(v) { return v == null ? '' : String(v); }
  function asArray(v) { return Array.isArray(v) ? v : []; }
  function clip(s, n) {
    s = str(s);
    if (n <= 0 || s.length <= n) return s;
    return s.slice(0, n) + '…';
  }
  // 压成一行，用于摘要 / 目标展示（保留可读性，去掉大段换行）
  function oneLine(s) { return str(s).replace(/\s+/g, ' ').trim(); }
  function countLines(s) {
    s = str(s);
    if (!s) return 0;
    var n = s.split('\n').length;
    return s.charAt(s.length - 1) === '\n' ? n - 1 : n;
  }
  function safeJson(v) {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  // ── 策略归一化（外部传入什么都能用；坏数据回退默认）────────────────────
  function normalizePolicy(p) {
    p = (p && typeof p === 'object') ? p : {};
    var tools = asArray(p.tools).map(str).map(function (s) { return s.trim(); }).filter(Boolean);
    var exempt = asArray(p.exempt).map(str).map(function (s) { return s.trim(); }).filter(Boolean);
    var timeout = Number(p.timeoutMs);
    return {
      enabled: p.enabled !== false,
      tools: tools.length ? tools : DEFAULT_TOOLS.slice(),
      exempt: exempt,
      timeoutMs: (isFinite(timeout) && timeout > 0) ? timeout : 0,
      defaultDenyReason: str(p.defaultDenyReason).trim()
    };
  }

  // ── 授权作用域：文件类按工具名；run_shell 按命令首词 ────────────────────
  function grantScope(toolName, args) {
    var name = str(toolName);
    var a = (args && typeof args === 'object') ? args : {};
    if (name === 'run_shell') {
      var cmd = oneLine(a.command);
      var first = cmd ? cmd.split(' ')[0] : '*';
      return 'run_shell::' + first;
    }
    return name;
  }

  // ── 把一次调用翻译成人话（供模态框展示，也供日志/审计）──────────────────
  function describe(toolName, args) {
    var name = str(toolName);
    var a = (args && typeof args === 'object') ? args : {};
    var d = {
      tool: name,
      label: TOOL_LABELS[name] || name || '(unknown tool)',
      risk: 'medium',
      target: '',
      summary: '',
      rows: [],
      preview: '',
      previewKind: 'text',
      scope: grantScope(name, a)
    };

    switch (name) {
      case 'write_file': {
        var content = str(a.content);
        d.risk = 'high';
        d.target = str(a.file_path);
        d.summary = '覆盖写入 ' + countLines(content) + ' 行（' + content.length + ' 字符）';
        d.previewKind = 'text';
        d.preview = content;
        break;
      }
      case 'edit_file': {
        var oldS = str(a.old_string);
        var newS = str(a.new_string);
        d.risk = 'high';
        d.target = str(a.file_path);
        d.summary = (a.replace_all ? '替换全部匹配' : '替换首个匹配') +
          '：' + clip(oneLine(oldS), 48) + ' → ' + clip(oneLine(newS), 48);
        d.previewKind = 'diff';
        d.preview = '- ' + clip(oldS, 600) + '\n+ ' + clip(newS, 600);
        d.rows.push({ key: '匹配', value: a.replace_all ? '全部出现' : '首个出现' });
        break;
      }
      case 'replace_lines': {
        var nl = str(a.new_content);
        d.risk = 'high';
        d.target = str(a.file_path);
        d.summary = '把第 ' + str(a.start_line) + '–' + str(a.end_line) + ' 行替换为 ' + countLines(nl) + ' 行';
        d.previewKind = 'diff';
        d.preview = '- [第 ' + str(a.start_line) + '–' + str(a.end_line) + ' 行]\n+ ' + clip(nl, 600);
        break;
      }
      case 'add_content': {
        var ac = str(a.add_content);
        d.risk = 'medium';
        d.target = str(a.file_path);
        d.summary = '在第 ' + str(a.line_number) + ' 行前插入 ' + countLines(ac) + ' 行（' + ac.length + ' 字符）';
        d.previewKind = 'text';
        d.preview = ac;
        break;
      }
      case 'delete_content': {
        d.risk = 'high';
        d.target = str(a.file_path);
        d.summary = '删除第 ' + str(a.start_line) + '–' + str(a.end_line) + ' 行';
        break;
      }
      case 'delete_file': {
        var ft = str(a.file_type).toLowerCase();
        var isDir = (ft === 'folder' || ft === 'directory');
        d.risk = 'high';
        d.target = str(a.file_path);
        d.summary = isDir ? '⚠ 递归删除目录及其全部内容' : '删除文件';
        d.rows.push({ key: '类型', value: isDir ? '目录（递归）' : '文件' });
        break;
      }
      case 'run_shell': {
        d.risk = 'high';
        d.target = str(a.command);
        d.summary = '在本机真实工作区执行 shell 命令';
        d.previewKind = 'command';
        d.preview = str(a.command);
        if (a.cwd) d.rows.push({ key: '工作目录', value: str(a.cwd) });
        if (a.timeout_ms) d.rows.push({ key: '超时', value: str(a.timeout_ms) + ' ms' });
        break;
      }
      case 'run_node': {
        var code = str(a.code);
        d.risk = 'high';
        d.target = 'almostnode 沙箱';
        d.summary = '执行 ' + code.length + ' 字符 Node.js 代码（可读写虚拟文件系统）';
        d.previewKind = 'code';
        d.preview = code;
        break;
      }
      default: {
        d.target = str(a.file_path || a.path || a.command || '');
        d.summary = clip(oneLine(safeJson(a)), 140);
        d.preview = clip(safeJson(a), 600);
        break;
      }
    }

    if (d.target) d.rows.unshift({ key: '目标', value: d.target });
    if (d.preview) d.preview = clip(d.preview, 1200);
    return d;
  }

  // ── 拒绝文案（回给模型的那条工具结果）──────────────────────────────────
  function denyMessage(descriptor, reason) {
    var d = descriptor || {};
    var name = str(d.tool) || '该工具';
    var label = str(d.label) || name;
    var target = d.target ? '（' + clip(oneLine(d.target), 120) + '）' : '';
    var why = str(reason).trim();
    return '⛔ 用户拒绝执行 ' + label + ' `' + name + '`' + target + '。' +
      (why ? '拒绝理由：' + why + '。' : '用户未填写拒绝理由。') +
      '这是用户主动做出的授权决定，不是工具故障、也不是参数错误 —— 请勿原样重试同一调用。' +
      '可以改用更小的改动范围、换一种做法，或先用一句话向用户说明意图并征得同意。' +
      ' [Denied by user; do not retry the same call unchanged.]';
  }

  // ── 服务实例 ──────────────────────────────────────────────────────────
  function create(opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    var policy = normalizePolicy(opts.policy);
    var ask = (typeof opts.ask === 'function') ? opts.ask : null;
    var nowFn = (typeof opts.now === 'function') ? opts.now : function () { return Date.now(); };
    var MAX_HISTORY = 200;

    var grants = Object.create(null);   // scopeKey -> 授权时间戳
    var history = [];                   // 审计流水（内存，最近 200 条）

    function setPolicy(next) { policy = normalizePolicy(next); }
    function getPolicy() {
      return {
        enabled: policy.enabled,
        tools: policy.tools.slice(),
        exempt: policy.exempt.slice(),
        timeoutMs: policy.timeoutMs,
        defaultDenyReason: policy.defaultDenyReason
      };
    }

    function isGuarded(name) {
      name = str(name);
      if (!name || !policy.enabled) return false;
      if (policy.exempt.indexOf(name) !== -1) return false;
      return policy.tools.indexOf(name) !== -1;
    }

    function needsApproval(name, args) {
      if (!policy.enabled) return { required: false, reason: 'disabled' };
      if (!isGuarded(name)) return { required: false, reason: 'unguarded' };
      var scope = grantScope(name, args);
      if (grants[scope]) return { required: false, reason: 'session-grant', scope: scope };
      return { required: true, reason: 'policy', scope: scope };
    }

    function grant(name, args) {
      var scope = (args === undefined) ? str(name) : grantScope(name, args);
      if (!scope) return '';
      grants[scope] = nowFn();
      return scope;
    }
    function revoke(scope) {
      if (scope) { delete grants[scope]; return; }
      grants = Object.create(null);
    }
    function listGrants() {
      return Object.keys(grants).map(function (k) { return { scope: k, at: grants[k] }; });
    }

    function _record(entry) {
      history.push(entry);
      if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    }
    function getHistory() { return history.slice(); }

    function _deny(descriptor, reason, code) {
      _record({
        tool: descriptor.tool, target: descriptor.target, scope: descriptor.scope,
        decision: 'deny', reason: reason, at: nowFn()
      });
      return {
        allowed: false, decision: 'deny', reason: reason, code: code || 'denied',
        descriptor: descriptor, text: denyMessage(descriptor, reason)
      };
    }

    // guard：唯一入口。永远 resolve（不 reject），失败一律转成 deny。
    function guard(toolName, args) {
      var need = needsApproval(toolName, args);
      if (!need.required) {
        var okDecision = (need.reason === 'session-grant') ? 'allow-session'
          : (need.reason === 'disabled' ? 'disabled' : 'unguarded');
        return Promise.resolve({ allowed: true, decision: okDecision, descriptor: null });
      }

      var descriptor = describe(toolName, args);

      if (!ask) {
        return Promise.resolve(_deny(descriptor, '当前宿主没有可用的审批界面（未注入 ask），按拒绝处理', 'no-asker'));
      }

      var asked;
      try { asked = Promise.resolve(ask(descriptor)); }
      catch (e) { asked = Promise.reject(e); }

      var timer = null;
      if (policy.timeoutMs > 0) {
        asked = Promise.race([
          asked,
          new Promise(function (resolve) {
            timer = setTimeout(function () {
              resolve({
                decision: 'deny',
                reason: '审批超时（' + Math.round(policy.timeoutMs / 1000) + ' 秒未响应），按拒绝处理',
                timedOut: true
              });
            }, policy.timeoutMs);
          })
        ]);
      }

      return asked.then(function (answer) {
        if (timer) { clearTimeout(timer); timer = null; }

        var decision = answer;
        var reason = '';
        if (answer && typeof answer === 'object') {
          decision = answer.decision;
          reason = str(answer.reason);
        }
        decision = str(decision);

        if (decision === 'allow-once' || decision === 'allow-session') {
          if (decision === 'allow-session') grant(toolName, args);
          _record({
            tool: descriptor.tool, target: descriptor.target, scope: descriptor.scope,
            decision: decision, at: nowFn()
          });
          return { allowed: true, decision: decision, descriptor: descriptor };
        }

        var finalReason = reason || policy.defaultDenyReason;
        if (!finalReason) {
          finalReason = (decision === 'deny')
            ? '用户未填写拒绝理由'
            : ('无法识别的审批结果：' + (decision || '(空)'));
        }
        return _deny(descriptor, finalReason, decision === 'deny' ? 'denied' : 'unknown-answer');
      }, function (err) {
        if (timer) { clearTimeout(timer); timer = null; }
        return _deny(descriptor, '审批流程异常：' + ((err && err.message) || str(err)), 'ask-error');
      });
    }

    return {
      version: VERSION,
      // 策略
      setPolicy: setPolicy,
      getPolicy: getPolicy,
      // 查询
      isGuarded: isGuarded,
      needsApproval: needsApproval,
      describe: describe,
      // 授权
      grant: grant,
      revoke: revoke,
      listGrants: listGrants,
      // 审批
      guard: guard,
      // 审计
      getHistory: getHistory
    };
  }

  return {
    version: VERSION,
    DEFAULT_TOOLS: DEFAULT_TOOLS,
    TOOL_LABELS: TOOL_LABELS,
    normalizePolicy: normalizePolicy,
    grantScope: grantScope,
    describe: describe,
    denyMessage: denyMessage,
    create: create
  };
});
