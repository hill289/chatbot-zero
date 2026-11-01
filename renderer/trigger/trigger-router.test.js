/* trigger-router 单测 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TR = require('./trigger-router.js');

test('threadOf prefers explicit thread', () => {
  assert.equal(TR.threadOf({ thread: 'th-1', path: 'a' }), 'th-1');
});

test('threadOf falls back to path', () => {
  assert.equal(TR.threadOf({ path: 'src/a.js' }), 'path:src/a.js');
});

test('threadOf falls back to source:group/channel/default', () => {
  assert.equal(TR.threadOf({ source: 'im', group: 'g1' }), 'im:g1');
  assert.equal(TR.threadOf({ source: 'fs' }), 'fs:default');
});

test('unsubscribed -> router', () => {
  const r = TR.route({ thread: 'th-x' }, {});
  assert.equal(r.type, 'router');
  assert.equal(r.thread, 'th-x');
});

test('subscribed -> direct to first worker with full list', () => {
  const subs = TR.createSubscriptionStore({ 'th-1': ['w1', 'w2'] });
  const r = TR.route({ thread: 'th-1' }, subs);
  assert.equal(r.type, 'direct');
  assert.equal(r.workerId, 'w1');
  assert.deepEqual(r.workerIds, ['w1', 'w2']);
});

test('subscription store add/remove/get/list + persist', () => {
  let saved = null;
  const storage = { load: () => null, save: (m) => { saved = m; } };
  const store = TR.createSubscriptionStore(null, storage);
  store.add('t', 'w1');
  store.add('t', 'w1'); // 去重
  store.add('t', 'w2');
  assert.deepEqual(store.get('t'), ['w1', 'w2']);
  assert.deepEqual(saved, { t: ['w1', 'w2'] });
  store.remove('t', 'w1');
  assert.deepEqual(store.get('t'), ['w2']);
  store.removeThread('t');
  assert.deepEqual(store.get('t'), []);
  assert.deepEqual(store.list(), {});
});

test('store loads from storage on init', () => {
  const storage = { load: () => ({ k: ['w9'] }) };
  const store = TR.createSubscriptionStore(null, storage);
  assert.deepEqual(store.get('k'), ['w9']);
});

test('route works with plain object subscriptions', () => {
  const r = TR.route({ thread: 't' }, { t: ['w3'] });
  assert.equal(r.type, 'direct');
  assert.equal(r.workerId, 'w3');
});
