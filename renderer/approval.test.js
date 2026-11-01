/*!
 * approval.test.js — 工具调用审批闸门（approval.js）单元测试
 * 运行：node --test renderer/approval.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const Approval = require('./approval.js');

// 便捷构造：注入一个「预设回答」的 ask，并记录被问了几次
function makeService(policy, answers) {
  const asked = [];
  const queue = Array.isArray(answers) ? answers.slice() : [answers];
  const svc = Approval.create({
    policy,
    ask(descriptor) {
      asked.push(descriptor);
      const a = queue.length > 1 ? queue.shift() : queue[0];
      return Promise.resolve(typeof a === 'function' ? a(descriptor) : a);
    }
  });
  return { svc, asked };
}

/* ── 策略与匹配 ─────────────────────────────────────────────────────── */

test('默认策略：写/改/删/执行 受管，只读工具不受管', () => {
  const svc = Approval.create({ ask: () => 'deny' });
  ['write_file', 'edit_file', 'replace_lines', 'add_content', 'delete_content', 'delete_file', 'run_shell']
    .forEach(n => assert.strictEqual(svc.isGuarded(n), true, n + ' 应受管'));
  ['read_file', 'list_dir', 'search_content', 'read_url', 'ask_user', 'run_node']
    .forEach(n => assert.strictEqual(svc.isGuarded(n), false, n + ' 不应受管（默认）'));
});

test('enabled=false 时全部放行，且不弹窗', async () => {
  const { svc, asked } = makeService({ enabled: false }, 'deny');
  const v = await svc.guard('run_shell', { command: 'rm -rf /tmp/x' });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.decision, 'disabled');
  assert.strictEqual(asked.length, 0);
});

test('exempt 里的工具即使在 tools 中也不拦', async () => {
  const { svc, asked } = makeService({ tools: ['delete_file'], exempt: ['delete_file'] }, 'deny');
  const v = await svc.guard('delete_file', { file_path: 'a.txt' });
  assert.strictEqual(v.allowed, true);
  assert.strictEqual(v.decision, 'unguarded');
  assert.strictEqual(asked.length, 0);
});

test('tools 传空数组时回退默认列表（防止误配成「全放行」）', () => {
  const p = Approval.normalizePolicy({ tools: [] });
  assert.deepStrictEqual(p.tools, Approval.DEFAULT_TOOLS);
});

test('未知工具加入 tools 后也会被拦（可扩展）', async () => {
  const { svc, asked } = makeService({ tools: ['db_migrate'] }, 'deny');
  const v = await svc.guard('db_migrate', { name: 'users' });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(asked.length, 1);
  assert.ok(asked[0].summary.length > 0);
});

/* ── describe：把调用翻译成人话 ─────────────────────────────────────── */

test('describe(write_file)：目标/行数/预览/高风险', () => {
  const d = Approval.describe('write_file', { file_path: '/a/b.txt', content: 'l1\nl2\nl3\n' });
  assert.strictEqual(d.target, '/a/b.txt');
  assert.strictEqual(d.risk, 'high');
  assert.match(d.summary, /3 行/);
  assert.strictEqual(d.preview, 'l1\nl2\nl3\n');
  assert.ok(d.rows.some(r => r.key === '目标' && r.value === '/a/b.txt'));
});

test('describe(edit_file)：摘要含 old → new，replace_all 影响文案', () => {
  const one = Approval.describe('edit_file', { file_path: 'x.js', old_string: 'foo', new_string: 'bar' });
  assert.match(one.summary, /foo/);
  assert.match(one.summary, /bar/);
  assert.match(one.summary, /首个/);
  const all = Approval.describe('edit_file', { file_path: 'x.js', old_string: 'foo', new_string: 'bar', replace_all: true });
  assert.match(all.summary, /全部/);
  assert.strictEqual(all.previewKind, 'diff');
});

test('describe(delete_file)：目录与文件措辞不同', () => {
  const dir = Approval.describe('delete_file', { file_path: 'dist', file_type: 'folder' });
  assert.match(dir.summary, /递归删除目录/);
  const file = Approval.describe('delete_file', { file_path: 'a.txt', file_type: 'file' });
  assert.match(file.summary, /删除文件/);
  assert.doesNotMatch(file.summary, /递归/);
});

test('describe(run_shell)：target=命令本身，带上 cwd/超时', () => {
  const d = Approval.describe('run_shell', { command: 'npm install', cwd: 'pkg', timeout_ms: 60000 });
  assert.strictEqual(d.target, 'npm install');
  assert.strictEqual(d.preview, 'npm install');
  assert.strictEqual(d.previewKind, 'command');
  assert.ok(d.rows.some(r => r.key === '工作目录' && r.value === 'pkg'));
  assert.ok(d.rows.some(r => r.key === '超时' && r.value === '60000 ms'));
});

test('describe：超长内容被截断，不会把整个文件塞进弹窗', () => {
  const d = Approval.describe('write_file', { file_path: 'big.txt', content: 'x'.repeat(50000) });
  assert.ok(d.preview.length <= 1201, 'preview 应被裁剪到 ~1200 字符，实际 ' + d.preview.length);
  assert.ok(d.preview.endsWith('…'));
});

test('describe：参数不是对象也不崩', () => {
  assert.strictEqual(Approval.describe('write_file', null).target, '');
  assert.strictEqual(Approval.describe('write_file', 'oops').label, '写入文件');
});

/* ── guard：三种决策 ────────────────────────────────────────────────── */

test('allow-once：本次放行，但下次仍要问', async () => {
  const { svc, asked } = makeService({}, 'allow-once');
  const v1 = await svc.guard('write_file', { file_path: 'a.txt', content: 'x' });
  assert.strictEqual(v1.allowed, true);
  assert.strictEqual(v1.decision, 'allow-once');
  const v2 = await svc.guard('write_file', { file_path: 'a.txt', content: 'x' });
  assert.strictEqual(v2.allowed, true);
  assert.strictEqual(asked.length, 2, 'allow-once 不应产生会话级授权');
});

test('allow-session：同一工具后续直接放行，不再弹窗', async () => {
  const { svc, asked } = makeService({}, 'allow-session');
  await svc.guard('write_file', { file_path: 'a.txt', content: 'x' });
  const v2 = await svc.guard('write_file', { file_path: 'b.txt', content: 'y' });
  assert.strictEqual(v2.allowed, true);
  assert.strictEqual(v2.decision, 'allow-session');
  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual(svc.listGrants().map(g => g.scope), ['write_file']);
});

test('allow-session 按工具隔离：授权 write_file 不影响 run_shell', async () => {
  const { svc, asked } = makeService({}, 'allow-session');
  await svc.guard('write_file', { file_path: 'a.txt', content: 'x' });
  const v = await svc.guard('run_shell', { command: 'ls' });
  assert.strictEqual(v.decision, 'allow-session');
  assert.strictEqual(asked.length, 2);
});

test('run_shell 的会话授权按「命令首词」收敛（git 不覆盖 rm）', async () => {
  const { svc, asked } = makeService({}, 'allow-session');
  await svc.guard('run_shell', { command: 'git status' });
  assert.strictEqual(svc.listGrants()[0].scope, 'run_shell::git');

  const same = await svc.guard('run_shell', { command: 'git diff HEAD' });
  assert.strictEqual(same.decision, 'allow-session');
  assert.strictEqual(asked.length, 1, '同为 git 命令应复用授权');

  const other = await svc.guard('run_shell', { command: 'rm -rf build' });
  assert.strictEqual(asked.length, 2, '不同命令首词必须重新审批');
  assert.strictEqual(other.allowed, true); // 预设 allow-session
});

test('deny：带上用户理由，且文案含「勿原样重试」', async () => {
  const { svc } = makeService({}, { decision: 'deny', reason: '这个目录是生产配置，别动' });
  const v = await svc.guard('delete_file', { file_path: '/etc/nginx.conf', file_type: 'file' });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.decision, 'deny');
  assert.match(v.text, /用户拒绝执行/);
  assert.match(v.text, /删除文件/);
  assert.match(v.text, /\/etc\/nginx\.conf/);
  assert.match(v.text, /这个目录是生产配置/);
  assert.match(v.text, /请勿原样重试/);
});

test('deny 不带理由：给默认可读文案，绝不空手而归', async () => {
  const { svc } = makeService({}, 'deny');
  const v = await svc.guard('write_file', { file_path: 'a.txt', content: 'x' });
  assert.strictEqual(v.allowed, false);
  assert.match(v.text, /用户未填写拒绝理由/);
  assert.ok(v.text.length > 40);
});

test('无法识别的答案按拒绝处理（fail-closed）', async () => {
  const { svc } = makeService({}, 'maybe');
  const v = await svc.guard('write_file', { file_path: 'a.txt', content: 'x' });
  assert.strictEqual(v.allowed, false);
  assert.match(v.text, /无法识别的审批结果/);
});

test('没有注入 ask（headless）→ 拒绝而不是静默放行', async () => {
  const svc = Approval.create({});
  const v = await svc.guard('run_shell', { command: 'echo hi' });
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.code, 'no-asker');
  assert.match(v.text, /没有可用的审批界面/);
});

test('ask 抛异常 → 转成拒绝，不把异常抛给工具循环', async () => {
  const svc = Approval.create({ ask: () => { throw new Error('boom'); } });
  const v = await svc.guard('write_file', { file_path: 'a.txt', content: 'x' });
  assert.strictEqual(v.allowed, false);
  assert.match(v.text, /审批流程异常/);
});

test('超时未响应 → 按拒绝处理（含超时理由）', async () => {
  const svc = Approval.create({
    policy: { timeoutMs: 30 },
    ask: () => new Promise(() => {}) // 永不 resolve
  });
  const v = await svc.guard('write_file', { file_path: 'a.txt', content: 'x' });
  assert.strictEqual(v.allowed, false);
  assert.match(v.text, /审批超时/);
});

/* ── 授权管理与审计 ─────────────────────────────────────────────────── */

test('revoke 单个 / 全部', async () => {
  const { svc } = makeService({}, 'allow-session');
  await svc.guard('write_file', { file_path: 'a', content: 'x' });
  await svc.guard('delete_file', { file_path: 'b' });
  assert.strictEqual(svc.listGrants().length, 2);
  svc.revoke('write_file');
  assert.strictEqual(svc.listGrants().length, 1);
  svc.revoke();
  assert.strictEqual(svc.listGrants().length, 0);
  assert.strictEqual(svc.needsApproval('write_file', {}).required, true);
});

test('setPolicy 可在运行中切换（开关审批）', async () => {
  const { svc, asked } = makeService({}, 'deny');
  assert.strictEqual((await svc.guard('write_file', { file_path: 'a', content: 'x' })).allowed, false);
  svc.setPolicy({ enabled: false });
  assert.strictEqual((await svc.guard('write_file', { file_path: 'a', content: 'x' })).allowed, true);
  assert.strictEqual(asked.length, 1, '关闭审批后不应再弹窗');
});

test('审计流水记录决策与被拒理由', async () => {
  const { svc } = makeService({}, [{ decision: 'deny', reason: '不要删' }]);
  await svc.guard('delete_file', { file_path: 'a.txt' });
  const h = svc.getHistory();
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].tool, 'delete_file');
  assert.strictEqual(h[0].decision, 'deny');
  assert.strictEqual(h[0].reason, '不要删');
});

test('审计流水有上限（不会无限增长）', async () => {
  const { svc } = makeService({}, 'allow-once');
  for (let i = 0; i < 230; i++) {
    await svc.guard('write_file', { file_path: 'f' + i, content: 'x' });
  }
  assert.strictEqual(svc.getHistory().length, 200);
});

test('denyMessage 对空描述也不崩', () => {
  const s = Approval.denyMessage(null, '');
  assert.ok(s.indexOf('用户拒绝执行') !== -1);
});
