/*!
 * file-to-image-core.test.js — file-to-image-core.js 的纯逻辑单测
 * 运行： node renderer/file-to-image-core.test.js （或经 npm test 的 node --test）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('./file-to-image-core.js');

test('detectFormat：按扩展名识别五种格式', () => {
  assert.strictEqual(C.detectFormat('/a/b/doc.docx'), 'docx');
  assert.strictEqual(C.detectFormat('/a/b/sheet.xlsx'), 'xlsx');
  assert.strictEqual(C.detectFormat('/a/b/deck.pptx'), 'pptx');
  assert.strictEqual(C.detectFormat('/a/b/report.pdf'), 'pdf');
  assert.strictEqual(C.detectFormat('/a/b/readme.md'), 'markdown');
  assert.strictEqual(C.detectFormat('/a/b/readme.markdown'), 'markdown');
});

test('detectFormat：别名与大小写', () => {
  assert.strictEqual(C.detectFormat('/a/DOC.DOC'), 'docx');
  assert.strictEqual(C.detectFormat('/a/x.XLS'), 'xlsx');
  assert.strictEqual(C.detectFormat('/a/x.csv'), 'xlsx');
  assert.strictEqual(C.detectFormat('/a/x.PPT'), 'pptx');
});

test('detectFormat：显式 format 优先于扩展名', () => {
  assert.strictEqual(C.detectFormat('/a/b.bin', 'pdf'), 'pdf');
  assert.strictEqual(C.detectFormat('/a/b.md', 'docx'), 'docx');
  assert.strictEqual(C.detectFormat('/a/b', '.xlsx'), 'xlsx');
});

test('detectFormat：未知格式返回空串', () => {
  assert.strictEqual(C.detectFormat('/a/b.txt'), '');
  assert.strictEqual(C.detectFormat('/a/b'), '');
  assert.strictEqual(C.detectFormat(null), '');
});

test('extOf：忽略 query/hash、隐藏文件、末尾点', () => {
  assert.strictEqual(C.extOf('/a/b.pdf?x=1#y'), 'pdf');
  assert.strictEqual(C.extOf('/a/.bashrc'), '');
  assert.strictEqual(C.extOf('/a/b.'), '');
  assert.strictEqual(C.extOf(''), '');
});

test('normalizeImageFormat / ext / mime', () => {
  assert.strictEqual(C.normalizeImageFormat('jpg'), 'jpeg');
  assert.strictEqual(C.normalizeImageFormat('JPEG'), 'jpeg');
  assert.strictEqual(C.normalizeImageFormat('webp'), 'webp');
  assert.strictEqual(C.normalizeImageFormat('gif'), 'png');
  assert.strictEqual(C.normalizeImageFormat(undefined), 'png');
  assert.strictEqual(C.extForImage('jpeg'), 'jpg');
  assert.strictEqual(C.extForImage('png'), 'png');
  assert.strictEqual(C.mimeForImage('jpeg'), 'image/jpeg');
  assert.strictEqual(C.mimeForImage('png'), 'image/png');
});

test('imageName：逐页命名', () => {
  assert.strictEqual(C.imageName('report', 1, 'png'), 'report-1.png');
  assert.strictEqual(C.imageName('report', 3, 'jpeg'), 'report-3.jpg');
  assert.strictEqual(C.imageName('', 2, 'png'), 'page-2.png');
});

test('planOutputs：由 output_path 推导目录/基础名', () => {
  const p = C.planOutputs({ output_path: '/home/pyodide/out/report.pdf', image_format: 'png' });
  assert.strictEqual(p.dir, '/home/pyodide/out');
  assert.strictEqual(p.base, 'report');
  assert.strictEqual(p.pdfPath, '/home/pyodide/out/report.pdf');
  assert.strictEqual(p.imageName(1), 'report-1.png');
});

test('planOutputs：output_dir 覆盖 + 默认值', () => {
  const p = C.planOutputs({ output_dir: '/home/pyodide/imgs/', base: 'deck', image_format: 'jpeg' });
  assert.strictEqual(p.dir, '/home/pyodide/imgs');
  assert.strictEqual(p.base, 'deck');
  assert.strictEqual(p.pdfPath, '/home/pyodide/imgs/deck.pdf');
  assert.strictEqual(p.imageName(2), 'deck-2.jpg');

  const d = C.planOutputs({});
  assert.strictEqual(d.dir, '/home/pyodide');
  assert.strictEqual(d.base, 'output');
  assert.strictEqual(d.pdfPath, '/home/pyodide/output.pdf');
});

test('selectPages：全部 / 指定 / 去重 / 越界过滤', () => {
  assert.deepStrictEqual(C.selectPages(3, null), [0, 1, 2]);
  assert.deepStrictEqual(C.selectPages(3, [1, 3]), [0, 2]);
  assert.deepStrictEqual(C.selectPages(4, [3, 1, 3, 9, 0]), [0, 2]);
  assert.deepStrictEqual(C.selectPages(0, null), []);
  assert.deepStrictEqual(C.selectPages(2, 2), [1]);
});

test('decodeDataUrl：base64 与非法输入', () => {
  // "ABC" 的 base64 = QUJD
  const r = C.decodeDataUrl('data:text/plain;base64,QUJD');
  assert.strictEqual(r.mime, 'text/plain');
  assert.deepStrictEqual(Array.from(r.bytes), [65, 66, 67]);

  const p = C.decodeDataUrl('data:image/png;base64,iVBORw0KGgo=');
  assert.strictEqual(p.mime, 'image/png');
  assert.ok(p.bytes.length > 0);

  assert.throws(() => C.decodeDataUrl('not-a-dataurl'));
});

test('detectFormat / isSupported：html 输入', () => {
  assert.strictEqual(C.detectFormat('/a/b/index.html'), 'html');
  assert.strictEqual(C.detectFormat('/a/b/index.htm'), 'html');
  assert.strictEqual(C.detectFormat('', 'html'), 'html');
  assert.ok(C.isSupported('html'));
});

test('isSupported / isMarkdown', () => {
  ['markdown', 'docx', 'xlsx', 'pptx', 'pdf'].forEach((f) => assert.ok(C.isSupported(f), f));
  assert.ok(!C.isSupported('txt'));
  assert.ok(C.isMarkdown('markdown'));
  assert.ok(!C.isMarkdown('pdf'));
});
