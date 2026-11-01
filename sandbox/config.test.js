/*!
 * sandbox/config.test.js — config.js 的 Node 自检（零依赖）
 * 运行： node sandbox/config.test.js
 */
'use strict';
const C = require('./config.js');
let pass = 0, fail = 0;
function ok(c, m) { c ? pass++ : (fail++, console.error('  ✗ ' + m)); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

group('默认值');
{
  const c = C.normalizeConfig();
  eq(c.enabled, true, 'enabled');
  eq(c.mode, 'auto', 'mode');
  eq(c.allowNetwork, false, 'allowNetwork');
  eq(c.memoryMB, 1024, 'memoryMB');
  eq(c.pidsLimit, 256, 'pidsLimit');
  eq(c.ignoreScripts, true, 'ignoreScripts');
  eq(Array.isArray(c.envAllowlist), true, 'envAllowlist 数组');
}

group('归一化与钳制');
{
  eq(C.normalizeConfig({ mode: 'OFF' }).mode, 'off', 'mode 小写');
  eq(C.normalizeConfig({ mode: 'bogus' }).mode, 'auto', '非法 mode → auto');
  eq(C.normalizeConfig({ enabled: false }).enabled, false, 'enabled false');
  eq(C.normalizeConfig({ memoryMB: 1 }).memoryMB, 64, 'memoryMB 下界');
  eq(C.normalizeConfig({ memoryMB: 999999 }).memoryMB, 65536, 'memoryMB 上界');
  eq(C.normalizeConfig({ pidsLimit: 0 }).pidsLimit, 1, 'pids 下界');
  eq(C.normalizeConfig({ cpuSec: -5 }).cpuSec, 1, 'cpu 下界');
  eq(C.normalizeConfig({ envAllowlist: ['A', 1, 'B'] }).envAllowlist, ['A', 'B'], '过滤非字符串');
  eq(C.normalizeConfig({ ignoreScripts: false }).ignoreScripts, false, '可关闭 ignoreScripts');
}

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
