#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
 *  scripts/clean-workspace-junk.js —— 清理工作区里的「运行期垃圾」
 *
 *  背景：
 *    run_shell / run_tests 会把工作区物化到真实目录后执行命令，沙箱
 *    (sandbox/index.js redirectHome) 会把 TMP/TEMP/TMPDIR 指向 <ws>/.tmp、
 *    HOME 指向 <ws>/.home；Node/npm/测试还会生成 node-compile-cache、
 *    .sandbox 审计等。这些都是「执行副作用」，不是项目内容。
 *
 *    正常链路里它们已被三处过滤（文件树/物化/导出用 PGPY_INTERNAL_DIRS、
 *    物化用 main.js isInternalRunRel、回收用 run-collect.js 的忽略规则），
 *    本脚本用于清理「历史遗留」或「手工误入」的这些目录。
 *
 *  用法：
 *    node scripts/clean-workspace-junk.js [目标目录] [--dry-run]
 *      · 目标目录缺省：环境变量 CHATBOT_WORKSPACE，否则 /home/pyodide
 *      · --dry-run 只统计不删除
 *
 *  这些名字与以下三处保持一致，改动时请同步：
 *    renderer/assets/js/15-pgpy-runtime.js  PGPY_INTERNAL_DIRS
 *    main.js                                isInternalRunRel
 *    renderer/run-collect.js                DEFAULT_IGNORED_DIRS
 * ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 沙箱/运行时会在工作区根下生成的垃圾目录（整棵删除）
const JUNK_DIRS = ['.tmp', '.home', '.sandbox', '.spill', 'node-compile-cache'];
// 运行期清单 / 性能采样等散落文件
const JUNK_FILES = ['.chatbot-run-manifest.json', 'default.profraw'];

function dirSize(p) {
  try {
    const st = fs.lstatSync(p);
    if (st.isFile()) return st.size;
    if (st.isDirectory()) {
      return fs.readdirSync(p).reduce((n, f) => n + dirSize(path.join(p, f)), 0);
    }
  } catch (_) { /* 忽略 */ }
  return 0;
}

function clean(target, opts) {
  opts = opts || {};
  const dry = !!opts.dryRun;
  const t = path.resolve(target || '.');
  const removed = [];
  let bytes = 0;

  const rm = (p, recursive) => {
    if (dry) return;
    try { fs.rmSync(p, { recursive: !!recursive, force: true }); }
    catch (e) { console.error('清理失败 ' + p + '：' + e.message); }
  };

  for (const name of JUNK_DIRS) {
    const p = path.join(t, name);
    try { if (!fs.existsSync(p)) continue; } catch (_) { continue; }
    bytes += dirSize(p);
    removed.push(name + '/');
    rm(p, true);
  }
  for (const name of JUNK_FILES) {
    const p = path.join(t, name);
    try { if (!fs.existsSync(p)) continue; } catch (_) { continue; }
    bytes += dirSize(p);
    removed.push(name);
    rm(p, false);
  }
  return { target: t, dryRun: dry, removed, bytes };
}

module.exports = { clean, JUNK_DIRS, JUNK_FILES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const target = args.find((a) => !a.startsWith('--')) || process.env.CHATBOT_WORKSPACE || '/home/pyodide';
  const r = clean(target, { dryRun });
  const mb = (r.bytes / 1024 / 1024).toFixed(1);
  if (!r.removed.length) {
    console.log('✓ 干净：未发现运行期垃圾（' + r.target + '）');
  } else {
    console.log((r.dryRun ? '（dry-run）将清理 ' : '✓ 已清理 ') + r.removed.length +
      ' 项 / 约 ' + mb + ' MB（' + r.target + '）：');
    r.removed.forEach((x) => console.log('  - ' + x));
  }
}
