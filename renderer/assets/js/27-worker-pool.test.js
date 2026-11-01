/* 27-worker-pool 单测（node --test） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const WP = require('./27-worker-pool.js');

function makeFakeStore() {
  let n = 0;
  const wins = [];
  return {
    wins,
    createWindow(title) {
      const id = ++n;
      const win = {
        id: id,
        title: title || '',
        runTask(task, context) {
          return new Promise((resolve, reject) => { win._resolve = resolve; win._reject = reject; });
        }
      };
      wins.push(win);
      return win;
    },
    removeWindow(id) {
      const i = wins.findIndex(w => w.id === id);
      if (i >= 0) wins.splice(i, 1);
    }
  };
}
const tick = () => new Promise(r => setTimeout(r, 0));

test('spawn -> accepted, running, emits running report', () => {
  const store = makeFakeStore();
  const reports = [];
  const pool = WP.createWorkerPool({ store, onReport: r => reports.push(r) });
  const r = pool.spawn({ task: 'do x', title: 'W1' });
  assert.equal(r.accepted, true);
  assert.equal(r.workerId, 1);
  assert.equal(pool.list().length, 1);
  assert.equal(pool.get(1).status, 'running');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'running');
});

test('task resolve -> done report with summary', async () => {
  const store = makeFakeStore();
  const reports = [];
  const pool = WP.createWorkerPool({ store, onReport: r => reports.push(r) });
  pool.spawn({ task: 'do x' });
  store.wins[0]._resolve('the result');
  await tick();
  assert.equal(pool.get(1).status, 'done');
  assert.equal(pool.get(1).lastReport.summary, 'the result');
  const done = reports.find(r => r.status === 'done');
  assert.equal(done.summary, 'the result');
});

test('task reject -> failed report', async () => {
  const store = makeFakeStore();
  const reports = [];
  const pool = WP.createWorkerPool({ store, onReport: r => reports.push(r) });
  pool.spawn({ task: 'do x' });
  store.wins[0]._reject(new Error('boom'));
  await tick();
  assert.equal(pool.get(1).status, 'failed');
  assert.match(pool.get(1).lastReport.summary, /boom/);
});

test('report() updates status and emits', () => {
  const store = makeFakeStore();
  const reports = [];
  const pool = WP.createWorkerPool({ store, onReport: r => reports.push(r) });
  pool.spawn({ task: 'do x' });
  const rep = pool.report(1, { status: 'running', summary: 'step 2 done' });
  assert.equal(rep.workerId, 1);
  assert.equal(reports[reports.length - 1].summary, 'step 2 done');
  assert.equal(pool.get(1).reports, 2); // running(初始) + 本条
});

test('report unknown worker -> null', () => {
  const pool = WP.createWorkerPool({ store: makeFakeStore() });
  assert.equal(pool.report(999, { status: 'done' }), null);
});

test('kill -> status killed + removeWindow called', () => {
  const store = makeFakeStore();
  const pool = WP.createWorkerPool({ store });
  pool.spawn({ task: 'do x' });
  assert.equal(store.wins.length, 1);
  const ok = pool.kill(1);
  assert.equal(ok, true);
  assert.equal(pool.get(1).status, 'killed');
  assert.equal(store.wins.length, 0);
});

test('killed worker does not flip back to done on resolve', async () => {
  const store = makeFakeStore();
  const pool = WP.createWorkerPool({ store });
  pool.spawn({ task: 'do x' });
  const win = store.wins[0];
  pool.kill(1);
  win._resolve('late result');
  await tick();
  assert.equal(pool.get(1).status, 'killed');
});

test('spawn without store -> accepted:false', () => {
  const pool = WP.createWorkerPool({});
  const r = pool.spawn({ task: 'x' });
  assert.equal(r.accepted, false);
  assert.equal(r.error, 'no-store');
});

test('multiple workers are independent', async () => {
  const store = makeFakeStore();
  const pool = WP.createWorkerPool({ store });
  pool.spawn({ task: 'a' });
  pool.spawn({ task: 'b' });
  assert.equal(pool.size(), 2);
  store.wins[0]._resolve('A');
  await tick();
  assert.equal(pool.get(1).status, 'done');
  assert.equal(pool.get(2).status, 'running');
});

test('adapter delegates createWindow/removeWindow', () => {
  const store = makeFakeStore();
  const adapter = WP.createSubagentStoreAdapter(store);
  const win = adapter.createWindow('t');
  assert.ok(win.id);
  assert.equal(store.wins.length, 1);
  adapter.removeWindow(win.id);
  assert.equal(store.wins.length, 0);
});
