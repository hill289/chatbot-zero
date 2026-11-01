/* daemon/agentd 协议单测 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('./agentd.js');

test('makeRequest shape', () => {
  const r = D.makeRequest({ id: 1, op: 'exec', args: { command: 'ls' } });
  assert.equal(r.v, '1');
  assert.equal(r.id, 1);
  assert.equal(r.op, 'exec');
  assert.deepEqual(r.args, { command: 'ls' });
});

test('isOp validates known ops', () => {
  assert.equal(D.isOp('exec'), true);
  assert.equal(D.isOp('ping'), true);
  assert.equal(D.isOp('nope'), false);
});

test('parseRequest from object roundtrip', () => {
  const r = D.parseRequest({ id: 2, op: 'ping', args: {} });
  assert.equal(r.ok, true);
  assert.equal(r.req.op, 'ping');
});

test('parseRequest from JSON string', () => {
  const r = D.parseRequest(JSON.stringify({ id: 3, op: 'readFile', args: { path: 'a' } }));
  assert.equal(r.ok, true);
  assert.equal(r.req.op, 'readFile');
});

test('parseRequest bad json', () => {
  const r = D.parseRequest('{not json');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bad-json');
});

test('validateRequest unknown op / missing id', () => {
  assert.equal(D.validateRequest({ id: 1, op: 'zzz' }).ok, false);
  assert.equal(D.validateRequest({ op: 'exec' }).ok, false);
});

test('makeResponse ok and error', () => {
  const ok = D.makeResponse({ id: 1, ok: true, result: { code: 0 } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.result, { code: 0 });
  const bad = D.makeResponse({ id: 1, ok: false, error: 'timeout' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'timeout');
});

test('parseResponse roundtrip + bad json', () => {
  const res = D.makeResponse({ id: 9, ok: true, result: { pong: true } });
  const p = D.parseResponse(JSON.stringify(res));
  assert.equal(p.ok, true);
  assert.equal(p.res.result.pong, true);
  assert.equal(D.parseResponse('xx').ok, false);
});

test('full request->response roundtrip', () => {
  const req = D.makeRequest({ id: 42, op: 'exec', args: { command: 'echo hi' } });
  const parsed = D.parseRequest(JSON.stringify(req));
  assert.equal(parsed.ok, true);
  const res = D.makeResponse({ id: parsed.req.id, ok: true, result: { code: 0, stdout: 'hi\n' } });
  const parsedRes = D.parseResponse(JSON.stringify(res));
  assert.equal(parsedRes.ok, true);
  assert.equal(parsedRes.res.id, 42);
  assert.equal(parsedRes.res.result.stdout, 'hi\n');
});
