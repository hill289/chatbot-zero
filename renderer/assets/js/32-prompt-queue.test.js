/* 32-prompt-queue 单测 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const PQ = require('./32-prompt-queue.js');

test('FIFO enqueue/dequeue', () => {
  const q = PQ.createPromptQueue();
  q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
  assert.equal(q.size(), 3);
  assert.equal(q.peek(), 'a');
  assert.equal(q.dequeue(), 'a');
  assert.equal(q.dequeue(), 'b');
});

test('drain returns all and empties', () => {
  const q = PQ.createPromptQueue();
  q.enqueue(1); q.enqueue(2);
  assert.deepEqual(q.drain(), [1, 2]);
  assert.equal(q.isEmpty(), true);
});

test('capacity drops oldest', () => {
  const q = PQ.createPromptQueue({ max: 2 });
  q.enqueue('a');
  q.enqueue('b');
  const r = q.enqueue('c');
  assert.equal(r.dropped, 'a');
  assert.deepEqual(q.drain(), ['b', 'c']);
});

test('empty dequeue undefined / peek undefined', () => {
  const q = PQ.createPromptQueue();
  assert.equal(q.dequeue(), undefined);
  assert.equal(q.peek(), undefined);
  assert.equal(q.isEmpty(), true);
});

test('ids increment + list snapshot', () => {
  const q = PQ.createPromptQueue();
  const a = q.enqueue('x');
  const b = q.enqueue('y');
  assert.ok(b.id > a.id);
  assert.equal(q.list().length, 2);
  assert.equal(q.list()[0].item, 'x');
});

test('clear empties', () => {
  const q = PQ.createPromptQueue();
  q.enqueue('a'); q.clear();
  assert.equal(q.size(), 0);
});
