/*!
 * browser-cdp.js — 主进程「CDP 直连」浏览器控制驱动 + bcdp:* IPC 注册
 * =============================================================================
 * 不引入 Puppeteer / Playwright / 外部 Chrome：直接 attach 目标标签页的
 * webContents.debugger（Electron 自带 Chromium 的原生 CDP 通道），
 * 以 isTrusted=true 的方式派发输入、走无障碍树做感知。
 *
 * 纯逻辑（a11y→refs、四边形→视口坐标、输入命令构造）在 renderer/cdp-core.js；
 * 本文件只负责「会话驱动 + IPC 注册」，deps 注入 getTab/activeTabId/... 后可用
 * fake webContents 单测（见 browser-cdp.test.js）。
 *
 * 对外：
 *   registerBrowserCdp({ ipcMain, getTab, getAllTabs, activeTabId, isTrustedSender })
 *     → 注册 bcdp:list-tabs / snapshot / click / type / navigate / evaluate / screenshot
 *   createBrowserCdpController(deps) → 控制器（便于单测，不含 IPC）
 * =============================================================================
 */
'use strict';

const CdpCore = require('./renderer/cdp-core');
const VfsResolve = require('./renderer/url-resolve');

// 只对「受信来源（工作台主页，注入了 preload）」开放；主进程二次校验（双保险）。
function createBrowserCdpController(deps) {
  deps = deps || {};
  const getTab = typeof deps.getTab === 'function' ? deps.getTab : () => null;
  const getAllTabs = typeof deps.getAllTabs === 'function' ? deps.getAllTabs : () => [];
  const getActiveId = typeof deps.activeTabId === 'function'
    ? deps.activeTabId
    : () => deps.activeTabId;
  // 新建标签能力（主进程注入）。仅当导航目标是「工作台标签」时用于改为新开网页标签。
  const createTab = typeof deps.createTab === 'function' ? deps.createTab : () => null;

  // tabId → 最近一次快照（ref → backendNodeId 映射）；ref 仅在「同一次快照」内有效
  const snapshots = new Map();

  // 是否「工作台主页」标签（AI 对话页本身）。这类标签绝不能被 browser_navigate 导航走，
  // 否则会把对话页面跳转掉、导致对话无法继续。
  function isWorkbenchTab(tab) {
    return !!(tab && tab.isWorkbench);
  }

  // 硬约束：第一个标签页 = 工作台主页（AI 对话页本身），任何浏览器工具都不得对它执行操作。
  // 命中即拒绝（不 attach debugger、不派发 CDP、不 loadURL），从根本上避免把对话页弄坏。
  function isProtectedTab(tab) {
    return !!(tab && tab.isWorkbench);
  }

  function protectRefusal() {
    return {
      ok: false,
      error: 'EPERM_WORKBENCH_TAB：第一个标签页是 AI 工作台/对话页，禁止对其执行任何操作',
      protectedTab: true,
    };
  }

  function resolveTab(tabId) {
    let id = (tabId === undefined || tabId === null || tabId === '') ? getActiveId() : tabId;
    if (typeof id === 'string' && /^\d+$/.test(id)) id = Number(id);
    const tab = getTab(id);
    if (!tab) throw new Error('标签页不存在：' + tabId);
    return tab;
  }

  function wcOf(tab) {
    const wc = tab && tab.view && tab.view.webContents;
    if (!wc) throw new Error('标签页无 webContents');
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) throw new Error('标签页已销毁');
    return wc;
  }

  async function dbgOf(tab) {
    const wc = wcOf(tab);
    const dbg = wc.debugger;
    if (!dbg) throw new Error('当前标签不支持 CDP debugger');
    const wasAttached = typeof dbg.isAttached === 'function' && dbg.isAttached();
    if (!wasAttached) {
      if (typeof dbg.attach === 'function') dbg.attach('1.3');
      // 首次 attach 后尽力开启常用域（失败不影响后续按需启用）
      for (const m of ['Page.enable', 'DOM.enable']) {
        try { await send(dbg, m); } catch (_) { /* 老版本可忽略 */ }
      }
    }
    return dbg;
  }

  function send(dbg, method, params) {
    return Promise.resolve(dbg.sendCommand(method, params || {}));
  }

  async function dispatchAll(dbg, cmds) {
    for (const c of cmds || []) await send(dbg, c.method, c.params);
  }

  // 用 backendNodeId 拿到「视口内、CSS 像素」的点击点（Puppeteer clickablePoint 同款）
  async function computePoint(dbg, entry) {
    const backendNodeId = entry.backendNodeId;
    try { await send(dbg, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }); } catch (_) { /* 允许失败 */ }
    const r = await send(dbg, 'DOM.getContentQuads', { backendNodeId });
    const quads = (r && r.quads) || [];
    let viewport = null;
    try {
      const m = await send(dbg, 'Page.getLayoutMetrics');
      viewport = (m && (m.layoutViewport || m.cssLayoutViewport)) || null;
    } catch (_) { /* 拿不到视口就按无边界处理 */ }
    return CdpCore.toDispatchPoint(quads, viewport);
  }

  function lookupRef(tab, ref) {
    const snap = snapshots.get(tab.id);
    if (!snap) throw new Error('请先调用 browser_snapshot 获取元素 ref');
    const entry = snap.byRef[ref] || snap.byRef[Number(ref)];
    if (!entry) throw new Error('无效的 ref：' + ref + '（请重新 snapshot）');
    return entry;
  }

  // ── bcdp:list-tabs ────────────────────────────────────────
  function listTabs() {
    const active = getActiveId();
    const tabs = getAllTabs().map((t) => ({
      id: t.id, url: t.url || '', title: t.title || '', active: t.id === active,
    }));
    return { ok: true, tabs, activeId: active };
  }

  // ── bcdp:snapshot ─────────────────────────────────────────
  async function snapshot(p) {
    p = p || {};
    const tab = resolveTab(p.tabId);
    if (isProtectedTab(tab)) return protectRefusal();
    const dbg = await dbgOf(tab);
    // 部分内核需显式开启无障碍域才能拿到完整 AX 树
    try { await send(dbg, 'Accessibility.enable'); } catch (_) { /* 老版本可直接取 */ }
    const tree = await send(dbg, 'Accessibility.getFullAXTree');
    const nodes = (tree && tree.nodes) || [];
    const url = tab.url || '';
    const title = tab.title || '';
    const built = CdpCore.buildSnapshot(nodes, { url, title });
    snapshots.set(tab.id, built);
    return { ok: true, url, title, refs: built.refs, text: built.text };
  }

  // ── bcdp:click ────────────────────────────────────────────
  async function click(p) {
    p = p || {};
    const tab = resolveTab(p.tabId);
    if (isProtectedTab(tab)) return protectRefusal();
    const dbg = await dbgOf(tab);
    let x = p.x;
    let y = p.y;
    if (p.ref !== undefined && p.ref !== null) {
      const entry = lookupRef(tab, p.ref);
      const pt = await computePoint(dbg, entry);
      if (!pt.visible) {
        return { ok: false, error: '元素不在视口内（visible:false），可先滚动或重新 snapshot', visible: false, x: pt.x, y: pt.y };
      }
      x = pt.x; y = pt.y;
    }
    if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) {
      throw new Error('browser_click 需要 ref，或提供数字 x/y');
    }
    const cmds = CdpCore.buildClickCommands({ x, y, button: p.button, clickCount: p.clickCount });
    await dispatchAll(dbg, cmds);
    return { ok: true, x, y };
  }

  // ── bcdp:type ─────────────────────────────────────────────
  async function type(p) {
    p = p || {};
    const tab = resolveTab(p.tabId);
    if (isProtectedTab(tab)) return protectRefusal();
    const dbg = await dbgOf(tab);
    const text = p.text == null ? '' : String(p.text);
    if (p.ref !== undefined && p.ref !== null) {
      const entry = lookupRef(tab, p.ref);
      const pt = await computePoint(dbg, entry);
      if (!pt.visible) return { ok: false, error: '元素不在视口内（visible:false）' };
      // 先点击聚焦目标元素，再输入（保证 input 事件落在正确控件上）
      await dispatchAll(dbg, CdpCore.buildClickCommands({ x: pt.x, y: pt.y }));
    }
    const cmds = (p.mode === 'keys')
      ? CdpCore.buildKeyTypeCommands(text)
      : CdpCore.buildInsertTextCommands(text);
    await dispatchAll(dbg, cmds);
    if (p.submit) await dispatchAll(dbg, CdpCore.buildEnterCommands());
    return { ok: true, typed: text.length };
  }

  // ── bcdp:navigate ─────────────────────────────────────────
  async function navigate(p) {
    p = p || {};
    const url = String(p.url || '').trim();
    if (!url) throw new Error('browser_navigate 需要 url');
    // VFS 路径（/home/pyodide/...）→ vfs:// 协议：AI 也能直接浏览 VFS 文件，
    // 与地址栏（main.js resolveInput）行为一致。
    let finalUrl = url;
    try {
      const resolved = VfsResolve.resolveBrowserInput(url);
      if (resolved && resolved.kind === 'vfs') finalUrl = resolved.url;
    } catch (_) { /* 解析失败按原样导航 */ }
    const tab = resolveTab(p.tabId);

    // 关键修复：若目标标签是「工作台主页」（AI 对话页），绝不原地导航它 ——
    // 那会把对话页面本身跳到新网址，导致对话中断、无法继续。改为新开一个网页标签承载该 URL。
    if (isWorkbenchTab(tab)) {
      const newId = createTab(finalUrl, { activate: true });
      if (newId === null || newId === undefined) {
        throw new Error('无法新建标签页：当前环境未提供 createTab，已阻止导航工作台标签');
      }
      return { ok: true, url: finalUrl, tabId: newId, newTab: true };
    }

    const wc = wcOf(tab);
    await wc.loadURL(finalUrl);
    return { ok: true, url: finalUrl, tabId: tab.id };
  }

  // ── bcdp:evaluate ─────────────────────────────────────────
  async function evaluate(p) {
    p = p || {};
    const tab = resolveTab(p.tabId);
    if (isProtectedTab(tab)) return protectRefusal();
    const dbg = await dbgOf(tab);
    const expression = String(p.expression == null ? '' : p.expression);
    const res = await send(dbg, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (res && res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'evaluate 执行异常';
      return { ok: false, error: String(msg) };
    }
    return { ok: true, value: res && res.result ? res.result.value : undefined };
  }

  // ── bcdp:screenshot ───────────────────────────────────────
  async function screenshot(p) {
    p = p || {};
    const tab = resolveTab(p.tabId);
    if (isProtectedTab(tab)) return protectRefusal();
    const dbg = await dbgOf(tab);
    const format = (p.format === 'jpeg' || p.format === 'jpg') ? 'jpeg' : 'png';
    let res;
    try {
      res = await send(dbg, 'Page.captureScreenshot', { format, fromSurface: true });
    } catch (_) {
      try { await send(dbg, 'Page.enable'); } catch (_2) { /* ignore */ }
      res = await send(dbg, 'Page.captureScreenshot', { format, fromSurface: true });
    }
    return { ok: true, data: (res && res.data) || '', format };
  }

  return {
    listTabs, snapshot, click, type, navigate, evaluate, screenshot,
    _snapshots: snapshots,
  };
}

// 注册 bcdp:* IPC；每个通道都先过 isTrustedSender，再统一 try/catch 归一成 {ok,error}
function registerBrowserCdp(deps) {
  deps = deps || {};
  const ipcMain = deps.ipcMain;
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('registerBrowserCdp 需要一个可用的 ipcMain');
  }
  const trusted = typeof deps.isTrustedSender === 'function' ? deps.isTrustedSender : () => true;
  const controller = createBrowserCdpController(deps);

  const guard = (fn) => async (e, payload) => {
    if (!trusted(e)) {
      return { ok: false, error: 'EPERM_UNTRUSTED：该浏览器接口只能由工作台页面调用' };
    }
    try {
      return await fn(payload || {});
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };

  ipcMain.handle('bcdp:list-tabs', guard(() => controller.listTabs()));
  ipcMain.handle('bcdp:snapshot', guard((p) => controller.snapshot(p)));
  ipcMain.handle('bcdp:click', guard((p) => controller.click(p)));
  ipcMain.handle('bcdp:type', guard((p) => controller.type(p)));
  ipcMain.handle('bcdp:navigate', guard((p) => controller.navigate(p)));
  ipcMain.handle('bcdp:evaluate', guard((p) => controller.evaluate(p)));
  ipcMain.handle('bcdp:screenshot', guard((p) => controller.screenshot(p)));

  return controller;
}

module.exports = { registerBrowserCdp, createBrowserCdpController };
