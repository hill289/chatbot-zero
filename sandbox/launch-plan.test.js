/*!
 * sandbox/launch-plan.test.js — 沙箱启动计划自检（零依赖）
 * 重点回归：打包成 asar 后，win-job.ps1 / macos-profile.sb 必须解析到
 * 「真实磁盘路径」，不能是 app.asar 归档内部路径（否则 powershell -File 报“文件不存在”）。
 * 运行： node sandbox/launch-plan.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./index.js');

let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.error('  ✗ ' + m)); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }
const isAsarArchivePath = (p) => /app\.asar[\\/]/.test(p); // 注意：app.asar.unpacked 不含 "app.asar/"

group('policy / off 直接执行');
{
  const p = S.buildLaunchPlan({ command: 'echo hi', cwd: os.tmpdir(), cfg: { mode: 'policy' }, platform: 'win32' });
  eq(p.meta.level, 'policy', 'policy 级别');
  eq(p.shell, true, 'policy 用 shell');
  eq(p.file, 'echo hi', 'policy file 即命令本身');
  const off = S.buildLaunchPlan({ command: 'echo hi', cwd: os.tmpdir(), cfg: { enabled: false }, platform: 'win32' });
  eq(off.meta.level, 'policy', 'enabled=false → policy');
}

group('win32 走 Job Object（win-job）');
{
  const p = S.buildLaunchPlan({ command: 'echo hi', cwd: os.tmpdir(), cfg: { mode: 'auto' }, platform: 'win32' });
  eq(p.meta.level, 'win-job', 'auto 模式级别');
  ok(/powershell\.exe$/i.test(p.file), '启动 powershell.exe');
  eq(p.shell, false, '不用 shell（直接 spawn）');
  const i = p.args.indexOf('-File');
  ok(i >= 0, '参数含 -File');
  const script = p.args[i + 1];
  ok(fs.existsSync(script), '-File 指向的脚本真实存在');
  ok(!isAsarArchivePath(script), '-File 不在 app.asar 归档内（关键回归）');
  ok(p.args.some((a) => a === '-CommandB64'), '命令走 Base64 传递');
}

group('resolveScriptPath：开发态 / asar 归档 / unpacked');
{
  // 开发态：sandbox/ 目录下真实存在
  const dev = S.resolveScriptPath('win-job.ps1');
  ok(dev && fs.existsSync(dev) && !isAsarArchivePath(dev), '开发态返回真实路径');

  // 模拟打包：位于 app.asar 归档内部 → 必须复制到 asar 之外
  const base = path.join(os.tmpdir(), 'lp-asar-' + process.pid, 'app.asar', 'sandbox');
  fs.mkdirSync(base, { recursive: true });
  const content = '# fake ps1\nparam()\n';
  fs.writeFileSync(path.join(base, 'win-job.ps1'), content);
  const out = S.resolveScriptPath('win-job.ps1', base);
  ok(out && !isAsarArchivePath(out), 'asar 内脚本被解析到归档之外');
  ok(fs.existsSync(out), '复制后的脚本存在');
  eq(fs.readFileSync(out, 'utf8'), content, '复制内容一致');

  // 模拟 asarUnpack：app.asar.unpacked 优先（无需复制）
  const up = path.join(os.tmpdir(), 'lp-unpacked-' + process.pid, 'app.asar.unpacked', 'sandbox');
  fs.mkdirSync(up, { recursive: true });
  fs.writeFileSync(path.join(up, 'win-job.ps1'), '# unpacked\n');
  const fromAsar = path.join(os.tmpdir(), 'lp-unpacked-' + process.pid, 'app.asar', 'sandbox');
  const out2 = S.resolveScriptPath('win-job.ps1', fromAsar);
  eq(out2, path.join(up, 'win-job.ps1'), 'unpacked 路径优先复用');

  // 不存在的脚本 → null
  const empty = path.join(os.tmpdir(), 'lp-empty-' + process.pid);
  fs.mkdirSync(empty, { recursive: true });
  eq(S.resolveScriptPath('nope.ps1', empty), null, '缺失脚本返回 null');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
