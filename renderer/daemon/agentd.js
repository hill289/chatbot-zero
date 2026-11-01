/*!
 * daemon/agentd.js — 端侧 daemon 轻量协议（Super-agent 模块 5.2 · 计算/环境分离）
 * =============================================================================
 * 把「在内嵌 run_shell 里物化到 workspace 再跑子进程」显式化为**端侧 daemon 协议**：
 *   daemon 只执行命令 / 读写文件 / 返回结果，**不持会话状态**；Agent Loop（Router/Worker
 *   推理）可在主进程或远端，按任务选择某台设备的 daemon 执行（BYOM=接入某台机器）。
 *
 * 本文件是纯协议编解码 + 校验（无 IO、无进程）：
 *   makeRequest / parseRequest / validateRequest / makeResponse / parseResponse / isOp
 * 本机模式下 daemon 即本地子进程（真正执行复用 sandbox-policy 的 spawnSandboxed），
 * 因此协议层可 Node 单测。A 档行为对模型透明：run_shell 仍是一次请求/响应往返。
 *
 * UMD：浏览器挂 globalThis.AgentDaemon / Node 下 module.exports。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.AgentDaemon = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PROTOCOL_VERSION = '1';
  var OPS = ['exec', 'readFile', 'writeFile', 'listDir', 'ping'];

  function isOp(op) { return OPS.indexOf(op) !== -1; }

  function makeRequest(req) {
    req = req || {};
    return { v: PROTOCOL_VERSION, id: req.id != null ? req.id : null, op: req.op, args: req.args || {} };
  }

  function validateRequest(req) {
    if (!req || typeof req !== 'object') return { ok: false, error: 'request-not-object' };
    if (!isOp(req.op)) return { ok: false, error: 'unknown-op:' + req.op };
    if (req.id == null) return { ok: false, error: 'missing-id' };
    return { ok: true };
  }

  function parseRequest(input) {
    var obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); } catch (e) { return { ok: false, error: 'bad-json' }; }
    }
    var v = validateRequest(obj);
    if (!v.ok) return v;
    return { ok: true, req: makeRequest(obj) };
  }

  function makeResponse(res) {
    res = res || {};
    var out = { v: PROTOCOL_VERSION, id: res.id != null ? res.id : null, ok: res.ok !== false };
    if (out.ok) out.result = (res.result !== undefined ? res.result : null);
    else out.error = res.error || 'error';
    return out;
  }

  function parseResponse(input) {
    var obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); } catch (e) { return { ok: false, error: 'bad-json' }; }
    }
    if (!obj || typeof obj !== 'object') return { ok: false, error: 'response-not-object' };
    return { ok: true, res: obj };
  }

  return {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    OPS: OPS,
    isOp: isOp,
    makeRequest: makeRequest,
    validateRequest: validateRequest,
    parseRequest: parseRequest,
    makeResponse: makeResponse,
    parseResponse: parseResponse
  };
});
