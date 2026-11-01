/*!
 * agent-control-bootstrap.js — 子代理控制面接线（list_agents / send_message / interrupt_agent）
 * 依赖：renderer/agent-control.js（纯逻辑）、renderer/tool-registry.js、window.__subagentStore。
 */
(function () {
  'use strict';
  var CORE = (typeof window !== 'undefined' && window.AgentControl) || null;
  if (!CORE) { try { console.warn('[agent-control] agent-control.js 未加载，跳过接线'); } catch (_) {} return; }

  function store() { return (typeof window !== 'undefined') ? window.__subagentStore : null; }

  function toolList() {
    var s = store();
    if (!s) return { error: 'subagent store 不可用（13-subagent-ui.js 未加载）' };
    var windows = s.windows || [];
    return { agents: windows.map(function (w) { return CORE.summarize(w); }), formatted: CORE.formatList(windows) };
  }

  function toolSend(args) {
    args = args || {};
    var s = store();
    if (!s) return { error: 'subagent store 不可用' };
    var win = CORE.findById(s.windows, args.id);
    if (!win) return { error: '未找到 agent #' + args.id };
    var msg = String(args.message == null ? '' : args.message);
    if (!msg.trim()) return { error: 'message 不能为空' };
    var status = CORE.statusOf(win);
    if (win.isRunningTask || win.generating || (win.taskQueue && win.taskQueue.length > 0)) {
      return { error: 'agent #' + args.id + ' 正忙（' + status + '）；请先 interrupt_agent 或等其完成后再发送', status: status };
    }
    win.userMessage = msg;
    try {
      var input = win.$el && win.$el.querySelector('.sa-input');
      if (input) input.value = msg;
      if (typeof updateSubagentInput === 'function') updateSubagentInput(win);
    } catch (_) {}
    try { win.sendMessage(); } catch (e) { return { error: '发送失败：' + ((e && e.message) || e) }; }
    return { sent: true, id: win.id, status: 'generating' };
  }

  function toolInterrupt(args) {
    args = args || {};
    var s = store();
    if (!s) return { error: 'subagent store 不可用' };
    var win = CORE.findById(s.windows, args.id);
    if (!win) return { error: '未找到 agent #' + args.id };
    var prev = CORE.statusOf(win);
    try {
      if (win.isRunningTask && typeof win._taskReject === 'function') {
        win._taskReject(new Error('interrupted by agent'));
      }
    } catch (_) {}
    win.isRunningTask = false;
    win.generating = false;
    win.isProcessing = false;
    win._guardAborted = true;
    var closed = false;
    if (args.close) { try { s.removeWindow(win.id); closed = true; } catch (_) {} }
    return { interrupted: true, id: args.id, previousStatus: prev, closed: closed };
  }

  var TOOLS = [
    {
      name: 'list_agents',
      description: '列出当前所有子代理（subagent）窗口：id、标题、状态（空闲/运行中/生成中/排队/已中止）、消息数、最近内容片段。',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      handler: function () { return toolList(); }
    },
    {
      name: 'send_message',
      description: '向某个空闲的子代理窗口发送一条消息（继续对话）。忙碌时会拒绝，请先 interrupt_agent 或等待完成。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '子代理窗口 id（来自 list_agents）' },
          message: { type: 'string', description: '要发送的消息' }
        },
        required: ['id', 'message'], additionalProperties: false
      },
      handler: function (args) { return toolSend(args); }
    },
    {
      name: 'interrupt_agent',
      description: '中断某个正在运行/生成的子代理（释放其任务 Promise）。可选 close=true 直接关闭该窗口。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '子代理窗口 id' },
          close: { type: 'boolean', description: '是否同时关闭窗口（默认 false）' }
        },
        required: ['id'], additionalProperties: false
      },
      handler: function (args) { return toolInterrupt(args); }
    }
  ];

  function register() {
    if (typeof window.registerTool !== 'function') { setTimeout(register, 100); return; }
    try {
      if (typeof window.registerTools === 'function') window.registerTools(TOOLS, { source: 'agent-control', builtin: true, override: true });
      else TOOLS.forEach(function (t) { window.registerTool(t, { source: 'agent-control', builtin: true, override: true }); });
    } catch (e) { try { console.warn('[agent-control] 注册失败', e); } catch (_) {} }
  }
  register();
})();
