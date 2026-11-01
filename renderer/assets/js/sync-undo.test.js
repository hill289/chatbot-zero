/*!
 * sync-undo.test.js — 21-sync-undo.js 的 Node 自检（零依赖）
 * 运行： node renderer/assets/js/sync-undo.test.js
 *
 * 本测试只访问模块的纯逻辑（__pure）与异步小函数（sha1 / makeItem），
 * 不触碰 IndexedDB / DOM / vfs，可在任意环境安全运行。
 */
'use strict';
const SU = require('./21-sync-undo.js');
const P = SU.__pure;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

// ── 1. normalizeItem ──
group('normalizeItem');
const it1 = P.normalizeItem({ real: '/tmp/a.txt', vPath: '/home/pyodide/a.txt', kind: 'write', pre: new Uint8Array([1, 2, 3]), postHash: 'sha1:x' });
ok(it1 !== null, '合法 write 项通过');
eq(it1.kind, 'write', 'kind 保留');
eq(it1.pre.length, 3, 'pre 字节保留');
eq(it1.preKnown, true, 'preKnown 默认 true');
eq(it1.done, false, 'done 默认 false');
eq(it1.undoable, true, '默认可撤销');
eq(P.normalizeItem({ vPath: '/x' }), null, '缺 real → null');
eq(P.normalizeItem({ real: '/tmp/a' }), null, '缺 vPath → null');
eq(P.normalizeItem(null), null, 'null → null');
const itD = P.normalizeItem({ real: '/tmp/a', vPath: '/home/pyodide/a', kind: 'delete', preKnown: true, pre: null });
eq(itD.kind, 'delete', 'kind=delete 保留');
eq(itD.pre, null, 'delete 无基线 pre=null');
eq(itD.undoable, true, 'delete 无基线仍可撤销（动作=确保删除）');
const itC = P.normalizeItem({ real: '/tmp/b', vPath: '/home/pyodide/b', kind: 'create', pre: null });
eq(itC.kind, 'create', 'kind=create 保留');
eq(itC.preKnown, false, 'create preKnown=false');

// 超大基线 → 不可撤销
group('normalizeItem · 超大基线');
const big = new Uint8Array(P.MAX_PRE_BYTES + 1);
const itBig = P.normalizeItem({ real: '/tmp/big', vPath: '/home/pyodide/big', kind: 'write', pre: big, preKnown: true });
eq(itBig.undoable, false, '超过 MAX_PRE_BYTES → undoable=false');
eq(itBig.pre, null, '超大基线不保留内容');
const itBigDel = P.normalizeItem({ real: '/tmp/big2', vPath: '/home/pyodide/big2', kind: 'delete', pre: big, preKnown: true });
eq(itBigDel.undoable, false, 'delete 超大基线同样不可撤销');
const itBigCreate = P.normalizeItem({ real: '/tmp/big3', vPath: '/home/pyodide/big3', kind: 'create', pre: null });
eq(itBigCreate.undoable, true, 'create 不受基线大小限制（撤销=删除）');

// ── 2. buildBatch ──
group('buildBatch');
const batch = P.buildBatch([it1, itC], '写回 1 个，新增 1 个', 1730000000000);
eq(batch.batchId, 1730000000000, 'batchId = 指定时间戳');
eq(batch.at, 1730000000000, 'at 同步');
eq(batch.items.length, 2, 'items 保留');
eq(batch.note, '写回 1 个，新增 1 个', 'note 保留');
eq(P.buildBatch(null, '').items.length, 0, '空 items → 空数组');
ok(P.buildBatch([it1]).batchId > 0, '未指定 now → Date.now()');

// ── 3. planItemAction（回退决策矩阵）──
group('planItemAction · write');
const w = P.normalizeItem({ real: '/t/a', vPath: '/h/a', kind: 'write', pre: new Uint8Array([1]), preKnown: true, postHash: 'sha1:post' });
eq(P.planItemAction(w, { exists: true, hash: 'sha1:post' }).action, 'restore', '磁盘=同步后内容 → restore');
eq(P.planItemAction(w, { exists: true, hash: 'sha1:other' }).action, 'skip', '磁盘被外部改过 → skip');
eq(P.planItemAction(w, { exists: true, hash: 'sha1:other' }).reason, 'external-modified', 'skip 原因 external-modified');
eq(P.planItemAction(w, { exists: false }).action, 'restore', '磁盘文件已不在 → 仍 restore（还原原版）');

group('planItemAction · delete');
const d = P.normalizeItem({ real: '/t/d', vPath: '/h/d', kind: 'delete', pre: new Uint8Array([9]), preKnown: true });
eq(P.planItemAction(d, { exists: false }).action, 'restore', '磁盘已删 → restore（重建）');
eq(P.planItemAction(d, { exists: true, hash: 'sha1:z' }).action, 'skip', '磁盘又有文件（外部重建）→ skip');
eq(P.planItemAction(d, { exists: true, hash: 'sha1:z' }).reason, 'external-recreated', 'skip 原因 external-recreated');

group('planItemAction · create');
const c = P.normalizeItem({ real: '/t/n', vPath: '/h/n', kind: 'create', pre: null, postHash: 'sha1:new' });
eq(P.planItemAction(c, { exists: true, hash: 'sha1:new' }).action, 'remove', '磁盘=同步后内容 → remove');
eq(P.planItemAction(c, { exists: false }).action, 'skip', '文件已不在 → skip');
eq(P.planItemAction(c, { exists: false }).reason, 'already-absent', 'skip 原因 already-absent');
eq(P.planItemAction(c, { exists: true, hash: 'sha1:other' }).action, 'skip', '被外部改过 → skip');
eq(P.planItemAction(null, {}).action, 'skip', '无效项 → skip');

// ── 4. summarizeUndo ──
group('summarizeUndo');
const s = P.summarizeUndo([
  { action: 'restore' }, { action: 'restore' }, { action: 'remove' },
  { action: 'skip', reason: 'external-modified' }, { action: 'skip', reason: 'external-recreated' },
  { action: 'skip', reason: 'oversized' }, { action: 'skip', reason: 'already-absent' },
  { action: 'error' }, { action: 'done-skip', reason: 'done' }, null
]);
eq(s.restored, 2, 'restored=2');
eq(s.removed, 1, 'removed=1');
eq(s.skipped, 5, 'skipped 含 done-skip');
eq(s.conflicts, 2, 'conflicts=2（external-modified + external-recreated）');
eq(s.oversized, 1, 'oversized=1');
eq(s.errors, 1, 'errors=1');
eq(P.summarizeUndo([]).restored, 0, '空结果不炸');

// ── 5. trimBatches ──
group('trimBatches');
const many = [];
for (let i = 1; i <= 15; i++) many.push({ batchId: i * 1000 });
const t = P.trimBatches(many, 10);
eq(t.keep.length, 10, '保留 10 个');
eq(t.drop.length, 5, '裁掉 5 个');
eq(t.keep[0].batchId, 15000, '最新批次在前');
eq(t.keep[9].batchId, 6000, '第 10 个是 6000');
eq(P.trimBatches(many).keep.length, P.MAX_BATCHES, '默认上限 MAX_BATCHES');

// ── 6. describeBatch ──
group('describeBatch');
eq(P.describeBatch(P.buildBatch([it1, itD, itC, it1], '')), '写回 2 个，删除 1 个，新增 1 个', '按类型计数描述');
eq(P.describeBatch(P.buildBatch([], '')), '', '空批次空描述');
eq(P.describeBatch(null), '', 'null → 空');

// ── 7. sha1 / makeItem（异步）──
(async function () {
  group('sha1');
  const h1 = await SU.sha1(new Uint8Array([1, 2, 3]));
  const h2 = await SU.sha1(new Uint8Array([1, 2, 3]));
  const h3 = await SU.sha1(new Uint8Array([1, 2, 4]));
  eq(h1, h2, '相同内容哈希一致');
  ok(h1 !== h3, '不同内容哈希不同');
  ok(/^(sha1:|fnv:)/.test(h1), '哈希带前缀');

  group('makeItem');
  const mk = await SU.makeItem({ real: '/t/x', vPath: '/h/x', kind: 'write', pre: new Uint8Array([7]), postBytes: new Uint8Array([8, 8]) });
  ok(mk.postHash && /^(sha1:|fnv:)/.test(mk.postHash), 'makeItem 异步算出 postHash');
  eq(mk.pre.length, 1, 'makeItem 保留 pre');
  const mkDel = await SU.makeItem({ real: '/t/y', vPath: '/h/y', kind: 'delete', pre: new Uint8Array([1]), postBytes: null });
  eq(mkDel.postHash, null, 'delete 项 postHash 留空');
  const mkBad = await SU.makeItem({ vPath: '/h/z' });
  eq(mkBad, null, '非法项 → null');
  const mkSame = await SU.makeItem({ real: '/t/x2', vPath: '/h/x2', kind: 'create', postBytes: new Uint8Array([8, 8]) });
  eq(mkSame.postHash, mk.postHash, '相同字节 → 相同哈希');

  // ── 8. 端到端决策流（纯逻辑层的「一次撤销」推演）──
  group('端到端 · 一轮同步→撤销推演');
  const b = P.buildBatch([
    await SU.makeItem({ real: '/d/orig.txt', vPath: '/h/orig.txt', kind: 'write', pre: new Uint8Array([65, 66]), postBytes: new Uint8Array([88, 89, 90]) }),
    await SU.makeItem({ real: '/d/old.txt', vPath: '/h/old.txt', kind: 'delete', pre: new Uint8Array([79, 76, 68]) }),
    await SU.makeItem({ real: '/d/new.txt', vPath: '/h/new.txt', kind: 'create', pre: null, postBytes: new Uint8Array([78, 69, 87]) })
  ], '写回 1 个，删除 1 个，新增 1 个', 1730000001000);
  eq(b.items.length, 3, '批次含 3 项');
  const plans = b.items.map(it => P.planItemAction(it, it.kind === 'delete' ? { exists: false } : { exists: true, hash: it.postHash }));
  eq(plans.map(x => x.action), ['restore', 'restore', 'remove'], '理想场景：写回还原 + 删除重建 + 新增移除');
  // 模拟外部修改 orig.txt → 该项冲突，其余照常
  const plans2 = b.items.map(it => P.planItemAction(it, it.kind === 'write' ? { exists: true, hash: 'sha1:tampered' } : (it.kind === 'delete' ? { exists: false } : { exists: true, hash: it.postHash })));
  eq(plans2.map(x => x.action), ['skip', 'restore', 'remove'], '外部改过的文件被跳过，其余不受影响');
  const sum2 = P.summarizeUndo(plans2.map((p, i) => ({ action: p.action, reason: p.reason || undefined })));
  eq(sum2.conflicts, 1, '恰好 1 个冲突');

  // ── 9. 重做字段归一化 ──
  group('normalizeItem · 重做基线');
  const itR = P.normalizeItem({ real: '/r/a', vPath: '/h/a', kind: 'write', pre: new Uint8Array([1]), post: new Uint8Array([2, 2]), undoAction: 'restore', preHash: 'sha1:p' });
  eq(itR.post.length, 2, 'post 字节保留');
  eq(itR.postKnown, true, 'postKnown=true');
  eq(itR.undoAction, 'restore', 'undoAction 保留');
  eq(itR.preHash, 'sha1:p', 'preHash 保留');
  eq(itR.redoDone, false, 'redoDone 默认 false');
  const itRBad = P.normalizeItem({ real: '/r/b', vPath: '/h/b', kind: 'write', undoAction: 'bogus' });
  eq(itRBad.undoAction, null, '非法 undoAction → null');
  const itBigPost = P.normalizeItem({ real: '/r/c', vPath: '/h/c', kind: 'write', post: new Uint8Array(P.MAX_PRE_BYTES + 1) });
  eq(itBigPost.redoable, false, '超大 post → redoable=false');
  eq(itBigPost.post, null, '超大 post 不保留');

  // ── 10. planRedoAction（重做决策矩阵）──
  group('planRedoAction · write');
  const rw = P.normalizeItem({ real: '/t/a', vPath: '/h/a', kind: 'write', pre: new Uint8Array([1]), post: new Uint8Array([2]), preHash: 'sha1:pre', undoAction: 'restore' });
  eq(P.planRedoAction(rw, { exists: true, hash: 'sha1:pre' }).action, 'reapply-write', '状态仍是撤销后 → 写回 post');
  eq(P.planRedoAction(rw, { exists: true, hash: 'sha1:other' }).action, 'skip', '撤销后又被改过 → skip');
  eq(P.planRedoAction(rw, { exists: true, hash: 'sha1:other' }).reason, 'external-modified', 'skip 原因 external-modified');
  eq(P.planRedoAction(rw, { exists: false }).action, 'skip', '撤销后文件消失 → skip');
  const rwNoPost = P.normalizeItem({ real: '/t/a2', vPath: '/h/a2', kind: 'write', pre: new Uint8Array([1]), undoAction: 'restore' });
  eq(P.planRedoAction(rwNoPost, { exists: true, hash: 'sha1:pre' }).reason, 'no-post-baseline', '无 post 基线 → skip(no-post-baseline)');

  group('planRedoAction · create');
  const rc = P.normalizeItem({ real: '/t/n', vPath: '/h/n', kind: 'create', pre: null, post: new Uint8Array([9]), undoAction: 'remove' });
  eq(P.planRedoAction(rc, { exists: false }).action, 'reapply-write', '撤销删掉的新增 → 恢复');
  eq(P.planRedoAction(rc, { exists: true, hash: 'sha1:x' }).action, 'skip', '撤销后又被重建 → skip');
  eq(P.planRedoAction(rc, { exists: true, hash: 'sha1:x' }).reason, 'external-recreated', 'skip 原因 external-recreated');

  group('planRedoAction · delete');
  const rd = P.normalizeItem({ real: '/t/d', vPath: '/h/d', kind: 'delete', pre: new Uint8Array([9]), preHash: 'sha1:old', undoAction: 'restore' });
  eq(P.planRedoAction(rd, { exists: true, hash: 'sha1:old' }).action, 'reapply-delete', '撤销重建的文件 → 再删一次');
  eq(P.planRedoAction(rd, { exists: false }).action, 'skip', '撤销后文件又不见了 → skip');
  eq(P.planRedoAction(rd, { exists: true, hash: 'sha1:changed' }).action, 'skip', '撤销后内容被改 → skip');

  group('planRedoAction · 边界');
  eq(P.planRedoAction(null, {}).action, 'skip', 'null → skip');
  const rDone = P.normalizeItem({ real: '/t/x', vPath: '/h/x', kind: 'write', post: new Uint8Array([1]), undoAction: 'restore', redoDone: true });
  eq(P.planRedoAction(rDone, { exists: true }).reason, 'already-redone', '已重做 → skip(already-redone)');
  const rNot = P.normalizeItem({ real: '/t/y', vPath: '/h/y', kind: 'write', post: new Uint8Array([1]) });
  eq(P.planRedoAction(rNot, { exists: true }).reason, 'not-undone', '未撤销过 → skip(not-undone)');

  // ── 11. summarizeRedo ──
  group('summarizeRedo');
  const sr = P.summarizeRedo([
    { action: 'reapply-write' }, { action: 'reapply-write' }, { action: 'reapply-delete' },
    { action: 'skip', reason: 'external-modified' }, { action: 'skip', reason: 'external-recreated' },
    { action: 'skip', reason: 'no-post-baseline' }, { action: 'skip', reason: 'not-undone' },
    { action: 'error' }, { action: 'done-skip' }, null
  ]);
  eq(sr.restored, 2, 'restored=2');
  eq(sr.removed, 1, 'removed=1');
  eq(sr.conflicts, 2, 'conflicts=2');
  eq(sr.noBaseline, 1, 'noBaseline=1');
  eq(sr.errors, 1, 'errors=1');
  eq(sr.skipped, 5, 'skipped 含 done-skip');

  // ── 12. 端到端：撤销后 → 重做（写回/删除/新增三类）──
  group('端到端 · 撤销→重做');
  const e2e = [
    P.normalizeItem({ real: '/e/w', vPath: '/h/w', kind: 'write', pre: new Uint8Array([65]), preHash: await SU.sha1(new Uint8Array([65])), post: new Uint8Array([88]), undoAction: 'restore' }),
    P.normalizeItem({ real: '/e/d', vPath: '/h/d', kind: 'delete', pre: new Uint8Array([68]), preHash: await SU.sha1(new Uint8Array([68])), undoAction: 'restore' }),
    P.normalizeItem({ real: '/e/c', vPath: '/h/c', kind: 'create', post: new Uint8Array([67]), undoAction: 'remove' })
  ];
  const rp1 = [
    P.planRedoAction(e2e[0], { exists: true, hash: e2e[0].preHash }),
    P.planRedoAction(e2e[1], { exists: true, hash: e2e[1].preHash }),
    P.planRedoAction(e2e[2], { exists: false })
  ];
  eq(rp1.map(x => x.action), ['reapply-write', 'reapply-delete', 'reapply-write'], '三类项都能正确重做');

  // ── 汇总 ──
  console.log('\n' + '='.repeat(50));
  console.log('通过 ' + pass + ' / 失败 ' + fail + ' / 共 ' + (pass + fail) + ' 项');
  if (fail > 0) process.exitCode = 1;
})();
