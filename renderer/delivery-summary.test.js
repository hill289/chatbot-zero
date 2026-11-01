/*!
 * delivery-summary.test.js — 结构化改动摘要（delivery-summary.js）单元测试
 * 运行：node --test renderer/delivery-summary.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const D = require('./delivery-summary.js');

const has = (f, code) => f.tags.some((t) => t.code === code);
const tagOf = (f, code) => f.tags.find((t) => t.code === code);

test('declsOf：识别 JS / Python / Go 的声明与参数', () => {
  const d = D.declsOf('function a(x, y) {}\nconst b = (p) => 1\nexport class C extends E {}\ndef go_(u, v=1):\nfunc Go(a int) {}');
  assert.strictEqual(d.a.params, 'x,y');
  assert.strictEqual(d.b.params, 'p');
  assert.strictEqual(d.C.kind, 'class');
  assert.strictEqual(d.go_.params, 'u,v=1');
  assert.strictEqual(d.Go.params, 'aint', '参数比较忽略空白（避免格式差异误报）');
});

test('SIG：参数变化被识别为「函数签名变更」', () => {
  const f = D.analyzeFile({
    path: 'src/a.js',
    aText: 'function get(id) {\n  return id;\n}\n',
    bText: 'function get(id, opts) {\n  return id;\n}\n'
  });
  assert.ok(has(f, 'SIG'), '应标记签名变更');
  assert.match(tagOf(f, 'SIG').detail, /get\(id\)/);
  assert.strictEqual(tagOf(f, 'SIG').severity, 'high');
});

test('SIG：参数不变（只改函数体）不误报', () => {
  const f = D.analyzeFile({
    path: 'a.js',
    aText: 'function get(id) {\n  return id;\n}\n',
    bText: 'function get(id) {\n  return id * 2;\n}\n'
  });
  assert.ok(!has(f, 'SIG'));
});

test('DECL：整个声明被删掉 → 移除声明（high）', () => {
  const f = D.analyzeFile({
    path: 'a.py',
    aText: 'def keep(a):\n    pass\n\ndef gone(b):\n    pass\n',
    bText: 'def keep(a):\n    pass\n'
  });
  assert.ok(has(f, 'DECL'));
  assert.match(tagOf(f, 'DECL').detail, /gone/);
});

test('ERR：异常处理被移除才报，增加了反而不报', () => {
  const removed = D.analyzeFile({
    path: 'a.js',
    aText: 'try {\n  risky();\n} catch (e) {\n  console.error(e);\n}\n',
    bText: 'risky();\n'
  });
  assert.ok(has(removed, 'ERR'), '删掉 try/catch 应报');
  const added = D.analyzeFile({
    path: 'a.py',
    aText: 'risky()\n',
    bText: 'try:\n    risky()\nexcept Exception:\n    pass\n'
  });
  assert.ok(!has(added, 'ERR'));
});

test('CFG / DEP：配置文件与依赖清单分别打标', () => {
  const cfg = D.analyzeFile({ path: 'config/app.yaml', aText: 'a: 1\n', bText: 'a: 2\n' });
  assert.ok(has(cfg, 'CFG'));
  const dep = D.analyzeFile({ path: 'package.json', aText: '{"a":"1"}', bText: '{"a":"2"}' });
  assert.ok(has(dep, 'DEP'));
  const env = D.analyzeFile({ path: '.env.production', aText: 'K=1', bText: 'K=2' });
  assert.ok(has(env, 'CFG'));
});

test('SQL：.sql 文件或含 DDL 的内容', () => {
  assert.ok(has(D.analyzeFile({ path: 'db/1.sql', aText: '', bText: 'select 1;' }), 'SQL'));
  assert.ok(has(D.analyzeFile({ path: 'x.txt', aText: 'a', bText: 'ALTER TABLE users ADD c int;' }), 'SQL'));
});

test('TEST：测试文件标 info（不算风险）', () => {
  const f = D.analyzeFile({ path: 'tests/a.test.js', aText: 'a', bText: 'b' });
  const t = tagOf(f, 'TEST');
  assert.ok(t);
  assert.strictEqual(t.severity, 'info');
  assert.strictEqual(f.high, 0, 'info 不计入高风险');
});

test('CONST：全大写常量值变化被识别', () => {
  const f = D.analyzeFile({
    path: 'a.js',
    aText: 'const TIMEOUT_MS = 3000;\n',
    bText: 'const TIMEOUT_MS = 30000;\n'
  });
  assert.ok(has(f, 'CONST'));
});

test('BIG：改动超过 200 行提示分段审核', () => {
  const a = Array.from({ length: 400 }, (_, i) => 'old' + i).join('\n');
  const b = Array.from({ length: 400 }, (_, i) => 'new' + i).join('\n');
  const f = D.analyzeFile({ path: 'a.js', aText: a, bText: b, add: 400, del: 400 });
  assert.ok(has(f, 'BIG'));
});

test('NEW / DEL / BIN / NOBASE 状态标签', () => {
  assert.ok(has(D.analyzeFile({ path: 'n.js', baselineUnknown: true, bText: 'x' }), 'NEW'));
  assert.ok(has(D.analyzeFile({ path: 'd.js', kind: 'delete' }), 'DEL'));
  assert.ok(has(D.analyzeFile({ path: 'p.png', binary: true }), 'BIN'));
  assert.ok(has(D.analyzeFile({ path: 'o.js', baselineUnknown: true, bText: 'x' }), 'NOBASE'));
});

test('analyzeFile：无 aText 时不误判「移除声明/移除异常」', () => {
  const f = D.analyzeFile({ path: 'new.py', baselineUnknown: true, bText: 'def a():\n    pass\n' });
  assert.ok(!has(f, 'DECL'));
  assert.ok(!has(f, 'ERR'));
});

test('build：汇总计数正确，且永远带三条结构性「无法验证」', () => {
  const s = D.build({
    files: [
      D.analyzeFile({ path: 'a.js', aText: 'function f(x){}', bText: 'function f(x,y){}', add: 1, del: 1, total: 1, accepted: 1 }),
      D.analyzeFile({ path: 'b.js', kind: 'delete' })
    ]
  });
  assert.strictEqual(s.totals.files, 2);
  assert.strictEqual(s.totals.add, 1);
  assert.strictEqual(s.totals.blocks, 1);
  assert.strictEqual(s.totals.accepted, 1);
  assert.ok(s.totals.riskHigh >= 2);
  for (const must of D.STRUCTURAL_UNVERIFIED) {
    assert.ok(s.unverified.some((u) => u.includes(must.slice(0, 6)) || u === must), '缺少结构性边界：' + must);
  }
});

test('build：gate 阻断 / 不可用 都进「无法验证」', () => {
  const blocked = D.build({ files: [], gate: { status: 'block', blocked: true, errors: ['a.js:3 语法错误 1005'], checked: 1 } });
  assert.strictEqual(blocked.totals.blocked, true);
  assert.ok(blocked.unverified.some((u) => u.includes('1005')));

  const unavailable = D.build({ files: [], gate: { status: 'unavailable', reason: 'load-failed' } });
  assert.ok(unavailable.unverified.some((u) => u.includes('未能运行') && u.includes('load-failed')));
});

test('toMarkdown：含表格 / 风险项 / 无法验证 三节，且不给出「已验证通过」式结论', () => {
  const s = D.build({
    files: [D.analyzeFile({ path: 'src/a.js', aText: 'function f(x){}', bText: 'function f(x,y){}', add: 2, del: 1, total: 2, accepted: 1 })],
    gate: { status: 'pass', blocked: false, checked: 1, errors: [], warnings: 2 }
  });
  const md = D.toMarkdown(s);
  assert.match(md, /交付说明/);
  assert.match(md, /\| 文件 \| 类型 \| 变化 \| 变更块 \| 风险 \|/);
  assert.match(md, /#### 风险项/);
  assert.match(md, /#### 无法验证的部分/);
  assert.match(md, /1\/2 已接受/);
  assert.match(md, /不含推测/);
  assert.ok(!/一切正常|没有问题|保证正确/.test(md));
});

test('toMarkdown：空摘要不崩', () => {
  assert.strictEqual(D.toMarkdown(null), '');
  const s = D.build({ files: [] });
  assert.match(D.toMarkdown(s), /0 个文件/);
});

test('oneLine：给按钮/toast 的一句话', () => {
  const s = D.build({ files: [D.analyzeFile({ path: 'a.js', aText: 'x', bText: 'y', add: 1, del: 1 })] });
  assert.match(D.oneLine(s), /1 个文件/);
});
