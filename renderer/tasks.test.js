/* renderer/tasks.test.js —— 任务中心纯逻辑单测（node --test） */
const test = require('node:test');
const assert = require('node:assert');
const T = require('./tasks.js');

test('创建任务：默认进入 planning，可序列化往返', () => {
  const t = T.createTask('把项目依赖升级到最新');
  assert.strictEqual(t.stage, 'planning');
  assert.strictEqual(t.status, 'running');
  const back = T.deserialize(JSON.parse(JSON.stringify(T.serialize(t))));
  assert.strictEqual(back.goal, t.goal);
  assert.strictEqual(back.stage, 'planning');
  assert.ok(back.id);
});

test('步骤：新增 / 状态流转 / 找下一个待办', () => {
  const t = T.createTask('x');
  const a = T.addStep(t, '读代码');
  const b = T.addStep(t, '改代码');
  assert.strictEqual(T.nextPendingStep(t).id, a.id);
  T.setStep(t, a.id, 'done');
  assert.strictEqual(T.nextPendingStep(t).id, b.id);
  T.setStep(t, b.id, 'running');
  assert.strictEqual(T.nextPendingStep(t).id, b.id);
});

test('lineDiff：统计与上下文折叠', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng';
  const after = 'a\nb\nc\nD\ne\nf\ng';
  const d = T.lineDiff(before, after);
  assert.strictEqual(d.add, 1);
  assert.strictEqual(d.del, 1);
  assert.ok(d.text.includes('-d'));
  assert.ok(d.text.includes('+D'));
});

test('lineDiff：超大文件降级为统计，不卡死', () => {
  const before = Array.from({ length: 1200 }, (_, i) => 'line' + i).join('\n');
  const after = Array.from({ length: 1200 }, (_, i) => 'LINE' + i).join('\n');
  const d = T.lineDiff(before, after);
  assert.strictEqual(d.truncated, true);
  assert.ok(d.text.indexOf('文件过大') !== -1);
});

test('产物归并：同一路径累计增删行', () => {
  const t = T.createTask('x');
  T.recordChange(t, '/home/pyodide/a.js', 'a\nb', 'a\nB');
  T.recordChange(t, '/home/pyodide/a.js', 'a\nB', 'a\nB\nc');
  assert.strictEqual(t.artifacts.length, 1);
  assert.strictEqual(t.artifacts[0].changes, 2);
  assert.strictEqual(t.artifacts[0].add, 2);
  assert.strictEqual(t.artifacts[0].del, 1);
  assert.strictEqual(T.guessKind('a.js'), 'code');
});

test('三段式：planning → 首次工具调用 → executing', () => {
  const t = T.createTask('x');
  T.advance(t, { type: 'plan', steps: [{ title: 'A' }, { title: 'B' }] });
  assert.strictEqual(t.steps.length, 2);
  assert.strictEqual(t.stage, 'planning');
  T.advance(t, { type: 'tool', name: 'read_file' });
  assert.strictEqual(t.stage, 'executing');
  assert.strictEqual(t.steps[0].status, 'running');
});

test('验证通过 → done；测试失败 → 回 executing 并记笔记', () => {
  const t = T.createTask('x');
  T.addStep(t, 'A');
  T.advance(t, { type: 'tool', name: 'write_file', path: '/a.js', before: '', after: 'x' });
  T.advance(t, { type: 'verify', evidence: { tests: { ok: true, passed: 12, failed: 0 } } });
  assert.strictEqual(t.stage, 'done');
  assert.strictEqual(t.status, 'done');

  const t2 = T.createTask('y');
  T.addStep(t2, 'A');
  T.advance(t2, { type: 'tool', name: 'write_file', path: '/a.js', before: '', after: 'x' });
  T.advance(t2, { type: 'verify', evidence: { tests: { ok: false, passed: 3, failed: 2 } } });
  assert.strictEqual(t2.stage, 'executing');
  assert.strictEqual(t2.attempts, 1);
  assert.ok(t2.notes[0].text.includes('测试失败 2 项'));
});

test('连续失败达到上限 → failed', () => {
  const t = T.createTask('z', { maxAttempts: 2 });
  T.advance(t, { type: 'verify', evidence: { diagnostics: { errors: 3 } } });
  assert.strictEqual(t.attempts, 1);
  assert.strictEqual(t.stage, 'executing');
  T.advance(t, { type: 'verify', evidence: { diagnostics: { errors: 3 } } });
  assert.strictEqual(t.stage, 'failed');
  assert.strictEqual(t.status, 'failed');
});

test('中断 → interrupted（paused），恢复 → executing 且带上一步提示', () => {
  const t = T.createTask('w');
  const a = T.addStep(t, '改配置');
  T.setStep(t, a.id, 'running');
  T.advance(t, { type: 'interrupt' });
  assert.strictEqual(t.stage, 'interrupted');
  assert.strictEqual(t.status, 'paused');
  assert.ok(T.resumePrompt(t).includes('中断恢复'));
  T.advance(t, { type: 'resume' });
  assert.strictEqual(t.stage, 'executing');
  assert.strictEqual(t.status, 'running');
  assert.ok(t.notes.some(n => n.stage === 'resume'));
});

test('从工具结果提取证据：测试计数 / 诊断错误数', () => {
  const ev = T.evidenceFromToolResult('run_tests', 'ℹ tests 10\nℹ pass 9\nℹ fail 1');
  assert.ok(ev.tests);
  assert.strictEqual(ev.tests.failed, 1);
  const ev2 = T.evidenceFromToolResult('run_shell', 'src/a.ts:3:1 - error TS2304: 2 errors');
  assert.ok(ev2.diagnostics);
  assert.strictEqual(ev2.diagnostics.errors, 2);
});

test('阶段指令与摘要：planning/executing 文案不同，摘要含阶段', () => {
  const t = T.createTask('写报告');
  assert.ok(T.stageDirective(t).includes('todo_write'));
  T.advance(t, { type: 'tool', name: 'read_file' });
  assert.ok(T.stageDirective(t).includes('当前步骤') || T.stageDirective(t).includes('逐步执行'));
  const s = T.summarize(t);
  assert.ok(s.includes('写报告'));
  assert.ok(s.includes('executing'));
});

// ── 执行护栏自动续跑 ─────────────────────────────────────
test('护栏自动续跑：步数上限允许续跑，重复/连续失败不允许', () => {
  const t = T.createTask('长任务');
  assert.strictEqual(t.autoContinues, 0);
  assert.strictEqual(t.maxAutoContinues, 3);

  const ok = T.shouldAutoContinue(t, { kind: 'steps' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.used, 0);
  assert.strictEqual(ok.max, 3);

  assert.strictEqual(T.shouldAutoContinue(t, { kind: 'repeat' }).ok, false);
  assert.strictEqual(T.shouldAutoContinue(t, { kind: 'error' }).ok, false);
  assert.strictEqual(T.shouldAutoContinue(null, { kind: 'steps' }).ok, false);
});

test('护栏自动续跑：guardAbort 记账并保持 running/executing，超上限转人工', () => {
  const t = T.createTask('长任务', { maxAutoContinues: 2 });
  T.addStep(t, 'A');
  T.advance(t, { type: 'tool', name: 'read_file' });
  T.advance(t, { type: 'guardAbort', reason: '达到单轮工具调用上限（30 轮）' });
  assert.strictEqual(t.autoContinues, 1);
  assert.strictEqual(t.stage, 'executing');
  assert.strictEqual(t.status, 'running');
  assert.ok(t.lastAutoContinue > 0);
  assert.ok(t.notes.some(n => n.stage === 'guard' && n.text.includes('自动续跑')));

  assert.strictEqual(T.shouldAutoContinue(t, { kind: 'steps' }).ok, true);
  T.advance(t, { type: 'guardAbort', reason: '再次触顶' });
  assert.strictEqual(t.autoContinues, 2);
  const blocked = T.shouldAutoContinue(t, { kind: 'steps' });
  assert.strictEqual(blocked.ok, false);
  assert.ok(blocked.reason.includes('上限'));
});

test('护栏自动续跑：已完成 / 已暂停任务不再自动续跑，人工 resume 重置预算', () => {
  const done = T.createTask('d');
  T.advance(done, { type: 'finish', ok: true });
  assert.strictEqual(T.shouldAutoContinue(done, { kind: 'steps' }).ok, false);

  const paused = T.createTask('p');
  T.advance(paused, { type: 'pause' });
  assert.strictEqual(T.shouldAutoContinue(paused, { kind: 'steps' }).ok, false);

  const t = T.createTask('r');
  T.advance(t, { type: 'guardAbort', reason: 'x' });
  assert.strictEqual(t.autoContinues, 1);
  T.advance(t, { type: 'resume' });
  assert.strictEqual(t.autoContinues, 0);
});

test('护栏自动续跑：序列化往返保留计数，旧任务补默认值', () => {
  const t = T.createTask('s');
  T.advance(t, { type: 'guardAbort', reason: 'reason' });
  const back = T.deserialize(JSON.parse(JSON.stringify(T.serialize(t))));
  assert.strictEqual(back.autoContinues, 1);
  assert.strictEqual(back.maxAutoContinues, 3);
  assert.strictEqual(back.lastGuardReason, 'reason');

  const legacy = T.deserialize({ goal: 'old', stage: 'executing', status: 'running', steps: [], artifacts: [], notes: [] });
  assert.strictEqual(legacy.autoContinues, 0);
  assert.strictEqual(legacy.maxAutoContinues, 3);
  assert.strictEqual(legacy.lastAutoContinue, 0);
});
