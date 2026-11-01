/*!
 * jobs.test.js — jobs.js 的 Node 自检（零依赖）
 * 运行： node renderer/jobs.test.js
 */
'use strict';
const J = require('./jobs.js');
let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.error('  ✗ ' + m)); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

group('statusOf');
{
  eq(J.statusOf({ status: 'running' }), 'running', '显式 status');
  eq(J.statusOf({ exitCode: 0 }), 'exited', 'exit 0');
  eq(J.statusOf({ exitCode: 1 }), 'failed', 'exit 1');
  eq(J.statusOf(null), 'missing', 'null');
}

group('formatDuration');
{
  eq(J.formatDuration(500), '500ms', '毫秒');
  eq(J.formatDuration(2500), '2.5s', '秒');
  eq(J.formatDuration(65000), '1m5s', '分秒');
}

group('truncateOutput');
{
  const r = J.truncateOutput('abcdef', 3);
  eq(r.text, 'abc', '截断');
  eq(r.truncated, true, '标记');
  eq(r.omitted, 3, '省略');
  eq(J.truncateOutput('ab', 10).truncated, false, '不截断');
}

group('formatList / formatOutput');
{
  const jobs = [
    { id: 'job-1', command: 'npm run dev', status: 'running', startedAt: Date.now() - 2000, stdoutBytes: 100, stderrBytes: 0 },
    { id: 'job-2', command: 'npm test', status: 'exited', exitCode: 0, startedAt: Date.now() - 5000, endedAt: Date.now(), stdoutBytes: 900 }
  ];
  const txt = J.formatList(jobs);
  ok(txt.indexOf('job-1') >= 0 && txt.indexOf('running') >= 0 && txt.indexOf('job-2') >= 0, '列表内容');
  ok(J.formatList([]).indexOf('没有后台任务') >= 0, '空列表');
  const out = J.formatOutput({ job: { id: 'job-1', command: 'x', status: 'running' }, stdout: 'hello', stderr: '', nextOffset: 5, hasMore: true });
  ok(out.indexOf('hello') >= 0 && out.indexOf('offset=5') >= 0, '输出与偏移');
  ok(J.formatOutput({ job: { id: 'j', status: 'exited', exitCode: 0 } }).indexOf('暂无输出') >= 0, '无输出文案');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
