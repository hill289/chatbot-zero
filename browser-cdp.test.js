/*!
 * browser-cdp.test.js — 用 fake webContents.debugger 验证 CDP 驱动全链路
 * 运行：node --test browser-cdp.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createBrowserCdpController, registerBrowserCdp } = require('./browser-cdp');

function makeFakeWC() {
  const calls = [];
  const dbg = {
    _attached: false,
    isAttached() { return this._attached; },
    attach() { this._attached = true; return true; },
    detach() { this._attached = false; },
    sendCommand(method, params) {
      calls.push({ method, params: params || {} });
      switch (method) {
        case 'Accessibility.getFullAXTree':
          return Promise.resolve({
            nodes: [
              { nodeId: 'root', role: { value: 'RootWebArea' }, childIds: ['1', '2', '3'] },
              { nodeId: '1', role: { value: 'textbox' }, name: { value: '搜索' }, backendDOMNodeId: 11, childIds: [] },
              { nodeId: '2', role: { value: 'button' }, name: { value: '百度一下' }, backendDOMNodeId: 22, childIds: [] },
              { nodeId: '3', role: { value: 'link' }, name: { value: '关于' }, ignored: true, backendDOMNodeId: 33, childIds: [] },
            ],
          });
        case 'DOM.getContentQuads':
          return Promise.resolve({ quads: [[10, 20, 110, 20, 110, 60, 10, 60]] });
        case 'Page.getLayoutMetrics':
          return Promise.resolve({ layoutViewport: { clientWidth: 800, clientHeight: 600 } });
        case 'Runtime.evaluate':
          return Promise.resolve({ result: { value: 'hello' } });
        case 'Page.captureScreenshot':
          return Promise.resolve({ data: 'iVBORw0KGgo=' });
        default:
          return Promise.resolve({});
      }
    },
  };
  const wc = {
    _destroyed: false,
    isDestroyed() { return this._destroyed; },
    debugger: dbg,
    _lastLoad: null,
    loadURL(u) { wc._lastLoad = u; return Promise.resolve(); },
  };
  return { wc, calls };
}

function makeDeps() {
  const { wc, calls } = makeFakeWC();
  const tab = { id: 1, url: 'https://www.baidu.com/', title: '百度一下，你就知道', view: { webContents: wc } };
  const other = { id: 2, url: 'about:blank', title: '新标签页', view: { webContents: makeFakeWC().wc } };
  return {
    calls,
    tab,
    deps: {
      getTab: (id) => ([tab, other].find((t) => t.id === id) || null),
      getAllTabs: () => [tab, other],
      activeTabId: () => 1,
      isTrustedSender: () => true,
    },
  };
}

test('listTabs 返回带 active 标记的标签列表', () => {
  const { deps } = makeDeps();
  const c = createBrowserCdpController(deps);
  const r = c.listTabs();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tabs.length, 2);
  assert.strictEqual(r.tabs[0].active, true);
  assert.strictEqual(r.tabs[1].active, false);
});

test('snapshot 走 Accessibility.getFullAXTree 并分配 ref（跳过 ignored）', async () => {
  const { deps } = makeDeps();
  const c = createBrowserCdpController(deps);
  const r = await c.snapshot({ tabId: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.refs.length, 2); // textbox + button，ignored 的 link 不进 refs
  assert.strictEqual(r.refs[0].role, 'textbox');
  assert.strictEqual(r.refs[0].backendNodeId, 11);
  assert.match(r.text, /百度一下/);
});

test('click（按 ref）→ getContentQuads 换算坐标并派发真实鼠标事件', async () => {
  const { deps, calls } = makeDeps();
  const c = createBrowserCdpController(deps);
  await c.snapshot({ tabId: 1 });
  const r = await c.click({ tabId: 1, ref: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.x, 60); // 四边形中心 x
  assert.strictEqual(r.y, 40); // 四边形中心 y
  const pressed = calls.filter((x) => x.method === 'Input.dispatchMouseEvent' && x.params.type === 'mousePressed');
  assert.strictEqual(pressed.length, 1);
  assert.strictEqual(pressed[0].params.x, 60);
});

test('click 无 snapshot 时按 ref 会报错提示先 snapshot', async () => {
  const { deps } = makeDeps();
  const c = createBrowserCdpController(deps);
  await assert.rejects(() => c.click({ tabId: 1, ref: 1 }), /先调用 browser_snapshot/);
});

test('type（按 ref）先点击聚焦再 insertText，submit 追加回车', async () => {
  const { deps, calls } = makeDeps();
  const c = createBrowserCdpController(deps);
  await c.snapshot({ tabId: 1 });
  const r = await c.type({ tabId: 1, ref: 1, text: 'hello', submit: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.typed, 5);
  const insert = calls.find((x) => x.method === 'Input.insertText');
  assert.ok(insert && insert.params.text === 'hello');
  const enter = calls.find((x) => x.method === 'Input.dispatchKeyEvent' && x.params.key === 'Enter');
  assert.ok(enter, '应派发回车');
});

test('navigate 调用 loadURL', async () => {
  const { deps, tab } = makeDeps();
  const c = createBrowserCdpController(deps);
  const r = await c.navigate({ tabId: 1, url: 'https://www.baidu.com' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(tab.view.webContents._lastLoad, 'https://www.baidu.com');
});

test('evaluate 返回 Runtime.evaluate 的值', async () => {
  const { deps } = makeDeps();
  const c = createBrowserCdpController(deps);
  const r = await c.evaluate({ tabId: 1, expression: '1+1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.value, 'hello');
});

test('screenshot 返回 base64 data', async () => {
  const { deps } = makeDeps();
  const c = createBrowserCdpController(deps);
  const r = await c.screenshot({ tabId: 1, format: 'png' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.data.length > 0);
});

test('registerBrowserCdp 注册全部 bcdp:* 通道，且拦截非受信来源', async () => {
  const { deps } = makeDeps();
  const registered = {};
  const ipcMain = { handle: (ch, fn) => { registered[ch] = fn; } };
  registerBrowserCdp(Object.assign({}, deps, { ipcMain }));
  for (const ch of ['bcdp:list-tabs', 'bcdp:snapshot', 'bcdp:click', 'bcdp:type', 'bcdp:navigate', 'bcdp:evaluate', 'bcdp:screenshot']) {
    assert.strictEqual(typeof registered[ch], 'function', '缺少通道 ' + ch);
  }
  // 受信来源可调用
  const okRes = await registered['bcdp:list-tabs']({ sender: { id: 1 } }, {});
  assert.strictEqual(okRes.ok, true);
  // 非受信来源被拒
  const untrusted = Object.assign({}, deps, { isTrustedSender: () => false });
  const reg2 = {};
  registerBrowserCdp(Object.assign({}, untrusted, { ipcMain: { handle: (ch, fn) => { reg2[ch] = fn; } } }));
  const deny = await reg2['bcdp:list-tabs']({ sender: { id: 999 } }, {});
  assert.strictEqual(deny.ok, false);
  assert.match(deny.error, /EPERM_UNTRUSTED/);
});
