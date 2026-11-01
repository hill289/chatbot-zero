/*!
 * provider-config.js — 多 Provider / 每 Agent 模型路由 纯逻辑
 * =============================================================================
 * 对齐 dsh 的 `llm/`（provider 适配家族）+ `preset/`（按会话组装能力）中
 * 「模型/端点解析」这一层。既有配置是单一 OpenAI 兼容端点；这里在不破坏旧行为
 * 的前提下支持：
 *   · providers: [{ id, name, url, path, model, apiKey, authPrefix, contentType, method }]
 *   · activeProviderId：当前主会话使用的 provider
 *   · subagentModel / subagentProviderId：子代理单独路由
 *   · 参数级 model 覆盖（opts.model）
 * 当 providers 为空时，完全回退到旧字段（url/path/model/…），行为不变。
 * UMD：window.ProviderConfig / Node module.exports。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ProviderConfig = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULTS = {
    url: '', path: '', model: '', apiKey: '', authPrefix: 'Bearer',
    contentType: 'application/json', method: 'POST',
    providers: [], activeProviderId: '', subagentProviderId: '', subagentModel: ''
  };

  function legacy(cfg) {
    cfg = cfg || {};
    return {
      providerId: 'legacy',
      providerName: '默认端点',
      url: cfg.url || '',
      path: cfg.path || '',
      model: cfg.model || '',
      apiKey: cfg.apiKey || '',
      authPrefix: cfg.authPrefix || DEFAULTS.authPrefix,
      contentType: cfg.contentType || DEFAULTS.contentType,
      method: cfg.method || DEFAULTS.method
    };
  }

  function normProviders(cfg) {
    var list = (cfg && Array.isArray(cfg.providers)) ? cfg.providers : [];
    return list.filter(function (p) { return p && typeof p === 'object'; }).map(function (p, i) {
      return {
        providerId: String(p.id || ('provider-' + (i + 1))),
        providerName: String(p.name || p.id || ('Provider ' + (i + 1))),
        url: String(p.url || ''),
        path: String(p.path || ''),
        model: String(p.model || ''),
        apiKey: String(p.apiKey || ''),
        authPrefix: String(p.authPrefix || DEFAULTS.authPrefix),
        contentType: String(p.contentType || DEFAULTS.contentType),
        method: String(p.method || DEFAULTS.method)
      };
    });
  }

  function pickProvider(cfg, providerId) {
    var list = normProviders(cfg);
    if (!list.length) return null;
    if (providerId) {
      for (var i = 0; i < list.length; i++) if (list[i].providerId === providerId) return list[i];
    }
    if (cfg && cfg.activeProviderId) {
      for (var j = 0; j < list.length; j++) if (list[j].providerId === cfg.activeProviderId) return list[j];
    }
    return list[0];
  }

  // opts: { sub?:boolean, model?:string, providerId?:string }
  function resolve(cfg, opts) {
    cfg = cfg || {};
    opts = opts || {};
    var base;
    if (opts.sub) {
      base = pickProvider(cfg, cfg.subagentProviderId || cfg.activeProviderId);
    } else {
      base = pickProvider(cfg, opts.providerId || cfg.activeProviderId);
    }
    if (!base) base = legacy(cfg);
    var out = Object.assign({}, base);
    if (opts.sub && cfg.subagentModel) out.model = String(cfg.subagentModel);
    if (opts.model) out.model = String(opts.model);
    if (!out.model && cfg.model) out.model = String(cfg.model);
    return out;
  }

  function listModels(cfg) {
    cfg = cfg || {};
    var out = [];
    var list = normProviders(cfg);
    if (!list.length) {
      out.push({
        providerId: 'legacy', providerName: '默认端点', model: cfg.model || '',
        active: true, subagent: false
      });
    } else {
      list.forEach(function (p) {
        out.push({
          providerId: p.providerId, providerName: p.providerName, model: p.model,
          active: p.providerId === (cfg.activeProviderId || list[0].providerId),
          subagent: p.providerId === (cfg.subagentProviderId || '')
        });
      });
      if (cfg.subagentModel) {
        out.push({ providerId: cfg.subagentProviderId || 'legacy', providerName: '子代理模型', model: cfg.subagentModel, active: false, subagent: true });
      }
    }
    return out;
  }

  function formatModels(cfg) {
    var models = listModels(cfg);
    var lines = ['可用模型（' + models.length + '）：'];
    models.forEach(function (m) {
      lines.push((m.active ? '★ ' : '  ') + m.providerName + ' · ' + (m.model || '(默认)') +
        '  «' + m.providerId + '»' + (m.subagent ? '  [subagent]' : ''));
    });
    return lines.join('\n');
  }

  return {
    DEFAULTS: DEFAULTS,
    legacy: legacy,
    normProviders: normProviders,
    pickProvider: pickProvider,
    resolve: resolve,
    listModels: listModels,
    formatModels: formatModels
  };
});
