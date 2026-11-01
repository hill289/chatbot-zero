/*!
 * browser-control-bootstrap.js — 把 CDP 浏览器控制能力注册成 LLM 可调用的工具
 * =============================================================================
 * 依赖：
 *   · window.browserControl  —— preload.js 通过 contextBridge 注入（仅工作台主页）
 *   · window.registerTools    —— tool-registry.js 提供（07-mcp.js 挂载）
 *
 * 暴露工具：browser_list_tabs / browser_snapshot / browser_click / browser_type /
 *           browser_navigate / browser_evaluate / browser_screenshot
 * 底层：主进程 browser-cdp.js 走 webContents.debugger（原生 CDP，isTrusted=true）。
 * =============================================================================
 */
(function () {
  'use strict';

  function api() { return (typeof window !== 'undefined') ? window.browserControl : null; }
  function need() {
    var a = api();
    if (!a) throw new Error('browserControl 不可用（当前页面不是工作台主页，或 preload 未注入）');
    return a;
  }
  function errText(r) { return '❌ ' + ((r && r.error) || '操作失败'); }
  function pick(o, keys) {
    var out = {};
    keys.forEach(function (k) { if (o[k] !== undefined) out[k] = o[k]; });
    return out;
  }
  function wrap(fn) {
    return async function (args) {
      try { return await fn(args || {}); }
      catch (e) { return '❌ ' + ((e && e.message) || e); }
    };
  }

  async function tList() {
    var r = await need().listTabs();
    if (!r || r.ok === false) return errText(r);
    var lines = ['标签（' + r.tabs.length + '）：'];
    r.tabs.forEach(function (t) {
      lines.push('#' + t.id + (t.active ? ' [当前]' : '') + ' ' + (t.title || '') + ' — ' + (t.url || ''));
    });
    return lines.join('\n');
  }

  async function tSnapshot(a) {
    var r = await need().snapshot(a.tabId);
    if (!r.ok) return errText(r);
    return r.text;
  }

  async function tClick(a) {
    var r = await need().click(pick(a, ['tabId', 'ref', 'x', 'y', 'button', 'clickCount']));
    if (!r.ok) return errText(r);
    return '已点击：(' + Math.round(r.x) + ', ' + Math.round(r.y) + ')';
  }

  async function tType(a) {
    if (a.text == null) return '❌ 需要 text';
    var r = await need().type(pick(a, ['tabId', 'ref', 'text', 'submit', 'mode']));
    if (!r.ok) return errText(r);
    return '已输入 ' + r.typed + ' 个字符' + (a.submit ? '（并回车提交）' : '');
  }

  async function tNav(a) {
    if (!a.url) return '❌ 需要 url';
    var r = await need().navigate(a.tabId, a.url);
    if (!r.ok) return errText(r);
    return '已导航到 ' + r.url + (r.newTab ? '（已在新标签页打开，保留工作台对话页）' : '');
  }

  async function tEval(a) {
    if (a.expression == null) return '❌ 需要 expression';
    var r = await need().evaluate(a.tabId, a.expression);
    if (!r.ok) return '❌ ' + (r.error || 'evaluate 失败');
    var v = r.value;
    try { v = (typeof v === 'string') ? v : JSON.stringify(v); } catch (_) { v = String(v); }
    return '结果：' + v;
  }

  async function tShot(a) {
    var fmt = (a && a.format) || 'png';
    var r = await need().screenshot(a.tabId, { format: fmt });
    if (!r.ok) return errText(r);
    var len = (r.data && r.data.length) || 0;
    return '已截图（' + fmt + '，base64 长度 ' + len + '）。如需查看/保存，请直接调用 window.browserControl.screenshot 获取 data。';
  }

  var TOOLS = [
    {
      name: 'browser_list_tabs',
      description: '列出内置浏览器的所有标签页（id / 标题 / URL / 是否当前）。操控某标签前先调用它拿 tabId；省略 tabId 时默认操作当前活动标签。',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      handler: wrap(tList),
    },
    {
      name: 'browser_snapshot',
      description: '获取目标标签页的无障碍树（a11y）快照，返回带 ref 编号的可交互元素（按钮/输入框/链接等）。ref 只在本次快照内有效；点击/输入前必须先 snapshot 拿 ref。感知走 a11y 而非截图。',
      inputSchema: { type: 'object', properties: { tabId: { type: 'integer', description: '标签 id（来自 browser_list_tabs）；省略=当前标签' } }, required: [], additionalProperties: false },
      handler: wrap(tSnapshot),
    },
    {
      name: 'browser_click',
      description: '按 ref（推荐）或屏幕坐标点击目标标签元素，通过 CDP Input.dispatchMouseEvent 派发真实鼠标事件（isTrusted=true，可过风控）。支持 button=left/right/middle、clickCount（双击=2）。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'integer' },
          ref: { type: 'integer', description: '元素 ref（来自 browser_snapshot）' },
          x: { type: 'number' }, y: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          clickCount: { type: 'integer' },
        },
        required: [], additionalProperties: false,
      },
      handler: wrap(tClick),
    },
    {
      name: 'browser_type',
      description: '向目标元素输入文本：先点击聚焦再输入（默认 Input.insertText，触发可信 input 事件；mode="keys" 逐字符真实键盘事件）。submit=true 时输入后回车提交。',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'integer' },
          ref: { type: 'integer', description: '输入框 ref（省略则向当前焦点输入）' },
          text: { type: 'string' },
          submit: { type: 'boolean' },
          mode: { type: 'string', enum: ['insert', 'keys'] },
        },
        required: ['text'], additionalProperties: false,
      },
      handler: wrap(tType),
    },
    {
      name: 'browser_navigate',
      description: '让目标标签导航到指定 URL。注意：若目标标签是「工作台主页」（AI 对话页本身），会改为新开一个标签页来打开该 URL，绝不把对话页跳走（避免对话中断）。',
      inputSchema: { type: 'object', properties: { tabId: { type: 'integer' }, url: { type: 'string' } }, required: ['url'], additionalProperties: false },
      handler: wrap(tNav),
    },
    {
      name: 'browser_evaluate',
      description: '在目标标签页的页面上下文执行一段 JavaScript 表达式并返回结果（CDP Runtime.evaluate）。可读取 DOM/状态，但属高危操作，勿用于绕过安全边界。',
      inputSchema: { type: 'object', properties: { tabId: { type: 'integer' }, expression: { type: 'string', description: '要执行的 JS 表达式' } }, required: ['expression'], additionalProperties: false },
      handler: wrap(tEval),
    },
    {
      name: 'browser_screenshot',
      description: '对目标标签页截图（CDP Page.captureScreenshot），返回 base64 长度摘要。用于视觉确认布局/渲染。',
      inputSchema: { type: 'object', properties: { tabId: { type: 'integer' }, format: { type: 'string', enum: ['png', 'jpeg'] } }, required: [], additionalProperties: false },
      handler: wrap(tShot),
    },
  ];

  function register() {
    if (typeof window.registerTool !== 'function') { setTimeout(register, 100); return; }
    try {
      if (typeof window.registerTools === 'function') {
        window.registerTools(TOOLS, { source: 'browser-control', builtin: true, override: true });
      } else {
        TOOLS.forEach(function (t) { window.registerTool(t, { source: 'browser-control', builtin: true, override: true }); });
      }
    } catch (e) { try { console.warn('[browser-control] 注册失败', e); } catch (_) {} }
  }
  register();
})();
