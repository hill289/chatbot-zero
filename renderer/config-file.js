/*!
 * config-file.js — Interface Configuration 配置文件固化（纯逻辑 / UMD / 零依赖）
 * =============================================================================
 * 把「⚙️ Interface Configuration」里可固化的配置（端点 / 模型 / 参数 / 高级项）
 * 落到「应用目录 / config / interface.json」这个人类可编辑的 JSON 文件里，
 * 并支持「页面设置 → 写文件」「改文件 → 刷新 → 回读生效」双向同步。
 *
 * 设计要点：
 *   · 白名单：只固化界面配置相关的键（FILE_KEYS），不落任何「密钥」明文；
 *   · 密钥（apiKey / providers[].apiKey / sshHosts[].password）永不写入文件，
 *     仍由主进程 safeStorage 加密保存；写文件前统一剥离（pickFileConfig）；
 *   · 回读（applyFileConfig）时，若文件里的 provider / sshHost 不带密钥，
 *     则保留内存里已有的密钥（来自 safeStorage），绝不用空串覆盖真实密钥；
 *   · 兼容两种文件结构：扁平 { url, model, ... } 或包裹 { chatbotStore: {...} }。
 *
 * 该模块不依赖 window / DOM / electron，可被 node --test 直接单测；
 * 浏览器端挂在 window.ConfigFile。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ConfigFile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 固化到配置文件的「接口配置」白名单键（顺序即写入顺序）。
  // 明确排除：apiKey（密钥，走 safeStorage）、providers[].apiKey、sshHosts[].password、
  // 以及各种一次性迁移标记（ctxWindowMigrated1M 等运行时状态）。
  var FILE_KEYS = [
    // 基本端点
    'url', 'path', 'model', 'authPrefix', 'contentType', 'method',
    // 请求行为
    'stream', 'mcp', 'cacheMode', 'multimodalEnabled',
    // 采样参数
    'max_tokens_type', 'max_tokens_value', 'temperature', 'top_p',
    // 高级：工具禁用 / 外部 MCP / 多 provider 路由
    'disabledTools', 'mcpUrls',
    'providers', 'activeProviderId', 'subagentProviderId', 'subagentModel',
    // 高级：护栏阈值 / 审批 / 上下文窗口 / 硬切
    'loopGuard', 'approval', 'contextWindowTokens', 'hardCutRatio', 'hardCutEnabled',
    // 高级：溢出 / 截止 / 工作区上下文 / 记忆 / 沙箱
    'spill', 'guard', 'workspaceContext', 'memory', 'sandbox',
    // SSH 主机（password 会被剥离）
    'sshHosts'
  ];

  function deepClone(v) {
    if (v === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; }
  }

  function has(obj, k) {
    return obj && Object.prototype.hasOwnProperty.call(obj, k);
  }

  // SSH 主机的稳定标识（与 08-ui-store.js 的 secret 键一致）
  function sshId(h) {
    if (!h) return '';
    return 'ssh.' + String(h.host || '').trim() + ':' + (parseInt(h.port, 10) || 22) +
      '@' + String(h.username || '').trim();
  }

  // 把一个 store 快照里「不该落盘」的密钥就地清空（用于生成文件内容）
  function stripSecrets(store) {
    var s = deepClone(store || {});
    if (s && typeof s === 'object') {
      s.apiKey = '';
      if (Array.isArray(s.providers)) {
        s.providers.forEach(function (p) { if (p && typeof p === 'object') p.apiKey = ''; });
      }
      if (Array.isArray(s.sshHosts)) {
        s.sshHosts.forEach(function (h) { if (h && typeof h === 'object') h.password = ''; });
      }
    }
    return s;
  }

  // 从实时 store 里抽取要写进配置文件的「接口配置」（白名单 + 剥离密钥）。
  // 永远不含 apiKey / providers[].apiKey / sshHosts[].password。
  function pickFileConfig(store) {
    store = store || {};
    var out = {};
    FILE_KEYS.forEach(function (k) {
      if (has(store, k)) out[k] = deepClone(store[k]);
    });
    if (Array.isArray(out.providers)) {
      out.providers.forEach(function (p) { if (p && typeof p === 'object') delete p.apiKey; });
    }
    if (Array.isArray(out.sshHosts)) {
      out.sshHosts.forEach(function (h) { if (h && typeof h === 'object') delete h.password; });
    }
    return out;
  }

  // 把文件里的配置应用回实时 store（只覆盖白名单键；保留内存里已有的密钥）。
  // 返回 store 便于链式调用。
  function applyFileConfig(store, fileConfig) {
    if (!store || typeof store !== 'object') return store;
    if (!fileConfig || typeof fileConfig !== 'object') return store;
    // 兼容包裹结构 { chatbotStore: {...} }
    var incoming = (fileConfig.chatbotStore && typeof fileConfig.chatbotStore === 'object')
      ? fileConfig.chatbotStore : fileConfig;

    FILE_KEYS.forEach(function (k) {
      if (!has(incoming, k)) return;

      if (k === 'providers') {
        var arr = Array.isArray(incoming.providers) ? deepClone(incoming.providers) : [];
        var oldP = {};
        (Array.isArray(store.providers) ? store.providers : []).forEach(function (p) {
          if (p) oldP[p.id || p.name || 'default'] = p;
        });
        arr.forEach(function (p) {
          if (!p || typeof p !== 'object') return;
          var old = oldP[p.id || p.name || 'default'];
          // 文件里不含密钥 → 保留内存中（安全存储回填的）真实密钥
          if (!p.apiKey && old && old.apiKey) p.apiKey = old.apiKey;
        });
        store.providers = arr;
        return;
      }

      if (k === 'sshHosts') {
        var hosts = Array.isArray(incoming.sshHosts) ? deepClone(incoming.sshHosts) : [];
        var oldH = {};
        (Array.isArray(store.sshHosts) ? store.sshHosts : []).forEach(function (h) {
          if (h) oldH[sshId(h)] = h;
        });
        hosts.forEach(function (h) {
          if (!h || typeof h !== 'object') return;
          var old = oldH[sshId(h)];
          if (!h.password && old && old.password) h.password = old.password;
        });
        store.sshHosts = hosts;
        return;
      }

      store[k] = deepClone(incoming[k]);
    });

    return store;
  }

  // 文件结构是否看起来是一份可用的接口配置（至少含一个已知键）
  function looksLikeConfig(obj) {
    if (!obj || typeof obj !== 'object') return false;
    var src = (obj.chatbotStore && typeof obj.chatbotStore === 'object') ? obj.chatbotStore : obj;
    for (var i = 0; i < FILE_KEYS.length; i++) {
      if (has(src, FILE_KEYS[i])) return true;
    }
    return false;
  }

  return {
    FILE_KEYS: FILE_KEYS,
    deepClone: deepClone,
    stripSecrets: stripSecrets,
    pickFileConfig: pickFileConfig,
    applyFileConfig: applyFileConfig,
    looksLikeConfig: looksLikeConfig
  };
});
