/*!
 * skill-layer.test.js — 技能体系 Node 自检（零依赖）
 * 运行： node renderer/skills/skill-layer.test.js
 */
'use strict';
const Store = require('./skill-store.js');
const Compose = require('./skill-compose.js');
const Builtin = require('./builtin-skills.js');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function group(t) { console.log('\n▶ ' + t); }

const MD = `---
name: weekly-report
description: 生成周报
version: 2
toolWhitelist: [read_file, write_file]
rules:
  - 不得编造
  - 量化结果
outputTemplate: |
  # 周报（{{week}}）
  ## 成果
---
## 执行步骤
1. 读取日志
2. 组织三段式
`;

group('parseSkillMD');
const p = Store.parseSkillMD(MD);
eq(p.errors.length, 0, '无解析错误');
eq(p.meta.name, 'weekly-report', 'name');
eq(p.meta.version, 2, 'number 字段');
eq(p.meta.toolWhitelist, ['read_file', 'write_file'], 'inline 数组');
eq(p.meta.rules.length, 2, '块列表 rules');
ok(/## 成果/.test(p.meta.outputTemplate), '块标量 outputTemplate');
ok(/执行步骤/.test(p.body), '正文 body');

group('validateSkill');
eq(Store.validateSkill({ name: 'ok_name', description: 'x' }).length, 0, '合法');
ok(Store.validateSkill({ name: 'bad name!', description: 'x' }).length > 0, 'name 非法报错');
ok(Store.validateSkill({ name: 'ok' }).length > 0, '缺 description 报错');

group('composeSystem · 字节稳定性');
const s1 = Store.parseSkillMD(MD).meta; s1.body = 'B1';
const s2 = { name: 'meeting-minutes', description: '纪要', body: 'B2', rules: [] };
const a1 = Compose.composeSystem([{ ...s1, name: 'z-skill' }, s2]);
const a2 = Compose.composeSystem([s2, { ...s1, name: 'z-skill' }]);   // 顺序颠倒
eq(a1 === a2, true, '同集合同字节（与输入顺序无关）');
ok(a1.indexOf('meeting-minutes') < a1.indexOf('z-skill'), '按 name 排序');
eq(Compose.composeSystem([]), '', '空集合 → 空串');

group('toolWhitelistFor / renderOutput');
eq(Compose.toolWhitelistFor([{ toolWhitelist: ['a', 'b'] }, { toolWhitelist: ['b', 'c'] }]).sort(), ['a', 'b', 'c'], '并集');
eq(Compose.toolWhitelistFor([{ description: 'x' }]), null, '无白名单 → null');
eq(Compose.renderOutput('hi {{name}}, {{missing}}', { name: 'A' }), 'hi A, {{missing}}', '模板渲染');

group('store CRUD + 往返导出');
const st = Store.createStore(Store.makeBackend ? undefined : undefined); // 内存后端
const add = st.add(MD, { override: true });
ok(add.ok, '新增技能');
eq(st.list().length, 1, '列表 1 条');
st.setEnabled('weekly-report', true);
eq(st.list({ enabledOnly: true }).length, 1, '启用过滤');
const md2 = st.exportSkill('weekly-report', 'skillmd');
const re = Store.parseSkillMD(md2);
eq(re.meta.name, 'weekly-report', '导出再解析 name 不变');
ok(st.add(MD).ok === false, '重名默认拒绝');
ok(st.add(MD, { override: true }).ok, 'override 覆盖');
const js = st.exportJSON({});
const st2 = Store.createStore();
eq(st2.importJSON(js).count, 1, 'JSON 导入');
st.remove('weekly-report');
eq(st.list().length, 0, '删除');

group('内置技能可解析');
let bad = 0;
Builtin.list().forEach(function (txt) { if (Store.parseSkillMD(txt).errors.length) bad++; });
eq(bad, 0, 'builtin 全部可解析（' + Builtin.list().length + ' 条）');

console.log('\n──────────────────────────────');
console.log('skill-layer.test: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exitCode = 1;
