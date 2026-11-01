/*!
 * provider-config-bootstrap.js — 模型/provider 发现工具（list_models）
 * 依赖：renderer/provider-config.js（纯逻辑）、chatbotStore（08-ui-store.js）。
 */
(function () {
  'use strict';
  var CORE = (typeof window !== 'undefined' && window.ProviderConfig) || null;
  if (!CORE) { try { console.warn('[provider-config] provider-config.js 未加载，跳过接线'); } catch (_) {} return; }

  function cfg() {
    try { return (typeof chatbotStore !== 'undefined' && chatbotStore) ? chatbotStore : {}; } catch (_) { return {}; }
  }

  function toolListModels() {
    var c = cfg();
    return {
      models: CORE.listModels(c),
      active: CORE.resolve(c, {}),
      formatted: CORE.formatModels(c)
    };
  }

  var TOOLS = [
    {
      name: 'list_models',
      description: '列出已配置的模型/provider（含当前主会话 active 与子代理 subagent 路由），并给出实际解析出的端点与模型。',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      handler: function () { return toolListModels(); }
    }
  ];

  function register() {
    if (typeof window.registerTool !== 'function') { setTimeout(register, 100); return; }
    try {
      if (typeof window.registerTools === 'function') window.registerTools(TOOLS, { source: 'provider-config', builtin: true, override: true });
      else TOOLS.forEach(function (t) { window.registerTool(t, { source: 'provider-config', builtin: true, override: true }); });
    } catch (e) { try { console.warn('[provider-config] 注册失败', e); } catch (_) {} }
  }
  register();
})();
