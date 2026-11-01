/*!
 * session-trace.test.js — session-trace.js 的 Node 自检（零依赖）
 * 运行： node renderer/session-trace.test.js
 */
'use strict';
const S = require('./session-trace.js');
let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.error('  ✗ ' + m)); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

const EVENTS = [
  { seq: 1, ts: 1000, type: 'session.create', title: 'T' },
  { seq: 2, ts: 1001, type: 'msg.append', msgs: [{ role: 'user', content: 'hello world' }] },
  { seq: 3, ts: 1002, type: 'model.request', digest: 'x', count: 1 },
  { seq: 4, ts: 1003, type: 'msg.append', msgs: [{ role: 'assistant', content: '你好，world 已处理' }] },
  { seq: 5, ts: 1004, type: 'session.branch', from: 's-0', fromSeq: 2 }
];

group('foldSummary');
{
  const st = S.foldSummary(EVENTS, 's-1');
  eq(st.sid, 's-1', 'sid');
  eq(st.title, 'T', '标题');
  eq(st.messages.length, 2, '消息数');
  eq(st.requests, 1, '请求数');
  eq(st.maxSeq, 5, 'maxSeq');
  eq(st.branch.from, 's-0', '血缘');
  eq(st.types['msg.append'], 2, '事件类型计数');
  const txt = S.formatTrace(st);
  ok(txt.indexOf('s-1') >= 0 && txt.indexOf('消息：2') >= 0 && txt.indexOf('fork') >= 0, 'trace 文本');
}

group('searchEvents');
{
  const hits = S.searchEvents(EVENTS, 'world');
  eq(hits.length, 2, '命中 2 处');
  ok(hits[0].snippet.indexOf('hello world') >= 0, '片段');
  eq(S.searchEvents(EVENTS, '').length, 0, '空查询');
  eq(S.searchEvents(EVENTS, '不存在').length, 0, '无命中');
  ok(S.formatSearch('world', hits).indexOf('2 处') >= 0, 'search 文本');
}

group('formatEventList / 边界');
{
  const txt = S.formatEventList(EVENTS, { maxEvents: 2 });
  ok(txt.indexOf('seq 1') >= 0 && txt.indexOf('seq 2') >= 0 && txt.indexOf('seq 3') < 0, '截断到 2 条');
  ok(S.formatEventList([]).indexOf('没有事件') >= 0, '空事件');
  eq(S.foldSummary(null, null).messages.length, 0, 'null 安全');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
