/*!
 * sync-guard.test.js — 写回前磁盘状态判定（sync-guard.js）单元测试
 * 运行：node --test renderer/sync-guard.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const SyncGuard = require('./sync-guard.js');
const Eol = require('./eol-meta.js');

const enc = (s) => new TextEncoder().encode(s);

test('decide：基线逐字节相等 → same', () => {
  const b = enc('a\r\nb\r\n');
  const r = SyncGuard.decide({ diskExists: true, diskBytes: b, refBytes: b, Eol });
  assert.strictEqual(r.state, 'same');
  assert.strictEqual(r.reason, 'baseline-bytes-equal');
});

test('decide：基线不等（哪怕只差一个字节）→ changed', () => {
  const r = SyncGuard.decide({
    diskExists: true,
    diskBytes: enc('a\r\nb\r\nc\r\n'),
    refBytes: enc('a\r\nb\r\n'),
    Eol
  });
  assert.strictEqual(r.state, 'changed');
  assert.strictEqual(SyncGuard.needsConfirm(r.state), true);
  assert.strictEqual(SyncGuard.allowsWrite(r.state), false);
});

test('decide：基线比指纹优先（基线相同即 same，即使指纹过期）', () => {
  const b = enc('x\n');
  const r = SyncGuard.decide({
    diskExists: true, diskBytes: b, refBytes: b,
    fp: { size: 999, h: 'deadbeef' }, Eol
  });
  assert.strictEqual(r.state, 'same');
});

test('decide：没有基线时退回指纹 → same / changed', () => {
  const bytes = enc('hello');
  const fp = Eol.hash(bytes);
  assert.strictEqual(SyncGuard.decide({ diskExists: true, diskBytes: bytes, refBytes: null, fp, Eol }).state, 'same');
  assert.strictEqual(SyncGuard.decide({ diskExists: true, diskBytes: enc('hello!'), refBytes: null, fp, Eol }).state, 'changed');
});

test('decide：磁盘文件已不存在 → missing（写回视为重建）', () => {
  const r = SyncGuard.decide({ diskExists: false, diskBytes: null, refBytes: enc('a'), Eol });
  assert.strictEqual(r.state, 'missing');
  assert.strictEqual(SyncGuard.allowsWrite(r.state), true);
});

test('decide：磁盘读不到（无权限/非 Electron）→ unknown，放行', () => {
  const r = SyncGuard.decide({ diskExists: true, diskBytes: null, refBytes: enc('a'), Eol });
  assert.strictEqual(r.state, 'unknown');
  assert.strictEqual(SyncGuard.allowsWrite(r.state), true);
  assert.strictEqual(SyncGuard.needsConfirm(r.state), false);
});

test('decide：既无基线也无指纹 → unknown（放行但不代表校验通过）', () => {
  const r = SyncGuard.decide({ diskExists: true, diskBytes: enc('a'), refBytes: null, fp: null, Eol });
  assert.strictEqual(r.state, 'unknown');
  assert.strictEqual(r.reason, 'no-baseline-no-fingerprint');
});

test('decide：接受 ArrayBuffer 形态的入参', () => {
  const b = enc('abc');
  const r = SyncGuard.decide({ diskExists: true, diskBytes: b.buffer, refBytes: b, Eol });
  assert.strictEqual(r.state, 'same');
});

test('decide：空文件（0 字节）也能判 same', () => {
  const empty = new Uint8Array(0);
  const r = SyncGuard.decide({ diskExists: true, diskBytes: empty, refBytes: empty, Eol });
  assert.strictEqual(r.state, 'same');
});

test('端到端：外部只改了换行风格（内容没变）→ same（不算冲突，写回时按原风格还原）', () => {
  const baseline = enc('line1\r\nline2\r\n');
  const outside = enc('line1\nline2\n');          // 别的编辑器另存成 LF，内容一致
  const r = SyncGuard.decide({ diskExists: true, diskBytes: outside, refBytes: baseline, Eol });
  assert.strictEqual(r.state, 'same');
  assert.strictEqual(r.reason, 'baseline-text-equal');
  // 且交付字节仍是原文件的 CRLF 风格
  const out = Eol.restoreBytes(enc('line1\nline2 edited\n'), Eol.detect(baseline));
  assert.strictEqual(new TextDecoder().decode(out), 'line1\r\nline2 edited\r\n');
});

test('端到端：外部改了内容 → changed（这才是必须拦的静默覆盖）', () => {
  const baseline = enc('line1\r\nline2\r\n');
  const outside = enc('line1\r\nline2 CHANGED BY IDE\r\n');
  const r = SyncGuard.decide({ diskExists: true, diskBytes: outside, refBytes: baseline, Eol });
  assert.strictEqual(r.state, 'changed');
  assert.strictEqual(SyncGuard.needsConfirm(r.state), true);
});

test('端到端：还原后的字节与“磁盘未变”判定相容', () => {
  // 场景：磁盘未变（same）→ 允许写 → 按 CRLF 还原 → 交付字节风格与原文件一致
  const baseline = enc('a\r\nb\r\n');
  const meta = Eol.detect(baseline);
  const gate = SyncGuard.decide({ diskExists: true, diskBytes: baseline, refBytes: baseline, Eol });
  assert.strictEqual(gate.state, 'same');
  const out = Eol.restoreBytes(enc('a\nB\n'), meta);
  assert.strictEqual(new TextDecoder().decode(out), 'a\r\nB\r\n');
});

test('跨换行风格：基线是 LF、磁盘是 CRLF（同一份内容）→ same，不误报警', () => {
  const baseline = enc('a\nb\n');       // 虚拟 FS / AI 写入的形态
  const disk = enc('a\r\nb\r\n');     // 磁盘原始形态
  const r = SyncGuard.decide({ diskExists: true, diskBytes: disk, refBytes: baseline, Eol });
  assert.strictEqual(r.state, 'same');
  assert.strictEqual(r.reason, 'baseline-text-equal');
});

test('跨换行风格：内容确实不同 → 仍然 changed（规范化不能掩盖真改动）', () => {
  const r = SyncGuard.decide({
    diskExists: true,
    diskBytes: enc('a\r\nb changed\r\n'),
    refBytes: enc('a\nb\n'),
    Eol
  });
  assert.strictEqual(r.state, 'changed');
});

test('指纹跨换行风格：canonicalHash 让 CRLF / LF 指纹一致', () => {
  const fp = Eol.canonicalHash(enc('x\r\ny\r\n'));
  const r = SyncGuard.decide({ diskExists: true, diskBytes: enc('x\ny\n'), refBytes: null, fp, Eol });
  assert.strictEqual(r.state, 'same');
});

test('指纹跨换行风格：内容变化仍判 changed', () => {
  const fp = Eol.canonicalHash(enc('x\r\ny\r\n'));
  const r = SyncGuard.decide({ diskExists: true, diskBytes: enc('x\ny\nz\n'), refBytes: null, fp, Eol });
  assert.strictEqual(r.state, 'changed');
});

test('二进制：不参与规范化，逐字节判定', () => {
  const a = new Uint8Array([0x00, 0x01, 0x02]);
  const b = new Uint8Array([0x00, 0x01, 0x03]);
  assert.strictEqual(SyncGuard.decide({ diskExists: true, diskBytes: b, refBytes: a, Eol }).state, 'changed');
  assert.strictEqual(SyncGuard.decide({ diskExists: true, diskBytes: a, refBytes: a, Eol }).state, 'same');
});
