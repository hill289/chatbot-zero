/*!
 * type-gate.test.js — 交付前类型/语法门禁（type-gate.js）单元测试
 * 运行：node --test renderer/type-gate.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const G = require('./type-gate.js');

// 真实 tsserver（与页面同一份 bundle）；加载失败则跳过端到端用例
let ts = null;
try { ts = require('./lsp/typescript.js'); } catch (_) { ts = null; }
let libs = null;
try { libs = require('./lsp/ts-libs.js'); } catch (_) { libs = null; }
const hasEngine = !!(ts && ts.createLanguageService);

test('canCheck：按扩展名分流 ts / json / 不检查', () => {
  assert.strictEqual(G.canCheck('a.js'), 'ts');
  assert.strictEqual(G.canCheck('a.tsx'), 'ts');
  assert.strictEqual(G.canCheck('a.mjs'), 'ts');
  assert.strictEqual(G.canCheck('a.json'), 'json');
  assert.strictEqual(G.canCheck('a.py'), null);
  assert.strictEqual(G.canCheck('a.png'), null);
  assert.strictEqual(G.canCheck(''), null);
});

test('jsonError：合法 JSON 无错，语法坏则报错', () => {
  assert.strictEqual(G.jsonError('{"a":1}'), null);
  assert.strictEqual(G.jsonError('[]'), null);
  assert.ok(G.jsonError('{"a":1,}'));
  assert.ok(G.jsonError(''));
});

test('classify：语法错误与白名单码 → errors；其余 → warnings', () => {
  const r = G.classify([
    { file: 'a.js', line: 3, col: 5, code: 1005, severity: 'error', message: "';' expected." },
    { file: 'a.js', line: 7, col: 1, code: 2304, severity: 'error', message: "Cannot find name 'foo'." },
    { file: 'a.js', line: 9, col: 1, code: 2339, severity: 'error', message: 'Property x does not exist.' }
  ]);
  assert.strictEqual(r.errors.length, 2);
  assert.strictEqual(r.warnings.length, 1);
  assert.match(r.errors[0], /a\.js:3:5 · TS1005/);
});

test('classify：去重同一行同一码', () => {
  const dup = { file: 'a.js', line: 1, col: 1, code: 2304, severity: 'error', message: 'x' };
  assert.strictEqual(G.classify([dup, { ...dup }]).errors.length, 1);
});

test('verdict：不支持的类型 → skipped（不阻断）', () => {
  const v = G.verdict({ path: 'a.py' });
  assert.strictEqual(v.status, 'skipped');
  assert.strictEqual(v.blocked, false);
});

test('verdict：JSON 语法错 → block', () => {
  const v = G.verdict({ path: 'package.json', jsonError: 'Unexpected token }' });
  assert.strictEqual(v.status, 'block');
  assert.strictEqual(v.blocked, true);
  assert.ok(v.errors[0].includes('package.json') === false); // 只给原因，不伪造位置
});

test('verdict：有阻断错误 → block；只有告警 → warn（放行）', () => {
  const block = G.verdict({ path: 'a.js', diagnostics: [{ file: 'a.js', line: 1, code: 2304, severity: 'error', message: 'Cannot find name y' }] });
  assert.strictEqual(block.blocked, true);
  const warn = G.verdict({ path: 'a.js', diagnostics: [{ file: 'a.js', line: 1, code: 2339, severity: 'error', message: 'Property' }] });
  assert.strictEqual(warn.status, 'warn');
  assert.strictEqual(warn.blocked, false);
});

test('verdict：干净 → pass，checked 计数正确', () => {
  const v = G.verdict({ path: 'a.js', diagnostics: [], checked: 3 });
  assert.strictEqual(v.status, 'pass');
  assert.strictEqual(v.checked, 3);
});

test('verdict：显式 skipReason 优先（大文件/无引擎）', () => {
  const v = G.verdict({ path: 'a.js', skipReason: '文件过大' });
  assert.strictEqual(v.status, 'skipped');
  assert.strictEqual(v.reason, '文件过大');
});

test('diagnose：无引擎时安全降级（返回 ok:false，不抛）', () => {
  const r = G.diagnose({ path: '/a.js', text: 'var a = 1;', ts: null });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason);
});

// ── 端到端：用真实 tsserver 检查「合成结果」，验证它抓得到拼装错误 ──
test('端到端：定义在块 2 / 使用在块 5，只接受使用块 → 门禁必须拦住', { skip: !hasEngine ? '无 TS 引擎' : false }, () => {
  const vfs = {
    '/src/a.js': 'function compute(x) {\n  return x * 2;\n}\n\nmodule.exports = { compute };\n'
  };
  const readFile = (p) => vfs[p];
  // 合成结果：调用了 helper()，但定义被用户拒掉了 → 未定义
  const composed = 'function compute(x) {\n  return x * 2;\n}\n\nconst out = helper(21);\nmodule.exports = { compute, out };\n';
  const r = G.diagnose({ path: '/src/a.js', text: composed, readFile, ts, libs, defaultLib: 'lib.es2020.full.d.ts' });
  assert.strictEqual(r.ok, true, '诊断应能运行：' + r.reason);
  const v = G.verdict({ path: '/src/a.js', diagnostics: r.items });
  assert.strictEqual(v.blocked, true, '未定义函数应被门禁拦住');
  assert.ok(v.errors.some((e) => /2304|helper/.test(e)), '应报找不到 helper：' + JSON.stringify(v.errors));
});

test('端到端：语法被拆坏（括号不闭合）→ 拦住', { skip: !hasEngine ? '无 TS 引擎' : false }, () => {
  const r = G.diagnose({ path: '/src/b.js', text: 'function f() {\n  return 1;\n', readFile: () => undefined, ts, libs });
  assert.strictEqual(r.ok, true, r.reason);
  const v = G.verdict({ path: '/src/b.js', diagnostics: r.items });
  assert.strictEqual(v.blocked, true, '语法错误必须阻断：' + JSON.stringify(v.errors));
});

test('端到端：跨文件 import 在工作区内可解析，不误报 2307', { skip: !hasEngine ? '无 TS 引擎' : false }, () => {
  const vfs = {
    '/src/util.js': 'exports.twice = function (n) { return n * 2; };\n',
    '/src/main.js': ''
  };
  const readFile = (p) => vfs[p];
  const composed = "const { twice } = require('./util');\nmodule.exports = twice(2);\n";
  const r = G.diagnose({ path: '/src/main.js', text: composed, readFile, ts, libs });
  assert.strictEqual(r.ok, true, r.reason);
  const v = G.verdict({ path: '/src/main.js', diagnostics: r.items });
  assert.strictEqual(v.blocked, false, '同工作区内的 require 不应被误判：' + JSON.stringify(v.errors));
});

test('端到端：干净的合成结果 → pass，不制造假告警阻断', { skip: !hasEngine ? '无 TS 引擎' : false }, () => {
  const composed = 'function add(a, b) {\n  return a + b;\n}\nmodule.exports = add(1, 2);\n';
  const r = G.diagnose({ path: '/src/c.js', text: composed, readFile: () => undefined, ts, libs });
  assert.strictEqual(r.ok, true, r.reason);
  const v = G.verdict({ path: '/src/c.js', diagnostics: r.items });
  assert.strictEqual(v.blocked, false, JSON.stringify(v.errors));
});
