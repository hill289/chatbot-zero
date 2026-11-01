/*!
 * spill.test.js — spill.js 的 Node 自检（零依赖）
 * 运行： node renderer/spill.test.js
 */
'use strict';
const S = require('./spill.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

group('parseResult · 形状识别');
{
  const strRes = JSON.stringify({ success: true, content: [{ type: 'text', text: 'hello' }] });
  const p1 = S.parseResult(strRes);
  eq(p1.shape, 'string', 'JSON 字符串');
  eq(p1.plain, false, 'JSON 字符串非 plain');
  eq(p1.content.length, 1, 'content 长度');
  const p2 = S.parseResult({ content: [{ type: 'text', text: 'x' }] });
  eq(p2.shape, 'object', '对象');
  const p3 = S.parseResult('plain text');
  eq(p3.plain, true, '纯文本 → plain');
  eq(S.parseResult(null), null, 'null → null');
}

group('totalTextChars · 文本统计');
{
  const c = [{ type: 'text', text: 'abc' }, { type: 'image', data: 'x' }, { type: 'text', text: 'de' }];
  eq(S.totalTextChars(c), 5, '只统计 text 项');
}

group('splitText · 头尾截断');
{
  const o = S.normOptions({ maxChars: 100, headChars: 30, tailChars: 20 });
  const small = S.splitText('short', o);
  eq(small.spilled, false, '小文本不截断');
  const big = S.splitText('a'.repeat(300), o);
  eq(big.spilled, true, '大文本截断');
  eq(big.head.length, 30, 'head 长度');
  eq(big.tail.length, 20, 'tail 长度');
  eq(big.omitted, 300 - 30 - 20, '省略字符数');
}

group('apply · 不改变形状 + 落盘指针');
{
  const o = S.normOptions({ maxChars: 100, headChars: 20, tailChars: 10 });
  const small = JSON.stringify({ success: true, content: [{ type: 'text', text: 'ok' }] });
  eq(S.apply(small, () => '/p', o).spilled, false, '小结果不 spill');

  const bigText = 'A'.repeat(50) + 'B'.repeat(50) + 'C'.repeat(50);
  const big = JSON.stringify({ success: false, isError: true, content: [{ type: 'text', text: bigText }], extra: 1 });
  let written = '';
  const r = S.apply(big, (t) => { written = t; return '/home/pyodide/.spill/x.txt'; }, o);
  eq(r.spilled, true, '大结果 spill');
  ok(typeof r.result === 'string', '保持 string 形状');
  const parsed = JSON.parse(r.result);
  eq(parsed.success, false, '保留 success');
  eq(parsed.isError, true, '保留 isError');
  eq(parsed.extra, 1, '保留其它字段');
  eq(parsed.__spilled, true, '标记 __spilled');
  eq(parsed.__spillPath, '/home/pyodide/.spill/x.txt', '记录路径');
  ok(parsed.content[0].text.indexOf('spill') >= 0, '含 spill 说明');
  ok(parsed.content[0].text.indexOf('/home/pyodide/.spill/x.txt') >= 0, '含指针');
  eq(written, bigText, 'writeFn 收到完整文本');

  // 对象形状
  const obj = { content: [{ type: 'text', text: bigText }] };
  const r2 = S.apply(obj, () => '/p2', o);
  ok(typeof r2.result === 'object', '保持 object 形状');
  eq(r2.result.__spillPath, '/p2', '对象路径');

  // 落盘失败 → 内联截断
  const r3 = S.apply(big, () => { throw new Error('no fs'); }, o);
  eq(r3.spilled, true, '落盘失败仍 spill');
  eq(JSON.parse(r3.result).__spillPath, undefined, '无路径');

  // 已 spill 不重复
  const r4 = S.apply(parsed, () => '/p', o);
  eq(r4.spilled, false, '已 spill 不重复');
}

group('多模态 · 非文本项保留');
{
  const o = S.normOptions({ maxChars: 10, headChars: 4, tailChars: 2 });
  const res = { content: [{ type: 'text', text: 'x'.repeat(100) }, { type: 'image', mimeType: 'image/png', data: 'AAA' }] };
  const r = S.apply(res, () => '/p', o);
  eq(r.result.content.length, 2, '文本 + 图片');
  eq(r.result.content[1].type, 'image', '图片项保留');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
