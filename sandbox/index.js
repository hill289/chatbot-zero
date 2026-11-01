/*!
 * sandbox/index.js — 进程级 OS 沙箱（L2）统一注入点
 * -----------------------------------------------------------------------------
 * 对齐 dsh `sandbox/` 的 Service Definition：main.js 只调用 buildLaunchPlan()，
 * 由 provider 决定最终 file/args/env/cwd（Windows = PowerShell + Job Object，
 * 其它平台/未启用 = policy-only 直接 shell）。
 *
 * 设计要点：
 *   · 环境变量清洗：默认剥离敏感键（*_KEY / TOKEN / SECRET / AWS_ / OPENAI_ …）；
 *     配置 envAllowlist 非空时改为严格白名单。
 *   · HOME/TMP 重定向到工作区 .home / .tmp，阻断读 ~/.ssh、~/.npmrc。
 *   · Windows：由 sandbox/win-job.ps1 创建 Job Object（内存/进程数/CPU 限制 +
 *     KILL_ON_JOB_CLOSE），父进程退出即全杀；命令输出按原始字节转发，交由
 *     既有 console-encoding 智能解码。
 *   · 无沙箱后端时降级为 policy（meta.fallback 记录原因），绝不静默裸奔到
 *     不可知的隔离级别（结果里带 meta.level 供 UI 展示）。
 * -----------------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { normalizeConfig } = require('./config');

// 敏感环境变量：默认剥离（避免把 API Key / token 传给模型生成的命令）
const SENSITIVE = /(^|_)(api[_-]?key|secret|token|passwd|password|credential|private[_-]?key|access[_-]?key|npm[_-]?token|aws_|openai_|anthropic_|deepseek_|database_url|db_pass|session[_-]?key|license[_-]?key)/i;

function sandboxEnv(baseEnv, cfg) {
  baseEnv = baseEnv || {};
  const allow = (cfg && cfg.envAllowlist) || [];
  if (allow.length) {
    const out = {};
    for (const k of allow) if (baseEnv[k] != null) out[k] = baseEnv[k];
    return out;
  }
  const out = {};
  for (const k of Object.keys(baseEnv)) {
    if (SENSITIVE.test(k)) continue;
    out[k] = baseEnv[k];
  }
  return out;
}

// 把 HOME / TEMP 指向工作区，降低读用户目录的风险（写权限由 OS 账户决定）
function redirectHome(env, wsDir) {
  try {
    const home = path.join(wsDir, '.home');
    const tmp = path.join(wsDir, '.tmp');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    env.HOME = home;
    if (process.platform === 'win32') env.USERPROFILE = home;
    env.TMPDIR = tmp;
    env.TEMP = tmp;
    env.TMP = tmp;
    env.XDG_CACHE_HOME = path.join(home, '.cache');
    env.XDG_CONFIG_HOME = path.join(home, '.config');
    env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  } catch (_) { /* 忽略：目录创建失败不阻断执行 */ }
  return env;
}

// 沙箱脚本（win-job.ps1 / macos-profile.sb）必须落在「真实磁盘路径」上：
// 应用被打包成 asar 后，这些文件位于 app.asar 归档内部，Node 的 fs 能读，
// 但外部进程（powershell.exe -File / sandbox-exec）无法读取 asar 归档，会报
// 「-File ... \app.asar\sandbox\win-job.ps1 不存在」。
// 解析顺序：
//   1) app.asar.unpacked 下的同名文件（electron-builder asarUnpack 产物，首选）；
//   2) 若仍在 asar 归档内：把只读副本复制到系统临时目录，返回该真实路径
//      （无需重新打包也能工作）；
//   3) 开发态：baseDir 下的原文件。
// baseDir 仅用于测试注入，正式调用省略即 __dirname。
const __scriptCache = Object.create(null);
function resolveScriptPath(name, baseDir) {
  const base = baseDir || __dirname;
  const cacheKey = base + '::' + name;
  if (__scriptCache[cacheKey] !== undefined) return __scriptCache[cacheKey] || null;

  const local = path.join(base, name);
  const inAsar = /app\.asar[\\/]/.test(local); // unpacked 路径里是 "app.asar.unpacked"，不会命中
  const unpacked = local.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const tryPaths = (inAsar && unpacked !== local) ? [unpacked, local] : [local];

  for (const p of tryPaths) {
    try {
      if (!fs.existsSync(p)) continue;
      // unpacked 与开发态都是真实文件，直接可用
      if (!/app\.asar[\\/]/.test(p)) { __scriptCache[cacheKey] = p; return p; }
      // 仍在 asar 归档内 → 复制到临时目录，供外部进程读取
      const content = fs.readFileSync(p);
      const dir = path.join(os.tmpdir(), 'electron-sandbox-scripts');
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, name);
      let same = false;
      try { same = fs.readFileSync(out).equals(content); } catch (_) {}
      if (!same) fs.writeFileSync(out, content);
      __scriptCache[cacheKey] = out;
      return out;
    } catch (_) { /* 尝试下一个候选 */ }
  }
  __scriptCache[cacheKey] = '';
  return null;
}

// Windows PowerShell 可执行文件探测：优先 System32 绝对路径，避免 PATH 缺失/被劫持。
let __pwshPath;
function resolvePowerShell() {
  if (__pwshPath !== undefined) return __pwshPath || 'powershell.exe';
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const abs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.existsSync(abs)) { __pwshPath = abs; return abs; } } catch (_) {}
  __pwshPath = '';
  return 'powershell.exe';
}

/**
 * buildLaunchPlan({ command, cwd, payload, cfg, platform })
 * 返回 { file, args, cwd, shell, env, meta, cleanup }
 */
function buildLaunchPlan(opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const cfg = normalizeConfig(opts.cfg);
  const command = String(opts.command == null ? '' : opts.command);
  const cwd = opts.cwd;
  const baseEnv = Object.assign({}, process.env, (opts.payload && opts.payload.env) || {});
  const env = redirectHome(sandboxEnv(baseEnv, cfg), cwd);

  const meta = {
    enabled: cfg.enabled,
    mode: cfg.mode,
    level: 'policy',
    platform: platform,
    memoryMB: cfg.memoryMB,
    cpuSec: cfg.cpuSec,
    pidsLimit: cfg.pidsLimit,
    allowNetwork: cfg.allowNetwork,
    tokenRestricted: false,
    fallback: null
  };

  const direct = () => ({ file: command, args: [], cwd, shell: true, env, meta, cleanup: () => {} });

  if (!cfg.enabled || cfg.mode === 'off' || cfg.mode === 'policy') return direct();

  if (platform === 'win32') {
    const ps1 = resolveScriptPath('win-job.ps1');
    if (ps1) {
      meta.level = 'win-job';
      const args = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        '-CommandB64', Buffer.from(command, 'utf8').toString('base64'),
        '-WorkDir', cwd,
        '-MemoryMB', String(cfg.memoryMB),
        '-Pids', String(cfg.pidsLimit),
        '-CpuSec', String(cfg.cpuSec)
      ];
      return { file: resolvePowerShell(), args, cwd, shell: false, env, meta, cleanup: () => {} };
    }
    meta.fallback = 'win-job.ps1 not found';
  } else if (platform === 'linux' && fs.existsSync('/usr/bin/bwrap')) {
    // Linux：bubblewrap 只读系统 + 绑定工作区 + 可选禁网
    meta.level = 'bwrap';
    const ws = cwd;
    const args = [
      '--die-with-parent', '--new-session',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--bind', ws, ws, '--chdir', ws,
      '--setenv', 'HOME', path.join(ws, '.home'),
      '--setenv', 'TMPDIR', path.join(ws, '.tmp')
    ];
    if (!cfg.allowNetwork) args.push('--unshare-net');
    args.push('--', '/bin/sh', '-c', command);
    return { file: '/usr/bin/bwrap', args, cwd, shell: false, env, meta, cleanup: () => {} };
  } else if (platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
    // macOS：sandbox-exec（已 deprecated 但可用）——见 sandbox/macos-profile.sb
    const profile = resolveScriptPath('macos-profile.sb');
    if (profile) {
      meta.level = 'sandbox-exec';
      const args = ['-f', profile, '-D', 'WS=' + cwd, '/bin/sh', '-c', command];
      return { file: '/usr/bin/sandbox-exec', args, cwd, shell: false, env, meta, cleanup: () => {} };
    }
    meta.fallback = 'macos-profile.sb not found';
  }

  return direct();
}

// 审计：workspace/<ws>/.sandbox/audit.jsonl
function appendAudit(wsDir, entry) {
  try {
    const dir = path.join(wsDir, '.sandbox');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), JSON.stringify(Object.assign({ ts: Date.now() }, entry || {})) + '\n');
  } catch (_) { /* 忽略 */ }
}

module.exports = { normalizeConfig, sandboxEnv, redirectHome, resolveScriptPath, buildLaunchPlan, appendAudit, SENSITIVE };
