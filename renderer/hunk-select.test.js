/*!
 * hunk-select.test.js — 变更块级接受（hunk-select.js）单元测试
 * 运行：node --test renderer/hunk-select.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const H = require('./hunk-select.js');

const lines = (s) => H.splitText(s);

test('相同内容：无变更块，合成本身', () => {
  const r = H.compose('a\nb\nc', 'a\nb\nc');
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.acceptedCount, 0);
  assert.strictEqual(r.text, 'a\nb\nc');
});

test('单处修改：接受 → 新文本；拒绝 → 旧文本', () => {
  const a = 'a\nb\nc';
  const b = 'a\nB\nc';
  const r = H.compose(a, b);
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.text, 'a\nB\nc');
  const r2 = H.compose(a, b, []);
  assert.strictEqual(r2.acceptedCount, 0);
  assert.strictEqual(r2.text, a);
});

test('三处独立修改：只接受第 1、3 块 → 精确合成', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
  const b = ['A', 'b', 'c', 'd', 'e', 'f', 'G', 'h', 'I'].join('\n');
  const r = H.compose(a, b);
  assert.strictEqual(r.total, 3, '应切成 3 个变更块');
  const r13 = H.compose(a, b, [0, 2]);
  assert.strictEqual(r13.acceptedCount, 2);
  assert.deepStrictEqual(r13.text.split('\n'), ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'I']);
  // 只接受中间那块
  const r2 = H.compose(a, b, [1]);
  assert.deepStrictEqual(r2.text.split('\n'), ['a', 'b', 'c', 'd', 'e', 'f', 'G', 'h', 'i']);
});

test('纯新增行（文件末尾追加）：接受/拒绝', () => {
  const a = 'x\ny';
  const b = 'x\ny\nz';
  assert.strictEqual(H.compose(a, b).text, 'x\ny\nz');
  assert.strictEqual(H.compose(a, b, []).text, 'x\ny');
});

test('纯删除行：接受才删除', () => {
  const a = 'x\ny\nz';
  const b = 'x\nz';
  assert.strictEqual(H.compose(a, b).text, 'x\nz');
  assert.strictEqual(H.compose(a, b, []).text, 'x\ny\nz');
});

test('空基线（新文件）：全接受=新内容，全拒绝=空', () => {
  assert.strictEqual(H.compose('', 'a\nb').text, 'a\nb');
  assert.strictEqual(H.compose('', 'a\nb', []).text, '');
});

test('删除整个文件（b 为空）：接受=空串', () => {
  assert.strictEqual(H.compose('a\nb\n', '', null).text, '');
});

test('块数统计与 +/− 统计只计已接受块', () => {
  const a = 'a\nb\nc\nd';
  const b = 'A\nb\nC\nd';
  const all = H.compose(a, b);
  assert.strictEqual(all.stats.add, 2);
  assert.strictEqual(all.stats.del, 2);
  const one = H.compose(a, b, [0]);
  assert.strictEqual(one.stats.add, 1);
  assert.strictEqual(one.stats.del, 1);
});

test('blockIndexByOp 与 buildRows().block 一致，且只对改动行标块', () => {
  const a = lines('a\nb\nc\nd\ne');
  const b = lines('a\nB\nc\nD\ne');
  const ops = H.diffLines(a, b, false);
  const rows = H.buildRows(a, b, ops);
  const map = H.blockIndexByOp(ops);
  // 每一行改动行的 block 都应在 [0, blockCount) 内，equal 行为 -1
  const blocks = H.blocksOf(ops);
  for (const r of rows) {
    if (r.type === 'equal') assert.strictEqual(r.block, -1);
    else assert.ok(r.block >= 0 && r.block < blocks.length);
  }
  assert.strictEqual(blocks.length, 2);
  // op 级映射：非 equal op 的块号必须递增且全覆盖
  const seen = new Set();
  for (let i = 0; i < ops.length; i++) if (ops[i].type !== 'equal') seen.add(map[i]);
  assert.deepStrictEqual([...seen].sort(), [0, 1]);
});

test('blocksOf：一个块的 del/ins 行号范围正确', () => {
  const a = lines('keep\nold1\nold2\nkeep2');
  const b = lines('keep\nnew1\nkeep2');
  const ops = H.diffLines(a, b, false);
  const blocks = H.blocksOf(ops);
  assert.strictEqual(blocks.length, 1);
  assert.deepStrictEqual(blocks[0].dels, [1, 2]);
  assert.deepStrictEqual(blocks[0].inss, [1]);
  assert.strictEqual(blocks[0].aFrom, 1);
  assert.strictEqual(blocks[0].aTo, 3);
});

test('ignoreWs：只改缩进的块在忽略空白时不存在', () => {
  const a = '  foo\nbar';
  const b = '    foo\nbar';
  assert.strictEqual(H.compose(a, b, null, false).total, 1);
  assert.strictEqual(H.compose(a, b, null, true).total, 0);
});

test('signature：同内容同签名；任一侧变化即变', () => {
  const s1 = H.signature('a\nb', 'a\nB');
  assert.strictEqual(s1, H.signature('a\nb', 'a\nB'));
  assert.notStrictEqual(s1, H.signature('a\nb', 'a\nC'));
  assert.notStrictEqual(s1, H.signature('x\nb', 'a\nB'));
  assert.notStrictEqual(H.signature('a\nb', 'a\nB', false), H.signature('a\nb', 'a\nB', true));
});

test('rejectedBlocks：返回未被接受的块', () => {
  const a = 'a\nb\nc\nd\ne\nf\ng';
  const b = 'A\nb\nc\nd\ne\nF\nG';
  const r = H.compose(a, b, [0]);
  const rej = H.rejectedBlocks(r.blocks, [0]);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(rej.length, 1);
  assert.strictEqual(rej[0].index, 1);
});

test('大量行（>2000）不爆栈：锚点二分路径可用', () => {
  const n = 3000;
  const A = [], B = [];
  for (let i = 0; i < n; i++) { A.push('line ' + i + ' x'); B.push('line ' + i + ' x'); }
  B[1500] = 'line 1500 CHANGED';
  const r = H.compose(A.join('\n'), B.join('\n'));
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.text.split('\n')[1500], 'line 1500 CHANGED');
});

test('原地往返：全接受再全拒绝，字节级回到起点', () => {
  const a = 'one\ntwo\nthree\nfour';
  const b = 'one\nTWO\nthree\nFOUR\nfive';
  const r = H.compose(a, b);
  assert.strictEqual(H.compose(a, r.text, []).text, a);
});

test('CRLF 文本按行切分后合成，不引入 \\r', () => {
  const r = H.compose('a\r\nb\r\n', 'a\r\nB\r\n');
  assert.ok(!/\r/.test(r.text), '合成文本应为纯 LF，EOL 由写回端还原');
  assert.strictEqual(r.text, 'a\nB\n', '末尾空行 = 保留文件末尾换行，写回端再还原成 CRLF');
});
