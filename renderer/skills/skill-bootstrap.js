/*!
 * skill-bootstrap.js — 技能体系接线（零侵入接入既有工具循环与前缀缓存）
 * -----------------------------------------------------------------------------
 *   1) 载入技能库；首次运行把 builtin-skills 播种进去（默认未启用）。
 *   2) 包一层 prefixManager.getSystem()：把【已启用技能】编译成的 system 片段
 *      追加到 system 末尾；技能集合变化时 invalidateSystem()（一次 cache miss）。
 *   3) 注册 skill_* 工具（走可插拔注册表 → 自动进入工具循环与工具指纹）。
 *   4) 暴露 window.SkillsBridge 供 UI / 第三方调用。
 *
 * 依赖（缺失时全部静默降级）：SkillStore / SkillCompose / BUILTIN_SKILLS /
 *   prefixManager(10) / window.registerTool(07) / nodeRuntime(读文件)。
 */
(function (root) {
  'use strict';
  function get(k) { try { return root[k]; } catch (_) { return undefined; } }
  var Store = get('SkillStore');
  var Compose = get('SkillCompose');
  if (!Store || !Compose) { try { console.warn('[skills] store/compose 未加载，技能体系禁用'); } catch (_) {} return; }

  // ── 1) system 附件 + 变更失效 ──
  Store.systemAddendum = function () {
    try { return Compose.composeSystem(Store.list({ enabledOnly: true })); } catch (_) { return ''; }
  };
  Store.toolWhitelist = function () {
    try { return Compose.toolWhitelistFor(Store.list({ enabledOnly: true })); } catch (_) { return null; }
  };

  // 注意：prefixManager 是 10-prefix-cache.js 顶层的 `const`（全局词法绑定），
  // 并非 window 属性；必须用【裸标识符】访问，不能用 globalThis.prefixManager。
  var _pm = null;
  try { _pm = (typeof prefixManager !== 'undefined') ? prefixManager : null; } catch (_) { _pm = null; }
  if (_pm && typeof _pm.getSystem === 'function' && !_pm.__skillsWrapped) {
    _pm.__skillsWrapped = true;
    var baseGetSystem = _pm.getSystem;
    _pm.getSystem = function () {
      var s = baseGetSystem.call(this);
      var add = Store.systemAddendum();
      return add ? (s + '\n\n' + add) : s;
    };
  }

  var lastSig = null;
  function sig() { return Store.list({ enabledOnly: true }).map(function (s) { return s.name + ':' + s.hash; }).join('|'); }
  Store.load();
  // 首次运行：播种内置技能（默认未启用）
  if (Store.list().length === 0) {
    var builtin = get('BUILTIN_SKILLS');
    if (builtin && builtin.list) {
      builtin.list().forEach(function (md) { Store.add(md, { override: true }); });
      Store.list().forEach(function (s) { Store.setEnabled(s.name, false); });
    }
  }
  lastSig = sig();
  Store.onChange(function () {
    var cur = sig();
    if (cur !== lastSig) {
      lastSig = cur;
      try { if (_pm && _pm.invalidateSystem) _pm.invalidateSystem(); } catch (_) {}
    }
    try { if (root.SkillsUI && root.SkillsUI.refresh) root.SkillsUI.refresh(); } catch (_) {}
  });

  // ── 2) 工具 ──
  function mcp(ok, text, extra) { return JSON.stringify(Object.assign({ success: !!ok, content: [{ type: 'text', text: String(text) }] }, extra || {})); }
  function summaryLine(s) { return (s.enabled ? '[x] ' : '[ ] ') + s.name + ' — ' + (s.description || ''); }

  function toolSkillList() {
    var arr = Store.list();
    if (!arr.length) return mcp(true, '技能库为空。可用 skill_install 安装，或 skill_create 创建。');
    return mcp(true, '技能库（' + arr.length + ' 条，[x]=已启用）：\n' + arr.map(summaryLine).join('\n'));
  }
  function toolSkillGet(a) {
    var s = Store.get((a && a.name) || '');
    if (!s) return mcp(false, '未找到技能：' + ((a && a.name) || ''));
    return mcp(true, Store.exportSkill(s.name, 'skillmd'));
  }
  function toolSkillInstall(a) {
    a = a || {};
    var text = a.text || a.md || a.content;
    if (!text && a.path) {
      try {
        var nr = root.nodeRuntime;
        if (nr && nr.FS && nr.ready) text = new TextDecoder().decode(nr.FS.readFile(a.path, { encoding: 'binary' }));
      } catch (e) { return mcp(false, '读取路径失败：' + (e && e.message)); }
    }
    if (!text && a.url && root.fileAPI && root.fileAPI.fetchUrl) {
      return root.fileAPI.fetchUrl(a.url, {}).then(function (r) {
        var t = r && r.base64 ? atob(r.base64) : '';
        var res = Store.add(t, { override: !!a.override });
        return res.ok ? mcp(true, '已从 URL 安装技能：' + res.skill.name) : mcp(false, (res.errors || []).join('；'));
      });
    }
    if (!text) return mcp(false, 'skill_install 需要 text，或 path，或 url。');
    var res = Store.add(text, { override: !!a.override });
    return res.ok ? mcp(true, '已安装技能：' + res.skill.name + (a.enable ? '（已启用）' : '')) : mcp(false, (res.errors || []).join('；'));
  }
  function toolSkillCreate(a) {
    a = a || {};
    if (!a.name || !a.description) return mcp(false, 'skill_create 需要 name 与 description。');
    var md = ['---', 'name: ' + a.name, 'description: ' + a.description];
    if (a.toolWhitelist) md.push('toolWhitelist: [' + [].concat(a.toolWhitelist).join(', ') + ']');
    if (a.rules && a.rules.length) { md.push('rules:'); [].concat(a.rules).forEach(function (r) { md.push('  - ' + r); }); }
    if (a.outputTemplate) { md.push('outputTemplate: |'); String(a.outputTemplate).split('\n').forEach(function (l) { md.push('  ' + l); }); }
    md.push('---', '');
    md.push(a.body || '## 适用场景\n- （待补充）\n## 执行步骤\n1. （待补充）\n');
    var res = Store.add(md.join('\n'), { override: true });
    if (!res.ok) return mcp(false, (res.errors || []).join('；'));
    if (a.enable) Store.setEnabled(res.skill.name, true);
    return mcp(true, '已创建技能：' + res.skill.name + '。可用 skill_get 查看，或在 🧩 面板中编辑。');
  }
  function toolSkillToggle(a) {
    a = a || {};
    var on = (a.enabled === undefined) ? true : !!a.enabled;
    if (!Store.get(a.name)) return mcp(false, '未找到技能：' + (a.name || ''));
    Store.setEnabled(a.name, on);
    return mcp(true, '技能 ' + a.name + (on ? ' 已启用（下一轮 system 前缀变更，一次 cache miss）' : ' 已停用'));
  }

  var registerTool = get('registerTool');
  if (typeof registerTool === 'function') {
    registerTool({
      name: 'skill_list', description: '列出技能库（含启用状态）。无需参数。', tags: ['skill', 'builtin'],
      inputSchema: { type: 'object', properties: {}, required: [] }, handler: toolSkillList
    });
    registerTool({
      name: 'skill_get', description: '读取某技能的完整 SKILL.md。Args: { name }', tags: ['skill', 'builtin'],
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      handler: function (a) { return toolSkillGet(a); }
    });
    registerTool({
      name: 'skill_install', description: '安装技能：传 text（SKILL.md 内容）或 { path } 或 { url }。Args: { text|path|url, override?, enable? }', tags: ['skill', 'builtin'],
      inputSchema: { type: 'object', properties: { text: { type: 'string' }, path: { type: 'string' }, url: { type: 'string' }, override: { type: 'boolean' }, enable: { type: 'boolean' } }, required: [] },
      handler: toolSkillInstall
    });
    registerTool({
      name: 'skill_create', description: '创建技能（自动组装 SKILL.md）。Args: { name, description, body?, toolWhitelist?, rules?, outputTemplate?, enable? }', tags: ['skill', 'builtin'],
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' }, toolWhitelist: { type: 'array', items: {} }, rules: { type: 'array', items: {} }, outputTemplate: { type: 'string' }, enable: { type: 'boolean' } }, required: ['name', 'description'] },
      handler: toolSkillCreate
    });
    registerTool({
      name: 'skill_toggle', description: '启用/停用技能。Args: { name, enabled?（默认 true）}', tags: ['skill', 'builtin'],
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, enabled: { type: 'boolean' } }, required: ['name'] },
      handler: toolSkillToggle
    });
  } else {
    try { console.warn('[skills] registerTool 不可用（07-mcp 未加载？），skill_* 工具未注册'); } catch (_) {}
  }

  // ── 3) 对外桥接 ──
  root.SkillsBridge = {
    list: function () { return Store.list(); },
    enabled: function () { return Store.list({ enabledOnly: true }); },
    get: function (n) { return Store.get(n); },
    install: function (text, opts) { return Store.add(text, opts); },
    enable: function (n, v) { return Store.setEnabled(n, v); },
    remove: function (n) { return Store.remove(n); },
    systemAddendum: function () { return Store.systemAddendum(); },
    exportAll: function () { return Store.exportJSON({}); },
    importJSON: function (t, o) { return Store.importJSON(t, o); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
