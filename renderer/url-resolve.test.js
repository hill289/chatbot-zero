/* url-resolve.test.js — 内置浏览器「地址 → URL」纯逻辑单测
 * 覆盖：VFS 路径识别（修复「浏览器浏览 vfs 的文件无法找到」）、
 *       vfs:// ↔ VFS 路径互转（含中文/空格/编码安全性）、
 *       归一化、MIME、目录页 HTML 转义（防注入）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const UrlResolve = require('./url-resolve.js');

// ── resolveBrowserInput：VFS 路径必须解析成 vfs://（本修复的核心行为）──────
test('resolveBrowserInput：/home/pyodide/... → vfs://（不再错转 file://）', () => {
  assert.deepStrictEqual(
    UrlResolve.resolveBrowserInput('/home/pyodide/index.html'),
    { kind: 'vfs', url: 'vfs://home/pyodide/index.html' }
  );
  assert.strictEqual(UrlResolve.resolveBrowserInput('/home/pyodide').kind, 'vfs');
  // 反斜杠 + ./ 噪声也认
  assert.strictEqual(UrlResolve.resolveBrowserInput('/home/pyodide/./a b/x.txt').url,
    'vfs://home/pyodide/a%20b/x.txt');
});

test('resolveBrowserInput：非 VFS 的 POSIX 绝对路径仍是磁盘路径（交给 file://）', () => {
  assert.deepStrictEqual(UrlResolve.resolveBrowserInput('/etc/hosts'), { kind: 'disk', path: '/etc/hosts' });
  assert.deepStrictEqual(UrlResolve.resolveBrowserInput('C:\\Temp\\a.txt'), { kind: 'disk', path: 'C:\\Temp\\a.txt' });
  // 前缀近似但不命中 VFS 根（/home/pyodidefile）
  assert.strictEqual(UrlResolve.resolveBrowserInput('/home/pyodidefile').kind, 'disk');
});

test('resolveBrowserInput：已带协议原样放行 / 域名 / 搜索 / 空输入', () => {
  assert.deepStrictEqual(UrlResolve.resolveBrowserInput('https://example.com/a?b=1'),
    { kind: 'raw', url: 'https://example.com/a?b=1' });
  assert.deepStrictEqual(UrlResolve.resolveBrowserInput('about:blank'), { kind: 'raw', url: 'about:blank' });
  assert.deepStrictEqual(UrlResolve.resolveBrowserInput('example.com/x'), { kind: 'web', url: 'https://example.com/x' });
  assert.strictEqual(UrlResolve.resolveBrowserInput('  ').kind, 'empty');
  const s = UrlResolve.resolveBrowserInput('中文 搜索');
  assert.strictEqual(s.kind, 'search');
  assert.ok(s.url.includes(encodeURIComponent('中文 搜索')));
});

test('resolveBrowserInput：直接输入 vfs:// 也规范化；坏 URL 退化为搜索而非静默失败', () => {
  assert.deepStrictEqual(
    UrlResolve.resolveBrowserInput('vfs://home/pyodide/./a.txt?x=1#y'),
    { kind: 'vfs', url: 'vfs://home/pyodide/a.txt' }
  );
  // 越界 vfs://etc/passwd → 非法，退化为搜索
  assert.strictEqual(UrlResolve.resolveBrowserInput('vfs://etc/passwd').kind, 'search');
});

// ── toVfsUrl / vfsPathFromUrl：互为逆变换 ────────────────────────────────
test('toVfsUrl / vfsPathFromUrl 往返一致（含中文、空格、#、%）', () => {
  const paths = [
    '/home/pyodide',
    '/home/pyodide/a.txt',
    '/home/pyodide/中文 目录/文件 #1 (草稿).md',
    '/home/pyodide/100%done/.hidden'
  ];
  for (const p of paths) {
    const url = UrlResolve.toVfsUrl(p);
    assert.ok(url.startsWith('vfs://home/'), url);
    assert.strictEqual(UrlResolve.vfsPathFromUrl(url), p);
  }
  // 根目录带尾斜杠（浏览器按目录处理）
  assert.strictEqual(UrlResolve.toVfsUrl('/home/pyodide'), 'vfs://home/pyodide/');
});

test('vfsPathFromUrl：非 vfs 协议 / 越界 / 非法编码 → null', () => {
  assert.strictEqual(UrlResolve.vfsPathFromUrl('https://home/pyodide/a'), null);
  assert.strictEqual(UrlResolve.vfsPathFromUrl('file:///home/pyodide/a'), null);
  assert.strictEqual(UrlResolve.vfsPathFromUrl('vfs://etc/passwd'), null);
  assert.strictEqual(UrlResolve.vfsPathFromUrl('vfs://home/other/a'), null);
  assert.strictEqual(UrlResolve.vfsPathFromUrl('vfs://home/%zz'), null); // 非法百分号编码
});

// ── 归一化 / 拼接 ─────────────────────────────────────────────────────────
test('normalizeVfsPath：折叠 //、解析 . 与 ..、反斜杠', () => {
  assert.strictEqual(UrlResolve.normalizeVfsPath('home//pyodide/./a/../b.txt'), '/home/pyodide/b.txt');
  assert.strictEqual(UrlResolve.normalizeVfsPath('\\home\\pyodide\\x'), '/home/pyodide/x');
  assert.strictEqual(UrlResolve.normalizeVfsPath('/../etc'), '/etc'); // 越界 pop 到根外也没事（isVfsPath 会拦）
  assert.strictEqual(UrlResolve.normalizeVfsPath(''), '');
});

test('joinVfsPath：基路径 + 相对段', () => {
  assert.strictEqual(UrlResolve.joinVfsPath('/home/pyodide/sub', 'a/b.txt'), '/home/pyodide/sub/a/b.txt');
  assert.strictEqual(UrlResolve.joinVfsPath('/home/pyodide', '/abs/x'), '/home/pyodide/abs/x');
  assert.strictEqual(UrlResolve.joinVfsPath('/home/pyodide', ''), '/home/pyodide');
});

// ── MIME / HTML ───────────────────────────────────────────────────────────
test('mimeFromVPath：常见类型 + 未知回落 octet-stream', () => {
  assert.ok(UrlResolve.mimeFromVPath('/home/pyodide/a.html').startsWith('text/html'));
  assert.strictEqual(UrlResolve.mimeFromVPath('/home/pyodide/a.png'), 'image/png');
  assert.strictEqual(UrlResolve.mimeFromVPath('/home/pyodide/a.pdf'), 'application/pdf');
  assert.strictEqual(UrlResolve.mimeFromVPath('/home/pyodide/a.xyz'), 'application/octet-stream');
});

test('renderDirectoryHtml：目录排序 + 链接编码 + 名称转义（防注入）', () => {
  const html = UrlResolve.renderDirectoryHtml('/home/pyodide/sub', [
    { name: 'b.txt', isDir: false, size: 2048 },
    { name: '<img src=x onerror=alert(1)>', isDir: false, size: 1 },
    { name: 'dir1', isDir: true, size: 0 }
  ]);
  assert.ok(html.includes('vfs://home/pyodide/sub/dir1'));            // 目录在前 + 链接可点
  assert.ok(html.includes('vfs://home/pyodide/sub/b.txt'));
  assert.ok(!html.includes('<img src=x onerror'), '文件名必须被转义');
  assert.ok(html.includes('&lt;img'));                                // 转义后才安全
  assert.ok(html.includes('2.0 KB'));
  // 非根目录要有 ../ 返回链接；根目录不带
  assert.ok(UrlResolve.renderDirectoryHtml('/home/pyodide/sub', []).includes('../'));
  assert.ok(!UrlResolve.renderDirectoryHtml('/home/pyodide', []).includes(' ../'));
});

test('renderVfsErrorHtml：详情被转义，不注入脚本', () => {
  const html = UrlResolve.renderVfsErrorHtml('无法找到该文件', '<script>alert(1)</script>');
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
