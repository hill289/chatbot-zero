/*!
 * session-clear.test.js — 回归测试：清空会话后「重启不再复活」
 * -----------------------------------------------------------------------------
 * 复现并验证修复：sessionLog.sync([]) 会创建一个「最新的空会话」，
 * 使 boot() 从磁盘恢复时得到空对话，而不是把上一条非空会话恢复回来。
 * 运行： node renderer/assets/js/session-clear.test.js
 */
'use strict';
const SL = require('./18-session-log.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

// —— 假磁盘（模拟 main.js 的 messages/<sid>/events.jsonl + msg:list/read/append）——
function makeDisk() {
  const store = new Map(); // sid -> events[]
  const api = {
    append: (sid, evs) => { const a = store.get(sid) || []; a.push.apply(a, evs); store.set(sid, a); return Promise.resolve({ ok: true }); },
    read: (sid) => Promise.resolve({ ok: true, events: (store.get(sid) || []).slice() }),
    list: () => Promise.resolve({
      ok: true,
      sessions: Array.from(store.keys()).map(sid => ({ sid, size: JSON.stringify(store.get(sid) || []).length, mtimeMs: 0 }))
    }),
    meta: () => Promise.resolve({ ok: true }),
    fork: () => Promise.resolve({ ok: true }),
    remove: (sid) => { store.delete(sid); return Promise.resolve({ ok: true }); }
  };
  return { store, api };
}

function makeLog(api, ids) {
  let i = 0, t = 1000;
  return SL.createSessionLog({
    api: api,
    now: function () { return (t += 10); },
    uuid: function () { return ids[i++] || ('s-' + i); },
    onError: function () {}
  });
}

(async function main() {
  group('修复前：只清内存 → 重启后旧会话复活（复现 bug）');
  {
    const { store, api } = makeDisk();
    const log1 = makeLog(api, ['s-old']);
    const conv = [{ role: 'user', content: '第一轮' }, { role: 'assistant', content: '回复' }];
    log1.sync(conv);                       // 旧会话落盘
    // 「清空」只清内存（旧行为：不 sync 空会话）
    log1.activate(null, null);
    // 刷新：新实例从磁盘恢复
    const log2 = makeLog(api, ['s-ignored']);
    const r = await log2.boot();
    eq(r.lastSid, 's-old', '旧行为：恢复了旧会话（size>0，含内容）');
    eq(SL.foldEvents(store.get('s-old'), 's-old').messages.length, 2, '恢复出 2 条消息 → 复活');
  }

  group('修复后：清空时 sync([]) → 重启后为空');
  {
    const { store, api } = makeDisk();
    const log1 = makeLog(api, ['s-old', 's-empty']);
    const conv = [{ role: 'user', content: '第一轮' }, { role: 'assistant', content: '回复' }];
    log1.sync(conv);                       // 旧会话落盘
    // 「新对话」：清内存 + 登记一个空的当前会话
    const empty = [];
    log1.sync(empty);                      // ← 本次修复新增的一行
    // 刷新：新实例从磁盘恢复
    const log2 = makeLog(api, ['s-x']);
    const r = await log2.boot();
    eq(r.lastSid, 's-empty', '恢复了「最新的空会话」');
    eq(SL.foldEvents(store.get('s-empty'), 's-empty').messages.length, 0, '折叠为空 → 不复活');
    ok(store.has('s-old'), '旧会话仍保留在历史中（未被删除）');
  }

  group('清空历史：删除磁盘日志');
  {
    const { store, api } = makeDisk();
    const log1 = makeLog(api, ['s-1', 's-2']);
    log1.sync([{ role: 'user', content: 'a' }]);
    log1.sync([{ role: 'user', content: 'b' }]);
    eq(store.size, 2, '两个会话落盘');
    log1._order().slice().forEach(sid => log1.removeSession(sid));  // ← resetState 里的做法
    await new Promise(r => setTimeout(r, 0));
    eq(store.size, 0, '磁盘会话已全部删除');
    const log2 = makeLog(api, []);
    const r = await log2.boot();
    eq(r.restored || 0, 0, '重启后没有可恢复会话');
  }

  console.log('\n──────────────────────────────');
  console.log('session-clear.test: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
})();
