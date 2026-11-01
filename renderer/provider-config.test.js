/*!
 * provider-config.test.js — provider-config.js 的 Node 自检（零依赖）
 * 运行： node renderer/provider-config.test.js
 */
'use strict';
const P = require('./provider-config.js');
let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.error('  ✗ ' + m)); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

const LEGACY = { url: 'https://api.deepseek.com', path: '/chat/completions', model: 'deepseek-chat', apiKey: 'k', authPrefix: 'Bearer', contentType: 'application/json', method: 'POST' };

group('空 providers → 回退旧字段（行为不变）');
{
  const r = P.resolve(LEGACY, {});
  eq(r.providerId, 'legacy', 'legacy provider');
  eq(r.url, 'https://api.deepseek.com', 'url');
  eq(r.model, 'deepseek-chat', 'model');
  eq(P.resolve(LEGACY, { model: 'm2' }).model, 'm2', '参数级 model 覆盖');
}

const MULTI = Object.assign({}, LEGACY, {
  providers: [
    { id: 'ds', name: 'DeepSeek', url: 'https://api.deepseek.com', path: '/chat/completions', model: 'deepseek-chat', apiKey: 'k1' },
    { id: 'oai', name: 'OpenAI', url: 'https://api.openai.com', path: '/v1/chat/completions', model: 'gpt-4o', apiKey: 'k2' }
  ],
  activeProviderId: 'ds',
  subagentProviderId: 'oai',
  subagentModel: 'gpt-4o-mini'
});

group('多 provider 路由');
{
  const main = P.resolve(MULTI, {});
  eq(main.providerId, 'ds', '主会话用 active');
  eq(main.model, 'deepseek-chat', '主模型');
  const sub = P.resolve(MULTI, { sub: true });
  eq(sub.providerId, 'oai', '子代理用 subagentProviderId');
  eq(sub.model, 'gpt-4o-mini', '子代理模型覆盖');
  eq(sub.apiKey, 'k2', '子代理 key');
  const forced = P.resolve(MULTI, { providerId: 'oai' });
  eq(forced.providerId, 'oai', '显式 providerId');
  eq(P.resolve(MULTI, { sub: true, model: 'x' }).model, 'x', '参数覆盖优先于 subagentModel');
}

group('listModels / formatModels');
{
  eq(P.listModels(LEGACY).length, 1, 'legacy 1 个');
  const list = P.listModels(MULTI);
  ok(list.length >= 2, '多 provider');
  ok(list.some(m => m.active && m.providerId === 'ds'), 'active 标记');
  ok(P.formatModels(MULTI).indexOf('★') >= 0, '文本含星标');
}

group('normProviders 过滤非法项');
{
  eq(P.normProviders({ providers: [null, { id: 'a' }, 5] }).length, 1, '只保留对象');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
