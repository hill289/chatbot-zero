/* watchdog-core 单测（node --test） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('./watchdog-core.js');

const NOW = 1_000_000_000_000; // 固定时基，避免 flaky

function worker(over) {
  return Object.assign({ id: 1, status: 'running', lastProgressAt: NOW - 1000 }, over);
}
function task(over) {
  return Object.assign({ id: 't1', status: 'running', stage: 'executing' }, over);
}

test('no worker -> healthy no-worker', () => {
  const r = core.assess(null, null, { now: NOW });
  assert.equal(r.healthy, true);
  assert.equal(r.code, 'no-worker');
  assert.equal(r.action, 'none');
});

test('worker missing status -> healthy no-worker', () => {
  const r = core.assess({ status: 'missing' }, task(), { now: NOW });
  assert.equal(r.healthy, true);
  assert.equal(r.code, 'no-worker');
});

test('task done -> healthy inactive', () => {
  const r = core.assess(worker(), task({ status: 'done' }), { now: NOW });
  assert.equal(r.healthy, true);
  assert.equal(r.code, 'inactive');
});

test('task paused -> healthy inactive', () => {
  const r = core.assess(worker(), task({ stage: 'paused' }), { now: NOW });
  assert.equal(r.healthy, true);
  assert.equal(r.code, 'inactive');
});

test('healthy running worker with fresh progress', () => {
  const r = core.assess(worker({ lastProgressAt: NOW - 1000 }), task(), { now: NOW });
  assert.equal(r.healthy, true);
  assert.equal(r.code, 'ok');
});

test('no-progress -> unhealthy interrupt', () => {
  const w = worker({ status: 'running', lastProgressAt: NOW - 200000 });
  const r = core.assess(w, task(), { now: NOW, stallMs: 90000 });
  assert.equal(r.healthy, false);
  assert.equal(r.code, 'no-progress');
  assert.equal(r.action, 'interrupt');
  assert.equal(r.severity, 'warn');
});

test('no-progress uses lastActivityAt fallback', () => {
  const w = worker({ lastProgressAt: undefined, lastActivityAt: NOW - 300000 });
  const r = core.assess(w, task(), { now: NOW, stallMs: 60000 });
  assert.equal(r.code, 'no-progress');
});

test('idle worker never flagged as no-progress', () => {
  const w = worker({ status: 'idle', lastProgressAt: NOW - 300000 });
  const r = core.assess(w, task(), { now: NOW, stallMs: 60000 });
  assert.equal(r.healthy, true);
  assert.equal(r.code, 'ok');
});

test('infra fatal -> unhealthy escalate (highest priority)', () => {
  const w = worker({ status: 'running', lastProgressAt: NOW - 300000, infra: { fatal: true, reason: 'api 500' } });
  const r = core.assess(w, task(), { now: NOW, stallMs: 60000 });
  assert.equal(r.healthy, false);
  assert.equal(r.code, 'infra-failure');
  assert.equal(r.action, 'escalate');
  assert.equal(r.severity, 'error');
});

test('infra recent error within window -> escalate', () => {
  const w = worker({ lastErrorAt: NOW - 10000 });
  const r = core.assess(w, task(), { now: NOW, infraErrorWindowMs: 120000 });
  assert.equal(r.code, 'infra-failure');
});

test('old error outside window -> not infra', () => {
  const w = worker({ lastErrorAt: NOW - 999999, lastProgressAt: NOW - 1000 });
  const r = core.assess(w, task(), { now: NOW, infraErrorWindowMs: 120000 });
  assert.equal(r.healthy, true);
});

test('toolErrorStreak over threshold -> escalate', () => {
  const w = worker({ toolErrorStreak: 4 });
  const r = core.assess(w, task(), { now: NOW, maxToolErrorStreak: 3 });
  assert.equal(r.code, 'infra-failure');
});

test('deviation signal -> unhealthy send', () => {
  const r = core.assess(worker({ lastProgressAt: NOW - 1000 }), task(), {
    now: NOW, deviation: { detected: true, reason: '在做无关的事' }
  });
  assert.equal(r.healthy, false);
  assert.equal(r.code, 'deviation');
  assert.equal(r.action, 'send');
});

test('assessAll returns only unhealthy issues', () => {
  const snaps = [
    { worker: worker({ id: 1, lastProgressAt: NOW - 1000 }), task: task({ id: 'a' }) },
    { worker: worker({ id: 2, lastProgressAt: NOW - 300000 }), task: task({ id: 'b' }) }
  ];
  const issues = core.assessAll(snaps, { now: NOW, stallMs: 90000 });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].workerId, 2);
  assert.equal(issues[0].code, 'no-progress');
});

test('DEFAULTS exposed and sane', () => {
  assert.ok(core.DEFAULTS.stallMs > 0);
  assert.ok(core.DEFAULTS.maxToolErrorStreak >= 1);
});
