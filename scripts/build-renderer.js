#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
 *  scripts/build-renderer.js —— 渲染层「覆盖式升级」发布脚本
 *
 *  背景：
 *    electron-builder 会把 renderer 打进 app.asar，改一行就要重新打包；
 *    而 main.js 现在优先加载「可执行文件同级 renderer/」。
 *    所以渲染层（HTML/CSS/JS/静态资源）的升级不需要重新打包安装包，
 *    只要把本脚本产出的目录覆盖到安装目录即可：
 *
 *      npm run build:renderer          # 只编译/复制，不打包
 *      npm run upgrade                 # 先清空目标 renderer，再完整覆盖
 *
 *  目标目录解析顺序（可用 --target 显式指定）：
 *    1) --target <dir>
 *    2) 环境变量 CHATBOT_RENDERER_DIR
 *    3) dist/renderer                （与 win-unpacked 同级；只分发 dist 时的便携目录）
 *    4) <项目根>/renderer 同级的发布副本不复制（源目录本身即运行时目录）
 *
 *  说明：打包后 chatbot-zero.exe 首选加载「dist 同级的 renderer/」（即项目根 renderer/），
 *        因此本机升级通常不需要复制；本脚本主要用于生成「只带 dist 分发」时的
 *        dist/renderer 便携副本。
 *
 *  只做「静态资源复制」，零构建、零依赖；产物附带 renderer-version.json，
 *  便于在安装目录里核对这次覆盖对应哪个版本、什么时候发布的。
 * ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'renderer');

function parseArgs(argv) {
  const out = { target: '', clean: false, dryRun: false, includeTests: false, stamp: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target' || a === '-t') out.target = argv[++i] || '';
    else if (a.startsWith('--target=')) out.target = a.slice('--target='.length);
    else if (a === '--clean') out.clean = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--include-tests') out.includeTests = true;
    else if (a === '--no-version') out.stamp = false;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function printHelp() {
  console.log([
    '用法：node scripts/build-renderer.js [选项]',
    '',
    '  -t, --target <dir>   指定输出的 renderer 目录（覆盖到哪）',
    '      --clean          先删除目标 renderer 再完整复制（默认直接覆盖）',
    '      --dry-run        只统计与打印，不写任何文件',
    '      --include-tests  连 *.test.js 一起复制（默认跳过，部署不需要）',
    '      --no-version     不写 renderer-version.json',
    '  -h, --help           显示帮助',
    '',
    '示例：',
    '  npm run build:renderer                       # 自动发布到 dist/win-unpacked/renderer',
    '  npm run upgrade                              # 清空后完整覆盖',
    '  node scripts/build-renderer.js -t D:/App/renderer',
  ].join('\n'));
}

function detectTarget() {
  if (args.target) return path.resolve(ROOT, args.target);
  if (process.env.CHATBOT_RENDERER_DIR) return path.resolve(process.env.CHATBOT_RENDERER_DIR);

  // 与 win-unpacked 同级：dist/renderer（只分发 dist 时的便携副本）
  const dist = path.join(ROOT, 'dist');
  if (fs.existsSync(dist)) return path.join(dist, 'renderer');
  return path.join(ROOT, 'dist', 'renderer');
}

// 部署时不需要测试文件；其余资源（HTML/CSS/JS/字体/图片/WASM）全部保留
function shouldCopy(rel) {
  if (!rel) return true;
  const norm = rel.replace(/\\/g, '/');
  if (!args.includeTests && /\.test\.js$/i.test(norm)) return false;
  if (!args.includeTests && /\.test\.js\.map$/i.test(norm)) return false;
  if (/(^|\/)\.DS_Store$/i.test(norm)) return false;
  if (/(^|\/)Thumbs\.db$/i.test(norm)) return false;
  return true;
}

function statTree(root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const childRel = rel ? path.join(rel, ent.name) : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, childRel);
      else if (ent.isFile() && shouldCopy(childRel)) {
        files++;
        try { bytes += fs.statSync(full).size; } catch (_) { /* ignore */ }
      }
    }
  };
  walk(root, '');
  return { files, bytes };
}

function readVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch (_) { return '0.0.0'; }
}

function assertSafeTarget(target) {
  const t = path.resolve(target);
  const s = path.resolve(SRC);
  if (t === s) throw new Error('目标目录不能等于源 renderer/');
  if (t.startsWith(s + path.sep)) throw new Error('目标目录不能位于源 renderer/ 之内：' + t);
  if (t === path.parse(t).root) throw new Error('拒绝把整个磁盘根目录当作目标');
  return t;
}

function main() {
  if (args.help) { printHelp(); return; }
  if (!fs.existsSync(path.join(SRC, 'index.html'))) {
    console.error('✗ 源目录不完整：' + SRC + ' 下没有 index.html');
    process.exitCode = 1;
    return;
  }

  const target = assertSafeTarget(detectTarget());
  const { files, bytes } = statTree(SRC);
  const mb = (bytes / 1024 / 1024).toFixed(1);
  console.log('源目录  : ' + SRC);
  console.log('目标目录: ' + target);
  console.log('待复制  : ' + files + ' 个文件 / 约 ' + mb + ' MB' + (args.clean ? '（先清空目标）' : '（直接覆盖）'));

  if (args.dryRun) { console.log('（--dry-run：未写入任何文件）'); return; }

  if (args.clean) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch (err) {
      console.error('✗ 清空目标失败：' + err.message); process.exitCode = 1; return;
    }
  }
  fs.mkdirSync(target, { recursive: true });

  let copied = 0;
  fs.cpSync(SRC, target, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(SRC, src);
      if (!shouldCopy(rel)) return false;
      copied++;
      return true;
    },
  });

  // 版本戳：一眼看出安装目录里的 renderer 是哪次覆盖的
  if (args.stamp) {
    const stamp = {
      version: readVersion(),
      builtAt: new Date().toISOString(),
      source: SRC,
      files,
      bytes,
    };
    try {
      fs.writeFileSync(path.join(target, 'renderer-version.json'), JSON.stringify(stamp, null, 2) + '\n', 'utf8');
    } catch (err) { console.warn('⚠ 写版本戳失败（不影响升级）：' + err.message); }
  }

  const required = ['index.html', 'browser-chrome.html', 'browser-chrome-preload.js', 'assets/js/01-core.js'];
  const missing = required.filter((rel) => !fs.existsSync(path.join(target, rel)));
  if (missing.length) {
    console.error('✗ 覆盖后缺少关键文件：' + missing.join(', '));
    process.exitCode = 1;
    return;
  }

  console.log('✓ 已覆盖 renderer（未打包安装包）。重启应用即生效，或按 Ctrl+R 重载页面。');
  console.log('  校验：' + required.map((r) => (fs.existsSync(path.join(target, r)) ? '✓' : '✗') + r).join('  '));
}

main();
