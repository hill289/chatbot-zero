/*!
 * workspace-context.test.js — workspace-context.js 的 Node 自检（零依赖）
 * 运行： node renderer/context/workspace-context.test.js
 */
'use strict';
const C = require('./workspace-context.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

group('truncate');
{
  const a = C.truncate('abcdef', 10);
  eq(a.truncated, false, '短文本不截断');
  const b = C.truncate('abcdef', 3);
  eq(b.text, 'abc', '截断文本');
  eq(b.truncated, true, '标记截断');
  eq(b.omitted, 3, '省略数');
}

group('formatTime');
{
  const d = new Date(2026, 0, 2, 3, 4, 5);
  const s = C.formatTime(d, 'TESTTZ');
  ok(/^2026-01-02 03:04 \(TESTTZ\)$/.test(s), '固定日期格式正确: ' + s);
  ok(/\d{4}-\d\d-\d\d \d\d:\d\d \(UTC[+-]\d\d:\d\d\)/.test(C.formatTime(d)), '默认 UTC 偏移');
  eq(C.formatTime('not-a-date'), '', '非法时间返回空');
}

group('compose');
{
  ok(C.compose({ enabled: false, agentsText: 'x' }) === '', 'enabled=false 返回空');
  const s = C.compose({
    agentsText: '# 规则\n不要删库',
    fileName: 'AGENTS.md',
    workingDirectory: '/home/pyodide/proj',
    includeTime: false
  });
  ok(s.indexOf('<workspace-context>') >= 0, '包裹标签');
  ok(s.indexOf('AGENTS.md') >= 0, '含指令文件名');
  ok(s.indexOf('不要删库') >= 0, '含指令正文');
  ok(s.indexOf('/home/pyodide/proj') >= 0, '含工作目录');
  ok(s.indexOf('当前时间') < 0, 'includeTime=false 无时间');

  const s2 = C.compose({ workingDirectory: '/w', includeTime: true, now: new Date(2026, 0, 2, 3, 4), timezone: 'Z' });
  ok(s2.indexOf('当前时间') >= 0, 'includeTime=true 有时间');

  const s3 = C.compose({ agentsText: 'x'.repeat(20000), maxAgentsChars: 100, includeTime: false });
  ok(s3.indexOf('已截断') >= 0, '超长指令有截断提示');

  ok(C.compose({ includeTime: false }) === '', '无任何内容返回空');
}

group('pickInstructionFile');
{
  eq(C.pickInstructionFile(['AGENTS.md', 'CLAUDE.md'], n => n === 'CLAUDE.md'), 'CLAUDE.md', '按优先级取第一个存在的');
  eq(C.pickInstructionFile(['A'], () => false), null, '都不存在返回 null');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
