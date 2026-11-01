/*!
 * guard.test.js — guard.js 的 Node 自检（零依赖）
 * 运行： node renderer/guard.test.js
 */
'use strict';
const G = require('./guard.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

(async function () {
  group('deadlineFor · 默认/豁免/关闭');
  {
    eq(G.deadlineFor('read_file', {}), 600000, '普通工具默认 10 分钟');
    eq(G.deadlineFor('ask_user', {}), 0, 'ask_user 豁免');
    eq(G.deadlineFor('run_shell', {}), 0, 'run_shell 豁免（自带 timeout）');
    eq(G.deadlineFor('read_file', { deadlineMs: 0 }), 0, 'deadlineMs=0 关闭');
    eq(G.deadlineFor('read_file', { enabled: false }), 0, 'enabled=false 关闭');
    eq(G.deadlineFor('foo', { deadlineMs: 1234, exempt: ['bar'] }), 1234, '自定义毫秒');
    eq(G.isExempt('bar', { exempt: ['bar'] }), true, '自定义豁免命中');
  }

  group('withDeadline · 正常返回');
  {
    const v = await G.withDeadline(Promise.resolve('ok'), 1000, 't');
    eq(v, 'ok', '未超时返回原值');
    const v2 = await G.withDeadline(Promise.resolve('ok2'), 0, 't');
    eq(v2, 'ok2', 'ms<=0 直通');
  }

  group('withDeadline · 超时');
  {
    let code = '';
    try {
      await G.withDeadline(new Promise(() => {}), 30, 'slow_tool');
    } catch (e) { code = e && e.code; }
    eq(code, 'TOOL_DEADLINE', '超时 reject TOOL_DEADLINE');
  }

  group('withDeadline · 原错误透传');
  {
    let msg = '';
    try {
      await G.withDeadline(Promise.reject(new Error('boom')), 1000, 't');
    } catch (e) { msg = e && e.message; }
    eq(msg, 'boom', '原错误透传');
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
})();
