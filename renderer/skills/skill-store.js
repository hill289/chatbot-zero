/*!
 * skill-store.js — SKILL.md 技能存储（解析 / 校验 / 增删改查 / 导入导出）
 * -----------------------------------------------------------------------------
 * SKILL.md 规范（兼容 OpenClaw / WorkBuddy 的 skill 生态，可双向迁移）：
 *
 *   ---
 *   name: weekly-report                 # 必填，唯一
 *   description: 生成结构化周报          # 必填
 *   version: 1
 *   toolWhitelist: [read_file, chart]   # 可选：本技能允许使用的工具
 *   rules:                              # 可选：额外约束
 *     - 数据必须来自实际日志
 *   outputTemplate: |                   # 可选：输出模板
 *     # 周报
 *   ---
 *   ## 适用场景
 *   ...
 *   ## 执行步骤
 *   1. ...
 *
 * 纯逻辑（parse/validate）+ 轻量存储（IndexedDB 不可用则 localStorage/内存）。
 * 数据全部本地，不经服务器。
 *
 * UMD：浏览器挂 globalThis.SkillStore；Node 下 module.exports（供单测）。
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SkillStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
  var STORE_KEY = 'skillStore';

  // ── 小工具 ──
  function stripQuotes(s) {
    s = String(s == null ? '' : s).trim();
    if ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'")) return s.slice(1, -1);
    return s;
  }
  function indentOf(line) { var m = /^\s*/.exec(line); return m ? m[0].length : 0; }
  // 标量强制转换：数字/布尔/null 还原为原生类型，其余保持字符串
  function coerceScalar(s) {
    var t = String(s == null ? '' : s).trim();
    if (t === '') return '';
    if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
    if (/^(null|~)$/i.test(t)) return null;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
    return s;
  }

  // 极简 YAML 解析（仅覆盖 SKILL.md front-matter 用到的子集）
  function parseYamlLite(fm) {
    var out = {};
    var lines = String(fm || '').split(/\r?\n/);
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (!line.trim() || /^\s*#/.test(line)) { i++; continue; }
      var m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) { i++; continue; }
      var key = m[1], rest = m[2], base = indentOf(line);
      if (rest === '') {
        var items = [], block = [];
        i++;
        while (i < lines.length) {
          var l = lines[i];
          if (l.trim() === '') { i++; continue; }
          if (indentOf(l) <= base) break;
          var im = /^\s*-\s+(.*)$/.exec(l);
          if (im) items.push(stripQuotes(im[1])); else block.push(l.trim());
          i++;
        }
        out[key] = items.length ? items : block.join('\n');
        continue;
      }
      if (rest === '|' || rest === '>' || /^[|>][-+]?$/.test(rest)) {
        var blk = [];
        i++;
        while (i < lines.length) {
          var l2 = lines[i];
          if (l2.trim() === '') { blk.push(''); i++; continue; }
          if (indentOf(l2) <= base) break;
          blk.push(l2.replace(/^\s{2}/, '')); i++;
        }
        while (blk.length && blk[blk.length - 1] === '') blk.pop();
        out[key] = blk.join('\n');
        continue;
      }
      if (/^\[.*\]$/.test(rest.trim())) {
        out[key] = rest.trim().slice(1, -1).split(',').map(function (s) { return stripQuotes(s); }).filter(Boolean);
        i++; continue;
      }
      out[key] = coerceScalar(stripQuotes(rest)); i++;
    }
    return out;
  }

  function parseSkillMD(text) {
    var errors = [];
    var src = String(text == null ? '' : text);
    var fm = '', body = src;
    var m = /^\uFEFF?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
    if (m) { fm = m[1]; body = m[2]; }
    else errors.push('缺少 front-matter（应以 --- 包裹的 YAML 开头）');
    var meta = {};
    try { meta = parseYamlLite(fm); } catch (e) { errors.push('front-matter 解析失败：' + (e && e.message)); }
    if (meta.toolWhitelist && !Array.isArray(meta.toolWhitelist)) meta.toolWhitelist = [meta.toolWhitelist];
    if (meta.rules && !Array.isArray(meta.rules)) meta.rules = [meta.rules];
    return { meta: meta, body: body.replace(/^\s*\n/, ''), errors: errors };
  }

  function validateSkill(meta) {
    var e = [];
    var name = meta && meta.name;
    if (!name || typeof name !== 'string') e.push('缺少 name');
    else if (!NAME_RE.test(name)) e.push('name 非法（^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$）');
    if (!meta || !meta.description || typeof meta.description !== 'string' || !meta.description.trim()) e.push('缺少 description');
    return e;
  }

  // ── 存储（默认后端探测：persist → localStorage → 内存）──
  function makeBackend() {
    try {
      if (typeof persist !== 'undefined' && persist && persist.load && persist.save) {
        return { load: function () { return persist.load(STORE_KEY, null); }, save: function (v) { persist.save(STORE_KEY, v); } };
      }
    } catch (_) {}
    try {
      if (root && root.localStorage) {
        return {
          load: function () { try { return JSON.parse(root.localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { return null; } },
          save: function (v) { try { root.localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch (_) {} }
        };
      }
    } catch (_) {}
    var mem = null;
    return { load: function () { return mem; }, save: function (v) { mem = v; } };
  }

  function createStore(backend) {
    backend = backend || makeBackend();
    var skills = {};   // name -> record
    var order = [];
    var listeners = new Set();

    function emit(evt) { listeners.forEach(function (fn) { try { fn(evt); } catch (_) {} }); }
    function now() { return Date.now(); }

    function normalize(meta, body) {
      return {
        name: String(meta.name),
        description: String(meta.description || ''),
        version: meta.version || 1,
        author: meta.author || '',
        source: meta.source || 'user',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        toolWhitelist: Array.isArray(meta.toolWhitelist) && meta.toolWhitelist.length ? meta.toolWhitelist : null,
        rules: Array.isArray(meta.rules) ? meta.rules : [],
        outputTemplate: meta.outputTemplate || '',
        inputs: Array.isArray(meta.inputs) ? meta.inputs : [],
        body: String(body || ''),
        enabled: !!meta.enabled,
        createdAt: meta.createdAt || now(),
        updatedAt: now(),
        hash: hashText(String(meta.name) + '\u0000' + String(body || '') + '\u0000' + JSON.stringify(meta.toolWhitelist || null))
      };
    }

    var store = {
      VERSION: 1,
      parseSkillMD: parseSkillMD,
      validateSkill: validateSkill,

      add: function (mdOrRecord, opts) {
        opts = opts || {};
        var rec;
        if (typeof mdOrRecord === 'string') {
          var parsed = parseSkillMD(mdOrRecord);
          var errs = validateSkill(parsed.meta);
          if (errs.length) return { ok: false, errors: errs };
          rec = normalize(parsed.meta, parsed.body);
        } else if (mdOrRecord && typeof mdOrRecord === 'object') {
          var em = validateSkill(mdOrRecord);
          if (em.length) return { ok: false, errors: em };
          rec = normalize(mdOrRecord, mdOrRecord.body || '');
        } else return { ok: false, errors: ['无效的技能定义'] };

        var exists = !!skills[rec.name];
        if (exists && !opts.override) return { ok: false, errors: ['技能已存在：' + rec.name + '（用 override 覆盖）'] };
        if (exists) { rec.enabled = skills[rec.name].enabled; rec.createdAt = skills[rec.name].createdAt; }
        else order.push(rec.name);
        skills[rec.name] = rec;
        store.persist();
        emit({ type: exists ? 'update' : 'add', name: rec.name });
        return { ok: true, skill: rec };
      },

      remove: function (name) {
        if (!skills[name]) return { ok: false };
        delete skills[name];
        order = order.filter(function (n) { return n !== name; });
        store.persist(); emit({ type: 'remove', name: name });
        return { ok: true };
      },

      get: function (name) { return skills[name] || null; },

      list: function (opts) {
        opts = opts || {};
        var arr = order.map(function (n) { return skills[n]; }).filter(Boolean);
        if (opts.enabledOnly) arr = arr.filter(function (s) { return s.enabled; });
        if (opts.tag) arr = arr.filter(function (s) { return (s.tags || []).indexOf(opts.tag) !== -1; });
        arr.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }); // 确定性排序
        return arr;
      },

      setEnabled: function (name, v) {
        if (!skills[name]) return false;
        skills[name].enabled = !!v;
        skills[name].updatedAt = now();
        store.persist(); emit({ type: 'toggle', name: name, enabled: skills[name].enabled });
        return true;
      },

      exportSkill: function (name, format) {
        var s = skills[name]; if (!s) return '';
        if (format === 'json') return JSON.stringify(s, null, 2);
        return serializeSkillMD(s);
      },
      exportJSON: function (opts) { return JSON.stringify({ version: 1, skills: (opts && opts.enabledOnly ? store.list({ enabledOnly: true }) : store.list()) }, null, 2); },
      importJSON: function (text, opts) {
        var data; try { data = JSON.parse(text); } catch (e) { return { ok: false, errors: ['JSON 解析失败'] }; }
        var arr = Array.isArray(data) ? data : (data && data.skills) || [];
        var n = 0, errs = [];
        arr.forEach(function (s) { var r = store.add(s, opts); if (r.ok) n++; else errs = errs.concat(r.errors); });
        return { ok: n > 0, count: n, errors: errs };
      },

      onChange: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },

      persist: function () { try { backend.save({ version: 1, skills: store.list() }); } catch (_) {} },
      load: function () {
        var data = null; try { data = backend.load(); } catch (_) {}
        if (data && Array.isArray(data.skills)) {
          data.skills.forEach(function (s) { if (s && s.name) { if (order.indexOf(s.name) === -1) order.push(s.name); skills[s.name] = Object.assign({}, s); } });
        }
        return store.list().length;
      },
      clear: function () { skills = {}; order = []; store.persist(); emit({ type: 'clear' }); }
    };
    return store;
  }

  function serializeSkillMD(s) {
    var fm = ['---', 'name: ' + s.name, 'description: ' + s.description];
    if (s.version) fm.push('version: ' + s.version);
    if (s.author) fm.push('author: ' + s.author);
    if (s.source) fm.push('source: ' + s.source);
    if (s.toolWhitelist && s.toolWhitelist.length) fm.push('toolWhitelist: [' + s.toolWhitelist.join(', ') + ']');
    if (s.inputs && s.inputs.length) fm.push('inputs: ' + JSON.stringify(s.inputs));
    if (s.rules && s.rules.length) { fm.push('rules:'); s.rules.forEach(function (r) { fm.push('  - ' + r); }); }
    if (s.outputTemplate) { fm.push('outputTemplate: |'); String(s.outputTemplate).split('\n').forEach(function (l) { fm.push('  ' + l); }); }
    fm.push('---', '');
    return fm.join('\n') + '\n' + (s.body || '');
  }

  function hashText(str) {
    str = String(str == null ? '' : str);
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8) + ':' + str.length;
  }

  // 默认实例（浏览器/宿主环境自动挂 globalThis.SkillStore）
  var defaultStore = createStore();
  defaultStore.parseSkillMD = parseSkillMD;
  defaultStore.validateSkill = validateSkill;
  defaultStore.serializeSkillMD = serializeSkillMD;
  defaultStore.createStore = createStore;
  defaultStore.hashText = hashText;
  return defaultStore;
});
