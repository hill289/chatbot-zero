/*!
 * plan-mode.test.js — 19-plan-mode.js 的 Node 自检（零依赖）
 * 运行： node renderer/assets/js/plan-mode.test.js
 *
 * 本测试只访问模块的纯逻辑（__pure）与无副作用方法（gateFor），
 * 不触碰真实 planStore / DOM，可在任意环境安全运行。
 */
'use strict';
const PM = require('./19-plan-mode.js');
const P = PM.__pure;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), msg + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

// ── 1. 归一化 ──
group('normalizeSteps');
const s1 = P.normalizeSteps(['读数据', { content: ' 出图 ', status: 'done', tool: 'chart', risk: 'high', dependsOn: 'p1' }]);
eq(s1.length, 2, '两条步骤保留');
eq(s1[0].content, '读数据', '字符串步骤 → content');
eq(s1[0].status, 'pending', '默认 pending');
eq(s1[1].content, '出图', 'trim content');
eq(s1[1].status, 'completed', 'status 别名 done → completed');
eq(s1[1].risk, 'high', 'risk 保留');

group('normalizeSteps · 空/去重/单一进行中');
const s2 = P.normalizeSteps([{ content: '' }, 'A', 'A', { content: 'B', status: 'in_progress' }, { content: 'C', status: 'doing' }]);
eq(s2.length, 4, '空步骤被丢弃，其余保留（含同名 A）');
eq(s2.filter(x => x.status === 'in_progress').length, 1, '只保留一个 in_progress');
ok(s2[0].id !== s2[1].id, '重复步骤 id 已去重');

// ── 2. 风险判定 ──
group('classifyRisk');
eq(P.classifyRisk('write_file', {}), 'high', 'write_file 高风险');
eq(P.classifyRisk('delete_file', {}), 'high', 'delete_file 高风险');
eq(P.classifyRisk('run_node', { code: "require('fs').writeFileSync('/x','y')" }), 'high', 'run_node 写盘高风险');
eq(P.classifyRisk('run_node', { code: 'return 1+1' }), 'low', 'run_node 纯计算低风险');
eq(P.classifyRisk('markdown_to_pdf', { output_path: '/a.pdf' }), 'low', '文档工具低风险');
eq(P.classifyRisk('read_file', {}), 'low', '只读低风险');

// ── 3. 依赖校验（+ 归一化联动）──
group('validateDepends');
eq(P.validateDepends([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }]).length, 0, '正常依赖无错');
ok(P.validateDepends([{ id: 'a', dependsOn: ['zzz'] }]).length > 0, '未知依赖报错');
const cyc = P.validateDepends([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]);
ok(cyc.some(e => /环/.test(e)), '环形依赖报错');
eq(P.validateDepends(P.normalizeSteps([{ id: 'a', content: 'x' }, { id: 'b', content: 'y', dependsOn: ['a'] }])).length, 0, '归一化后依赖正常');

// ── 4. 模式文本 ──
group('mode');
eq(P.modeLabel('plan').indexOf('Plan') >= 0, true, 'modeLabel plan');
ok(P.buildModeNote('plan').indexOf('plan_write') >= 0, 'plan 模式提示含 plan_write');
ok(P.buildModeNote('ask').indexOf('Ask') >= 0, 'ask 模式提示');
eq(P.buildModeNote('craft'), '', 'craft 模式不注入');

// ── 5. 快照（格式：`N. [mark] content`）──
group('snapshotText');
const snap = P.snapshotText('出周报', P.normalizeSteps(['读数据', { content: '出图', status: 'completed' }]));
ok(/目标: 出周报/.test(snap), '含目标');
ok(/1\. \[ \] 读数据/.test(snap), 'pending 标记');
ok(/2\. \[x\] 出图/.test(snap), 'completed 标记');
ok(/1\/2 已完成/.test(snap), '进度');

// ── 6. 审批门（只读判定，不触碰 planStore）──
group('gateFor / beforeToolCall');
ok(typeof PM.beforeToolCall('read_file', {}) === 'object', 'beforeToolCall 返回 Promise');
const saveMode = PM.mode, saveAppr = PM.approval;
PM.mode = 'plan';
let g = PM.gateFor('write_file', {});
ok(g && g.kind === 'block', 'plan 模式下写操作被 block');
eq(PM.gateFor('read_file', {}), null, 'plan 模式下只读放行');
PM.mode = 'craft';
PM.approval = true;
g = PM.gateFor('delete_file', {});
ok(g && g.kind === 'ask', 'craft + 审批开：写操作 ask');
PM.approval = false;
eq(PM.gateFor('delete_file', {}), null, '审批关：不拦截');
PM.mode = saveMode; PM.approval = saveAppr; // 还原

console.log('\n──────────────────────────────');
console.log('plan-mode.test: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
