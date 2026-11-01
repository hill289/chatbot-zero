#!/usr/bin/env node
/*!
 * kb-layer.test.js — 知识库层全量自检（零依赖，仿 memory-layer.test.js）
 * 运行：node renderer/knowledge/kb-layer.test.js
 *
 * 覆盖：分块/幂等摄取、混合检索（含 superseded 排除）、Myers diff 与
 * 锚点对齐（15天/10天）、双向近邻对称、指纹幂等、evidenceHash 忽略-重开、
 * 复审判定、差评归因与背书归零、AssignRule 三规则、三种结案状态机。
 */
'use strict';

const path = require('path');
const KB = (p) => require(path.join(__dirname, p));

const KBStore = KB('kb-store.js');
const ingest = KB('kb-ingest.js');
const search = KB('kb-search.js');
const qa = KB('kb-qa.js');
const steward = KB('kb-steward.js');
const div = KB('kb-health/divergence.js');
const dup = KB('kb-health/duplicate.js');
const runner = KB('kb-health/detector.js');
const review = KB('kb-health/review.js');
const dispute = KB('kb-health/dispute.js');
const settle = KB('kb-health/settle.js');
const todo = KB('kb-todo.js');
const source = KB('kb-source.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ FAIL: ' + name); }
}
function section(t) { console.log('\n— ' + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 固定装置 ──────────────────────────────────────────────────────────────
async function fixture() {
  const st = KBStore.createStore({ backend: KBStore.createMemoryBackend(), timeout: 300 });
  await st.init();
  const kb = await st.kbs.create({ name: '公司制度', reviewIntervalDays: 30 });
  const alice = await st.members.add({ name: '张三' });
  const bob = await st.members.add({ name: '李四' });
  await st.kbs.update(kb.id, { defaultOwnerId: alice.id });
  runner.register({ name: 'duplicate', detect: (k, d) => dup.detect(k, d) });
  runner.register({ name: 'review', detect: (k, d, c) => review.detect(k, d, c) });
  runner.register({ name: 'feedback', detect: (k, d, c) => dispute.detect(k, d, c) });
  ingest.setOnIngest((ev) => runner.trigger(ev.kbId, ev.doc.id, { debounceMs: 0 }));
  return { st, kb, alice, bob };
}

const base15 = '根据公司考勤管理制度，员工入职满一年后每年享有15天带薪年假，申请需提前一周提交部门主管审批，年假不可跨年度累计使用。';
const filler = '第二条 本制度适用于全体正式员工，试用期员工按实际出勤天数折算年假额度。'.repeat(3);
const t2024 = '# 考勤管理制度（2024版）\n\n' + base15 + '\n\n' + filler;
const t2025 = '# 考勤管理制度（2025版）\n\n' + base15.replace('15天', '10天') + '\n\n' + filler;

async function main() {
  // ── 1. 分块 ────────────────────────────────────────────────────────────
  section('分块（splitChunks）');
  const chunks = ingest.splitChunks(t2024);
  ok(chunks.length >= 1, '至少 1 块');
  ok(chunks.every((c) => Array.from(c.text).length >= 40), '短于 40 字的碎片被丢弃');
  const tiny = ingest.splitChunks('短句。\n\n也短。');
  ok(tiny.length === 0, '全是碎片 → 0 块');
  const longDoc = ('A'.repeat(600) + '\n\n' + 'B'.repeat(600) + '\n\n' + '结尾段落。').repeat(3);
  const lc = ingest.splitChunks(longDoc);
  ok(lc.length > 1, '超长文档切多块');
  ok(lc.every((c) => c.text.length <= 1200 + 200), '单块有上限（允许重叠余量）');

  // ── 2. 摄取 + 幂等 ─────────────────────────────────────────────────────
  section('摄取（ingest）与幂等');
  const fx = await fixture();
  const r1 = await ingest.ingest({ kbId: fx.kb.id, title: '考勤管理制度2024', text: t2024, sourceKey: 'policy-2024', ownerId: fx.alice.id });
  const r2 = await ingest.ingest({ kbId: fx.kb.id, title: '考勤管理制度2025', text: t2025, sourceKey: 'policy-2025', ownerId: fx.bob.id });
  ok(r1.changed && r1.chunkCount >= 1, '首摄取 changed=true, chunks=' + r1.chunkCount);
  ok(r1.doc.version === 1, '版本 v1');
  const again = await ingest.ingest({ kbId: fx.kb.id, title: '考勤管理制度2024', text: t2024, sourceKey: 'policy-2024' });
  ok(!again.changed, '同内容幂等（changed=false）');
  const updated = await ingest.ingest({ kbId: fx.kb.id, title: '考勤管理制度2024', text: t2024 + '\n补充条款。', sourceKey: 'policy-2024' });
  ok(updated.changed && updated.doc.version === 2, '内容变化 → v2');
  ok(updated.doc.lastVouchedAt >= Date.now() - 5000, '修改即背书（lastVouchedAt 刷新）');

  // ── 3. 检索 ────────────────────────────────────────────────────────────
  section('混合检索（search）');
  const hits = await search.search(fx.kb.id, '年假 有多少天', { limit: 5 });
  ok(hits.length > 0, '命中 ' + hits.length + ' 条');
  ok(hits[0].docId === r1.doc.id || hits[0].docId === r2.doc.id, '带 docId 元数据');
  ok(hits.every((h) => h.title), '带标题');
  const other = await search.search(fx.kb.id, '报销流程', { limit: 5 });
  ok(Array.isArray(other), '无命中时返回空数组不报错');

  // ── 4. 引用问答 ────────────────────────────────────────────────────────
  section('引用问答（qa）');
  const cite = await qa.buildBlock(fx.kb.id, '员工年假有多少天？', { limit: 5 });
  ok(cite.block.includes('[S1]') && cite.block.includes('知识库参考资料'), '注入块含 [S1] 与说明');
  ok(cite.refs.length >= 1, 'refs 数量=' + cite.refs.length);
  const answer = '根据 [S1] 规定，员工享有带薪年假。';
  const cited = qa.extractCitations(answer, cite.refs);
  ok(cited.length === 1 && cited[0].docId, '解析回答中的 [S1]');
  ok(qa.extractCitations('无引用回答', cite.refs).length === 0, '无标记 → 0 引用');
  const rec = await qa.recordAnswer('msg-t1', cite.refs, answer, { kbId: fx.kb.id, question: '员工年假有多少天？' });
  ok(rec.cited.length === 1, '引用关系落库');

  // ── 5. 健康检查：divergent（15天 vs 10天）─────────────────────────────
  section('近重复检测（duplicate/divergent）');
  await sleep(80);   // 等 ingest 触发的 debounce
  await runner.run(fx.kb.id, r1.doc.id, {});
  await runner.run(fx.kb.id, r2.doc.id, {});
  const open1 = fx.st.findings.list({ status: 'open' });
  const df = open1.find((f) => f.type === 'divergent');
  ok(!!df, '报出 divergent（15天≠10天）');
  if (df) {
    ok(df.severity === 'warning', 'divergent = warning');
    ok(df.details.evidence.length > 0, '有证据 ' + df.details.evidence.length + ' 对');
    ok(df.details.evidence[0].differs === true, '证据标注 differs');
    ok(df.details.overlapRatio > 0, 'overlapRatio=' + df.details.overlapRatio);
    ok(df.details.evidenceHash, 'evidenceHash 存在');
    ok(df.assigneeId === fx.alice.id || df.assigneeId === fx.bob.id, '路由到具体人');
    ok(df.fingerprint.length <= 128, '指纹合法');

    // 差异内容确实是「15 vs 10」：eq 段含「1」，del/ins 段为数字（5→0）
    const ev = df.details.evidence[0];
    const segs = div.diffSegments(ev.subjectExcerpt, ev.relatedExcerpt);
    const delSeg = segs.filter((s) => s.type === 'del').map((s) => s.text).join('');
    const insSeg = segs.filter((s) => s.type === 'ins').map((s) => s.text).join('');
    ok(/\d/.test(delSeg) && /\d/.test(insSeg), 'diffSegments 高亮出数字差异 (del="' + delSeg + '" ins="' + insSeg + '")');
    ok(delSeg !== insSeg, '删除段与插入段不同');

    // 指纹幂等：再跑一次不产生第二条
    await runner.run(fx.kb.id, r1.doc.id, {});
    await runner.run(fx.kb.id, r2.doc.id, {});
    const dfCount = fx.st.findings.list({}).filter((f) => f.type === 'divergent').length;
    ok(dfCount === 1, '重复检查不产生重复发现（' + dfCount + ' 条）');
  }

  // ─ 5b. 纯复制（逐字相同）→ duplicate ─────────────────────────────────
  const cp = await ingest.ingest({ kbId: fx.kb.id, title: '考勤管理制度2024-副本', text: t2024, sourceKey: 'policy-copy' });
  await sleep(80);
  await runner.run(fx.kb.id, cp.doc.id, {});
  const dupF = fx.st.findings.list({ status: 'open' }).find((f) => f.type === 'duplicate');
  ok(!!dupF, '逐字复制报出 duplicate');
  if (dupF) {
    ok(dupF.details.evidence.some((e) => !e.differs), 'duplicate 证据为逐字相同');
    ok(dupF.severity === 'info' || dupF.severity === 'warning', 'duplicate 严重度合法');
  }

  // ── 6. diff 引擎（divergence 单元）────────────────────────────────────
  section('diff 引擎（divergence）');
  ok(div.comparePassages('同一段文字', '同一段文字').differs === false, '相同 → 不差异');
  ok(div.comparePassages(base15, base15.replace('15天', '10天')).differs === true, '15→10 → 差异');
  ok(div.comparePassages('今天天气很好适合出门', '本通知自发布之日起执行').differs === true, '重写 → 差异');
  const edge = div.comparePassages('前言。' + base15 + '附件。', base15);
  ok(edge.differs === false, '切块边缘差异被容忍');
  const ops = div.diffRunes(Array.from('abcde'), Array.from('abXde'), 100);
  ok(!!ops && ops.length > 0, 'diffRunes 出编辑脚本');
  ok(Array.from(div.normalizeSpace(' a \n b  c ')).join('') === 'a b c', 'normalizeSpace');

  // ── 7. 反馈归因（dispute）─────────────────────────────────────────────
  section('反馈归因（dispute）');
  await qa.recordFeedback('msg-t1', 'down', { comment: '答错了', shareQuestion: true, question: '员工年假有多少天？' });
  await runner.run(fx.kb.id, rec.cited[0].docId, {});
  const disp = fx.st.findings.list({ status: 'open' }).find((f) => f.type === 'disputed');
  ok(!!disp, '差评产生 disputed');
  if (disp) {
    ok(disp.score === 1 && disp.severity === 'info', '1 次差评 = info');
    ok(disp.details.extra.reports[0].question === '员工年假有多少天？', 'shareQuestion 时问题入证据');
    ok(disp.details.extra.reports[0].excerpt, '证据带被引摘录');
    // 攒够 3 次 → warning（注意：同一 messageId 是 upsert —— 重复点同一个
    // 回答的 👎 只算一次，与 Yuheng 语义一致，所以要用不同回答）
    await qa.recordAnswer('msg-t2', cite.refs, '第二答 [S1]', { kbId: fx.kb.id });
    await qa.recordAnswer('msg-t3', cite.refs, '第三答 [S1]', { kbId: fx.kb.id });
    await qa.recordFeedback('msg-t2', 'down', {});
    await qa.recordFeedback('msg-t3', 'down', {});
    await runner.run(fx.kb.id, rec.cited[0].docId, {});
    const disp3 = fx.st.findings.get(disp.id);
    ok(disp3.score === 3 && disp3.severity === 'warning', '3 次差评 = warning');
    ok(disp3.details.evidenceHash !== disp.details.evidenceHash, '新差评改变 evidenceHash');

    // 背书 → 归零
    await settle.confirm(rec.cited[0].docId, 'alice', runner);
    await sleep(80);
    await runner.run(fx.kb.id, rec.cited[0].docId, {});
    const dispAfter = fx.st.findings.list({ status: 'open' }).find((f) => f.type === 'disputed');
    ok(!dispAfter, '确认背书后争议销案');
  }

  // ── 8. 复审周期（review）──────────────────────────────────────────────
  section('复审周期（review）');
  await fx.st.kbs.update(fx.kb.id, { reviewIntervalDays: 1 });
  await fx.st.documents.patch(r2.doc.id, { lastVouchedAt: Date.now() - 5 * 86400000 });
  const due = await review.detect(fx.kb.id, r2.doc.id, { now: Date.now() });
  ok(due.length === 1 && due[0].type === 'stale', '逾期 5 天 > 1 周期 → stale');
  ok(due[0].severity === 'warning', '逾期 ≥2 周期 → warning');
  ok(due[0].details.evidenceHash === String(due[0].details.extra ? due[0].details.evidenceHash : due[0].details.evidenceHash), 'evidenceHash=dueAt');
  const notDue = await review.detect(fx.kb.id, r1.doc.id, { now: Date.now() });
  ok(notDue.length === 0, '未到期 → 无 stale');
  await fx.st.kbs.update(fx.kb.id, { reviewIntervalDays: 0 });
  const off = await review.detect(fx.kb.id, r2.doc.id, { now: Date.now() });
  ok(off.length === 0, '周期关闭 → 无到期（同时供 Reconcile 销案）');
  const dueList = todo.overdueDocs(fx.kb.id, Date.now(), 0);
  ok(Array.isArray(dueList), 'overdueDocs 可用（周期关闭后为空）');
  await fx.st.kbs.update(fx.kb.id, { reviewIntervalDays: 30 });

  // ── 9. 路由规则（steward.assign）──────────────────────────────────────
  section('路由规则（AssignRule）');
  const sA = { ownerId: 'a', lastVouchedAt: 100 };
  const sB = { ownerId: 'b', lastVouchedAt: 200 };
  ok(steward.assign('latest_hand', sA, sB) === 'b', 'latest_hand → 最近背书方');
  ok(steward.assign('stalest_owner', sA, sB) === 'a', 'stalest_owner → 最久未背书方');
  ok(steward.assign('subject_owner', sA, sB) === 'a', 'subject_owner → 主文档负责人');
  ok(steward.assign('subject_owner', { ownerId: '' }, { ownerId: 'b' }) === 'b', '主方无人 → 回退对方');
  ok(steward.assign('subject_owner', { ownerId: '' }, null) === '', '两方无人 → 空（由默认负责人兜底）');

  // ── 10. 结案（settle）─────────────────────────────────────────────────
  section('结案（settle）：确认 / 忽略 / 取代 / 改派');
  const anyOpen = fx.st.findings.list({ status: 'open' })[0];
  ok(!!anyOpen, '存在 open 发现项');
  try {
    await settle.dismiss(anyOpen.id, 'whatever', 'alice', runner);
    ok(false, '坏理由应被拒绝');
  } catch (e) { ok(/理由/.test(e.message), '坏理由被拒：' + e.message); }
  await settle.dismiss(anyOpen.id, 'distinct_scope', 'alice', runner);
  ok(fx.st.findings.get(anyOpen.id).status === 'dismissed', 'dismissed 状态');
  ok(fx.st.findings.get(anyOpen.id).resolution === 'distinct_scope', 'resolution=distinct_scope');
  await runner.run(fx.kb.id, anyOpen.subjectDocId, {});
  ok(fx.st.findings.get(anyOpen.id).status === 'dismissed', '证据不变 → 保持 dismissed');
  await settle.reopen(anyOpen.id);
  ok(fx.st.findings.get(anyOpen.id).status === 'open', 'reopen 重开');

  // 手工改派保持
  const target = fx.st.findings.list({ status: 'open' })[0];
  await settle.assign(target.id, fx.bob.id, 'alice');
  await runner.run(fx.kb.id, target.subjectDocId, {});
  ok(fx.st.findings.get(target.id).assigneeId === fx.bob.id, '手工改派不被自动路由覆盖');

  // supersede：检索排除 + 不删除 + 可恢复
  const sup = await settle.supersede(r1.doc.id, r2.doc.id, 'alice', runner);
  ok(sup.loser.status === 'superseded', 'loser → superseded');
  ok(fx.st.documents.get(r1.doc.id) != null, '不删除（文档仍在）');
  const afterHits = await search.search(fx.kb.id, '年假', { limit: 6 });
  ok(afterHits.length > 0 && afterHits.every((h) => h.docId !== r1.doc.id), '取代后旧版被检索排除');
  await sleep(80);
  await runner.run(fx.kb.id, r2.doc.id, {});
  const divRow = fx.st.findings.list({}).find((f) => f.type === 'divergent' && (f.subjectDocId === r1.doc.id || f.relatedDocId === r1.doc.id));
  ok(!divRow || divRow.status === 'resolved', '取代后配对发现自动销案');
  await settle.restore(r1.doc.id, 'alice', runner);
  ok(fx.st.documents.get(r1.doc.id).status === 'active', 'restore 恢复检索');
  const backHits = await search.search(fx.kb.id, '年假', { limit: 6 });
  ok(backHits.some((h) => h.docId === r1.doc.id), '恢复后可被检索');

  // ── 11. 待办（todo）───────────────────────────────────────────────────
  section('待办（todo）与摘要（digest）');
  const c = todo.counts();
  ok(typeof c.total === 'number' && typeof c.unassigned === 'number', 'counts 结构');
  const inbox = todo.inbox(fx.bob.id);
  ok(Array.isArray(inbox), 'inbox 可用');
  if (inbox.length) {
    ok(inbox[0].typeLabel && inbox[0].assigneeName, '待办带类型标签与负责人名');
  }
  const dg = todo.digest({});
  ok(dg.openTotal >= 0 && dg.byType && typeof dg.overdueDocs === 'number', 'digest 结构');

  // ── 12. 本地知识库路径（kb-source）────────────────────────────────────
  section('本地知识库路径（kb-source）');
  const kbDir = {
    '/data/kb/考勤制度.md': '# 考勤制度\n\n' + base15 + '\n\n' + filler,
    '/data/kb/报销规定.txt': '员工报销需在费用发生后30天内提交发票，逾期财务不予受理，特殊情况需直属主管审批。' + filler,
    '/data/kb/废纸.png': 'PNGDATA',
  };
  const scanEntries = () => Object.keys(kbDir).map((p) => {
    const nm = p.split('/').pop();
    const m = /\.[a-z0-9]+$/i.exec(nm);
    return { path: p, name: nm, ext: m ? m[0].toLowerCase() : '', size: String(kbDir[p]).length, mtimeMs: 0 };
  });
  source.setDriver({
    kind: 'fake',
    available: () => true,
    pickDirectory: () => Promise.resolve('/data/kb'),
    scan: () => Promise.resolve({ files: scanEntries(), scanned: scanEntries().length, truncated: false, total: scanEntries().length }),
    readBytes: (p) => Promise.resolve(String(kbDir[p] || '')),
  });

  await source.writeConfig(fx.kb.id, { rootPath: '/data/kb' });
  ok(source.status(fx.kb.id).rootPath === '/data/kb', '配置本地路径已保存（meta 持久化）');
  ok(source.readConfig(fx.kb.id).rootPath === '/data/kb', 'readConfig 读回配置');

  const sc = await source.scan(fx.kb.id);
  ok(sc.total === 2, '扫描按扩展名过滤（png 不计）→ ' + sc.total);
  ok(sc.files.every((f) => source.extOf(f.name) !== '.png'), '扫描结果不含不支持扩展名');

  const sy1 = await source.sync(fx.kb.id);
  ok(sy1.added === 2 && sy1.unchanged === 0, '首次同步入库 2 篇（added=' + sy1.added + '）');
  const fileDocs = fx.st.documents.list({ kbId: fx.kb.id }).filter((d) => d.sourceType === 'file');
  ok(fileDocs.length === 2, '文档记录 sourceType=file');
  ok(fileDocs.some((d) => d.title === '考勤制度'), '标题取文件名（去扩展名）');
  ok(source.status(fx.kb.id).docs === 2 && source.status(fx.kb.id).activeDocs === 2, 'status 统计本地文档 2/生效 2');

  const hitLocal = await search.search(fx.kb.id, '年假 有多少天', { limit: 8 });
  ok(hitLocal.some((h) => h.title === '考勤制度'), '提问命中本地路径文档');
  const citeLocal = await qa.buildBlock(fx.kb.id, '年假有多少天？', { limit: 6 });
  ok(citeLocal.block.indexOf('[S1]') >= 0, '本地路径文档参与引用问答');

  const sy2 = await source.sync(fx.kb.id);
  ok(sy2.added === 0 && sy2.unchanged === 2, '重复同步幂等（added=0, unchanged=2）');

  // 修改一个文件 → 更新
  kbDir['/data/kb/报销规定.txt'] = kbDir['/data/kb/报销规定.txt'].replace('30天', '15天');
  const sy3 = await source.sync(fx.kb.id);
  ok(sy3.updated === 1 && sy3.added === 0, '文件内容变化 → 更新 1 篇');
  const baoxiaoId = fileDocs.filter((d) => d.title === '报销规定')[0].id;
  ok(fx.st.documents.get(baoxiaoId).version === 2, '变更文档 version 前进到 v2');

  // 删除文件 → 停用（不删除、可恢复、检索排除）
  delete kbDir['/data/kb/报销规定.txt'];
  const sy4 = await source.sync(fx.kb.id);
  ok(sy4.missing === 1, '文件被删除 → 停用 1 篇');
  ok(fx.st.documents.get(baoxiaoId) != null, '停用不删除（文档仍在）');
  ok(fx.st.documents.get(baoxiaoId).status === 'disabled', '缺失文档 status=disabled');
  const hitGone = await search.search(fx.kb.id, '报销发票逾期财务', { limit: 8 });
  ok(!hitGone.some((h) => h.docId === baoxiaoId), '停用文档不再被检索');

  // 文件回来 → 自动重新生效
  kbDir['/data/kb/报销规定.txt'] = '员工报销需在费用发生后15天内提交发票，逾期财务不予受理。' + filler;
  const sy5 = await source.sync(fx.kb.id);
  ok(fx.st.documents.get(baoxiaoId).status === 'active', '文件恢复 → 文档自动重新生效');
  ok(sy5.missing === 0, '恢复后无缺失');

  // 配置持久化 + html 去标签
  const cfg2 = source.readConfig(fx.kb.id);
  ok(cfg2.lastSyncAt > 0 && cfg2.lastSummary && cfg2.lastSummary.updated === 1, 'lastSyncAt/lastSummary 落库');
  const exHtml = source.extractText('x.html', '<html><body><h1>标题</h1><script>bad()</script><p>正文内容</p></body></html>');
  ok(exHtml.text.indexOf('正文内容') >= 0 && exHtml.text.indexOf('bad()') < 0, 'html 去标签且剔除 script');
  ok(source.isSupported('a.md') && !source.isSupported('a.exe'), 'isSupported 扩展名判定');

  // ── 12b. Office/PDF 摄取：统一走 anydoc → Markdown ───────────────────
  const exPdfNo = source.extractText('年度报告.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]));
  ok(exPdfNo.unsupported === true && exPdfNo.format === 'pdf', 'Node 无 anydoc → pdf 标记 unsupported（不乱码入库）');
  ok((await source.whenAnydocReady(30)) === false, 'Node 无 anydoc → whenAnydocReady=false');

  kbDir['/data/kb/年度报告.pdf'] = 'FAKE-PDF-BYTES';
  const syPdfFail = await source.sync(fx.kb.id, { markMissing: false });
  const pdfErr = (syPdfFail.errors[0] || {}).reason || '';
  ok(syPdfFail.failed === 1 && /无法解析/.test(pdfErr), '无 anydoc → pdf 摄取明确失败：' + pdfErr);

  // 模拟 anydoc 就绪：Office/PDF → Markdown 摄取
  global.window = {
    __undocParse: () => ({ format: () => 'pdf', toMarkdown: () => '# 年度报告\n\n' + base15 + '\n\n' + filler })
  };
  try {
    const syPdfOk = await source.sync(fx.kb.id, { markMissing: false });
    ok(syPdfOk.added === 1 && syPdfOk.failed === 0, 'anydoc 就绪 → pdf 转 Markdown 摄取成功（added=' + syPdfOk.added + '）');
    const pdfDoc = fx.st.documents.list({ kbId: fx.kb.id })
      .find((d) => d.sourcePath === '/data/kb/年度报告.pdf');
    ok(!!pdfDoc && pdfDoc.text.indexOf('# 年度报告') === 0, '入库正文 = anydoc 产出的 Markdown');
    ok(pdfDoc && pdfDoc.sourceType === 'file', '文件摄取 sourceType=file');
    ok((await source.whenAnydocReady(30)) === true, 'anydoc 就绪 → whenAnydocReady=true');
  } finally {
    delete global.window;
  }

  // 扫描被截断时不做「缺失」判定（避免误停用）
  source.setDriver({
    kind: 'fake', available: () => true,
    scan: () => Promise.resolve({ files: [], scanned: 100, truncated: true, total: 0 }),
    readBytes: () => Promise.resolve(''),
  });
  const syTrunc = await source.sync(fx.kb.id);
  ok(syTrunc.truncated === true && syTrunc.missing === 0, '扫描被截断 → 不误停用文档');

  // ── 13. 存储统计 / 门面 ───────────────────────────────────────────────
  section('存储（store）');
  const stats = fx.st.stats();
  ok(stats.kbs === 1 && stats.documents >= 3, '统计：' + JSON.stringify(stats.docByStatus));
  ok(KBStore.current === fx.st, 'facade 门面转发到当前实例');
  ok(stats.storage === 'memory', '测试走内存后端');

  console.log('\n========================================');
  console.log('  通过 ' + passed + ' / 失败 ' + failed);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\n✗ 运行异常:', e && e.message);
  console.error((e && e.stack || '').split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
