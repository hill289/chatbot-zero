/*!
 * sandbox/config.js — 沙箱配置归一化（Node 侧，main.js 用）
 */
'use strict';

const DEFAULTS = {
  enabled: true,
  mode: 'auto',            // off | policy | auto | win-job
  allowNetwork: false,
  memoryMB: 1024,
  cpuSec: 300,
  pidsLimit: 256,
  ignoreScripts: true,
  restrictedToken: false,  // 预留：需提权 helper，当前仅记录
  envAllowlist: []         // 空 = 敏感变量 denylist 模式
};

function clampInt(v, min, max, def) {
  v = Number(v);
  if (!isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function normalizeConfig(cfg) {
  cfg = cfg || {};
  const out = Object.assign({}, DEFAULTS, cfg);
  out.enabled = out.enabled !== false;
  out.mode = String(out.mode || 'auto').toLowerCase();
  if (['off', 'policy', 'auto', 'win-job'].indexOf(out.mode) < 0) out.mode = 'auto';
  out.allowNetwork = !!out.allowNetwork;
  out.memoryMB = clampInt(out.memoryMB, 64, 65536, DEFAULTS.memoryMB);
  out.cpuSec = clampInt(out.cpuSec, 1, 86400, DEFAULTS.cpuSec);
  out.pidsLimit = clampInt(out.pidsLimit, 1, 4096, DEFAULTS.pidsLimit);
  out.ignoreScripts = out.ignoreScripts !== false;
  out.restrictedToken = !!out.restrictedToken;
  out.envAllowlist = Array.isArray(out.envAllowlist) ? out.envAllowlist.filter((x) => typeof x === 'string') : [];
  return out;
}

module.exports = { DEFAULTS, normalizeConfig, clampInt };
