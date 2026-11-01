/*!
 * session-log.test.js — 会话事件日志（18-session-log.js）单元测试
 * 运行：node --test renderer/assets/js/session-log.test.js
 * 覆盖：fold/replay 往返、增量 sync、截断(重生成)、model.request 指纹、
 *       fork（本地回退 + 磁盘前缀）、崩溃恢复（replay）、稳定序列化。
 */
const test = require('node:test');
const assert = require('node:assert');
const SL = require('./18-session-log.js');

// ── 内存版 messagesAPI 假实现 ─────────────────────────────
function makeApi(opts) {
  opts = opts || {};
  const store = {};
  return {
    store,
    append(sid, evs) { (store[sid] = store[sid] || []).push(...evs.map((e) => Object.assign({}, e))); return Promise.resolve({ ok: true, appended: evs.length }); },
    read(sid) { const evs = (store[sid] || []).slice(); return Promise.resolve({ ok: true, events: evs, total: evs.length }); },
    list() { return Promise.resolve({ ok: true, sessions: Object.keys(store).map((sid) => ({ sid, size: (store[sid] || []).length })) }); },
    remove(sid) { delete store[sid]; return Promise.resolve({ ok: true }); },
    fork: opts.fork ? function (from, to, upToSeq) {
      const src = store[from] || [];
      const kept = [];
      let max = 0;
      for (const ev of src.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
        if (ev.seq != null && upToSeq != null && ev.seq > upToSeq) break;
        kept.push(Object.assign({}, ev)); if (ev.seq != null) max = Math.max(max, ev.seq);
      }
      kept.push({ seq: max + 1, ts: Date.now(), type: 'session.branch', sid: to, from, fromSeq: upToSeq == null ? max : upToSeq });
      store[to] = kept;
      return Promise.resolve({ ok: true, to, copied: kept.length - 1 });
    } : undefined
  };
}
function mkLog(api) {
  let i = 0, t = 1000;
  return SL.createSessionLog({ api, uuid: () => 'sid' + (++i), now: () => t++ });
}
const only = (log) => Object.keys(log._sessions())[0];
const diskMsgs = (api, sid) => SL.foldEvents(api.store[sid], sid).messages;

test('fold/replay 往返：sync 后 fold(日志) === 内存对话', () => {
  const api = makeApi();
  const log = mkLog(api);
  const conv = [{ role: 'user', content: '你好' }];
  log.sync(conv);
  conv.push({ role: 'assistant', content: '你好，有什么可以帮你？' });
  log.sync(conv);
  conv.push({ role: 'user', content: '介绍一下 append-only 日志' });
  log.sync(conv);

  const sid = only(log);
  assert.deepStrictEqual(diskMsgs(api, sid), conv, 'replay 应还原出完整对话');
});

test('sync 幂等：无变化时不追加事件', () => {
  const api = makeApi();
  const log = mkLog(api);
  const conv = [{ role: 'user', content: 'a' }];
  log.sync(conv);
  const n1 = api.store[only(log)].length;
  log.sync(conv);
  log.sync(conv);
  assert.strictEqual(api.store[only(log)].length, n1, '重复 sync 不应产生新事件');
});

test('截断（重生成）：splice 后 sync 落 msg.truncate 并保持一致', () => {
  const api = makeApi();
  const log = mkLog(api);
  const conv = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'old' }];
  log.sync(conv);
  conv.splice(1);                        // 重新生成：丢弃旧回答
  conv.push({ role: 'assistant', content: 'new' });
  log.sync(conv);

  const sid = only(log);
  const types = api.store[sid].map((e) => e.type);
  assert.ok(types.includes('msg.truncate'), '应记录截断事件');
  assert.deepStrictEqual(diskMsgs(api, sid), conv);
});

test('model.request：记录模型可见载荷指纹（不变量锚点）', () => {
  const api = makeApi();
  const log = mkLog(api);
  const conv = [{ role: 'user', content: 'hi' }];
  const modelMsgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
  const r = log.recordRequest(modelMsgs, conv);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 2);

  const st = SL.foldEvents(api.store[only(log)], only(log));
  assert.strictEqual(st.requests, 1);
  assert.strictEqual(st.lastRequest.count, 2);
  assert.strictEqual(st.lastRequest.digest, SL.hashText(SL.stableStringify(modelMsgs)));
  assert.deepStrictEqual(st.messages, conv, 'recordRequest 也应先把内存对话对齐到日志');
});

test('fork（本地回退）：新会话 = 源会话消息前缀，且带 branch 标记', async () => {
  const api = makeApi();                 // 无 api.fork → 走本地重建
  const log = mkLog(api);
  const conv = [{ role: 'user', content: '1' }, { role: 'assistant', content: '2' }];
  log.sync(conv);
  const sid = only(log);

  const r = await log.fork(sid);
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(r.sid, sid);
  assert.deepStrictEqual(diskMsgs(api, r.sid), conv);
  const st = SL.foldEvents(api.store[r.sid], r.sid);
  assert.deepStrictEqual(st.branch, { from: sid, fromSeq: conv.length });
});

test('fork（磁盘前缀）：带上 api.fork 时复制源事件并保留请求锚点', async () => {
  const api = makeApi({ fork: true });
  const log = mkLog(api);
  const conv = [{ role: 'user', content: 'x' }];
  log.sync(conv);
  log.recordRequest([{ role: 'user', content: 'x' }], conv);   // 产生一个 model.request 锚点
  const sid = only(log);

  const r = await log.fork(sid);
  const st = SL.foldEvents(api.store[r.sid], r.sid);
  assert.deepStrictEqual(st.messages, conv);
  assert.ok(st.branch, '应有分支标记');
  assert.strictEqual(st.requests, 1, '前缀里的 model.request 锚点应被保留');
});

test('崩溃恢复：新实例 replay 磁盘日志还原对话', async () => {
  const api = makeApi();
  const log = mkLog(api);
  const conv = [{ role: 'user', content: '崩溃前' }, { role: 'assistant', content: '已落盘' }];
  log.sync(conv);
  // 模拟「刷新 / 崩溃后重启」：换一个全新的日志实例，只有磁盘可用
  const log2 = mkLog(api);
  const sid = Object.keys(api.store)[0];
  const rr = await log2.replay(sid);
  assert.strictEqual(rr.ok, true);
  assert.deepStrictEqual(rr.messages, conv);
});

test('稳定序列化 / 指纹：键序无关、内容变则指纹变', () => {
  assert.strictEqual(SL.stableStringify({ a: 1, b: [2, 3] }), SL.stableStringify({ b: [2, 3], a: 1 }));
  assert.notStrictEqual(
    SL.hashText(SL.stableStringify({ role: 'user', content: 'a' })),
    SL.hashText(SL.stableStringify({ role: 'user', content: 'b' }))
  );
  // 多模态（content 为数组）也能稳定折叠
  const mm = { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] };
  assert.strictEqual(SL.messageHash(mm), SL.messageHash(JSON.parse(JSON.stringify(mm))));
});
