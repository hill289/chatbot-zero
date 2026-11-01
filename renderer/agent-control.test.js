/*!
 * agent-control.test.js — agent-control.js 的 Node 自检（零依赖）
 * 运行： node renderer/agent-control.test.js
 */
'use strict';
const A = require('./agent-control.js');
let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.error('  ✗ ' + m)); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

const W = [
  { id: 1, title: 'Alpha', conversation: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'done 12' }], isRunningTask: false, generating: false },
  { id: 2, title: 'Beta', conversation: [{ role: 'assistant', content: 'working' }], isRunningTask: true, generating: true },
  { id: 3, title: 'Gamma', conversation: [], _guardAborted: true }
];

group('statusOf');
{
  eq(A.statusOf(W[0]), 'idle', '空闲');
  eq(A.statusOf(W[1]), 'generating', '生成中优先');
  eq(A.statusOf(W[2]), 'aborted', '已中止');
  eq(A.statusOf(null), 'missing', 'null');
}

group('summarize / formatList');
{
  const s = A.summarize(W[0]);
  eq(s.id, 1, 'id');
  eq(s.status, 'idle', 'status');
  eq(s.messages, 2, '消息数');
  ok(s.snippet.indexOf('done 12') >= 0, '最近 assistant 片段');
  const txt = A.formatList(W);
  ok(txt.indexOf('#1') >= 0 && txt.indexOf('#2') >= 0 && txt.indexOf('生成中') >= 0, '列表含 id/状态');
  ok(A.formatList([]).indexOf('没有 agent') >= 0, '空列表文案');
}

group('findById / clip');
{
  eq(A.findById(W, 2).title, 'Beta', '按 id 查找');
  eq(A.findById(W, 99), null, '找不到');
  eq(A.clip('abcdef', 3), 'ab…', '截断');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
