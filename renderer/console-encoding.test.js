/*!
 * console-encoding.test.js — 控制台输出解码自检（零依赖）
 * 运行： node renderer/console-encoding.test.js
 *
 * 复现的线上问题：Windows 上 run_shell 的 stderr 里，cmd.exe 的内建中文错误
 * （`'head' 不是内部或外部命令…`，OEM 代码页 GBK）被当成 UTF-8 解，变成
 * `'head' �����ڲ����ⲿ���`。参考 opencode 的 smartDecodeOutput：
 * 严格 UTF-8 失败 → Windows 上按 GB18030 重解。
 *
 * 验收：
 *   1) GBK 字节还原为正确中文；
 *   2) 正常 UTF-8 中文不受影响（不会被误判成 GBK）；
 *   3) 流式解码逐行判定：UTF-8 行 + GBK 行混排都正确，无 U+FFFD；
 *   4) 多字节字符被 chunk 边界劈开也不产生乱码；
 *   5) 非 Windows 平台不做 GBK 兜底（避免把二进制输出误当中文）；
 *   6) 超长单行强制吐出时仍不劈坏多字节字符。
 */
'use strict';
const path = require('path');
const CE = require('./console-encoding.js');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + '\n    got:  ' + JSON.stringify(a) + '\n    want: ' + JSON.stringify(b)); }
function group(t) { console.log('\n▶ ' + t); }

// ── 夹具：真实 cmd.exe 中文报错的 GBK 字节（PowerShell GetEncoding(936) 生成）──
const CMD_MSG = "'head' 不是内部或外部命令，也不是可运行的程序或批处理文件。";
const CMD_MSG_GBK = Buffer.from([
  39, 104, 101, 97, 100, 39, 32, 178, 187, 202, 199, 196, 218, 178, 191, 187, 242,
  205, 226, 178, 191, 195, 252, 193, 238, 163, 172, 210, 178, 178, 187, 202, 199,
  191, 201, 212, 203, 208, 208, 181, 196, 179, 204, 208, 242, 187, 242, 197, 250,
  180, 166, 192, 237, 206, 196, 188, 254, 161, 163,
]);
const countFffd = (s) => (s.match(/\uFFFD/g) || []).length;

group('夹具自检（确认 GBK 字节与期望文本一致）');
eq(new TextDecoder('gb18030').decode(CMD_MSG_GBK), CMD_MSG, 'GB18030 解码 = 期望中文');
let utf8Threw = false;
try { new TextDecoder('utf-8', { fatal: true }).decode(CMD_MSG_GBK); } catch (_) { utf8Threw = true; }
ok(utf8Threw, '同一串在严格 UTF-8 下确实失败（这正是乱码的根因）');

// ── 1. 整块解码：GBK → 中文 ─────────────────────────────────────
group('decodeConsoleBuffer · win32 GBK 兜底');
eq(CE.decodeConsoleBuffer(CMD_MSG_GBK, 'win32'), CMD_MSG, 'GBK stderr 正确还原');
eq(CE.smartDecodeOutput(CMD_MSG_GBK, 'win32'), CMD_MSG, 'smartDecodeOutput 别名一致');

// ── 2. UTF-8 中文不受影响 ──────────────────────────────────────
group('decodeConsoleBuffer · UTF-8 直通');
const U8_LINE = '✔ 已写入 3 个文件（中文不乱码）';
eq(CE.decodeConsoleBuffer(Buffer.from(U8_LINE, 'utf8'), 'win32'), U8_LINE, 'UTF-8 中文原样返回');
eq(countFffd(CE.decodeConsoleBuffer(Buffer.from(U8_LINE, 'utf8'), 'win32')), 0, '无替换符');

// ── 3. 流式逐行：UTF-8 行 + GBK 行混排 ─────────────────────────
group('createConsoleStreamDecoder · 混排流');
{
  let out = '';
  const d = CE.createConsoleStreamDecoder({ platform: 'win32', onText: (t) => { out += t; } });
  d.push(Buffer.from('\n[stdout]\n' + U8_LINE + '\n', 'utf8'));
  // 把 GBK 报错行拆成两半喂进去，模拟 pipe chunk 边界
  d.push(CMD_MSG_GBK.subarray(0, 17));
  d.push(CMD_MSG_GBK.subarray(17));
  d.push(Buffer.from('\n退出码 255\n', 'utf8'));
  d.flush();
  ok(out.indexOf(U8_LINE) !== -1, 'UTF-8 行正确');
  ok(out.indexOf(CMD_MSG) !== -1, 'GBK 行正确（关键修复）');
  eq(countFffd(out), 0, '整段无 U+FFFD');
  d.push(Buffer.from('x', 'utf8')); // 已 flush，不应抛错
}

// ── 4. 多字节字符被 chunk 劈开 ─────────────────────────────────
group('流式 · 跨 chunk 的多字节字符');
{
  const line = '中文输出：完成\n';
  const bytes = Buffer.from(line, 'utf8');
  let out = '';
  const d = CE.createConsoleStreamDecoder({ platform: 'win32', onText: (t) => { out += t; } });
  for (let i = 0; i < bytes.length; i++) d.push(bytes.subarray(i, i + 1)); // 逐字节喂
  d.flush();
  eq(out, line, '逐字节喂入仍还原整行');
  eq(countFffd(out), 0, '无替换符');
}

// ── 5. 非 Windows 不兜底 GBK ──────────────────────────────────
group('非 win32 · 不做 GBK 误判');
{
  const linux = CE.decodeConsoleBuffer(CMD_MSG_GBK, 'linux');
  ok(countFffd(linux) > 0, 'linux 上走 lossy UTF-8（有替换符），不当 GBK 猜');
  eq(CE.decodeConsoleBuffer(Buffer.from(U8_LINE, 'utf8'), 'linux'), U8_LINE, 'linux 上 UTF-8 照常');
}

// ── 6. 超长单行（无换行）强制吐出 ─────────────────────────────
group('流式 · 超长单行不劈坏字符');
{
  const chunk = '汉'.repeat(30000); // 90000 字节 > MAX_PENDING_BYTES
  const bytes = Buffer.from(chunk, 'utf8');
  let out = '';
  const d = CE.createConsoleStreamDecoder({ platform: 'win32', onText: (t) => { out += t; } });
  d.push(bytes);
  d.flush();
  eq(out.length, chunk.length, '字符数完整');
  eq(countFffd(out), 0, '无替换符（切点落在 ASCII 边界）');
  ok(out === chunk, '内容一致');
}

// ── 7. run_shell 输出格式：编码提示 + 常规字段 ─────────────────
group('run_shell · 结果格式化');
{
  const fs = require('fs');
  const SRC = fs.readFileSync(path.join(__dirname, 'assets/js/03-node-tools.js'), 'utf8');
  const factory = new Function('pgpyMode', 'nodeRuntime', 'window', 'document', SRC +
    '\n;return { pgpyFormatRunResult: pgpyFormatRunResult, run_shell: run_shell };');
  const T = factory('node', { ready: true }, {}, {});
  const text = T.pgpyFormatRunResult(
    { dir: 'C:/ws', written: 1, skipped: 2, removed: 0 },
    'head -1',
    { code: 1, durationMs: 12, stdout: '', stderr: CMD_MSG, encodingHint: '输出中有 1 段既非 UTF-8 也非 GB18030' }
  );
  ok(text.indexOf(CMD_MSG) !== -1, 'stderr 原样进入结果');
  ok(/\[编码提示\]/.test(text), '带上编码提示');
  ok(/退出码：1/.test(text), '带退出码');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} console-encoding: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
