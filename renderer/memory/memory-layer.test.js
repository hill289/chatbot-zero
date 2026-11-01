/*!
 * memory-layer.test.js — 本地记忆层纯逻辑自检（Node 运行，无第三方依赖）
 * 运行：node renderer/memory/memory-layer.test.js
 * 说明：不依赖真实 IndexedDB —— 显式注入内存存储（CORE.storage.memory()），
 *       因此可在 Node / almostnode 中直接跑。
 */
'use strict';
var CORE = require('./memory-layer.js');

var results = [];
function ok(name, cond, extra) {
  results.push({ name: name, pass: !!cond, extra: extra });
  if (!cond) { try { console.error('  ✗ ' + name + (extra ? '  ' + JSON.stringify(extra) : '')); } catch (_) {} }
  else { try { console.log('  ✓ ' + name); } catch (_) {} }
}
function approx(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

function newEngine() {
  var e = CORE.createEngine({ storage: CORE.storage.memory(), dim: 256 });
  return e.init().then(function () { return e; });
}

async function run() {
  // ── 1. 分词 ──────────────────────────────────────────────────────────────
  var toks = CORE.tokenize('混合检索 RRF 融合 retrieval_augmented');
  ok('tokenize: 中文含二元组', toks.indexOf('混合') >= 0 && toks.indexOf('融合') >= 0);
  ok('tokenize: 英文小写化', toks.indexOf('rrf') >= 0);
  ok('tokenize: 下划线拆分', toks.indexOf('retrieval') >= 0 && toks.indexOf('augmented') >= 0);

  // ── 2. 哈希向量 ──────────────────────────────────────────────────────────
  var v1 = CORE.hashEmbed('向量检索', 256);
  ok('hashEmbed: 维度正确', v1.length === 256);
  var norm = 0; for (var i = 0; i < v1.length; i++) norm += v1[i] * v1[i];
  ok('hashEmbed: L2 归一化', approx(Math.sqrt(norm), 1, 1e-4));
  var sim = CORE.cosine(CORE.hashEmbed('向量检索', 256), CORE.hashEmbed('向量检索', 256));
  ok('cosine: 自相似=1', approx(sim, 1, 1e-4));
  ok('cosine: 相关>无关',
    CORE.cosine(CORE.hashEmbed('向量检索与融合'),
      CORE.hashEmbed('向量检索')) >
    CORE.cosine(CORE.hashEmbed('向量检索与融合'),
      CORE.hashEmbed('紫菜蛋花汤的做法')));

  // ── 3. RRF 融合（对齐 Yuheng score = w/(k+rank)）─────────────────────────
  var A = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.5 }];
  var B = [{ id: 'b', score: 3.0 }, { id: 'c', score: 1.0 }];
  var fused = CORE.rrfFuse([A, B], { k: 60, weights: [1, 1] });
  ok('rrfFuse: 双榜命中分数更高', fused.get('b') > fused.get('a') && fused.get('b') > fused.get('c'), { b: fused.get('b'), a: fused.get('a'), c: fused.get('c') });
  var expectB = 1 / (60 + 2) + 1 / (60 + 1);
  ok('rrfFuse: 分数公式正确', approx(fused.get('b'), expectB, 1e-9));

  // ── 4. 确定性排序 + 去重 + TopK ─────────────────────────────────────────
  var sorted = CORE.deterministicSort([
    { id: 'z', score: 1, ts: 2 }, { id: 'a', score: 1, ts: 9 }, { id: 'm', score: 2, ts: 1 }
  ]);
  ok('deterministicSort: 分数优先 + id 次序', sorted[0].id === 'm' && sorted[1].id === 'a' && sorted[2].id === 'z');
  var deduped = CORE.dedupeByScore([{ id: 'x', score: 1 }, { id: 'x', score: 5 }]);
  ok('dedupeByScore: 保留最高分', deduped.length === 1 && deduped[0].score === 5);
  ok('filterTopK: 截断', CORE.filterTopK([1, 2, 3, 4], 2).length === 2);

  // ── 5. 查询扩展 ─────────────────────────────────────────────────────────
  var exp = CORE.expandQueries('什么是 向量检索 与 RRF 融合？');
  ok('expandQueries: 产出变体', exp.length >= 1, exp);
  ok('expandQueries: 去除疑问词', exp.every(function (s) { return s.indexOf('什么是') !== 0; }));

  // ── 6. BM25 ─────────────────────────────────────────────────────────────
  var qtf = CORE.termFreq(CORE.tokenize('向量检索'));
  var df = new Map([['向量', 2], ['检索', 2], ['汤', 1]]);
  var hit = { tf: CORE.termFreq(CORE.tokenize('向量检索 融合 排序')), len: 6 };
  var miss = { tf: CORE.termFreq(CORE.tokenize('紫菜 蛋花 汤 做法')), len: 6 };
  ok('bm25: 命中文档得分更高', CORE.bm25Score(qtf, hit, df, 3, 6) > CORE.bm25Score(qtf, miss, df, 3, 6));

  // ── 7. 引擎：混合检索 ───────────────────────────────────────────────────
  var e = await newEngine();
  await e.addMany([
    { id: 'm1', kind: 'memory', text: '用户偏好使用 TypeScript 与 pnpm，提交信息用中文。' },
    { kind: 'memory', text: '本项目的前缀缓存策略：system 与 tools 必须逐轮字节稳定。' },
    { kind: 'fact', text: '部署环境是 macOS + Windows 双平台。' },
    { kind: 'memory', text: '用户喜欢喝美式咖啡，不加糖。' }
  ]);
  var r1 = await e.search('前缀缓存 稳定', { limit: 3 });
  ok('search: 命中相关记忆', r1.length > 0 && /前缀缓存/.test(r1[0].text), r1.map(function (x) { return x.text; }));
  var r2 = await e.search('TypeScript pnpm', { limit: 2 });
  ok('search: 英文关键词命中', r2.length > 0 && /TypeScript/.test(r2[0].text));
  var r3 = await e.search('咖啡', { limit: 2, kinds: ['memory'] });
  ok('search: kinds 过滤生效', r3.length > 0 && /咖啡/.test(r3[0].text));

  // ── 8. 画像（画像注入）──────────────────────────────────────────────────
  await e.upsertProfile({ key: '语言', text: '偏好中文交流' });
  await e.setProfile([{ key: '语言', text: '偏好中文交流' }, { key: '时区', text: 'UTC+8' }]);
  var prof = await e.getProfile();
  ok('profile: 写入/读取', prof.length === 2 && prof[0].key === '语言');

  // ── 9. 会话检索（跨会话历史对话）────────────────────────────────────────
  await e.indexTurns([
    { role: 'user', content: '帮我给这个 Electron 项目加一个多标签浏览器' },
    { role: 'assistant', content: '可以，用 BaseWindow + WebContentsView 实现多标签。' }
  ], { sessionId: 'sess-A' });
  await e.indexTurns([
    { role: 'user', content: '数据库连接池怎么调优？' },
    { role: 'assistant', content: '建议设置 maxPoolSize 与 idleTimeout。' }
  ], { sessionId: 'sess-B' });
  var ss = await e.sessionSearch('多标签浏览器怎么实现', { limit: 3, merge: false });
  ok('sessionSearch: 找到历史会话', ss.length > 0 && /WebContentsView|多标签/.test(ss[0].text), ss.map(function (x) { return x.sessionId; }));

  // ── 10. 自动召回组装 ────────────────────────────────────────────────────
  var rec = await e.recall('我应该用中文还是英文写提交信息？', { limit: 3 });
  ok('recall: 生成上下文块', typeof rec.block === 'string' && rec.block.length > 0);
  ok('recall: 含用户画像', /用户画像/.test(rec.block) && /偏好中文/.test(rec.block));
  ok('recall: 含相关记忆', /相关长期记忆/.test(rec.block));

  // ── 11. 相邻合并 ────────────────────────────────────────────────────────
  var merged = CORE.mergeAdjacent([
    { id: 't1', score: 1, ts: 1000, sessionId: 's', text: 'a' },
    { id: 't2', score: 2, ts: 2000, sessionId: 's', text: 'b' },
    { id: 't3', score: 3, ts: 1000, sessionId: 'o', text: 'c' }
  ], { gapMs: 5000 });
  ok('mergeAdjacent: 同会话相邻合并', merged.length === 2 && merged.some(function (g) { return g.text === 'a\nb'; }));

  // ── 12. 持久化导入/导出 ─────────────────────────────────────────────────
  var dump = await e.exportJSON();
  ok('exportJSON: 结构完整', Array.isArray(dump.items) && dump.items.length >= 4 && Array.isArray(dump.profile));

  var failed = results.filter(function (r) { return !r.pass; });
  return { total: results.length, passed: results.length - failed.length, failed: failed.map(function (f) { return f.name; }) };
}

module.exports = { run: run, results: results };
