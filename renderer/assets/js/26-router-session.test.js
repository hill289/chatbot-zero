/* 26-router-session 单测（node --test） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const RS = require('./26-router-session.js');

function tool(name) { return { type: 'function', function: { name } }; }
const TOOLS = [
  tool('read_file'), tool('list_dir'), tool('search_content'),
  tool('run_subagent'), tool('write_file'), tool('run_shell'), tool('edit_file'),
  tool('run_tests'), tool('web_search'), tool('read_url')
];

test('isExecutionTool classifies heavy tools', () => {
  assert.equal(RS.isExecutionTool('run_shell'), true);
  assert.equal(RS.isExecutionTool('write_file'), true);
  assert.equal(RS.isExecutionTool('read_file'), false);
  assert.equal(RS.isExecutionTool('run_subagent'), false);
});

test('filterToolsForModel router removes execution tools', () => {
  const out = RS.filterToolsForModel(TOOLS, 'router');
  const names = out.map(RS.toolNameOf);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('run_subagent'));
  assert.ok(names.includes('web_search'));
  assert.ok(!names.includes('run_shell'));
  assert.ok(!names.includes('write_file'));
  assert.ok(!names.includes('edit_file'));
  assert.ok(!names.includes('run_tests'));
});

test('filterToolsForModel worker returns all tools unchanged', () => {
  const out = RS.filterToolsForModel(TOOLS, 'worker');
  assert.equal(out.length, TOOLS.length);
  assert.ok(out.map(RS.toolNameOf).includes('run_shell'));
});

test('filterToolsForModel undefined role returns copy (not same ref)', () => {
  const out = RS.filterToolsForModel(TOOLS, undefined);
  assert.equal(out.length, TOOLS.length);
  assert.notEqual(out, TOOLS);
});

test('filterToolsForModel non-array safe', () => {
  assert.deepEqual(RS.filterToolsForModel(null, 'router'), []);
});

test('routerToolFilter equals router filter', () => {
  const out = RS.routerToolFilter(TOOLS);
  assert.ok(!out.map(RS.toolNameOf).includes('run_shell'));
});

test('buildWorkerReportText formats status + summary', () => {
  const t = RS.buildWorkerReportText({ workerId: 3, status: 'done', summary: 'ok result' });
  assert.match(t, /Worker #3/);
  assert.match(t, /done/);
  assert.match(t, /ok result/);
});

test('buildWorkerReportText truncates very long summary', () => {
  const t = RS.buildWorkerReportText({ workerId: 1, status: 'running', summary: 'x'.repeat(900) });
  assert.ok(t.length < 700);
  assert.match(t, /…$/);
});

test('RouterSession.dispatch calls workerPool.spawn', () => {
  const calls = [];
  const pool = { spawn: (spec) => { calls.push(spec); return { workerId: 7, accepted: true }; } };
  const rs = RS.createRouterSession({ workerPool: pool });
  const r = rs.dispatch({ task: 'do it' });
  assert.equal(r.workerId, 7);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, 'do it');
});

test('RouterSession.dispatch without pool -> error', () => {
  const rs = RS.createRouterSession({});
  const r = rs.dispatch({ task: 'x' });
  assert.equal(r.accepted, false);
  assert.equal(r.error, 'no-worker-pool');
});

test('onWorkerReport emits integrated message + queues in outbox', () => {
  const emitted = [];
  const rs = RS.createRouterSession({ emit: (m) => emitted.push(m) });
  const msg = rs.onWorkerReport({ workerId: 2, status: 'done', summary: 'finished' });
  assert.equal(msg.role, 'user');
  assert.match(msg.content, /<worker-report>/);
  assert.match(msg.content, /finished/);
  assert.equal(emitted.length, 1);
  const drained = rs.drainReports();
  assert.equal(drained.length, 1);
  assert.equal(rs.drainReports().length, 0); // 已清空
});

test('listWorkers / killWorker delegate when pool present', () => {
  const pool = { list: () => [{ id: 1 }], kill: (id) => id === 1 };
  const rs = RS.createRouterSession({ workerPool: pool });
  assert.equal(rs.listWorkers().length, 1);
  assert.equal(rs.killWorker(1), true);
});
