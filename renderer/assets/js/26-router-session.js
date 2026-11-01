/*!
 * 26-router-session.js — RouterSession（Super-agent 模块 2 · 双层架构 · Router 层）
 * =============================================================================
 * 目标（对齐优化方案 模块 2）：
 *   · Router 只做「人类交互 + 任务分派 + 全局记忆」，**不挂重执行工具**；
 *     所有真实执行都经 workerPool.spawn 派给 Worker（隔离上下文 / 全工具）。
 *   · Worker 完成后把「状态/进度/结论」作为事件汇报给 Router（onWorkerReport），
 *     Router 统一整合、面向最终用户输出（避免多会话各自回复造成交互混乱）。
 *
 * 本文件是**纯逻辑 + 编排**（不碰 DOM、不做 IO），便于 Node 单测：
 *   · filterToolsForModel(tools, role)：按会话角色裁剪工具集（前缀缓存友好——
 *     只有当角色确实为 router 时才剔除重工具，Worker/main 原样返回）。
 *   · isExecutionTool(name)：重执行工具判定。
 *   · createRouterSession({ workerPool, emit, role })：派单 + 汇报整合 + 出站队列。
 *
 * UMD：浏览器挂 globalThis.RouterSession / Node 下 module.exports（可 node --test）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RouterSession = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Router 不直接调用的「重执行」工具：这些一律派给 Worker。
  // 注意：run_subagent 保留（它就是派单入口）；read_* / search / read_url / web_search
  //      等只读检索类保留在 Router，用于分派前侦察与整合。
  var EXECUTION_TOOLS = [
    'run_shell', 'run_node', 'write_file', 'edit_file', 'replace_lines',
    'add_content', 'delete_content', 'delete_file', 'run_tests',
    'markdown_to_pdf', 'html_to_ppt'
  ];
  var EXEC_SET = {};
  EXECUTION_TOOLS.forEach(function (n) { EXEC_SET[n] = 1; });

  function isExecutionTool(name) { return !!EXEC_SET[name]; }

  function toolNameOf(t) {
    if (!t) return '';
    if (t.function && t.function.name) return t.function.name;
    if (t.name) return t.name;
    return '';
  }

  // role==='router' → 去掉重执行工具；其它角色（'worker'/'main'/undefined）原样返回副本。
  function filterToolsForModel(tools, role) {
    if (!Array.isArray(tools)) return [];
    if (role !== 'router') return tools.slice();
    return tools.filter(function (t) { return !isExecutionTool(toolNameOf(t)); });
  }

  function buildWorkerReportText(report) {
    report = report || {};
    var label = 'Worker #' + (report.workerId != null ? report.workerId : '?');
    var status = report.status ? ('[' + report.status + '] ') : '';
    var summary = (report.summary == null ? '' : String(report.summary)).trim();
    if (summary.length > 500) summary = summary.slice(0, 500) + '…';
    return label + ' ' + status + (summary || '（无摘要）');
  }

  function createRouterSession(deps) {
    deps = deps || {};
    var workerPool = deps.workerPool || null;
    var emit = (typeof deps.emit === 'function') ? deps.emit : function () {};
    var role = deps.role || 'router';
    var now = (typeof deps.now === 'function') ? deps.now : function () { return Date.now(); };
    var outbox = [];       // 待投递给 Router 对话的「汇报消息」
    var reportLog = [];    // 收到的全部汇报（供巡检 / 追溯）

    function dispatch(spec) {
      if (!workerPool || typeof workerPool.spawn !== 'function') {
        return { workerId: null, accepted: false, error: 'no-worker-pool' };
      }
      return workerPool.spawn(spec || {});
    }

    // Worker 汇报出口：整合成一条 Router 侧消息（作为对话尾部新事件注入，前缀不变）
    function onWorkerReport(report) {
      report = report || {};
      reportLog.push(Object.assign({ at: now() }, report));
      if (reportLog.length > 500) reportLog.shift();
      var msg = {
        role: 'user',
        content: '<worker-report>\n' + buildWorkerReportText(report) + '\n</worker-report>',
        _workerReport: true,
        _workerId: report.workerId,
        _workerStatus: report.status
      };
      outbox.push(msg);
      try { emit(msg, report); } catch (_) {}
      return msg;
    }

    function drainReports() {
      var out = outbox.slice();
      outbox = [];
      return out;
    }

    function listWorkers() {
      if (workerPool && typeof workerPool.list === 'function') return workerPool.list();
      return [];
    }

    function killWorker(id) {
      if (workerPool && typeof workerPool.kill === 'function') return workerPool.kill(id);
      return false;
    }

    return {
      role: role,
      dispatch: dispatch,
      onWorkerReport: onWorkerReport,
      drainReports: drainReports,
      listWorkers: listWorkers,
      killWorker: killWorker,
      reports: function () { return reportLog.slice(); }
    };
  }

  // 便捷：作为 mcpStore.toolFilter 直接注入（仅当 Router 角色启用时）
  function routerToolFilter(tools) { return filterToolsForModel(tools, 'router'); }

  return {
    EXECUTION_TOOLS: EXECUTION_TOOLS,
    isExecutionTool: isExecutionTool,
    toolNameOf: toolNameOf,
    filterToolsForModel: filterToolsForModel,
    buildWorkerReportText: buildWorkerReportText,
    createRouterSession: createRouterSession,
    routerToolFilter: routerToolFilter
  };
});
