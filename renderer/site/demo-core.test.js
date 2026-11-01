/*!
 * demo-core.test.js — 官网 Demo 核心计算的交叉验证
 * 运行：node --test renderer/site/demo-core.test.js
 *
 * 重点验证 Demo 对外宣称的三件事是真的，而不是文案：
 *   1) 「全接受 → 门禁通过」；
 *   2) 「只接受调用点、拒绝改名定义 → 门禁阻断（TS2304）」；
 *   3) 「部分落盘后的剩余差异，恰好等于被拒的那些块」。
 */
const test = require('node:test');
const assert = require('node:assert');

const H = require('../hunk-select.js');
const D = require('../delivery-summary.js');
const G = require('../type-gate.js');
const core = require('./demo-core.js').create({
  HunkSelect: H, DeliverySummary: D, TypeGate: G
});

let ts = null;
try { ts = require('../lsp/typescript.js'); } catch (_) { ts = null; }
let libs = {};
try {
  const fs = require('node:fs');
  const m = {};
  new Function('window', fs.readFileSync(require('node:path').join(__dirname, '../lsp/ts-libs.js'), 'utf8'))(m);
  libs = m.__TS_LIBS__ || {};
} catch (_) { libs = {}; }

const hasEngine = !!(ts && ts.createLanguageService && Object.keys(libs).length);

test('差异被切成 4 个变更块（常量 / 改名定义 / 主体 / 导出）', () => {
  const base = core.diff();
  assert.strictEqual(base.total, 4);
  assert.deepStrictEqual(base.stats, { add: 6, del: 11 });
});

test('全部接受 → 门禁 pass，且没有任何诊断', { skip: !hasEngine }, () => {
  const c = core.compose(null);
  const v = core.gate({ text: c.text, ts, libs });
  assert.strictEqual(v.status, 'pass');
  assert.strictEqual(v.blocked, false);
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(v.items.length, 0);
});

test('只接受调用点 → 门禁 block，且错误是 TS2304 找不到名称', { skip: !hasEngine }, () => {
  const accepted = core.presetBrokenAcceptance();
  const c = core.compose(accepted);
  assert.strictEqual(c.acceptedCount, 3, '应接受 3 个块');
  assert.ok(/calcTax\(amount\)/.test(c.text), '被拒的改名块应保持旧定义');
  assert.ok(/calcTaxInclusive\(amount\)/.test(c.text), '接受的块应使用新名字');

  const v = core.gate({ text: c.text, ts, libs });
  assert.strictEqual(v.status, 'block');
  assert.strictEqual(v.blocked, true);
  assert.ok(v.items.some((i) => i.code === 2304), '应出现 TS2304');
  assert.strictEqual(v.errors.length, 1, '阻断错误只保留 TS2304，其余降级为告警');
});

test('交付摘要含「高风险项 2」与阻断结论', { skip: !hasEngine }, () => {
  const c = core.compose(core.presetBrokenAcceptance());
  const v = core.gate({ text: c.text, ts, libs });
  const s = core.summary(c, v);
  assert.strictEqual(s.summary.totals.riskHigh, 2, '函数签名变更 + 移除异常处理');
  assert.ok(s.summary.unverified.some((x) => /诊断错误/.test(x)));
  assert.match(s.markdown, /存在阻断性错误/);
  assert.match(s.markdown, /无法验证的部分/);
  assert.doesNotMatch(s.markdown, /✅ 语法\/引用检查通过/, '阻断时绝不出现通过结论');
});

test('门禁不可用时返回 unavailable，绝不冒充 pass', () => {
  const c = core.compose(null);
  const v = core.gate({ text: c.text, ts: null, libs: {} });
  assert.strictEqual(v.status, 'unavailable');
  assert.strictEqual(v.blocked, false);
  const s = core.summary(c, v);
  assert.ok(s.summary.unverified.some((x) => /未能运行/.test(x)), '摘要必须把「没检查」说出来');
});

test('部分落盘后，剩余差异恰好等于被拒的块数', { skip: !hasEngine }, () => {
  const accepted = core.presetBrokenAcceptance();
  const c = core.compose(accepted);
  const rest = core.remaining(c.text);
  assert.strictEqual(rest.total, 1, '只剩 1 块未同步');
  assert.ok(rest.blocks[0].dels.some((i) => /function calcTax\(amount\)/.test(rest.aLines[i])));
});

test('全部落盘后，剩余差异为 0', { skip: !hasEngine }, () => {
  const c = core.compose(null);
  assert.strictEqual(core.remaining(c.text).total, 0);
});
