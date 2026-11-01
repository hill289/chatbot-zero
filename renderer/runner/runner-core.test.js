/* runner/runner-core 单测 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const RC = require('./runner-core.js');

test('isResumableTask: done/failed false, others true', () => {
  assert.equal(RC.isResumableTask({ status: 'running', stage: 'executing' }), true);
  assert.equal(RC.isResumableTask({ status: 'running', stage: 'interrupted' }), true);
  assert.equal(RC.isResumableTask({ status: 'done', stage: 'done' }), false);
  assert.equal(RC.isResumableTask({ status: 'failed', stage: 'failed' }), false);
  assert.equal(RC.isResumableTask(null), false);
});

test('selectResumable filters', () => {
  const tasks = [
    { id: 1, status: 'running', stage: 'executing' },
    { id: 2, status: 'done', stage: 'done' },
    { id: 3, status: 'running', stage: 'interrupted' }
  ];
  assert.deepEqual(RC.selectResumable(tasks).map(t => t.id), [1, 3]);
});

test('runner drives until no work', async () => {
  let remaining = 3;
  let saves = 0;
  const runner = RC.createRunner({
    hasWork: () => remaining > 0,
    step: () => { remaining--; },
    save: () => { saves++; }
  });
  const r = await runner.run();
  assert.equal(r.steps, 3);
  assert.equal(r.done, true);
  assert.equal(saves, 3);
});

test('runner respects maxSteps guard', async () => {
  let infinite = true;
  const runner = RC.createRunner({
    hasWork: () => infinite,
    step: () => {},
    maxSteps: 5
  });
  const r = await runner.run();
  assert.equal(r.steps, 5);
  assert.equal(r.hitLimit, true);
  assert.equal(r.done, false);
});

test('runner with no work -> 0 steps done', async () => {
  const runner = RC.createRunner({ hasWork: () => false, step: () => { throw new Error('should not run'); } });
  const r = await runner.run();
  assert.equal(r.steps, 0);
  assert.equal(r.done, true);
});

test('runner without step -> ok:false', async () => {
  const runner = RC.createRunner({ hasWork: () => true });
  const r = await runner.run();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-step');
});

test('step rejection propagates (does not silently swallow)', async () => {
  const runner = RC.createRunner({ hasWork: () => true, step: () => Promise.reject(new Error('boom')) });
  await assert.rejects(() => runner.run(), /boom/);
});
