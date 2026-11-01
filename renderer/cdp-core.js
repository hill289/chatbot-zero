/*!
 * cdp-core.js — CDP 直连浏览器控制的「纯逻辑核心」
 * =============================================================================
 * 不依赖 Electron / DOM，可被主进程 require、也可被浏览器当全局脚本加载：
 *   1) buildSnapshot(nodes[, opts])  ：Accessibility.getFullAXTree 的扁平节点
 *        → 带自增 ref 的可交互元素清单 + 紧凑文本快照（Agent 的「感知」）。
 *   2) toDispatchPoint(quads, viewport)：DOM.getContentQuads 的四边形 →
 *        Input.dispatchMouseEvent 需要的「CSS 像素·视口坐标」（Puppeteer 同款）。
 *   3) buildClickCommands / buildInsertTextCommands / buildKeyTypeCommands /
 *        buildEnterCommands：构造真实输入（isTrusted=true）的 CDP 命令序列。
 *
 * UMD：Node 下 module.exports；浏览器挂到 globalThis.CdpCore。
 * =============================================================================
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CdpCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 常量 ─────────────────────────────────────────────────
  // 命中这些角色的元素才会被分到 ref（既可交互 / 也有语义价值）
  var INTERACTIVE_ROLES = {
    button: 1, link: 1, textbox: 1, searchbox: 1, checkbox: 1, radio: 1,
    switch: 1, combobox: 1, listbox: 1, option: 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, tab: 1, slider: 1, spinbutton: 1,
    heading: 1, textarea: 1,
  };
  var BUTTON_BITS = { left: 1, right: 2, middle: 4 };

  // ── 小工具 ───────────────────────────────────────────────
  function roleOf(node) {
    if (!node) return '';
    var r = node.role;
    if (r && typeof r === 'object') return String(r.value || '');
    return r ? String(r) : '';
  }
  function nameOf(node) {
    if (!node || !node.name) return '';
    var n = node.name;
    if (typeof n === 'object') return String(n.value == null ? '' : n.value);
    return String(n);
  }
  function valueOf(node) {
    if (!node || !node.value) return '';
    var v = node.value;
    if (typeof v === 'object') return v.value == null ? '' : v.value;
    return v;
  }
  // properties: [{name, value:{value}}] → 取某个属性值
  function propValue(node, name) {
    var props = (node && node.properties) || [];
    for (var i = 0; i < props.length; i++) {
      if (props[i] && props[i].name === name) {
        var pv = props[i].value;
        return (pv && typeof pv === 'object') ? pv.value : pv;
      }
    }
    return undefined;
  }

  // ── 无障碍树 → 带 ref 的元素快照 ─────────────────────────
  // nodes: Accessibility.getFullAXTree 的 nodes[]
  // opts : { url, title, maxRefs }
  // 返回 : { url, title, refs:[{ref,role,name,value,backendNodeId,depth,
  //          disabled,checked,focused}], byRef, backendToRef, text }
  function buildSnapshot(nodes, opts) {
    opts = opts || {};
    nodes = Array.isArray(nodes) ? nodes : [];
    var byId = new Map();
    nodes.forEach(function (n) { if (n && n.nodeId != null) byId.set(n.nodeId, n); });

    // 找根：优先 RootWebArea / nodeId==='root' / 未被任何 childIds 引用的节点
    var root = null;
    for (var i = 0; i < nodes.length; i++) {
      if (roleOf(nodes[i]).toLowerCase() === 'rootwebarea') { root = nodes[i]; break; }
    }
    if (!root) {
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j] && nodes[j].nodeId === 'root') { root = nodes[j]; break; }
      }
    }
    if (!root) {
      var childSet = new Set();
      nodes.forEach(function (n) { (n && n.childIds || []).forEach(function (c) { childSet.add(c); }); });
      for (var k = 0; k < nodes.length; k++) {
        if (nodes[k] && !childSet.has(nodes[k].nodeId)) { root = nodes[k]; break; }
      }
    }
    if (!root) root = nodes[0] || null;

    var refs = [];
    var byRef = {};
    var backendToRef = {};
    var maxRefs = opts.maxRefs && opts.maxRefs > 0 ? opts.maxRefs : Infinity;
    var nextRef = 1;

    // 迭代 DFS（childIds 优先），保持文档顺序
    var stack = root ? [{ node: root, depth: 0 }] : [];
    var visited = new Set();
    while (stack.length) {
      var cur = stack.pop();
      var node = cur.node;
      if (!node || visited.has(node.nodeId)) continue;
      visited.add(node.nodeId);

      var role = roleOf(node);
      var backendDOMNodeId = node.backendDOMNodeId;
      var assignable = !node.ignored
        && INTERACTIVE_ROLES[role]
        && typeof backendDOMNodeId === 'number'
        && backendDOMNodeId > 0;

      if (assignable && refs.length < maxRefs) {
        var entry = {
          ref: nextRef,
          role: role,
          name: nameOf(node),
          depth: cur.depth,
          backendNodeId: backendDOMNodeId,
        };
        var val = valueOf(node);
        if (val !== '' && val != null) entry.value = val;
        if (propValue(node, 'checked') !== undefined) entry.checked = propValue(node, 'checked');
        if (propValue(node, 'disabled') === true) entry.disabled = true;
        if (propValue(node, 'focused') === true) entry.focused = true;
        refs.push(entry);
        byRef[nextRef] = entry;
        backendToRef[backendDOMNodeId] = nextRef;
        nextRef++;
      }

      var kids = node.childIds || [];
      for (var c = kids.length - 1; c >= 0; c--) {
        var child = byId.get(kids[c]);
        if (child) stack.push({ node: child, depth: cur.depth + 1 });
      }
    }

    var text = renderSnapshot(opts, refs);
    return {
      url: opts.url || '',
      title: opts.title || '',
      refs: refs,
      byRef: byRef,
      backendToRef: backendToRef,
      text: text,
    };
  }

  // 把 refs 渲染成紧凑文本快照
  function renderSnapshot(opts, refs) {
    opts = opts || {};
    var head = 'Page: ' + (opts.title ? opts.title : '(无标题)')
      + (opts.url ? (' — ' + opts.url) : '');
    if (!refs || !refs.length) {
      return head + '\n（未发现可交互元素：可尝试 browser_screenshot 或 browser_evaluate）';
    }
    var lines = [head];
    for (var i = 0; i < refs.length; i++) {
      lines.push('  ' + formatRef(refs[i]));
    }
    return lines.join('\n');
  }

  function formatRef(e) {
    var indent = '';
    var d = Math.min(e.depth || 0, 6);
    for (var i = 1; i < d; i++) indent += '  '; // 根节点下的第一层不再缩进
    var s = indent + '[' + e.ref + '] ' + e.role;
    if (e.name) s += ' "' + e.name + '"';
    if (e.value !== undefined && e.value !== '') s += ' value="' + e.value + '"';
    if (e.checked !== undefined && e.checked !== false && e.checked !== 'false') s += ' checked';
    if (e.disabled) s += ' disabled';
    if (e.focused) s += ' focused';
    return s;
  }

  // ── 四边形 → 视口坐标（Input.dispatchMouseEvent 用）────────
  // quad: [x1,y1,x2,y2,x3,y3,x4,y4]（CSS 像素，已含滚动，即视口坐标）
  function quadCenter(quad) {
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
  }

  // 用「鞋带公式」算四边形面积（取绝对值）
  function quadArea(quad) {
    var xs = [quad[0], quad[2], quad[4], quad[6]];
    var ys = [quad[1], quad[3], quad[5], quad[7]];
    var area = 0;
    for (var i = 0; i < 4; i++) {
      var j = (i + 1) % 4;
      area += xs[i] * ys[j] - xs[j] * ys[i];
    }
    return Math.abs(area) / 2;
  }

  // 从多块四边形里挑「中心在视口内且面积最大」的一块；都没有则返回 null
  function pickVisibleQuad(quads, viewport) {
    if (!Array.isArray(quads) || !quads.length) return null;
    var w = (viewport && viewport.clientWidth) || 0;
    var h = (viewport && viewport.clientHeight) || 0;
    var best = null;
    for (var i = 0; i < quads.length; i++) {
      var q = quads[i];
      if (!q || q.length < 8) continue;
      var c = quadCenter(q);
      var inView = c.x >= 0 && c.y >= 0 && (w <= 0 || c.x <= w) && (h <= 0 || c.y <= h);
      if (!inView) continue;
      var a = quadArea(q);
      if (!best || a > best.area) best = { quad: q, center: c, area: a };
    }
    return best;
  }

  // 坐标换算主入口：quads + viewport → {x, y, visible}
  // visible=false 时 x/y 取第一块四边形中心（供上层决定是否滚动/报错）
  function toDispatchPoint(quads, viewport) {
    var pick = pickVisibleQuad(quads, viewport);
    if (pick) return { x: pick.center.x, y: pick.center.y, visible: true };
    if (Array.isArray(quads) && quads.length && quads[0] && quads[0].length >= 8) {
      var c = quadCenter(quads[0]);
      return { x: c.x, y: c.y, visible: false };
    }
    return { x: 0, y: 0, visible: false };
  }

  // ── 输入命令构造（isTrusted=true）─────────────────────────
  function assertXY(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) {
      throw new Error('点击坐标必须是数字 x/y');
    }
  }

  // 生成一次真实点击的命令序列（mouseMoved → (Pressed → Released)×clickCount）
  function buildClickCommands(o) {
    o = o || {};
    var x = o.x, y = o.y;
    assertXY(x, y);
    var button = o.button || 'left';
    var bits = BUTTON_BITS[button] != null ? BUTTON_BITS[button] : BUTTON_BITS.left;
    var count = o.clickCount == null ? 1 : Math.max(1, o.clickCount | 0);
    var modifiers = o.modifiers || 0;
    var cmds = [{
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mouseMoved', x: x, y: y, button: 'none', buttons: 0, modifiers: modifiers },
    }];
    for (var i = 1; i <= count; i++) {
      cmds.push({
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mousePressed', x: x, y: y, button: button, buttons: bits, clickCount: i, modifiers: modifiers },
      });
      cmds.push({
        method: 'Input.dispatchMouseEvent',
        params: { type: 'mouseReleased', x: x, y: y, button: button, buttons: 0, clickCount: i, modifiers: modifiers },
      });
    }
    return cmds;
  }

  // 走 IME 通道一次性插入文本（触发可信 input 事件，最快最稳）
  function buildInsertTextCommands(text) {
    var s = String(text == null ? '' : text);
    if (!s) return [];
    return [{ method: 'Input.insertText', params: { text: s } }];
  }

  function keyInfoFor(ch) {
    if (ch === ' ') return { key: ' ', code: 'Space', vk: 32 };
    if (ch === '\n' || ch === '\r') return { key: 'Enter', code: 'Enter', vk: 13 };
    if (/^[a-zA-Z]$/.test(ch)) {
      var up = ch.toUpperCase();
      return { key: ch, code: 'Key' + up, vk: up.charCodeAt(0) };
    }
    if (/^[0-9]$/.test(ch)) return { key: ch, code: 'Digit' + ch, vk: ch.charCodeAt(0) };
    return { key: ch, code: '', vk: 0 };
  }

  // 逐字符真实键盘事件（keyDown(text) + keyUp），需要 keydown 的应用用这个
  function buildKeyTypeCommands(text) {
    var s = String(text == null ? '' : text);
    var cmds = [];
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      var k = keyInfoFor(ch);
      cmds.push({
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyDown', text: ch, unmodifiedText: ch,
          key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
        },
      });
      cmds.push({
        method: 'Input.dispatchKeyEvent',
        params: {
          type: 'keyUp', key: k.key, code: k.code,
          windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
        },
      });
    }
    return cmds;
  }

  // 回车（提交表单 / 触发搜索）
  function buildEnterCommands() {
    return [
      { method: 'Input.dispatchKeyEvent', params: { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'char', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } },
    ];
  }

  return {
    INTERACTIVE_ROLES: INTERACTIVE_ROLES,
    BUTTON_BITS: BUTTON_BITS,
    buildSnapshot: buildSnapshot,
    renderSnapshot: renderSnapshot,
    formatRef: formatRef,
    quadCenter: quadCenter,
    quadArea: quadArea,
    pickVisibleQuad: pickVisibleQuad,
    toDispatchPoint: toDispatchPoint,
    buildClickCommands: buildClickCommands,
    buildInsertTextCommands: buildInsertTextCommands,
    buildKeyTypeCommands: buildKeyTypeCommands,
    buildEnterCommands: buildEnterCommands,
  };
});
