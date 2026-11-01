/* trigger-filter 单测 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const TF = require('./trigger-filter.js');

test('default admits any source', () => {
  const r = TF.programFilter({ source: 'fs', path: 'a.js' }, {});
  assert.equal(r.admit, true);
  assert.equal(r.route.type, 'router');
});

test('denySources blocks', () => {
  const r = TF.programFilter({ source: 'mail' }, { denySources: ['mail'] });
  assert.equal(r.admit, false);
});

test('allowSources whitelist gates', () => {
  assert.equal(TF.programFilter({ source: 'fs' }, { allowSources: ['im'] }).admit, false);
  assert.equal(TF.programFilter({ source: 'im' }, { allowSources: ['im'] }).admit, true);
});

test('denyGroups blocks group', () => {
  const r = TF.programFilter({ source: 'im', group: 'spam' }, { denyGroups: ['spam'] });
  assert.equal(r.admit, false);
});

test('allowGroups requires membership when group present', () => {
  assert.equal(TF.programFilter({ source: 'im', group: 'ops' }, { allowGroups: ['dev'] }).admit, false);
  assert.equal(TF.programFilter({ source: 'im', group: 'dev' }, { allowGroups: ['dev'] }).admit, true);
});

test('keywords require hit; denyKeywords block', () => {
  assert.equal(TF.programFilter({ source: 'im', text: 'hello world' }, { keywords: ['deploy'] }).admit, false);
  assert.equal(TF.programFilter({ source: 'im', text: 'please deploy now' }, { keywords: ['deploy'] }).admit, true);
  assert.equal(TF.programFilter({ source: 'im', text: 'ignore this spam' }, { denyKeywords: ['spam'] }).admit, false);
});

test('pathInclude / pathExclude', () => {
  assert.equal(TF.programFilter({ source: 'fs', path: 'src/a.js' }, { pathInclude: ['src/'] }).admit, true);
  assert.equal(TF.programFilter({ source: 'fs', path: 'dist/a.js' }, { pathInclude: ['src/'] }).admit, false);
  assert.equal(TF.programFilter({ source: 'fs', path: 'node_modules/x' }, { pathExclude: ['node_modules'] }).admit, false);
});

test('routes map overrides route type', () => {
  const r = TF.programFilter({ source: 'timer' }, { routes: { timer: { type: 'direct' } } });
  assert.equal(r.route.type, 'direct');
});

test('semanticPromptFor includes event summary and JSON instruction', () => {
  const p = TF.semanticPromptFor({ source: 'github', path: 'pr#1', text: 'review please' });
  assert.match(p, /来源=github/);
  assert.match(p, /review please/);
  assert.match(p, /"act"/);
});

test('eventSummary handles empty', () => {
  assert.equal(TF.eventSummary({}), '');
});
