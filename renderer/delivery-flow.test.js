/*!
 * delivery-flow.test.js — 「块级接受 → 门禁 → 摘要 → 部分落盘 → 剩余差异」端到端（纯逻辑）
 * 运行：node --test renderer/delivery-flow.test.js
 *
 * 这里不碰 DOM / 磁盘，只验证最容易出错的那条链路：
 *   部分接受之后，磁盘上变成「合成结果」，vfs 里仍是 AI 的完整提案，
 *   于是**剩余差异必须恰好等于被拒的那些块** —— 否则用户拒掉的改动会在下一轮
 *   被悄悄写盘（或已接受的被重复写）。这是本功能唯一真正危险的地方。
 *
 * 注意：块 = 「连续的非 equal 行」。相邻的两处修改会并成一块（与 git hunk 同理），
 * 所以夹具里每处改动之间都夹了未改动行。
 */
const test = require('node:test');
const assert = require('node:assert');
const H = require('./hunk-select.js');
const D = require('./delivery-summary.js');
const G = require('./type-gate.js');

let ts = null;
try { ts = require('./lsp/typescript.js'); } catch (_) { ts = null; }
let libs = null;
try { libs = require('./lsp/ts-libs.js'); } catch (_) { libs = null; }
const hasEngine = !!(ts && ts.createLanguageService);

// 三处被未改动行隔开的修改：常量值 / 字符串 / 新增一行
const A = [
  'const TIMEOUT_MS = 3000;',
  'const RETRIES = 3;',
  "const HOST = 'a';",
  'const EXTRA = 0;',
  'module.exports = { TIMEOUT_MS, RETRIES, HOST, EXTRA };'
].join('\n');

const B = [
  'const TIMEOUT_MS = 30000;',
  'const RETRIES = 3;',
  "const HOST = 'b';",
  'const EXTRA = 0;',
  'const DEBUG = true;',
  'module.exports = { TIMEOUT_MS, RETRIES, HOST, EXTRA };'
].join('\n');

test('三块：只接受第 1、3 块 → 合成结果既不是原文也不是 AI 稿', () => {
  const c = H.compose(A, B);
  assert.strictEqual(c.total, 3, '应切成 3 块，实际 ' + c.total);
  const part = H.compose(A, B, [0, 2]);
  assert.strictEqual(part.acceptedCount, 2);
  assert.deepStrictEqual(part.text.split('\n'), [
    'const TIMEOUT_MS = 30000;',
    'const RETRIES = 3;',
    "const HOST = 'a';",        // ← 被拒的块保留原文
    'const EXTRA = 0;',
    'const DEBUG = true;',
    'module.exports = { TIMEOUT_MS, RETRIES, HOST, EXTRA };'
  ]);
});

test('部分落盘后：剩余差异 == 被拒的块（不多不少）', () => {
  const c = H.compose(A, B);
  const accepted = [0, 2];
  const composed = H.compose(A, B, accepted);
  const rejected = H.rejectedBlocks(c.blocks, accepted);
  assert.strictEqual(rejected.length, 1);

  // 落盘后基线轮转为 composed，vfs 仍是 AI 稿 → 剩余差异应只剩被拒那块
  const rest = H.compose(composed.text, B);
  assert.strictEqual(rest.total, 1, '剩余差异应正好 1 块，实际 ' + rest.total);
  assert.strictEqual(rest.blocks[0].inss.length, 1);
  assert.ok(rest.text.includes("const HOST = 'b';"), '剩下的就是被拒的那处');

  // 收敛性：再全接受 → 与 AI 稿完全一致
  assert.strictEqual(H.compose(composed.text, B, null).text, B);
  // 再全拒绝 → 保持 composed，不会把已交付的回滚
  assert.strictEqual(H.compose(composed.text, B, []).text, composed.text);
});

test('摘要：3 块里接受 1 块，块计数按「已接受」统计，且不误报签名变更', () => {
  const c = H.compose(A, B, [0]);
  const entry = D.analyzeFile({
    path: 'src/config.js', aText: A, bText: c.text, kind: 'write',
    add: c.stats.add, del: c.stats.del, total: c.total, accepted: c.acceptedCount
  });
  assert.strictEqual(entry.accepted, 1);
  assert.strictEqual(entry.total, 3);
  assert.ok(entry.tags.some((t) => t.code === 'CONST'), '常量值变化应被识别');
  const s = D.build({ files: [entry], gate: { status: 'pass', blocked: false, checked: 1 } });
  assert.match(D.toMarkdown(s), /1\/3 已接受/);
});

// ── 真实代码：签名变更 / 异常处理 ────────────────────────────────
const ORIGINAL = [
  "const fs = require('fs');",
  '',
  'function load(p) {',
  '  return fs.readFileSync(p, 1);',
  '}',
  '',
  'module.exports = { load };'
].join('\n');

const AI = [
  "const fs = require('fs');",
  '',
  'function load(p, retries) {',
  '  try {',
  '    return fs.readFileSync(p, { retries });',
  '  } catch (e) {',
  '    return null;',
  '  }',
  '}',
  '',
  'module.exports = { load };'
].join('\n');

test('摘要：全接受时识别「签名变更」，且「新增异常处理」不误报为移除', () => {
  const c = H.compose(ORIGINAL, AI);
  const entry = D.analyzeFile({
    path: 'src/load.js', aText: ORIGINAL, bText: c.text, kind: 'write',
    add: c.stats.add, del: c.stats.del, total: c.total, accepted: c.acceptedCount
  });
  assert.ok(entry.tags.some((t) => t.code === 'SIG'), 'load(p) → load(p, retries) 应报签名变更');
  assert.ok(!entry.tags.some((t) => t.code === 'ERR'), '新增 try/catch 不该报「移除异常处理」');
});

test('门禁：拒绝「定义块」却接受「使用块」→ 拼装结果必须被判阻断', { skip: !hasEngine ? '无 TS 引擎' : false }, () => {
  const vfs = { '/src/a.js': 'function twice(n) { return n * 2; }\n' };
  const readFile = (p) => vfs[p];
  const composed = 'module.exports = twice(21);\n';
  const r = G.diagnose({ path: '/src/a.js', text: composed, readFile, ts, libs });
  assert.strictEqual(r.ok, true, r.reason);
  const v = G.verdict({ path: '/src/a.js', diagnostics: r.items });
  assert.strictEqual(v.blocked, true, '拼装出的未定义引用必须拦住：' + JSON.stringify(v.errors));

  const ok = G.diagnose({ path: '/src/a.js', text: 'function twice(n) { return n * 2; }\nmodule.exports = twice(21);\n', readFile, ts, libs });
  assert.strictEqual(G.verdict({ path: '/src/a.js', diagnostics: ok.items }).blocked, false);
});

test('门禁 + 摘要联动：阻断项必须进入「无法验证」清单', () => {
  const entry = D.analyzeFile({ path: 'src/a.js', aText: 'a', bText: 'b', add: 1, del: 1 });
  const s = D.build({
    files: [entry],
    gate: { status: 'block', blocked: true, errors: ['a.js:1:1 · TS2304 找不到名称 twice'], checked: 1 }
  });
  assert.strictEqual(s.totals.blocked, true);
  assert.ok(s.unverified.some((u) => u.includes('TS2304')));
  assert.match(D.toMarkdown(s), /❌ 存在阻断性错误/);
});

test('签名与块号：内容一变，旧选择集签名即失效（防止错套块）', () => {
  const sig1 = H.signature(A, B, false);
  const B2 = B.replace('30000', '40000');
  assert.notStrictEqual(sig1, H.signature(A, B2, false), 'AI 再改一次 → 签名必须变，旧勾选作废');
});
