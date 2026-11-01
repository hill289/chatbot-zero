/*!
 * read-fs-tools.test.js — 05-fs-tools.js 里 read_file / read_file_char_range 的端到端自检（零依赖）
 * 运行： node renderer/read-fs-tools.test.js
 *
 * 纯逻辑测试（read-window.test.js）只验算窗口算法；这里验「接线」：
 * 把 05-fs-tools.js 原文塞进 new Function，注入一个假 almostnode FS，
 * 然后真的调 read_file / read_file_char_range，断言返回给模型的那段文本。
 *
 * 三条验收：
 *   1) 默认读取不超 token 预算，且没读完时一定带 [继续] start_line=N；
 *   2) 顺着指针连读，能不重不漏读完整个文件；
 *   3) min.js / >2MB 不再是「读不了」或「文件不存在」，而是可执行的替代路径。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const RW = require('./read-window.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

// ── 假 almostnode FS ────────────────────────────────────────────
function makeFS(initial) {
  const files = new Map();
  for (const k of Object.keys(initial || {})) files.set(k, Buffer.from(initial[k], 'utf8'));
  return {
    files,
    FS: {
      readFile(p) {
        if (!files.has(p)) { const e = new Error('ENOENT: no such file or directory, open \'' + p + '\''); e.code = 'ENOENT'; throw e; }
        const buf = files.get(p);
        return new Uint8Array(buf);
      },
      stat(p) {
        if (!files.has(p)) { const e = new Error('ENOENT: no such file or directory'); e.code = 'ENOENT'; throw e; }
        return { size: files.get(p).length, mtimeMs: 1000, mode: 0o100644 };
      },
      isFile() { return true; },
      isDir() { return false; },
      readdir() { return []; }
    }
  };
}

// ── 加载被测文件（原文 + 注入依赖） ─────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, 'assets/js/05-fs-tools.js'), 'utf8');
function load(fakeFs) {
  const factory = new Function(
    'pgpyMode', 'nodeRuntime', 'ReadWindow', 'window', 'document',
    'pgpyDetectImageMime', 'pgpyBytesToBase64', 'pgpyUndocParse',
    SRC + '\n;return { read_file: read_file, read_file_char_range: read_file_char_range, read_file_line_slice: read_file_line_slice, FILE_TOOL_CONFIG: FILE_TOOL_CONFIG };'
  );
  return factory('node', { ready: true, FS: fakeFs.FS }, RW, {}, {}, function () { return null; }, function () { return ''; }, undefined);
}
function parse(jsonStr) { return JSON.parse(jsonStr); }
function textOf(jsonStr) {
  const o = parse(jsonStr);
  return (o.content && o.content[0] && o.content[0].text) || '';
}

// ── 夹具 ────────────────────────────────────────────────────────
const NORMAL = Array.from({ length: 2000 }, (_, i) => `  const v${i} = fn(${i}); // ${'x'.repeat(30)}`).join('\n');
const KATEX = '!function(e,t){"object"==typeof exports?e.exports=t():e.katex=t()}' + 'y'.repeat(275000);
const BIG = 'z'.repeat(3 * 1024 * 1024);

const fake = makeFS({
  '/home/pyodide/normal.js': NORMAL,
  '/home/pyodide/katex.min.js': KATEX,
  '/home/pyodide/big.js': BIG,
  '/home/pyodide/small.txt': 'a\nb\nc\nd\ne\nf\ng\n'
});
const T = load(fake);

async function main() {
// ── 1. 默认读取：预算 + 续读指针 ─────────────────────────────────
group('read_file · 默认窗口');
const r1 = parse(await T.read_file({ file_path: '/home/pyodide/normal.js' }));
ok(r1.success === true, '调用成功');
const t1 = r1.content[0].text;
ok(RW.estimateTokens(t1) <= T.FILE_TOOL_CONFIG.READ_MAX_TOKENS + 200, `token 预算内（${RW.estimateTokens(t1)}）`);
ok(/\[继续\] start_line=\d+/.test(t1), '带 [继续] start_line=N');
ok(/已读|窗口/.test(t1), '带窗口说明');
ok(t1.split('\n').length < 450, '行数不超默认上限太多');

// ── 2. 顺着指针连读：不重不漏 ──────────────────────────────────
group('read_file · 顺指针连读');
{
  let start = 1, rounds = 0, total = 0, done = false;
  const seen = new Set();
  while (!done && rounds < 50) {
    const r = parse(await T.read_file({ file_path: '/home/pyodide/normal.js', start_line: start }));
    if (!r.success) { ok(false, '第 ' + rounds + ' 轮失败：' + textOf(JSON.stringify(r))); break; }
    const body = r.content[0].text;
    const m = body.match(/\[窗口\] 第 (\d+)–(\d+) 行 \/ 共 (\d+) 行/);
    if (!m) { ok(false, '第 ' + rounds + ' 轮没有窗口标记'); break; }
    const a = +m[1], b = +m[2], n = +m[3];
    eq(n, 2000, '总行数 2000');
    for (let i = a; i <= b; i++) seen.add(i);
    total += (b - a + 1);
    rounds++;
    if (/已到文件末尾/.test(body)) { done = true; break; }
    const next = body.match(/\[继续\] start_line=(\d+)/);
    if (!next) { ok(false, '未到末尾却没有续读指针'); break; }
    start = +next[1];
  }
  eq(total, 2000, '总读取行数 2000');
  eq(seen.size, 2000, '无重复、无遗漏');
  ok(rounds >= 4 && rounds < 50, `分 ${rounds} 轮读完`);
}

// ── 3. min.js：不返回正文，给结构摘要 ──────────────────────────
group('read_file · min.js');
const r3 = parse(await T.read_file({ file_path: '/home/pyodide/katex.min.js' }));
ok(r3.success === true, '调用成功（不是报错）');
const t3 = r3.content[0].text;
ok(/\[SUMMARY\]/.test(t3), '返回 SUMMARY');
ok(/read_file_char_range/.test(t3), '指向 char_range');
ok(/search_content/.test(t3), '指向 search_content');
ok(t3.length < 5000, '摘要不超 5KB');
ok(!/y{500,}/.test(t3), '不回显 27 万字符正文');

// ── 4. >2MB：不再说“读不了”，给替代方案 ───────────────────────
group('read_file · 超大文件');
const r4 = parse(await T.read_file({ file_path: '/home/pyodide/big.js' }));
const t4 = r4.content[0].text;
ok(/read_file_char_range/.test(t4), '指向 char_range');
ok(/run_node/.test(t4), '指向 run_node');
ok(t4.indexOf('zzzzzzzzzz') === -1, '不回显 3MB 正文');

// ── 5. char_range：偏移分片能读完单行巨文件 ─────────────────────
group('read_file_char_range');
{
  let off = 0, acc = '', rounds = 0;
  while (off != null && rounds < 100) {
    const r = parse(await T.read_file_char_range({ file_path: '/home/pyodide/katex.min.js', offset: off, limit: 20000 }));
    ok(r.success === true, '第 ' + rounds + ' 轮成功');
    acc += r.content[0].text.split('\n').slice(1).join('\n').split('\n[偏移]')[0];
    const m = r.content[0].text.match(/\[继续\] offset=(\d+)/);
    off = m ? +m[1] : null;
    rounds++;
  }
  ok(acc.length > KATEX.length - 100, `拼回 ${acc.length} / ${KATEX.length} 字符`);
  ok(acc.indexOf(KATEX.slice(0, 100)) === 0, '开头一致');
}

// ── 6. 文件不存在：明确说「不存在」，不再伪装成功 ───────────────
group('错误分类');
{
  const r = parse(await T.read_file({ file_path: '/home/pyodide/nope.js' }));
  eq(r.success, false, 'ENOENT → success:false');
  ok(/不存在/.test(r.content[0].text), '提示「不存在」');
  ok(!/not exists in almostnode FS/.test(r.content[0].text), '不再用旧的无信息文案');

  const r2 = parse(await T.read_file_char_range({ file_path: '/home/pyodide/nope.js' }));
  eq(r2.success, false, 'char_range ENOENT → success:false');
}

// ── 7. 正常小文件：读完即止，无多余指针 ─────────────────────────
group('read_file · 小文件');
{
  const r = parse(await T.read_file({ file_path: '/home/pyodide/small.txt' }));
  const t = r.content[0].text;
  ok(/已到文件末尾/.test(t), '标记到末尾');
  ok(!/\[继续\]/.test(t), '无续读指针');
  ok(t.indexOf('1:a') === 0, '带行号');
}

// ── 8. read_file_line_slice 兼容 + next_offset ─────────────────
group('read_file_line_slice');
{
  const r = parse(await T.read_file_line_slice({ file_path: '/home/pyodide/katex.min.js', line: 1, offset: 0, limit: 50 }));
  ok(r.success === true, '成功');
  ok(/Line 1, offset=0/.test(r.content[0].text), '旧格式保留');
  ok(/Total length of this line/.test(r.content[0].text), '保留行长信息');
  ok(/offset=50/.test(r.content[0].text), '给出 next offset');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} read-fs-tools: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
}

main().catch(function (e) { console.error('测试异常：', e); process.exit(1); });
