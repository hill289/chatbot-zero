/*!
 * read-window.test.js — read-window.js 的 Node 自检（零依赖）
 * 运行： node renderer/read-window.test.js
 *
 * 全是纯逻辑：不碰 FS / DOM，夹具在内存里现造（不往仓库里塞 3 MB 的 min.js）。
 *
 * 四条不变量（对应本次改动的验收口径）：
 *   1) 任何一次窗口返回都不超 token 预算（单行塞不下时的强制一行除外）；
 *   2) 只要没读到末尾，返回里必然带续读指针（nextStartLine / nextOffset）；
 *   3) 顺着指针连着读，能不重不漏地读完整个文件；
 *   4) 同样的输入 → 逐字节相同的输出（前缀缓存友好）。
 */
'use strict';
const RW = require('./read-window.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

// ── 夹具（全部在内存里造，形状对齐仓库里的真实文件） ──────────────
const FIX = {
  // renderer/assets/js/12-render.js：1541 行，平均 53 字符
  render: Array.from({ length: 1541 }, (_, i) => 'const x' + i + ' = someFunction(' + i + ', "abcdefghijklmnopqrstuvwxyz");').join('\n'),
  // renderer/assets/js/05-fs-tools.js 级别：2000 行正常代码
  normal2000: Array.from({ length: 2000 }, (_, i) => `  // line ${i} ${'x'.repeat(30)}`).join('\n'),
  // renderer/mermaid.min.js：2030 行，其中一行 302,842 字符
  mermaid: (function () {
    const ls = Array.from({ length: 2030 }, (_, i) => 'var a' + i + '=' + i + ';');
    ls[1200] = 'var huge="' + 'a'.repeat(302842) + '";';
    return ls.join('\n');
  })(),
  // renderer/katex.min.js：1 行 275,414 字符
  katex: '!function(e,t){"object"==typeof exports?' + 'x'.repeat(275400),
  // 3 MB 超大文件
  huge: 'y'.repeat(3 * 1024 * 1024),
  // CRLF
  crlf: Array.from({ length: 300 }, (_, i) => 'line' + i).join('\r\n')
};

const linesOf = (s) => String(s).split(/\r?\n/);
const bytesOf = (s) => Buffer.byteLength(s, 'utf8');

// ── 1. probe：形状判定 ────────────────────────────────────────────
group('probe · 形状判定');
eq(RW.probe(FIX.render).kind, 'normal', '1541 行正常代码 → normal');
eq(RW.probe(FIX.mermaid).kind, 'longline', '含 30 万字符单行 → longline');
eq(RW.probe(FIX.katex).kind, 'minified', '1 行 275KB → minified');
eq(RW.probe(FIX.huge, { bytes: bytesOf(FIX.huge) }).kind, 'huge', '3MB → huge');
eq(RW.probe(FIX.crlf).kind, 'normal', 'CRLF 300 行 → normal');
eq(RW.probe(FIX.crlf).totalLines, 300, 'CRLF 行数正确');

const sRender = RW.probe(FIX.render);
ok(sRender.maxLineLen < 200, '渲染文件最长行 <200');
eq(sRender.totalLines, 1541, 'render 行数');

// ── 2. plan：分派策略 ────────────────────────────────────────────
group('plan · 策略分派');
eq(RW.plan({ kind: 'normal' }).mode, 'lines', 'normal → lines');
eq(RW.plan({ kind: 'longline' }).mode, 'longline', 'longline → longline');
eq(RW.plan({ kind: 'minified' }).mode, 'minified', 'minified → minified');
eq(RW.plan({ kind: 'huge' }).mode, 'huge', 'huge → huge');
eq(RW.plan({ kind: 'minified' }).allowBody, false, '压缩包不给正文');
eq(RW.plan({ kind: 'normal' }).maxLines, 400, '默认 400 行');
eq(RW.plan({ kind: 'normal' }, { explicitRange: true }).maxLines, 2000, '显式范围放宽到 2000 行');

// ── 3. sliceByLines：token 预算 ──────────────────────────────────
group('sliceByLines · token 预算');
[
  ['render', FIX.render],
  ['normal2000', FIX.normal2000]
].forEach(([name, content]) => {
  const lines = linesOf(content);
  const r = RW.sliceByLines(lines, 1, lines.length, {});
  const tok = RW.estimateTokens(r.text);
  ok(tok <= 6000 + 200, `${name}: 一次返回 ${tok} tokens（预算 6000 + 尾部余量）`);
  ok(r.text.length > 0, `${name}: 非空`);
  ok(tokensAreSane(r.text), `${name}: token 估算非零`);
});

function tokensAreSane(t) { return RW.estimateTokens(t) > 0; }

// ── 4. 续读指针：连着读必须不重不漏 ──────────────────────────────
group('sliceByLines · 顺指针连读不重不漏');
(function () {
  const lines = linesOf(FIX.normal2000);
  let start = 1, rounds = 0, total = 0, guard = 0;
  const seen = [];
  while (start != null && guard++ < 100) {
    const r = RW.sliceByLines(lines, start, lines.length, {});
    rounds++;
    total += r.endLine - r.startLine + 1;
    for (let n = r.startLine; n <= r.endLine; n++) seen.push(n);
    if (r.nextStartLine != null) {
      ok(r.nextStartLine === r.endLine + 1, '指针 = 本窗口末行 + 1');
      ok(r.footer.indexOf('start_line=' + r.nextStartLine) !== -1, '尾部指令含 start_line=' + r.nextStartLine);
    }
    start = r.nextStartLine;
  }
  eq(total, 2000, '总读取行数 = 2000');
  eq(seen[0], 1, '从第 1 行开始');
  eq(seen[seen.length - 1], 2000, '读到第 2000 行');
  eq(new Set(seen).size, 2000, '无重复行');
  ok(rounds >= 4, `分 ${rounds} 轮读完（受 token 预算约束）`);
})();

// ── 5. 超长行：头尾摘要 + 指到 char_range ────────────────────────
group('sliceByLines · 超长行');
(function () {
  const lines = linesOf(FIX.mermaid);
  const r = RW.sliceByLines(lines, 1195, 1210, { maxTokens: 20000 });
  ok(r.longLines.length === 1, '识别到 1 条超长行');
  eq(r.longLines[0].line, 1201, '超长行行号 = 1201（1-indexed）');
  eq(r.longLines[0].lineLength, lines[1200].length, '原始行长正确');
  ok(r.footer.indexOf('read_file_char_range') !== -1, '尾部指向 read_file_char_range');
  ok(r.footer.indexOf('offset=' + r.longLines[0].nextOffset) !== -1, '给出 offset');
  ok(RW.estimateTokens(r.text) < 20000, '超长行不会把结果撑爆');
  const shown = r.text;
  ok(shown.indexOf('1201:var huge="aaa') !== -1, '展示头 1000 字符');
  ok(/…\[\+\d+ chars\]…/.test(shown), '省略号标注省略了多少字符');
})();

// ── 6. 确定性（前缀缓存友好） ─────────────────────────────────────
group('确定性');
(function () {
  const lines = linesOf(FIX.render);
  const a = RW.sliceByLines(lines, 1, lines.length, {});
  const b = RW.sliceByLines(lines, 1, lines.length, {});
  eq(a.text, b.text, '同输入 → 同输出（无时间戳/随机数）');
  ok(a.text.indexOf('[') !== -1, '含结构化尾巴');
})();

// ── 7. 边界 ──────────────────────────────────────────────────────
group('sliceByLines · 边界');
(function () {
  const lines = linesOf(FIX.crlf);
  const r1 = RW.sliceByLines(lines, 1, 300, { maxTokens: 100000 });
  eq(r1.nextStartLine, null, '读到末尾 → 无续读指针');
  ok(r1.text.indexOf('已到文件末尾') !== -1, '末尾有明确标记');
  const r2 = RW.sliceByLines(lines, 301, 400, {});
  eq(r2.ok, false, '越界 start_line → 明确报错');
  const r3 = RW.sliceByLines([], 1, 10, {});
  eq(r3.totalLines, 0, '空文件不炸');
  const r4 = RW.sliceByLines(lines, 300, 300, {});
  eq(r4.startLine, 300, '单行窗口');
  eq(r4.nextStartLine, null, '最后一行');
})();

// ── 8. sliceByChars：字符偏移切片 ────────────────────────────────
group('sliceByChars');
(function () {
  const raw = FIX.katex;
  let off = 0, acc = '', guard = 0;
  while (off != null && guard++ < 500) {
    const r = RW.sliceByChars(raw, off, 20000, {});
    acc += r.text;
    if (r.nextOffset != null) ok(r.nextOffset === r.end, 'nextOffset = end');
    off = r.nextOffset;
  }
  eq(acc, raw, '拼起来等于原文（UTF-8 边界安全）');
  eq(guard < 500, true, '有限轮次读完');

  const rEnd = RW.sliceByChars('abc', 1, 10, {});
  eq(rEnd.text, 'bc', '尾部切片');
  eq(rEnd.nextOffset, null, '到尾 → 无 nextOffset');
  const rOver = RW.sliceByChars('abc', 999, 10, {});
  eq(rOver.text, '', '越界 offset → 空串不炸');
})();

// ── 9. summarizeStructure ────────────────────────────────────────
group('summarizeStructure');
(function () {
  const minified = 'function alpha(){return 1}function beta(){return 2}var gamma=3;const delta=4;' + 'z'.repeat(200000);
  const shape = RW.probe(minified);
  const txt = RW.summarizeStructure('mermaid.min.js', minified, shape);
  ok(txt.length < 4000, '摘要不超 4KB');
  ok(txt.indexOf('不返回正文') !== -1, '明说不给正文');
  ok(/alpha|beta/.test(txt), '提取到顶层符号');
  ok(txt.indexOf('search_content') !== -1, '给出替代工具 search_content');
  ok(txt.indexOf('run_node') !== -1, '给出替代工具 run_node');
})();

// ── 10. classifyError：别再全说“文件不存在” ──────────────────────
group('classifyError');
eq(RW.classifyError(Object.assign(new Error('no such file'), { code: 'ENOENT' })).code, 'ENOENT', 'ENOENT 识别');
eq(RW.classifyError(Object.assign(new Error('is a directory'), { code: 'EISDIR' })).code, 'EISDIR', 'EISDIR 识别');
eq(RW.classifyError(new Error('permission denied')).code, 'EPERM', '权限错误识别');
eq(RW.classifyError(new Error('TextDecoder: out of memory')).code, 'OTHER', '其它异常不再伪装成 ENOENT');

// ── 11. 预算单调性：文件越大，窗口越小 ──────────────────────────
group('预算单调性');
(function () {
  const small = linesOf(FIX.render);
  const rSmall = RW.sliceByLines(small, 1, small.length, { maxTokens: 1000 });
  const rBig = RW.sliceByLines(small, 1, small.length, { maxTokens: 8000 });
  ok(rBig.endLine > rSmall.endLine, '预算越大读的行越多');
})();

console.log(`\n${fail === 0 ? '✅' : '❌'} read-window: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
