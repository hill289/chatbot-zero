/*!
 * browser-control-bootstrap.test.js — 工具接线自检（模拟 window + 假 browserControl）
 * 验证 7 个 browser_* 工具被注册，且 handler 正确调用 preload API 并格式化结果。
 * 运行： node renderer/browser-control-bootstrap.test.js
 */
'use strict';
let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.error('  ✗ ' + m)); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

// ── 造一个最小 window，捕获 registerTools ─────────────────
const registered = [];
let capturedOpts = null;
const calls = [];
global.window = {
  registerTool: function () {}, // 让 register() 认为注册表就绪（不再 setTimeout）
  registerTools: function (defs, opts) { registered.push.apply(registered, defs); capturedOpts = opts; },
  browserControl: {
    listTabs: async () => ({ ok: true, tabs: [{ id: 1, title: 'Demo', url: 'https://d.test/', active: true }, { id: 2, title: 'Other', url: 'https://o.test/', active: false }], activeId: 1 }),
    snapshot: async (tabId) => { calls.push(['snapshot', tabId]); return { ok: true, text: 'Page: Demo — https://d.test/\n  [1] button "Go"' }; },
    click: async (p) => { calls.push(['click', p]); return p.ref === 99 ? { ok: false, error: '引用不存在: ref=99' } : { ok: true, x: 10.4, y: 20.6 }; },
    type: async (p) => { calls.push(['type', p]); return { ok: true, typed: String(p.text || '').length }; },
    navigate: async (tabId, url) => { calls.push(['navigate', tabId, url]); return { ok: true, url: url }; },
    evaluate: async (tabId, expr) => { calls.push(['evaluate', tabId, expr]); return expr === 'bad' ? { ok: false, error: 'boom' } : { ok: true, value: expr === '1+1' ? 2 : { a: 1 } }; },
    screenshot: async (tabId, o) => ({ ok: true, data: 'x'.repeat(50) }),
  },
};

// 加载即执行注册
require('./browser-control-bootstrap.js');

function tool(name) { return registered.find(t => t.name === name); }

(async function run() {
  group('注册');
  {
    eq(registered.length, 7, '注册 7 个工具');
    const names = registered.map(t => t.name).sort();
    eq(names, ['browser_click', 'browser_evaluate', 'browser_list_tabs', 'browser_navigate', 'browser_screenshot', 'browser_snapshot', 'browser_type'], '工具名齐全');
    eq(capturedOpts.source, 'browser-control', 'source 标记');
    eq(capturedOpts.override, true, 'override=true');
    registered.forEach(t => ok(typeof t.handler === 'function' && t.inputSchema, t.name + ' 有 handler+inputSchema'));
  }

  group('handler：调用 preload API 并格式化');
  {
    eq(await tool('browser_list_tabs').handler({}), '标签（2）：\n#1 [当前] Demo — https://d.test/\n#2 Other — https://o.test/', 'list_tabs 文本');

    const snap = await tool('browser_snapshot').handler({ tabId: 1 });
    ok(snap.indexOf('[1] button "Go"') >= 0, 'snapshot 返回快照文本');
    eq(calls.find(c => c[0] === 'snapshot')[1], 1, 'snapshot 透传 tabId');

    eq(await tool('browser_click').handler({ ref: 1 }), '已点击：(10, 21)', 'click 取整坐标');
    eq(await tool('browser_click').handler({ ref: 99 }), '❌ 引用不存在: ref=99', 'click 失败透传错误');

    eq(await tool('browser_type').handler({ text: 'abc' }), '已输入 3 个字符', 'type 计数');
    eq(await tool('browser_type').handler({ text: 'abc', submit: true }), '已输入 3 个字符（并回车提交）', 'type submit 提示');
    eq(await tool('browser_type').handler({}), '❌ 需要 text', 'type 缺 text');

    eq(await tool('browser_navigate').handler({ url: 'https://a.test/' }), '已导航到 https://a.test/', 'navigate 文本');
    eq(await tool('browser_navigate').handler({}), '❌ 需要 url', 'navigate 缺 url');

    eq(await tool('browser_evaluate').handler({ expression: '1+1' }), '结果：2', 'evaluate 标量');
    eq(await tool('browser_evaluate').handler({ expression: '({a:1})' }), '结果：{"a":1}', 'evaluate 对象 JSON');
    eq(await tool('browser_evaluate').handler({ expression: 'bad' }), '❌ boom', 'evaluate 异常');
    eq(await tool('browser_evaluate').handler({}), '❌ 需要 expression', 'evaluate 缺表达式');

    ok((await tool('browser_screenshot').handler({ format: 'png' })).indexOf('base64 长度 50') >= 0, 'screenshot 摘要');
  }

  group('api 缺失时优雅报错');
  {
    const saved = window.browserControl;
    window.browserControl = null;
    const r = await tool('browser_list_tabs').handler({});
    ok(r.indexOf('browserControl 不可用') >= 0, '无 API 提示不可用');
    window.browserControl = saved;
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
})();
