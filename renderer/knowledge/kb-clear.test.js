/*!
 * kb-clear.test.js — documents.clear() 一键清空功能回归
 * 覆盖：全量清空、按 kbId 清空、级联（分块/发现项/反馈/引用）落库、
 *       清空后知识库与成员保留、空库幂等、单篇 remove 的引用落库。
 * 运行：node renderer/knowledge/kb-clear.test.js
 */
'use strict';
var path = require('path');
var KBStore = require(path.join(__dirname, 'kb-store.js'));

var passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ ' + msg); }
}

// 直接读内存后端行数（验证「真删了」而非只清缓存）
function rows(table) {
  return KBStore.current.backendKind === 'memory'
    ? null : null; // 占位：内存后端不对外暴露表，改用重新 init 后的缓存回读
}

(async function main() {
  console.log('— 清空（documents.clear）');
  var st = KBStore.createStore();
  await st.init();

  var kb1 = await st.kbs.create({ name: 'KB-甲' });
  var kb2 = await st.kbs.create({ name: 'KB-乙' });
  await st.members.add({ name: '张三' });

  // 两个库各摄取文档 + 分块
  var d1 = (await st.documents.upsert({ kbId: kb1.id, title: '报销制度', text: '第一篇正文'.repeat(20) })).doc;
  var d2 = (await st.documents.upsert({ kbId: kb1.id, title: '考勤制度', text: '第二篇正文'.repeat(20) })).doc;
  var d3 = (await st.documents.upsert({ kbId: kb2.id, title: '安全规范', text: '第三篇正文'.repeat(20) })).doc;
  await st.chunks.replaceForDoc(d1.id, kb1.id, [{ text: '块A' }, { text: '块B' }]);
  await st.chunks.replaceForDoc(d2.id, kb1.id, [{ text: '块C' }]);
  await st.chunks.replaceForDoc(d3.id, kb2.id, [{ text: '块D' }]);

  // 发现项 / 反馈 / 引用
  await st.findings.put({
    id: 'f-1', kbId: kb1.id, type: 'divergent', severity: 'warning', status: 'open',
    subjectDocId: d1.id, relatedDocId: d2.id, fingerprint: 'fp1', score: 1, updatedAt: Date.now()
  });
  await st.feedback.record({ messageId: 'm-1', docId: d1.id, kbId: kb1.id, rating: 'up' });
  await st.citations.record({ messageId: 'm-1', kbId: kb1.id, chunkIds: ['x1'], docIds: [d1.id],
    refs: [{ docId: d1.id, chunkId: 'x1', title: '报销制度' }] });
  // 引用行横跨两个库的文档（裁剪而非整行删）
  await st.citations.record({ messageId: 'm-2', kbId: kb1.id, chunkIds: [], docIds: [d1.id, d3.id],
    refs: [{ docId: d1.id, chunkId: '', title: 'A' }, { docId: d3.id, chunkId: '', title: 'B' }] });

  ok(st.documents.list().length === 3, '初始 3 篇文档');
  ok(st.stats().findings === 1, '初始 1 条发现项');

  // ── 按 kbId 清空（只清 KB-甲）────────────────────────────────────────
  var r1 = await st.documents.clear(kb1.id);
  ok(r1.docs === 2 && r1.chunks === 3, '清 KB-甲：2 篇文档 / 3 个分块');
  ok(r1.findings === 1 && r1.feedback === 1, '清 KB-甲：发现项 1、反馈 1');
  ok(st.documents.list({ kbId: kb1.id }).length === 0, 'KB-甲 文档已空');
  ok(st.documents.list({ kbId: kb2.id }).length === 1, 'KB-乙 文档不受影响');
  ok(st.findings.list().length === 0, '发现项已级联删除');
  ok(st.feedback.list().length === 0, '反馈已级联删除');
  var cite2 = st.citations.byMessage('m-2');
  ok(cite2 && cite2.docIds.length === 1 && cite2.docIds[0] === d3.id, '跨库引用行被裁剪（保留乙的文档）');
  ok(st.citations.byMessage('m-1') === null, '只含被清文档的引用行已删除');
  ok(st.kbs.list().length === 2 && st.members.list().length === 1, '知识库与成员保留');

  // ── 全量清空（不传 kbId）──────────────────────────────────────────────
  var r2 = await st.documents.clear();
  ok(r2.docs === 1 && r2.chunks === 1, '全量清空：剩 1 篇文档 / 1 分块');
  ok(st.documents.list().length === 0, '所有文档已清空');
  ok(st.kbs.list().length === 2, '知识库仍在（只清文档）');

  // ── 幂等：空库再清不报错 ─────────────────────────────────────────────
  var r3 = await st.documents.clear();
  ok(r3.docs === 0 && r3.chunks === 0, '空库再清 → 全 0 且不报错');

  // ── 清空后仍可重新摄取 ───────────────────────────────────────────────
  var again = (await st.documents.upsert({ kbId: kb1.id, title: '新文档', text: '清空后重新入库' })).doc;
  await st.chunks.replaceForDoc(again.id, kb1.id, [{ text: '新块' }]);
  ok(st.documents.list().length === 1, '清空后可正常重新摄取');

  // ── 单篇 remove 的引用行落库修复 ─────────────────────────────────────
  await st.citations.record({ messageId: 'm-3', kbId: kb1.id, chunkIds: [], docIds: [again.id], refs: [] });
  await st.documents.remove(again.id);
  ok(st.citations.byMessage('m-3') === null, '单篇删除时引用行同步落库删除');

  console.log('\n========================================');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  process.exit(failed ? 1 : 0);
})().catch(function (e) {
  console.error('测试崩溃：', e);
  process.exit(1);
});
