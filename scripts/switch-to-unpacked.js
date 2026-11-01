#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
 *  scripts/switch-to-unpacked.js —— 把已打包的 win-unpacked 从 app.asar
 *  切换成「resources/app 目录」运行（不重新打包，不生成 app.asar）。
 *
 *  背景：
 *    Electron 会优先加载 resources/app.asar；只有它不存在时才用
 *    resources/app 目录。要让 chatbot-zero.exe 直接加载 dist 同级的 renderer/，
 *    必须先把现有安装目录切成「未打包目录」形态。
 *
 *  用法（先关闭 chatbot-zero.exe 再执行；运行中的 exe 会占用 app.asar）：
 *      node scripts/switch-to-unpacked.js            # 准备 resources/app，并尝试移除 app.asar
 *      node scripts/switch-to-unpacked.js --prepare  # 只准备 resources/app，不动 app.asar
 *      node scripts/switch-to-unpacked.js --dir dist/win-unpacked
 *
 *  产物：
 *    resources/app/{main.js, preload.js, fs-grant.js, atomic-write.js, sandbox/}
 *    resources/app/renderer/  仅保留主进程需要的 4 个共享模块（UI 从 dist 同级 renderer/ 加载）
 *    resources/app.asar → 重命名为 app.asar.bak（可回滚）
 * ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const prepareOnly = args.includes('--prepare') || args.includes('--prepare-only');
let appDirRel = 'dist/win-unpacked';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir' || args[i] === '-d') appDirRel = args[++i] || appDirRel;
  else if (args[i].startsWith('--dir=')) appDirRel = args[i].slice('--dir='.length);
}

const PACKED_DIR = path.resolve(ROOT, appDirRel);
const RES = path.join(PACKED_DIR, 'resources');
const ASAR = path.join(RES, 'app.asar');
const ASAR_BAK = path.join(RES, 'app.asar.bak');
const APP = path.join(RES, 'app');
const TMP = path.join(RES, '.app-unpacked-tmp');

const CORE_RENDERER = ['console-encoding.js', 'job-store.js', 'drop-grant.js', 'run-collect.js', 'cdp-core.js'];
const COPY_FROM_ROOT = ['main.js', 'preload.js', 'fs-grant.js', 'atomic-write.js', 'browser-cdp.js', 'package.json'];

function log(msg) { console.log(msg); }
function die(msg) { console.error('✗ ' + msg); process.exitCode = 1; throw new Error(msg); }

function asarBin() {
  const bin = process.platform === 'win32' ? 'asar.cmd' : 'asar';
  const p = path.join(ROOT, 'node_modules', '.bin', bin);
  if (!fs.existsSync(p)) die('找不到 asar CLI：' + p + '（请先 npm install）');
  return p;
}

function extractAsar() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  log('· 解包 app.asar → ' + TMP);
  execFileSync(asarBin(), ['extract', ASAR, TMP], { stdio: 'inherit', shell: process.platform === 'win32' });
}

function copyCoreFiles() {
  for (const f of COPY_FROM_ROOT) {
    const src = path.join(ROOT, f);
    const dst = path.join(TMP, f);
    if (!fs.existsSync(src)) { log('· 跳过不存在：' + f); continue; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  // sandbox 运行脚本必须是真实文件（不能留在 asar 里）
  const sandboxSrc = path.join(ROOT, 'sandbox');
  if (fs.existsSync(sandboxSrc)) {
    fs.rmSync(path.join(TMP, 'sandbox'), { recursive: true, force: true });
    fs.cpSync(sandboxSrc, path.join(TMP, 'sandbox'), { recursive: true, force: true });
  }
}

// 不把整套 renderer 留在 resources/app：只留 main.js 需要的 4 个共享模块。
// 真正的 UI 由 <dist 同级>/renderer 提供（main.js 会优先加载它）。
function pruneRenderer() {
  const r = path.join(TMP, 'renderer');
  fs.rmSync(r, { recursive: true, force: true });
  fs.mkdirSync(r, { recursive: true });
  for (const f of CORE_RENDERER) {
    const src = path.join(ROOT, 'renderer', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(r, f));
  }
}

function main() {
  if (!fs.existsSync(PACKED_DIR)) die('安装目录不存在：' + PACKED_DIR);
  if (!fs.existsSync(RES)) die('resources 目录不存在：' + RES);

  const hasAsar = fs.existsSync(ASAR);
  if (!hasAsar && fs.existsSync(path.join(APP, 'main.js'))) {
    log('✓ 已经是未打包目录形态：' + APP);
    return;
  }
  if (!hasAsar) die('既没有 resources/app.asar，也没有 resources/app/main.js');

  extractAsar();
  copyCoreFiles();
  pruneRenderer();

  fs.rmSync(APP, { recursive: true, force: true });
  fs.renameSync(TMP, APP);
  log('✓ 已生成目录运行形态：' + APP);

  if (prepareOnly) {
    log('（--prepare：未动 app.asar。关闭 chatbot-zero.exe 后重新执行本脚本即可完成切换）');
    return;
  }

  try {
    fs.renameSync(ASAR, ASAR_BAK);
    log('✓ 已移除 app.asar（重命名为 app.asar.bak，可回滚）');
    log('✓ 下次启动 chatbot-zero.exe 将直接使用 resources/app + dist 同级 renderer/');
  } catch (err) {
    log('⚠ 暂时无法移除 app.asar：' + err.message);
    log('  这是正常的——应用正在运行并占用 app.asar。');
    log('  请关闭 chatbot-zero.exe 后重新运行：npm run switch:unpacked');
  }
}

try { main(); } catch (_) { /* die 已设置退出码 */ }
