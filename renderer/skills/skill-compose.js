/*!
 * skill-compose.js — 把激活的技能「编译」进 system 片段（前缀缓存友好）
 * -----------------------------------------------------------------------------
 * 关键约束：同一技能集合 → 必须产出【逐字节相同】的文本，否则会持续打破
 * DeepSeek 前缀缓存。故：按 name 排序 + 固定分隔符 + 不使用时间戳。
 * 变更（启用/停用/编辑）时由 bootstrap 调 prefixManager.invalidateSystem()，
 * 只接受「一次 cache miss」，之后保持稳定。
 *
 * UMD：浏览器挂 globalThis.SkillCompose；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SkillCompose = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

  // 单条技能 → system 片段（确定性）
  function renderSkill(skill) {
    var out = [];
    out.push('### SKILL: ' + skill.name);
    if (skill.description) out.push(clip(skill.description, 400));
    if (skill.outputTemplate) out.push('【输出模板】\n' + clip(skill.outputTemplate, 2000));
    if (skill.body && skill.body.trim()) out.push('【方法论】\n' + clip(skill.body.trim(), 4000));
    if (skill.rules && skill.rules.length) out.push('【规则】\n' + skill.rules.map(function (r) { return '- ' + r; }).join('\n'));
    if (skill.toolWhitelist && skill.toolWhitelist.length) out.push('【可用工具】' + skill.toolWhitelist.join(', '));
    return out.join('\n');
  }

  // 技能数组 → 完整 system 附件（按 name 排序保证字节稳定）
  function composeSystem(skills) {
    var arr = (skills || []).slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    if (!arr.length) return '';
    return '# 已启用技能 / Active Skills\n' + arr.map(renderSkill).join('\n\n');
  }

  // 工具白名单并集（null 表示不限制）。用于软约束（越权调用记警告，不改 tools 前缀）。
  function toolWhitelistFor(skills) {
    var arr = skills || [];
    if (!arr.length) return null;
    var any = false, set = {};
    arr.forEach(function (s) {
      if (s.toolWhitelist && s.toolWhitelist.length) { any = true; s.toolWhitelist.forEach(function (t) { set[t] = 1; }); }
    });
    return any ? Object.keys(set) : null;
  }

  // 输出模板渲染：{{var}} → 值（缺失保留占位，便于排查）
  function renderOutput(template, vars) {
    vars = vars || {};
    return String(template == null ? '' : template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (m, k) {
      var v = vars[k];
      return (v === undefined || v === null) ? m : String(v);
    });
  }

  return { renderSkill: renderSkill, composeSystem: composeSystem, toolWhitelistFor: toolWhitelistFor, renderOutput: renderOutput };
});
