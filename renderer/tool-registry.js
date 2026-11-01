/*!
 * tool-registry.js — 可插拔工具注册表（Pluggable Tool Registry）
 * -----------------------------------------------------------------------------
 * 面向「第三方 / 自定义工具」的注册中心。设计目标是**零侵入**接入既有的
 * LLM 工具调用循环：
 *
 *   1) 本模块只提供纯逻辑的注册表（不依赖 DOM、不依赖应用内其它全局）；
 *   2) 由主脚本（renderer/index.html）把注册表映射为一个内置 MCP Server
 *      （服务键 `tool-registry`）注入 `window.mcpServers`，于是
 *      `mcpStore.listTools / getTool / callTool`、以及 `prefixManager`
 *      （system+tools 前缀缓存指纹）都无需任何改动即可生效；
 *   3) 第三方脚本可仅通过 `window.registerTool({...})` 自行注册，无需改源码。
 *
 * 工具定义（三种执行体，任选其一；优先 handler > code > http）：
 *   - handler : (args, ctx) => any        直接给函数（仅在内存，不随持久化保存）
 *   - code    : string                    内联 JS 源码（可持久化）
 *   - http    : { url, method, headers }  声明式 HTTP 调用（可持久化）
 * 公共字段：
 *   - name        工具名（必填；^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$，全局唯一）
 *   - description 给模型看的说明（建议写清「何时用 / 何时不要用」）
 *   - inputSchema JSON Schema（也接受 OpenAI 风格的 `parameters` 别名）
 *   - tags        字符串数组（便于按 tag 批量注销，如插件卸载）
 *   - enabled     是否下发给模型（默认 true）
 *   - source/builtin/meta  溯源信息
 *
 * 兼容 UMD：浏览器挂到 globalThis.ToolRegistry；Node 下 module.exports 导出，
 * 便于对本文件做独立单元测试。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ToolRegistry = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
  var MAX_DESC = 8192;

  // ── 小工具 ────────────────────────────────────────────────
  function isFn(x) { return typeof x === 'function'; }
  function normalizeName(n) { return n == null ? '' : String(n).trim(); }

  function toText(x) {
    if (x == null) return '';
    if (typeof x === 'string') return x;
    try { return JSON.stringify(x); } catch (_) { return String(x); }
  }

  // 统一 JSON Schema：宽容处理空值 / 缺字段
  function normalizeSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      return { type: 'object', properties: {} };
    }
    var out = {};
    for (var k in schema) { if (Object.prototype.hasOwnProperty.call(schema, k)) out[k] = schema[k]; }
    if (!out.type) out.type = 'object';
    if (out.type === 'object' && (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties))) {
      out.properties = {};
    }
    return out;
  }

  // 把 handler 的任意返回值规整为 MCP 结果 { content:[...] }
  function normalizeResult(raw) {
    if (raw && typeof raw === 'object' && Array.isArray(raw.content)) {
      var r = { content: raw.content };
      if (raw.isError) r.isError = true;
      if (raw.structuredContent !== undefined) r.structuredContent = raw.structuredContent;
      return r;
    }
    if (raw == null) return { content: [{ type: 'text', text: '' }] };
    if (typeof raw === 'string') return { content: [{ type: 'text', text: raw }] };
    return { content: [{ type: 'text', text: toText(raw) }] };
  }

  // {arg} 占位符插值；encode=true 时做 URL 编码（用于 URL）
  function interpolate(tpl, args, encode) {
    return String(tpl == null ? '' : tpl).replace(/\{([^{}]+)\}/g, function (m, key) {
      var v = args == null ? undefined : args[key];
      if (v === undefined) return m;
      var s = (typeof v === 'object') ? JSON.stringify(v) : String(v);
      return encode ? encodeURIComponent(s) : s;
    });
  }

  // ── 执行体构造 ────────────────────────────────────────────
  function buildHttpHandler(http) {
    return async function (args, ctx) {
      args = (args && typeof args === 'object') ? args : {};
      var method = String(http.method || 'POST').toUpperCase();
      var url = interpolate(http.url, args, true);
      var headers = {};
      if (http.headers && typeof http.headers === 'object') {
        for (var hk in http.headers) {
          if (Object.prototype.hasOwnProperty.call(http.headers, hk)) {
            headers[hk] = interpolate(http.headers[hk], args, false);
          }
        }
      }
      var isGet = (method === 'GET' || method === 'HEAD');
      var body;
      if (http.bodyTemplate != null) {
        body = interpolate(http.bodyTemplate, args, false);
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
      } else if (!isGet) {
        body = JSON.stringify(args);
        if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
      }
      if (isGet) {
        var qs = Object.keys(args).map(function (k) {
          var v = args[k];
          return encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'object' ? JSON.stringify(v) : String(v));
        }).join('&');
        if (qs) url += (url.indexOf('?') === -1 ? '?' : '&') + qs;
      }
      var fetchImpl = (ctx && ctx.fetch) || (typeof fetch !== 'undefined' ? fetch : null);
      if (!fetchImpl) throw new Error('当前环境没有可用的 fetch()');
      var resp = await fetchImpl(url, { method: method, headers: headers, body: body });
      var text = await resp.text();
      var parsed = text;
      try { parsed = JSON.parse(text); } catch (_) { /* 非 JSON → 原样文本 */ }
      if (!resp.ok) {
        var err = new Error('HTTP ' + resp.status + ' ' + resp.statusText);
        err.status = resp.status;
        err.body = parsed;
        throw err;
      }
      return {
        content: [{ type: 'text', text: (typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)) }],
        structuredContent: parsed,
        meta: { status: resp.status, url: url }
      };
    };
  }

  function buildCodeHandler(code) {
    // 源码在独立函数体内执行：可用 args / ctx；用 return 回传结果
    var fn = new Function('args', 'ctx', 'return (async () => {\n' + String(code) + '\n})();');
    return async function (args, ctx) { return await fn(args, ctx); };
  }

  function resolveHandler(def) {
    if (isFn(def.handler)) return def.handler;
    if (typeof def.code === 'string' && def.code.trim()) return buildCodeHandler(def.code);
    if (def.http && typeof def.http === 'object' && def.http.url) return buildHttpHandler(def.http);
    return null;
  }

  function kindOf(def) {
    if (isFn(def.handler)) return 'handler';
    if (typeof def.code === 'string' && def.code.trim()) return 'code';
    if (def.http && typeof def.http === 'object' && def.http.url) return 'http';
    return null;
  }

  // ── 注册表实例工厂 ────────────────────────────────────────
  function createRegistry() {
    var _tools = new Map();       // name -> 内部描述符（含 handler）
    var _listeners = new Set();   // (evt) => void
    var _deps = { onChange: null, load: null, save: null };

    function emit(evt) {
      _listeners.forEach(function (fn) {
        try { fn(evt); } catch (e) { if (typeof console !== 'undefined') console.error('[toolRegistry] listener error', e); }
      });
      if (_deps.onChange) { try { _deps.onChange(evt); } catch (e) { if (typeof console !== 'undefined') console.error('[toolRegistry] onChange error', e); } }
    }

    function persistNow() {
      if (!_deps.save) return;
      try { _deps.save(exportJSON()); } catch (_) { /* 持久化失败不阻断注册 */ }
    }

    // 公开描述符（剥离不可序列化的 handler 函数）
    function publicDescriptor(d) {
      var out = {
        name: d.name,
        description: d.description,
        inputSchema: d.inputSchema,
        tags: d.tags.slice(),
        source: d.source,
        enabled: !!d.enabled,
        builtin: !!d.builtin,
        kind: d.kind,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
      };
      if (d.kind === 'code') out.code = d.code;
      if (d.kind === 'http') out.http = d.http;
      if (d.meta && Object.keys(d.meta).length) out.meta = d.meta;
      return out;
    }

    function validate(def) {
      if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error('工具定义必须是对象');
      var name = normalizeName(def.name);
      if (!NAME_RE.test(name)) throw new Error("工具名非法：'" + def.name + "'（仅允许字母/数字/下划线/点/连字符，首字符不能是 . 或 -，1~64 位）");
      if (kindOf(def) === null) throw new Error("工具 '" + name + "' 缺少执行体：请提供 handler / code / http 三者之一");
      return name;
    }

    function register(def, opts) {
      opts = opts || {};
      var name = validate(def);
      var existing = _tools.get(name);
      if (existing && !opts.override) {
        throw new Error("工具 '" + name + "' 已存在（需覆盖请传 { override: true }）");
      }
      var kind = kindOf(def);
      var now = Date.now();
      var inputSchema = normalizeSchema(def.inputSchema || def.parameters);
      var desc = String(def.description == null ? '' : def.description).slice(0, MAX_DESC);
      var descriptor = {
        name: name,
        description: desc,
        inputSchema: inputSchema,
        tags: Array.isArray(def.tags) ? def.tags.map(String) : [],
        enabled: def.enabled === undefined ? true : !!def.enabled,
        builtin: !!def.builtin,
        source: String(opts.source || def.source || (kind === 'handler' ? 'plugin' : 'manual')),
        kind: kind,
        handler: resolveHandler(def),
        code: kind === 'code' ? String(def.code) : undefined,
        http: kind === 'http' ? Object.assign({}, def.http) : undefined,
        meta: (def.meta && typeof def.meta === 'object') ? Object.assign({}, def.meta) : {},
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now
      };
      _tools.set(name, descriptor);
      persistNow();
      emit({ type: existing ? 'update' : 'register', name: name, tool: publicDescriptor(descriptor) });
      return publicDescriptor(descriptor);
    }

    function registerMany(defs, opts) {
      defs = Array.isArray(defs) ? defs : [];
      var out = [], errors = [];
      for (var i = 0; i < defs.length; i++) {
        try { out.push(register(defs[i], opts)); }
        catch (e) { errors.push((defs[i] && defs[i].name || ('#' + i)) + ': ' + ((e && e.message) || e)); }
      }
      return { registered: out, errors: errors };
    }

    function unregister(name) {
      name = normalizeName(name);
      if (!_tools.has(name)) return false;
      _tools.delete(name);
      persistNow();
      emit({ type: 'unregister', name: name });
      return true;
    }

    function unregisterByTag(tag) {
      tag = String(tag);
      var hit = [];
      _tools.forEach(function (d, n) { if (d.tags.indexOf(tag) !== -1) hit.push(n); });
      hit.forEach(function (n) { _tools.delete(n); });
      if (hit.length) { persistNow(); emit({ type: 'unregister', name: null, tag: tag, names: hit }); }
      return hit.length;
    }

    function unregisterBySource(source) {
      source = String(source);
      var hit = [];
      _tools.forEach(function (d, n) { if (d.source === source) hit.push(n); });
      hit.forEach(function (n) { _tools.delete(n); });
      if (hit.length) { persistNow(); emit({ type: 'unregister', name: null, source: source, names: hit }); }
      return hit.length;
    }

    function clear(opts) {
      opts = opts || {};
      var keepBuiltin = !!opts.keepBuiltin;
      var removed = [];
      _tools.forEach(function (d, n) { if (!(keepBuiltin && d.builtin)) removed.push(n); });
      removed.forEach(function (n) { _tools.delete(n); });
      if (removed.length) { persistNow(); emit({ type: 'clear', names: removed }); }
      return removed.length;
    }

    function has(name) { return _tools.has(normalizeName(name)); }
    function get(name) { return _tools.get(normalizeName(name)) || null; }
    function info(name) { var d = get(name); return d ? publicDescriptor(d) : null; }
    function count(opts) { return list(opts).length; }

    function list(opts) {
      opts = opts || {};
      var out = [];
      _tools.forEach(function (d) {
        if (opts.enabledOnly && !d.enabled) return;
        out.push(publicDescriptor(d));
      });
      out.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
      return out;
    }

    function setEnabled(name, enabled) {
      var d = get(name);
      if (!d) return false;
      var val = !!enabled;
      if (d.enabled === val) return true;
      d.enabled = val;
      d.updatedAt = Date.now();
      persistNow();
      emit({ type: val ? 'enable' : 'disable', name: d.name });
      return true;
    }

    function toggle(name) { var d = get(name); return d ? setEnabled(name, !d.enabled) : false; }

    // MCP 工具描述符（供 window.mcpServers[...].tools.list 使用）
    function toMCPToolDescriptors() {
      return list({ enabledOnly: true }).map(function (d) {
        return { name: d.name, description: d.description, inputSchema: d.inputSchema };
      });
    }

    // 执行一个已注册工具；返回 MCP 结果 { content:[...] }（失败时 isError:true）
    async function call(name, args, ctx) {
      name = normalizeName(name);
      var d = _tools.get(name);
      if (!d) throw new Error("未注册的工具：'" + name + "'");
      if (!d.enabled) {
        return { content: [{ type: 'text', text: "工具 '" + name + "' 已停用（可在「🔌 工具注册表」中启用）。" }], isError: true };
      }
      args = (args && typeof args === 'object') ? args : {};
      var context = Object.assign({
        name: d.name,
        registry: api,
        call: function (n, a, c) { return call(n, a, c); },
        fetch: (typeof fetch !== 'undefined' ? fetch : undefined),
        log: (typeof console !== 'undefined' ? console : { log: function () {}, error: function () {}, warn: function () {} })
      }, ctx || {});
      var t0 = Date.now();
      var raw;
      try {
        raw = await d.handler(args, context);
      } catch (e) {
        var msg = (e && e.message) || String(e);
        emit({ type: 'error', name: d.name, error: msg, durationMs: Date.now() - t0 });
        return { content: [{ type: 'text', text: "工具 '" + d.name + "' 执行失败：" + msg }], isError: true };
      }
      var res = normalizeResult(raw);
      emit({ type: 'call', name: d.name, durationMs: Date.now() - t0, isError: !!res.isError });
      return res;
    }

    // 导出可序列化工具（handler 类型无法序列化，跳过）
    function exportJSON() {
      var tools = [];
      _tools.forEach(function (d) { if (d.kind !== 'handler') tools.push(publicDescriptor(d)); });
      return { version: VERSION, exportedAt: new Date().toISOString(), tools: tools };
    }

    // 导入：接受 {tools:[...]} / 数组 / JSON 字符串
    function importJSON(input, opts) {
      opts = opts || {};
      var data = input;
      if (typeof input === 'string') data = JSON.parse(input);
      var arr = Array.isArray(data) ? data : (data && Array.isArray(data.tools) ? data.tools : null);
      if (!arr) throw new Error('导入内容不是合法工具列表（应为 { tools:[...] } 或数组）');
      var ok = 0, errors = [];
      for (var i = 0; i < arr.length; i++) {
        try {
          var def = Object.assign({}, arr[i]);
          if (opts.source && !def.source) def.source = opts.source;
          register(def, { override: !!opts.override });
          ok++;
        } catch (e) {
          errors.push((arr[i] && arr[i].name || ('#' + i)) + ': ' + ((e && e.message) || e));
        }
      }
      return { ok: ok, failed: errors.length, errors: errors };
    }

    // 从持久化存储恢复（由主脚本注入 load/save）
    function loadPersisted() {
      if (!_deps.load) return { loaded: 0 };
      var data;
      try { data = _deps.load(); } catch (_) { return { loaded: 0 }; }
      if (!data) return { loaded: 0 };
      try { return { loaded: importJSON(data, {}).ok }; }
      catch (_) { return { loaded: 0 }; }
    }

    function configure(deps) {
      deps = deps || {};
      if (deps.onChange !== undefined) _deps.onChange = deps.onChange;
      if (deps.load !== undefined) _deps.load = deps.load;
      if (deps.save !== undefined) _deps.save = deps.save;
      return api;
    }

    function addListener(fn) {
      if (!isFn(fn)) throw new Error('listener 必须是函数');
      _listeners.add(fn);
      return function () { _listeners.delete(fn); };
    }
    function removeListener(fn) { return _listeners.delete(fn); }

    var api = {
      version: VERSION,
      NAME_RE: NAME_RE,
      configure: configure,
      addListener: addListener,
      removeListener: removeListener,
      register: register,
      registerMany: registerMany,
      unregister: unregister,
      unregisterByTag: unregisterByTag,
      unregisterBySource: unregisterBySource,
      clear: clear,
      has: has,
      get: get,
      info: info,
      list: list,
      count: count,
      setEnabled: setEnabled,
      toggle: toggle,
      call: call,
      toMCPToolDescriptors: toMCPToolDescriptors,
      exportJSON: exportJSON,
      importJSON: importJSON,
      loadPersisted: loadPersisted
    };
    return api;
  }

  // 默认实例 + create 工厂（方便隔离测试）
  var defaultRegistry = createRegistry();
  var rootApi = { create: createRegistry, version: VERSION };
  Object.keys(defaultRegistry).forEach(function (k) {
    if (typeof defaultRegistry[k] === 'function') {
      rootApi[k] = defaultRegistry[k].bind(defaultRegistry);
    } else {
      rootApi[k] = defaultRegistry[k];
    }
  });
  return rootApi;
});
