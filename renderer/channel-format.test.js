/* channel-format 单测 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const CF = require('./channel-format.js');

test('countWords latin', () => {
  assert.equal(CF.countWords('hello world foo'), 3);
});

test('countWords cjk each char = 1', () => {
  assert.equal(CF.countWords('你好世界'), 4);
});

test('countWords mixed', () => {
  // 两个 CJK 字 + 两个拉丁词
  assert.equal(CF.countWords('你好 hello world'), 4);
});

test('short IM message unchanged', () => {
  const r = CF.formatForChannel('hello there', 'im');
  assert.equal(r.truncated, false);
  assert.equal(r.text, 'hello there');
  assert.equal(r.channel, 'im');
});

test('long IM message truncated to <=100 words + ellipsis', () => {
  const text = Array.from({ length: 150 }, (_, i) => 'w' + i).join(' ');
  const r = CF.formatForChannel(text, 'im');
  assert.equal(r.truncated, true);
  assert.ok(r.finalWords <= 100, 'finalWords=' + r.finalWords);
  assert.ok(r.text.endsWith('…'));
  assert.equal(r.wordCount, 150);
});

test('exactly 100 words IM unchanged', () => {
  const text = Array.from({ length: 100 }, () => 'w').join(' ');
  const r = CF.formatForChannel(text, 'im');
  assert.equal(r.truncated, false);
  assert.equal(r.finalWords, 100);
});

test('long CJK IM truncated to <=100 chars(words)', () => {
  const text = '你'.repeat(150);
  const r = CF.formatForChannel(text, 'im');
  assert.equal(r.truncated, true);
  assert.ok(r.finalWords <= 100);
});

test('github passthrough not truncated', () => {
  const text = Array.from({ length: 150 }, () => 'x').join(' ');
  const r = CF.formatForChannel(text, 'github');
  assert.equal(r.truncated, false);
  assert.equal(r.channel, 'github');
});

test('unknown channel passthrough', () => {
  const r = CF.formatForChannel('abc', 'whatever');
  assert.equal(r.text, 'abc');
  assert.equal(r.truncated, false);
});

test('slack treated as IM channel', () => {
  const text = Array.from({ length: 150 }, () => 'x').join(' ');
  const r = CF.formatForChannel(text, 'slack');
  assert.equal(r.truncated, true);
});

test('custom maxWords honored', () => {
  const text = 'a b c d e f g h';
  const r = CF.formatForChannel(text, 'im', { maxWords: 3 });
  assert.equal(r.truncated, true);
  assert.ok(r.finalWords <= 3);
});
