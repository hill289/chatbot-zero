/* 30-async-tools 单测 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AT = require('./30-async-tools.js');

test('isAsyncTool whitelist', () => {
  assert.equal(AT.isAsyncTool('run_shell'), true);
  assert.equal(AT.isAsyncTool('run_subagent'), true);
  assert.equal(AT.isAsyncTool('read_file'), false);
});

test('start non-async tool rejected', () => {
  const c = AT.createAsyncToolController({ run: () => Promise.resolve('x') });
  const r = c.start('read_file', {});
  assert.equal(r.started, false);
  assert.equal(r.reason, 'not-async-tool');
});

test('start returns immediately then emits done on resolve', async () => {
  let resolveRun;
  const events = [];
  const c = AT.createAsyncToolController({
    run: () => new Promise((res) => { resolveRun = res; }),
    onResult: (e) => events.push(e)
  });
  const r = c.start('run_shell', { command: 'sleep 1' });
  assert.equal(r.started, true);
  assert.ok(r.taskId);
  assert.equal(c.get(r.taskId).status, 'running');
  assert.equal(events.length, 0); // 未阻塞、未立即完成
  resolveRun('exit 0');
  await new Promise(r2 => setTimeout(r2, 0));
  assert.equal(c.get(r.taskId).status, 'done');
  assert.equal(events[0].status, 'done');
  assert.equal(events[0].result, 'exit 0');
});

test('runner reject -> failed event', async () => {
  const events = [];
  const c = AT.createAsyncToolController({
    run: () => Promise.reject(new Error('boom')),
    onResult: (e) => events.push(e)
  });
  const r = c.start('run_tests', {});
  await new Promise(r2 => setTimeout(r2, 0));
  assert.equal(c.get(r.taskId).status, 'failed');
  assert.equal(events[0].status, 'failed');
  assert.match(events[0].error, /boom/);
});

test('stop cancels; late result does not flip to done', async () => {
  let resolveRun;
  const events = [];
  const c = AT.createAsyncToolController({
    run: () => new Promise((res) => { resolveRun = res; }),
    onResult: (e) => events.push(e)
  });
  const r = c.start('run_shell', {});
  assert.equal(c.stop(r.taskId), true);
  resolveRun('late');
  await new Promise(r2 => setTimeout(r2, 0));
  assert.equal(c.get(r.taskId).status, 'cancelled');
  assert.equal(events.length, 0);
});

test('no runner -> start false', () => {
  const c = AT.createAsyncToolController({});
  assert.equal(c.start('run_shell', {}).started, false);
});

test('list returns tasks', () => {
  const c = AT.createAsyncToolController({ run: () => Promise.resolve('x') });
  c.start('run_shell', {});
  assert.equal(c.list().length, 1);
});
