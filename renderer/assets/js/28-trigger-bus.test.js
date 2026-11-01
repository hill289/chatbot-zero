/* 28-trigger-bus 单测（注入真实 trigger-filter / trigger-router 纯逻辑） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TB = require('./28-trigger-bus.js');
const TF = require('../../trigger/trigger-filter.js');
const TR = require('../../trigger/trigger-router.js');

function makeBus(over) {
  return TB.createTriggerBus(Object.assign({
    filter: TF,
    router: TR,
    rules: {},
    subscriptions: {}
  }, over || {}));
}

test('deny by rules', () => {
  const bus = makeBus({ rules: { denySources: ['mail'] } });
  const r = bus.classify({ source: 'mail', text: 'hi' });
  assert.equal(r.action, 'deny');
});

test('direct when thread subscribed', () => {
  const bus = makeBus({ subscriptions: { 'th-1': ['w1'] } });
  const r = bus.classify({ thread: 'th-1', source: 'im', text: 'x' });
  assert.equal(r.action, 'direct');
  assert.equal(r.workerId, 'w1');
});

test('router (needs semantic) when unsubscribed', () => {
  const bus = makeBus();
  const r = bus.classify({ source: 'fs', path: 'a.js', text: 'changed' });
  assert.equal(r.action, 'router');
  assert.ok(r.prompt && r.prompt.includes('act'));
});

test('ingest with decision.act dispatches via routerSession', () => {
  const spawned = [];
  const routerSession = { dispatch: (spec) => { spawned.push(spec); return { workerId: 9, accepted: true }; } };
  const bus = makeBus({ routerSession });
  const r = bus.ingest({ source: 'fs', text: 'fix it' }, { act: true, workerTask: 'fix the file' });
  assert.equal(r.action, 'dispatched');
  assert.equal(r.workerId, 9);
  assert.equal(spawned[0].task, 'fix the file');
});

test('ingest without decision returns router (needs semantic)', () => {
  const bus = makeBus();
  const r = bus.ingest({ source: 'timer', text: 'tick' });
  assert.equal(r.action, 'router');
});

test('ingest decision.act=false -> stays router', () => {
  const bus = makeBus();
  const r = bus.ingest({ source: 'im', text: 'noise' }, { act: false });
  assert.equal(r.action, 'router');
});

test('direct ingest forwards to worker when hook present', () => {
  const forwarded = [];
  const routerSession = { forwardToWorker: (id, ev) => forwarded.push([id, ev]) };
  const bus = makeBus({ subscriptions: { t: ['w5'] }, routerSession });
  const r = bus.ingest({ thread: 't', source: 'im', text: 'x' });
  assert.equal(r.action, 'direct');
  assert.equal(forwarded[0][0], 'w5');
});

test('speculate spawns via workerPool', () => {
  const spawned = [];
  const workerPool = { spawn: (spec) => { spawned.push(spec); return { workerId: 3, accepted: true }; } };
  const bus = makeBus({ workerPool });
  const r = bus.speculate({ text: 'maybe' });
  assert.equal(r.action, 'speculated');
  assert.equal(r.workerId, 3);
  assert.equal(spawned[0].speculative, true);
});

test('speculate without pool -> none', () => {
  const bus = makeBus();
  assert.equal(bus.speculate({ text: 'x' }).action, 'none');
});
