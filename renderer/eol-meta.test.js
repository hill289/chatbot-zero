/*!
 * eol-meta.test.js — 文本原样保真（eol-meta.js）单元测试
 * 运行：node --test renderer/eol-meta.test.js
 * 覆盖：EOL 探测（CRLF/LF/CR/混合）、BOM 与 UTF-16 往返、末尾换行补/去、
 *       二进制与 GBK 拒绝改写、幂等（风格一致时字节不变）、指纹哈希。
 */
const test = require('node:test');
const assert = require('node:assert');
const Eol = require('./eol-meta.js');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder('utf-8').decode(b);
const toStr = (b) => Buffer.from(b).toString('latin1');

// ── EOL 探测 ───────────────────────────────────────────────
test('detectEol：三种风格 + 混合', () => {
  assert.strictEqual(Eol.detectEol('a\r\nb\r\n').eol, 'crlf');
  assert.strictEqual(Eol.detectEol('a\nb\n').eol, 'lf');
  assert.strictEqual(Eol.detectEol('a\rb\r').eol, 'cr');
  const m = Eol.detectEol('a\r\nb\n');
  assert.strictEqual(m.mixed, true);
});

test('detectEol：无换行按 lf', () => {
  const r = Eol.detectEol('single line');
  assert.strictEqual(r.eol, 'lf');
  assert.strictEqual(r.mixed, false);
});

// ── 档案抽取 ───────────────────────────────────────────────
test('detect：CRLF 文本被识别，末尾换行记录正确', () => {
  const m = Eol.detect(enc('a\r\nb\r\n'));
  assert.ok(m);
  assert.strictEqual(m.enc, 'utf8');
  assert.strictEqual(m.eol, 'crlf');
  assert.strictEqual(m.finalNewline, true);
});

test('detect：无末尾换行被记录', () => {
  const m = Eol.detect(enc('a\nb'));
  assert.strictEqual(m.finalNewline, false);
});

test('detect：UTF-8 BOM 被识别', () => {
  const bytes = new Uint8Array([0xEF, 0xBB, 0xBF].concat([...enc('x\r\n')]));
  const m = Eol.detect(bytes);
  assert.ok(m);
  assert.strictEqual(m.enc, 'utf8bom');
  assert.strictEqual(m.eol, 'crlf');
});

test('detect：UTF-16LE 被识别', () => {
  const m = Eol.detect(Eol.encode('a\r\nb\r\n', 'utf16le'));
  assert.ok(m);
  assert.strictEqual(m.enc, 'utf16le');
  assert.strictEqual(m.eol, 'crlf');
});

test('detect：混合换行 → null（不猜）', () => {
  assert.strictEqual(Eol.detect(enc('a\r\nb\nc\r\n')), null);
});

test('detect：二进制 → null', () => {
  assert.strictEqual(Eol.detect(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00, 0x01])), null);
});

test('detect：GBK 字节（非法 UTF-8）→ null，绝不改写', () => {
  const gbk = new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3, 0x0D, 0x0A]); // “你好” + CRLF
  assert.strictEqual(Eol.detect(gbk), null);
});

// ── 还原：核心场景 ─────────────────────────────────────────
test('restoreBytes：AI 写成 LF，CRLF 原文件被还原', () => {
  const meta = Eol.detect(enc('line1\r\nline2\r\n'));
  const aiOutput = enc('line1\nline2 changed\n');
  const out = Eol.restoreBytes(aiOutput, meta);
  assert.strictEqual(dec(out), 'line1\r\nline2 changed\r\n');
});

test('restoreBytes：风格已一致时字节不变（幂等）', () => {
  const original = enc('a\r\nb\r\n');
  const meta = Eol.detect(original);
  const out = Eol.restoreBytes(original, meta);
  assert.ok(Eol.sameBytes(out, original));
});

test('restoreBytes：UTF-8 BOM 被补回', () => {
  const orig = new Uint8Array([0xEF, 0xBB, 0xBF].concat([...enc('x\r\n')]));
  const meta = Eol.detect(orig);
  const out = Eol.restoreBytes(enc('x\ny\n'), meta);
  assert.strictEqual(out[0], 0xEF);
  assert.strictEqual(out[1], 0xBB);
  assert.strictEqual(out[2], 0xBF);
  assert.strictEqual(dec(out.subarray(3)), 'x\r\ny\r\n');
});

test('restoreBytes：UTF-16LE 原文件按 UTF-16LE 写回', () => {
  const orig = Eol.encode('a\r\nb\r\n', 'utf16le');
  const meta = Eol.detect(orig);
  const out = Eol.restoreBytes(enc('a\nc\n'), meta);   // AI 产出 UTF-8
  assert.strictEqual(out[0], 0xFF);
  assert.strictEqual(out[1], 0xFE);
  assert.strictEqual(Eol.decode(out, 'utf16le'), 'a\r\nc\r\n');
});

test('restoreBytes：末尾换行缺失时补回 / 多出时去掉', () => {
  const withNl = Eol.detect(enc('a\nb\n'));
  assert.strictEqual(dec(Eol.restoreBytes(enc('a\nb'), withNl)), 'a\nb\n');

  const noNl = Eol.detect(enc('a\nb'));
  assert.strictEqual(dec(Eol.restoreBytes(enc('a\nb\n'), noNl)), 'a\nb');
});

test('restoreBytes：CR 风格（老 Mac）也能还原', () => {
  const meta = Eol.detect(enc('a\rb\r'));
  assert.strictEqual(dec(Eol.restoreBytes(enc('a\nb\n'), meta)), 'a\rb\r');
});

test('restoreBytes：meta 为 null / 混合换行 → 原样返回', () => {
  const ai = enc('a\nb\n');
  assert.ok(Eol.sameBytes(Eol.restoreBytes(ai, null), ai));
  assert.ok(Eol.sameBytes(Eol.restoreBytes(ai, { mixed: true }), ai));
});

test('restoreBytes：二进制当前字节不动', () => {
  const meta = Eol.detect(enc('a\r\nb\r\n'));
  const bin = new Uint8Array([0x00, 0x01, 0x02, 0xFF]);
  assert.ok(Eol.sameBytes(Eol.restoreBytes(bin, meta), bin));
});

test('restoreBytes：中文内容无损', () => {
  const meta = Eol.detect(enc('第一行\r\n第二行\r\n'));
  const out = Eol.restoreBytes(enc('第一行\n第二行改\n'), meta);
  assert.strictEqual(dec(out), '第一行\r\n第二行改\r\n');
});

// ── 指纹 ───────────────────────────────────────────────────
test('hash：相同字节同指纹，差一个字节即不同', () => {
  const a = Eol.hash(enc('hello world'));
  const b = Eol.hash(enc('hello world'));
  const c = Eol.hash(enc('hello worle'));
  assert.ok(Eol.sameHash(a, b));
  assert.ok(!Eol.sameHash(a, c));
  assert.strictEqual(a.size, 11);
});

test('hash：不同长度不会被判为相同', () => {
  assert.ok(!Eol.sameHash(Eol.hash(enc('ab')), Eol.hash(enc('abc'))));
});

test('sameBytes：类型混用（Uint8Array / ArrayBuffer）也能比', () => {
  const u8 = enc('abc');
  const ab = u8.slice().buffer;
  assert.ok(Eol.sameBytes(u8, ab));
  assert.ok(!Eol.sameBytes(u8, enc('abd')));
});

// ── 规范化比较（跨换行风格）────────────────────────────────
test('sameText：CRLF 与 LF 的同一份内容判为相同', () => {
  assert.strictEqual(Eol.sameText(enc('a\r\nb\r\n'), enc('a\nb\n')), true);
});

test('sameText：内容不同则不相同', () => {
  assert.strictEqual(Eol.sameText(enc('a\r\nb\r\n'), enc('a\nb\n!')), false);
});

test('sameText：BOM 差异被忽略', () => {
  const withBom = new Uint8Array([0xEF, 0xBB, 0xBF].concat([...enc('a\r\n')]));
  assert.strictEqual(Eol.sameText(withBom, enc('a\n')), true);
});

test('canonicalHash：换行风格不同、内容相同 → 同哈希', () => {
  assert.ok(Eol.sameHash(Eol.canonicalHash(enc('a\r\nb')), Eol.canonicalHash(enc('a\nb'))));
});

test('canonicalHash：内容不同 → 不同哈希', () => {
  assert.ok(!Eol.sameHash(Eol.canonicalHash(enc('a\r\nb')), Eol.canonicalHash(enc('a\nc'))));
});

test('canonicalBytes：二进制原样返回', () => {
  const bin = new Uint8Array([0x00, 0xFF]);
  assert.ok(Eol.sameBytes(Eol.canonicalBytes(bin), bin));
});
