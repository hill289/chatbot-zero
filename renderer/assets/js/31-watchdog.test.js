/* 31-watchdog 单测（真实 watchdog-core + 假快照/作动器/定时器） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const W = require('./31-watchdog.js');
const Core = require('../../watchdog/watchdog-core.js');

const NOW = 1_000_000_000_000;
function worker(over) { return Object.assign({ id: 1, status: 'running', lastProgressAt: NOW - 1000 }, over || {}); }
function task(over) { return Object.assign({ id: 't1', status: 'running', stage: 'executing' }, over || {}); }

test('tick healthy -> no actions, history empty', () => {
  const calls = [];
  const wd = W.createWatchdog({
    core: Core, now: () => NOW,
    snapshots: () => [{ worker: worker(), task: task() }],
    actuator: { interrupt: () => calls.push('int'), send: () => calls.push('send'), escalate: () => calls.push('esc') }
  });
  const r = wd.tick();
  assert.equal(r.issues.length, 0);
  assert.equal(calls.length, 0);
});

test('tick no-progress -> interrupt called', () => {
  const calls = [];
  const wd = W.createWatchdog({
    core: Core, now: () => NOW, assessOpts: { stallMs: 60000 },
    snapshots: () => [{ worker: worker({ lastProgressAt: NOW - 300000 }), task: task() }],
    actuator: { interrupt: (id, reason) => calls.push(['interrupt', id]), send: () => {}, escalate: () => {} }
  });
  const r = wd.tick();
  assert.equal(r.issues.length, 1);
  assert.equal(r.issues[0].code, 'no-progress');
  assert.equal(r.issues[0].did, 'interrupt');
  assert.deepEqual(calls[0], ['interrupt', 1]);
});

test('tick infra-failure -> escalate', () => {
  const calls = [];
  const wd = W.createWatchdog({
    core: Core, now: () => NOW,
    snapshots: () => [{ worker: worker({ infra: { fatal: true } }), task: task() }],
    actuator: { interrupt: () => {}, send: () => {}, escalate: (it) => calls.push('escalate') }
  });
  const r = wd.tick();
  assert.equal(r.issues[0].code, 'infra-failure');
  assert.equal(r.issues[0].did, 'escalate');
  assert.deepEqual(calls, ['escalate']);
});

test('tick deviation -> send', () => {
  const calls = [];
  const wd = W.createWatchdog({
    core: Core, now: () => NOW, assessOpts: { deviation: { detected: true, reason: 'off track' } },
    snapshots: () => [{ worker: worker(), task: task() }],
    actuator: { interrupt: () => {}, send: (id, txt) => calls.push(txt), escalate: () => {} }
  });
  const r = wd.tick();
  assert.equal(r.issues[0].code, 'deviation');
  assert.equal(r.issues[0].did, 'send');
  assert.match(calls[0], /偏离/);
});

test('start/stop toggles running + uses injected timers', () => {
  const timers = [];
  const cleared = [];
  const wd = W.createWatchdog({
    core: Core, now: () => NOW, snapshots: () => [], actuator: {},
    setTimer: (fn, ms) => { timers.push(fn); return timers.length; },
    clearTimer: (t) => cleared.push(t)
  });
  assert.equal(wd.start(), true);
  assert.equal(wd.isRunning(), true);
  assert.equal(wd.start(), false); // 已在跑
  wd.stop();
  assert.equal(wd.isRunning(), false);
  assert.equal(cleared.length, 1);
});

test('history accumulates acted records', () => {
  const wd = W.createWatchdog({
    core: Core, now: () => NOW, assessOpts: { stallMs: 1000 },
    snapshots: () => [{ worker: worker({ lastProgressAt: NOW - 99999 }), task: task() }],
    actuator: { interrupt: () => {} }
  });
  wd.tick(); wd.tick();
  assert.equal(wd.history().length, 2);
});

test('no core -> tick returns empty without throwing', () => {
  const wd = W.createWatchdog({ core: null });
  assert.deepEqual(wd.tick().issues, []);
});
