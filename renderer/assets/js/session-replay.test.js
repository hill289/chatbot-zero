/*!
 * session-replay.test.js — 20-session-replay-ui.js 的 Node 自检（零依赖）
 * 运行： node renderer/assets/js/session-replay.test.js
 */
'use strict';
const SR = require('./20-session-replay-ui.js');
const P = SR.__pure;

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

group('lineDiff');
const d = P.lineDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
eq(d.map(x => x.type), ['eq', 'del', 'ins', 'eq'], 'LCS 产出 eq/del/ins/eq');
eq(d.filter(x => x.type === 'eq').length, 2, '两处相同');
eq(P.lineDiff(['a'], ['a']).every(x => x.type === 'eq'), true, '全等');

group('wordDiff');
const wd = P.wordDiff('天数是15天', '天数是10天');
ok(wd.some(x => x.type === 'del' && /15/.test(x.text)), '删除 15');
ok(wd.some(x => x.type === 'ins' && /10/.test(x.text)), '插入 10');
ok(wd.some(x => x.type === 'eq' && /天数是/.test(x.text)), '相同前缀合并');
eq(P.wordDiff('same', 'same').every(x => x.type === 'eq'), true, '完全相同');

group('messagesToLines');
const lines = P.messagesToLines([
  { role: 'user', content: '你好' },
  { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'image_url' }] }
]);
eq(lines[0], 'user: 你好', '普通消息');
ok(/assistant: hi image_url/.test(lines[1]), '多模态数组拼接');
ok(P.messagesToLines([{ role: 'user', content: 'x'.repeat(300) }])[0].length < 200, '超长截断');

group('normalizeEvents');
eq(P.normalizeEvents({ events: [1, 2] }).length, 2, 'events 字段');
eq(P.normalizeEvents([9]).length, 1, '数组直传');
eq(P.normalizeEvents(null), null, 'null');

group('foldUpTo（兜底实现）');
const evs = [
  { seq: 1, type: 'session.create' },
  { seq: 2, type: 'msg.append', msgs: [{ role: 'user', content: 'a' }] },
  { seq: 3, type: 'msg.append', msgs: [{ role: 'assistant', content: 'b' }] },
  { seq: 4, type: 'msg.truncate', toLen: 1 }
];
eq(P.foldUpTo(evs, 2, 's').length, 1, 'fold 到第2步=1条');
eq(P.foldUpTo(evs, 3, 's').length, 2, 'fold 到第3步=2条');
eq(P.foldUpTo(evs, 4, 's').length, 1, 'truncate 生效');
eq(P.foldUpTo(evs, 0, 's').length, 0, 'fold 到 0 = 空');

console.log('\n──────────────────────────────');
console.log('session-replay.test: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
