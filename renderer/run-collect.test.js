/*!
 * run-collect.test.js — 真实执行后「回收」纯逻辑单测
 * 运行：node --test renderer/run-collect.test.js
 *
 * 只验证最危险的判定：哪些文件算「变了」、哪些永远不回收、超限时怎么兜底。
 * 真正的读盘 / 写 vfs 在 main.js / 03-node-tools.js，不在这里。
 */
const test = require('node:test');
const assert = require('node:assert');
const RC = require('./run-collect.js');

test('忽略规则：依赖目录 / 版本库 / 运行清单永不回收', () => {
  assert.strictEqual(RC.isIgnoredRunPath('src/a.js'), false);
  assert.strictEqual(RC.isIgnoredRunPath('./src/app.js'), false);
  assert.strictEqual(RC.isIgnoredRunPath('node_modules/electron/index.js'), true);
  assert.strictEqual(RC.isIgnoredRunPath('packages/x/node_modules/y.js'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.git/config'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.sandbox/audit.jsonl'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.chatbot-run-manifest.json'), true);
  // 工具结果溢出目录 .spill 属于运行期内部产物，永不回收
  assert.strictEqual(RC.isIgnoredRunPath('.spill'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.spill/spill-abc.txt'), true);
  assert.strictEqual(RC.isIgnoredRunPath(''), true);
});

test('忽略规则：构建产物 / 缓存 / 日志 / 临时文件默认不回收', () => {
  // 构建输出目录
  assert.strictEqual(RC.isIgnoredRunPath('dist/app.js'), true);
  assert.strictEqual(RC.isIgnoredRunPath('build/out.min.js'), true);
  assert.strictEqual(RC.isIgnoredRunPath('coverage/lcov.info'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.next/server/page.js'), true);
  // 缓存目录
  assert.strictEqual(RC.isIgnoredRunPath('__pycache__/m.pyc'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.pytest_cache/v/x'), true);
  // 日志 / 临时文件（通配）
  assert.strictEqual(RC.isIgnoredRunPath('debug.log'), true);
  assert.strictEqual(RC.isIgnoredRunPath('a/b/run.tmp'), true);
  assert.strictEqual(RC.isIgnoredRunPath('x/y.pyc'), true);
  assert.strictEqual(RC.isIgnoredRunPath('note.swp'), true);
  assert.strictEqual(RC.isIgnoredRunPath('backup~'), true);
  assert.strictEqual(RC.isIgnoredRunPath('types.tsbuildinfo'), true);
  // 正常源码 / 文档仍要回收
  assert.strictEqual(RC.isIgnoredRunPath('src/app.js'), false);
  assert.strictEqual(RC.isIgnoredRunPath('README.md'), false);
  assert.strictEqual(RC.isIgnoredRunPath('packages/core/index.ts'), false);
});

test('忽略规则：沙箱运行期目录 .tmp / .home / node-compile-cache 永不回收', () => {
  // sandbox/index.js redirectHome 把 TMP/HOME 指到 <ws>/.tmp、<ws>/.home
  assert.strictEqual(RC.isIgnoredRunPath('.tmp'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.tmp/node-compile-cache/ab/cd'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.tmp/jobstore-4wQPkm/job.json'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.home'), true);
  // 关键回归：.home 下的非日志/缓存子路径也必须拦下来（历史上只靠 *.log/.cache 偶然命中）
  assert.strictEqual(RC.isIgnoredRunPath('.home/.config/thing'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.home/.local/share/x'), true);
  assert.strictEqual(RC.isIgnoredRunPath('.home/.npm/_logs/x.log'), true);
  // Node 编译缓存目录（任意层级）
  assert.strictEqual(RC.isIgnoredRunPath('node-compile-cache/v22/x'), true);
  // 正常点文件（如用户项目里的 .env）不应被误伤
  assert.strictEqual(RC.isIgnoredRunPath('.env'), false);
  assert.strictEqual(RC.isIgnoredRunPath('src/.env.local'), false);
});

test('忽略规则：可通过 extraIgnored* 追加自定义规则（默认规则仍在）', () => {
  assert.strictEqual(RC.isIgnoredRunPath('vendor/lib.js', { extraIgnoredDirs: ['vendor'] }), true);
  assert.strictEqual(RC.isIgnoredRunPath('vendor/lib.js'), false); // 未配置时不忽略
  assert.strictEqual(RC.isIgnoredRunPath('data/blob.bin', { extraIgnoredGlobs: ['*.bin'] }), true);
  // 追加不影响默认：node_modules 仍被忽略
  assert.strictEqual(RC.isIgnoredRunPath('node_modules/x/y.js', { extraIgnoredDirs: ['vendor'] }), true);
});

test('忽略规则：ignoredGlobs 覆盖默认通配（替换语义，向后兼容）', () => {
  assert.strictEqual(RC.isIgnoredRunPath('debug.log', { ignoredGlobs: ['*.dat'] }), false);
  assert.strictEqual(RC.isIgnoredRunPath('x.dat', { ignoredGlobs: ['*.dat'] }), true);
});

test('matchGlob：* 与 ? 的通配匹配', () => {
  assert.strictEqual(RC.matchGlob('npm-debug.log.1', 'npm-debug.log*'), true);
  assert.strictEqual(RC.matchGlob('a.log', '*.log'), true);
  assert.strictEqual(RC.matchGlob('a.logx', '*.log'), false);
  assert.strictEqual(RC.matchGlob('ab', 'a?'), true);
  assert.strictEqual(RC.matchGlob('abc', 'a?'), false);
});

test('diffRunDir：新增 / 修改 / 未变 / 删除四类不混淆', () => {
  const manifest = { 'a.js': 'h1', 'b.js': 'h2', 'gone.js': 'h3' };
  const entries = [
    { rel: 'a.js', hash: 'h1' },       // 未变
    { rel: 'b.js', hash: 'h2-changed' }, // 修改
    { rel: 'new.js', hash: 'h4' }      // 新增
  ];
  const d = RC.diffRunDir(manifest, entries);
  assert.deepStrictEqual(d.changed, ['b.js', 'new.js']);
  assert.deepStrictEqual(d.unchanged, ['a.js']);
  assert.deepStrictEqual(d.removed, ['gone.js']);
});

test('diffRunDir：清单里的路径统一成相对路径，避免 / 与 \\ 造成假删除', () => {
  const d = RC.diffRunDir({ 'dir\\a.js': 'h1' }, [{ rel: './dir/a.js', hash: 'h1' }]);
  assert.deepStrictEqual(d.changed, []);
  assert.deepStrictEqual(d.removed, []);
  assert.deepStrictEqual(d.unchanged, ['dir/a.js']);
});

test('selectCollectable：文件数 / 单文件 / 总字节三重限额，超限进 skipped', () => {
  const items = [
    { rel: 'a.txt', size: 10 },
    { rel: 'b.txt', size: 10 },
    { rel: 'big.bin', size: 100 },
    { rel: 'c.txt', size: 10 }
  ];
  const r = RC.selectCollectable(items, { maxFiles: 2, maxFileBytes: 50, maxTotalBytes: 100 });
  assert.deepStrictEqual(r.take, ['a.txt', 'b.txt']);
  assert.deepStrictEqual(r.skipped, ['big.bin', 'c.txt']);
  assert.strictEqual(r.bytes, 20);
});

test('selectCollectable：总字节超限后，后续小文件仍可继续收（不整批放弃）', () => {
  const r = RC.selectCollectable(
    [{ rel: 'x', size: 60 }, { rel: 'y', size: 60 }, { rel: 'z', size: 10 }],
    { maxTotalBytes: 100, maxFileBytes: 1000, maxFiles: 10 }
  );
  assert.deepStrictEqual(r.take, ['x', 'z']);
  assert.deepStrictEqual(r.skipped, ['y']);
});

test('buildNextManifest：收集采用新哈希，删除/超限条目移除，其余保留', () => {
  const next = RC.buildNextManifest(
    { keep: 'k1', mod: 'old', del: 'd1', skip: 's1' },
    { collected: { mod: 'new' }, removed: ['del'], skipped: ['skip'] }
  );
  assert.deepStrictEqual(next, { keep: 'k1', mod: 'new' });
});

test('buildNextManifest：不修改传入的清单对象（纯函数）', () => {
  const manifest = { a: 'h1' };
  RC.buildNextManifest(manifest, { collected: { b: 'h2' }, removed: ['a'] });
  assert.deepStrictEqual(manifest, { a: 'h1' });
});

test('准入白名单 isAdmitted：只放行「已有文件编辑/删除」，陌生新增默认拒绝', () => {
  const baseline = new Set(['src/app.js', 'README.md', 'src/.env']);
  const ctx = { baseline: baseline };
  // 已有文件的修改 / 删除 → 允许（必要的编辑）
  assert.strictEqual(RC.isAdmitted('src/app.js', ctx), true);
  assert.strictEqual(RC.isAdmitted('README.md', ctx), true);
  assert.strictEqual(RC.isAdmitted('src/.env', ctx), true); // 用户已有的点文件仍可编辑
  // 陌生新增（哪怕是“像源码”的名字）→ 默认一律拒绝（与文件名无关的逻辑保证）
  assert.strictEqual(RC.isAdmitted('src/new-feature.js', ctx), false);
  assert.strictEqual(RC.isAdmitted('whatever.js', ctx), false);
  assert.strictEqual(RC.isAdmitted('a/b/c/tmpfile', ctx), false);
  // 已知垃圾无论是否 baseline 永远拒绝（纵深防御）
  assert.strictEqual(RC.isAdmitted('.tmp/x', ctx), false);
  assert.strictEqual(RC.isAdmitted('node_modules/x/y.js', ctx), false);
});

test('准入白名单 isAdmitted：allowNew=true 放行新增，可用 includeGlobs 收窄', () => {
  const baseline = ['src/app.js'];
  // 纯 allowNew：新增放行
  assert.strictEqual(RC.isAdmitted('src/gen.js', { baseline: baseline, allowNew: true }), true);
  // 但已知垃圾即便 allowNew 也拒绝
  assert.strictEqual(RC.isAdmitted('.tmp/x', { baseline: baseline, allowNew: true }), false);
  assert.strictEqual(RC.isAdmitted('.home/.npm/x', { baseline: baseline, allowNew: true }), false);
  // includeGlobs 收窄：只允许 .js
  const ctx = { baseline: baseline, allowNew: true, includeGlobs: ['*.js'] };
  assert.strictEqual(RC.isAdmitted('src/gen.js', ctx), true);
  assert.strictEqual(RC.isAdmitted('src/gen.txt', ctx), false);
  // 路径模式 src/**/*.ts
  const ctx2 = { baseline: baseline, allowNew: true, includeGlobs: ['src/**/*.ts'] };
  assert.strictEqual(RC.isAdmitted('src/a/b/x.ts', ctx2), true);
  assert.strictEqual(RC.isAdmitted('src/a/b/x.js', ctx2), false);
});
