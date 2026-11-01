const { app, BaseWindow, WebContentsView, Menu, ipcMain, dialog, shell, net, Notification, session, safeStorage, protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');
// 子进程控制台输出解码（Windows 中文乱码修复，见 renderer/console-encoding.js）
const consoleEncoding = require(path.join(__dirname, 'renderer', 'console-encoding.js'));
const sandbox = require('./sandbox');
// 可选模块：打包配置若漏了文件，也要「降级拒绝」而不是整个应用起不来。
//   fs-grant 缺失 → 所有文件读写一律拒绝（fail-closed）；
//   job-store 缺失 → 后台任务退化为纯内存（关窗即丢），但不影响启动。
let createGrantStore = null;
try { ({ createGrantStore } = require('./fs-grant')); }
catch (err) { console.warn('[main] fs-grant 未加载，文件接口将全部拒绝：', err && err.message); }
let createJobStore = null;
try { ({ createJobStore } = require('./renderer/job-store')); }
catch (err) { console.warn('[main] job-store 未加载，后台任务不落盘：', err && err.message); }
// 拖入路径「免确认授权」的证明校验（纯逻辑）；缺失时 fs:grant-dropped 直接拒绝，
// 拖放会退回旧的逐条 grant + 原生确认框，不会静默放行。
let createDropGrantVerifier = null;
try { ({ createDropGrantVerifier } = require(path.join(__dirname, 'renderer', 'drop-grant.js'))); }
catch (err) { console.warn('[main] drop-grant 未加载，拖入路径仍需逐条确认：', err && err.message); }
// 原子写（tmp + fsync + rename）：同步回写是全系统唯一「不可恢复」的动作，
// 覆盖源码时绝不能出现半截文件。缺失时降级为普通 writeFile 并告警 ——
// 宁可写得不原子，也不能因为少一个文件就让应用起不来。
let writeFileAtomic = null;
try { ({ writeFileAtomic } = require('./atomic-write')); }
catch (err) { console.warn('[main] atomic-write 未加载，写盘退化为非原子 writeFile：', err && err.message); }
// 真实执行后的「回收」纯逻辑（判变 / 忽略规则 / 限额兜底）。
// 缺失时 run:collect 直接拒绝：执行产物不会悄悄进虚拟工作区，但应用照常启动。
let RunCollect = null;
try { RunCollect = require(path.join(__dirname, 'renderer', 'run-collect.js')); }
catch (err) { console.warn('[main] run-collect 未加载，执行后无法回收变更到虚拟工作区：', err && err.message); }
// 内置浏览器「地址输入 → 可加载 URL」纯逻辑（VFS 路径 → vfs://；见 renderer/url-resolve.js）。
// 缺失时 resolveInput 退化为旧逻辑，浏览器仍可上网，但浏览不了 VFS 文件。
let UrlResolve = null;
try { UrlResolve = require(path.join(__dirname, 'renderer', 'url-resolve.js')); }
catch (err) { console.warn('[main] url-resolve 未加载，内置浏览器无法浏览 VFS 文件：', err && err.message); }
// SSH/SFTP 连接管理（MCP ssh 工具 + VFS 上传/下载）。可选模块：
// 缺失（或 ssh2 未安装）→ ssh:*= 拒绝并提示「SSH 不可用」，应用照常启动。
let registerSshIpc = null;
try { ({ registerSshIpc } = require(path.join(__dirname, 'ssh-manager.js'))); }
catch (err) { console.warn('[main] ssh-manager 未加载，SSH/SFTP 功能不可用：', err && err.message); }
// PGlite wire-protocol 服务（参考 pglite-server-master）：app 就绪后监听本地端口，
// 让 psql / 任意 pg 客户端能连进应用内的 PGlite 库（默认 127.0.0.1:5432）。
// 可选模块：缺失或 @electric-sql/pglite 未安装 → 服务不启动并告警，应用照常启动。
let startPgliteServer = null, startPgliteDirect = null, getPgliteDb = null, stopPgliteServer = null, startWireServer = null;
try { ({ startPgliteServer, startPgliteDirect, getPgliteDb, stopPgliteServer, startWireServer } = require(path.join(__dirname, 'pglite-service.js'))); }
catch (err) { console.warn('[main] pglite-service 未加载：', err && err.message); }
// 内嵌 PostgreSQL 后端（PGlite 直连，无端口）：dbclient 已并入启动程序，供 db:* IPC 使用。
let embeddedDb = null;
try { embeddedDb = require(path.join(__dirname, 'embedded-db.js')); }
catch (err) { console.warn('[main] embedded-db 未加载，数据库功能不可用：', err && err.message); }
// vfs:// 是自定义 standard scheme，必须在 app ready 之前声明（standard 才能有 host + 相对链接）
try {
  protocol.registerSchemesAsPrivileged([{ scheme: 'vfs', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
} catch (err) { console.warn('[main] vfs:// scheme 声明失败：', err && err.message); }

// ── 渲染层目录解析（外部 renderer，不打包进 app.asar）────────────────
// 目标：chatbot-zero.exe 直接加载「dist 同级目录的 renderer/」，不再把 renderer 打进
// app.asar，也不在找不到时回退 app.asar。这样改渲染层无需重新打包：
//   编辑/覆盖 <项目根>/renderer/ → 重启应用即生效。
// 打包后 exe 位于 <项目根>/dist/win-unpacked/chatbot-zero.exe，因此：
//   dist 同级   = <exeDir>/../../renderer   （首选，源码目录，直接覆盖即可升级）
//   win-unpacked 同级 = <exeDir>/../renderer （只分发 dist 时的便携布局）
//   exe 同级    = <exeDir>/renderer        （兜底）
// 开发态（npm start）则直接用应用目录下的 renderer/。
function resolveRendererDir() {
  const hasIndex = (dir) => {
    try { return !!dir && fs.existsSync(path.join(dir, 'index.html')); } catch (_) { return false; }
  };
  const candidates = [];
  if (process.env.CHATBOT_RENDERER_DIR) candidates.push(path.resolve(process.env.CHATBOT_RENDERER_DIR));

  let exeDir = '';
  try { if (app.isPackaged) exeDir = path.dirname(app.getPath('exe')); } catch (_) { /* 取不到则走开发态 */ }

  if (exeDir) {
    candidates.push(path.resolve(exeDir, '..', '..', 'renderer')); // dist 同级的 renderer（首选）
    candidates.push(path.resolve(exeDir, '..', 'renderer'));        // dist/renderer（win-unpacked 同级）
    candidates.push(path.join(exeDir, 'renderer'));                 // win-unpacked/renderer（兜底）
  } else {
    try { candidates.push(path.join(app.getAppPath(), 'renderer')); } catch (_) { /* ignore */ }
    candidates.push(path.join(__dirname, 'renderer'));
  }

  for (const dir of candidates) {
    if (hasIndex(dir)) {
      console.log('[main] renderer 目录：', dir);
      return dir;
    }
  }
  // 明确不回退 app.asar：找不到就把首个候选路径返回，让加载失败暴露出来（便于发现部署缺目录）
  const fallback = candidates[0] || path.join(__dirname, 'renderer');
  console.error('[main] 找不到 renderer/index.html，已尝试：' + candidates.join(' | '));
  console.error('[main] 请把 renderer/ 放在 dist 同级目录（与 dist 并列），不要打进 app.asar。');
  return fallback;
}
const RENDERER_DIR = resolveRendererDir();
// 渲染资源一律从外部 RENDERER_DIR 取；不做 asar 回退，避免掩盖部署问题。
function rendererAsset(name) {
  return path.join(RENDERER_DIR, name);
}

// ── 布局常量 ─────────────────────────────────────────────
// chrome（标签栏 + 地址栏）高度，须与 renderer/browser-chrome.html 的两行高度一致
const CHROME_HEIGHT = 88;
// 导出/下载完成后是否弹 Windows 系统通知（右下角横幅）。默认关闭：
// 文件已静默落到「下载」目录，不再打扰。改成 true 可恢复提示。
const DOWNLOAD_NOTIFY_ENABLED = false;
const HOME_URL = pathToFileURL(rendererAsset('index.html')).toString();
const BLANK_URL = 'about:blank';

// ── 全局状态 ─────────────────────────────────────────────
let win = null;            // BaseWindow
let chrome = null;         // 顶部浏览器 chrome 的 WebContentsView
const tabs = new Map();    // id -> { id, view, url, title, loading, canGoBack, canGoForward }
let activeTabId = null;
let nextTabId = 1;

// 执行类 IPC 的受信来源白名单：只有注入了 preload（工作台主页）的 WebContents 才能
// 调用 run:*。远程网页标签没有 preload，无法触达这些通道。见 createTab()。
const trustedSenders = new Set();

// ── 工具函数 ─────────────────────────────────────────────

// 把地址栏输入解析成可加载的 URL
// 修复「浏览器浏览 vfs 的文件无法找到」：VFS 文件（/home/pyodide/...）不在磁盘上，
// 旧逻辑把它们错转成 file:// 去磁盘找 → 必然 ERR_FILE_NOT_FOUND；
// 现在由 url-resolve.js 识别并转成 vfs:// 协议，主进程 protocol.handle('vfs') 从
// 工作台渲染层的 almostnode FS 取字节回给浏览器标签。
function resolveInput(input) {
  const s = (input || '').trim();
  if (!s) return null;
  if (UrlResolve) {
    const r = UrlResolve.resolveBrowserInput(s);
    if (r.kind === 'disk') {
      try { return pathToFileURL(path.resolve(r.path)).toString(); } catch (_) { /* 落到搜索 */ }
      return 'https://www.google.com/search?q=' + encodeURIComponent(s);
    }
    return r.kind === 'empty' ? null : (r.url || null);
  }
  // 兜底（url-resolve.js 缺失时维持旧行为）
  if (/^(https?|file|about|data|chrome|view-source|blob):/i.test(s)) return s;
  if (/^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]{1,2}/.test(s)) {
    try { return pathToFileURL(path.resolve(s)).toString(); } catch (_) { /* 落到后面 */ }
  }
  if (/^[^\s]+\.[^\s]{2,}(?:[/:?#].*)?$/.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

function activeTab() {
  return tabs.get(activeTabId) || null;
}

// 计算某标签的后退/前进可用性
function syncNav(id) {
  const t = tabs.get(id);
  if (!t) return;
  const wc = t.view.webContents;
  try {
    const nh = wc.navigationHistory;
    t.canGoBack = nh ? nh.canGoBack() : wc.canGoBack();
    t.canGoForward = nh ? nh.canGoForward() : wc.canGoForward();
  } catch (_) {
    t.canGoBack = false;
    t.canGoForward = false;
  }
}

// 把当前全部标签状态推给 chrome UI
function pushState() {
  if (!chrome || chrome.webContents.isDestroyed()) return;
  const list = [];
  for (const t of tabs.values()) {
    list.push({
      id: t.id, url: t.url, title: t.title,
      loading: t.loading, canGoBack: t.canGoBack, canGoForward: t.canGoForward,
    });
  }
  chrome.webContents.send('browser:state', { tabs: list, activeId: activeTabId });
}

// ── 布局 ─────────────────────────────────────────────────
function layout() {
  if (!win || win.isDestroyed()) return;
  const b = win.getContentBounds();
  if (chrome && !chrome.webContents.isDestroyed()) {
    chrome.setBounds({ x: 0, y: 0, width: b.width, height: CHROME_HEIGHT });
  }
  const t = activeTab();
  if (t) {
    t.view.setBounds({
      x: 0,
      y: CHROME_HEIGHT,
      width: Math.max(0, b.width),
      height: Math.max(0, b.height - CHROME_HEIGHT),
    });
  }
}

// ── 标签页生命周期 ───────────────────────────────────────
function createTab(url = BLANK_URL, { activate = true, preload = false, preloadFile = null, trusted = false } = {}) {
  if (!win || win.isDestroyed()) return null;
  const id = nextTabId++;

  // workbench（本地主页）注入 preload.js，暴露 fileAPI：
  //   拖拽文件的磁盘真实路径 + 真实目录读写（AI 编辑后同步回磁盘）。
  const webPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
  if (preload) webPreferences.preload = path.join(__dirname, 'preload.js');
  else if (preloadFile) webPreferences.preload = preloadFile;

  const view = new WebContentsView({ webPreferences });
  const wc = view.webContents;

  // 只有「工作台主页」这一支（preload=true）被登记为受信来源，可调用 run:* 执行类 IPC。
  // 内嵌数据库页（trusted=true）也登记为受信来源，可使用 db:* IPC。
  if (preload || trusted) trustedSenders.add(wc.id);
  wc.once('destroyed', () => trustedSenders.delete(wc.id));

  tabs.set(id, {
    id, view,
    // isWorkbench：标记「工作台主页」标签（preload=true 的那一支，即 AI 对话页本身）。
    // AI 浏览器控制（browser_navigate）据此判断：绝不能把工作台标签导航走，否则对话中断。
    isWorkbench: !!preload,
    url: url || BLANK_URL,
    title: url && url !== BLANK_URL ? url : '新标签页',
    loading: false, canGoBack: false, canGoForward: false,
  });

  // 新窗口请求（target=_blank / window.open）→ 在本应用新开标签，不弹新窗口
  wc.setWindowOpenHandler(({ url: target }) => {
    createTab(target);
    return { action: 'deny' };
  });

  wc.on('page-title-updated', (_e, title) => {
    const t = tabs.get(id); if (!t) return; t.title = title; pushState();
  });
  wc.on('did-start-loading', () => {
    const t = tabs.get(id); if (!t) return; t.loading = true; pushState();
  });
  wc.on('did-stop-loading', () => {
    const t = tabs.get(id); if (!t) return; t.loading = false; syncNav(id); pushState();
  });
  wc.on('did-navigate', (_e, navUrl) => {
    const t = tabs.get(id); if (!t) return;
    if (!/^data:/i.test(navUrl)) t.url = navUrl; // 跳过内部错误页 data: URL
    syncNav(id); pushState();
  });
  wc.on('did-navigate-in-page', (_e, navUrl) => {
    const t = tabs.get(id); if (!t) return;
    t.url = navUrl; syncNav(id); pushState();
  });
  wc.on('did-fail-load', (_e, code, desc, failingUrl, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // ERR_ABORTED：用户主动取消 / 重定向，忽略
    const t = tabs.get(id); if (!t) return;
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>无法访问</title>'
      + '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#1e1e1e;color:#ddd;padding:48px;}'
      + 'h2{color:#ff7b72;margin:0 0 16px;}code{background:#2b2b2b;padding:2px 6px;border-radius:4px;}</style></head>'
      + '<body><h2>无法加载此页面</h2><p>地址：<code>' + failingUrl + '</code></p>'
      + '<p>错误：' + (desc || '') + ' (' + code + ')</p></body></html>';
    t.url = failingUrl; // 地址栏保留用户输入的目标地址
    wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    pushState();
  });

  wc.loadURL(url || BLANK_URL);

  if (activate) activateTab(id);
  else pushState();
  return id;
}

function activateTab(id) {
  if (!win || win.isDestroyed() || !tabs.has(id)) return;
  const prev = tabs.get(activeTabId);
  if (prev && prev.id !== id) win.contentView.removeChildView(prev.view);
  activeTabId = id;
  const t = tabs.get(id);
  win.contentView.addChildView(t.view);
  layout();
  t.view.webContents.focus();
  pushState();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  const wasActive = id === activeTabId;
  try { win.contentView.removeChildView(t.view); } catch (_) { /* 可能已移除 */ }
  try { t.view.webContents.close(); } catch (_) { /* 可能已销毁 */ }
  tabs.delete(id);

  if (wasActive) {
    const ids = [...tabs.keys()];
    if (ids.length === 0) {
      if (win && !win.isDestroyed()) win.close(); // 关掉最后一个标签 = 关窗口
      return;
    }
    activeTabId = null;
    activateTab(ids[ids.length - 1]);
  } else {
    pushState();
  }
}

function navigate(input, id = activeTabId) {
  const t = tabs.get(id);
  if (!t) return;
  const url = resolveInput(input);
  if (!url) return;
  t.url = url;
  pushState();
  t.view.webContents.loadURL(url);
}

// ── 窗口 ─────────────────────────────────────────────────
function createWindow() {
  win = new BaseWindow({ width: 1280, height: 860, title: 'chatbot-zero' });

  chrome = new WebContentsView({
    webPreferences: {
      preload: rendererAsset('browser-chrome-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(chrome);
  chrome.webContents.loadFile(rendererAsset('browser-chrome.html'));

  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);
  win.on('closed', () => {
    for (const t of tabs.values()) {
      try { t.view.webContents.close(); } catch (_) { /* ignore */ }
    }
    tabs.clear();
    activeTabId = null;
    win = null;
    chrome = null;
  });

  // 首个标签 = 工作台主页（注入 preload，暴露 fileAPI 供拖拽真实路径 / 磁盘读写使用）
  createTab(HOME_URL, { preload: true });
  layout();
}

// ── 菜单（原生）──────────────────────────────────────────
function focusAddressBar() {
  if (chrome && !chrome.webContents.isDestroyed()) {
    chrome.webContents.focus();
    chrome.webContents.send('browser:focus-address');
  }
}

function menuNewTab() {
  const id = createTab(BLANK_URL);
  if (id) focusAddressBar();
}

async function menuOpenFile() {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  if (!r.canceled && r.filePaths[0]) {
    navigate(pathToFileURL(r.filePaths[0]).toString());
  }
}

// ── 一键清空 IndexedDB（真正的物理删除）────────────────────────────────
// 为什么不能只调 session.clearStorageData()：
//   1) 页面（WebContentsView）仍持有 IndexedDB 连接时，Chromium 无法回收 LevelDB
//      句柄；Windows 上文件被占用，删除要么失败、要么只清了逻辑记录，刷新后“复活”；
//   2) 旧版本 Electron 对 file:// 源的 clearStorageData 并不彻底；
//   3) 只 clear 不删库目录，DevTools → IndexedDB 里数据库名依旧在。
// 所以按「卸载页面关连接 → clearStorageData → 删磁盘目录 → 校验 → 恢复页面」执行。

// 会话数据根目录（IndexedDB / Local Storage / Partitions 都在其下）
function sessionDataDir() {
  try { return app.getPath('sessionData') || app.getPath('userData'); }
  catch (_) { return app.getPath('userData'); }
}

// 所有可能存放 IndexedDB 的目录：默认会话 + 各持久化分区
function indexedDbDirs() {
  const base = sessionDataDir();
  const dirs = [path.join(base, 'IndexedDB')];
  try {
    const parts = path.join(base, 'Partitions');
    for (const name of fs.readdirSync(parts)) dirs.push(path.join(parts, name, 'IndexedDB'));
  } catch (_) { /* 没有分区目录 */ }
  return dirs;
}

// 目录里是否还残留 LevelDB 数据文件（.ldb / .log）
function leftoverIdbFiles() {
  const left = [];
  for (const dir of indexedDbDirs()) {
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) if (/\.(ldb|log)$/i.test(f)) left.push(path.join(dir, f));
  }
  return left;
}

// 带重试地删除目录（刚释放句柄时 Windows 可能短暂 EBUSY/EPERM）
async function rmDirWithRetry(dir, tries = 8) {
  if (!fs.existsSync(dir)) return true;
  for (let i = 0; i < tries; i++) {
    await rmPath(dir);
    if (!fs.existsSync(dir)) return true;
    await new Promise(r => setTimeout(r, 120 * (i + 1)));
  }
  return !fs.existsSync(dir);
}

// 加载 URL 并等待文档就绪（把页面卸载到 about:blank，从而释放 IDB 连接）
function loadAndWait(wc, url, timeoutMs = 8000) {
  return new Promise(resolve => {
    if (!wc || wc.isDestroyed()) return resolve(false);
    let done = false;
    const finish = ok => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        wc.removeListener('did-finish-load', onLoad);
        wc.removeListener('did-fail-load', onFail);
      } catch (_) { /* 可能已销毁 */ }
      resolve(ok);
    };
    const onLoad = () => finish(true);
    const onFail = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    wc.once('did-finish-load', onLoad);
    wc.once('did-fail-load', onFail);
    try { wc.loadURL(url); } catch (_) { finish(false); }
  });
}

// 一键清空 IndexedDB（知识库 / 长期记忆 / 同步/撤销记录都存放在这里）
async function menuClearIndexedDB() {
  if (!win || win.isDestroyed()) return;

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '清空 IndexedDB',
    message: '确定要清空全部 IndexedDB 数据吗？',
    detail: '将物理删除本应用所有站点的 IndexedDB 数据库（知识库、长期记忆、'
      + '同步/撤销记录、diff 缓存等），包括磁盘上的 LevelDB 文件，'
      + '此操作不可撤销。\n清空后所有标签页会自动重新加载。',
    buttons: ['取消', '清空并重新加载'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response !== 1) return;

  // 记录待恢复的地址（卸载到 about:blank 会覆盖 tab.url）
  const entries = [];
  for (const t of tabs.values()) entries.push({ tab: t, url: t.url || BLANK_URL });

  // ① 先把所有页面卸载，销毁文档 → 关闭各渲染进程内的 IDB 连接
  await Promise.all(entries.map(e => loadAndWait(e.tab.view.webContents, BLANK_URL)));
  await new Promise(r => setTimeout(r, 250)); // 给 Chromium 回收句柄的时间

  // ② 走官方通道清一次（同时清 localStorage/quota 里的 IDB 索引）
  let clearErr = null;
  try {
    await session.defaultSession.clearStorageData({ storages: ['indexeddb'] });
  } catch (err) { clearErr = err; }

  // ③ 兜底：直接删除磁盘上的 IndexedDB 目录（彻底物理删除）
  const dirs = indexedDbDirs();
  await Promise.all(dirs.map(d => rmDirWithRetry(d)));

  // ④ 校验：是否还有 .ldb / .log 残留
  const left = leftoverIdbFiles();

  // ⑤ 恢复标签页（页面重新加载后会按需重建空库）
  for (const e of entries) {
    const wc = e.tab.view && e.tab.view.webContents;
    if (!wc || wc.isDestroyed()) continue;
    const target = (!e.url || e.url === BLANK_URL) ? HOME_URL : e.url;
    try { wc.loadURL(target); } catch (_) { /* 可能已销毁 */ }
  }
  if (chrome && !chrome.webContents.isDestroyed()) {
    try { chrome.webContents.reloadIgnoringCache(); } catch (_) { /* 可能已销毁 */ }
  }

  // ⑥ 如实反馈（不再无条件报“已清空”）
  if (left.length) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: '清空 IndexedDB 未完成',
      message: '仍有 IndexedDB 数据文件删除失败',
      detail: (clearErr ? 'clearStorageData 失败：' + String((clearErr && clearErr.message) || clearErr) + '\n\n' : '')
        + '残留 ' + left.length + ' 个文件（通常是其它窗口/进程仍占用）：\n'
        + left.slice(0, 6).join('\n') + (left.length > 6 ? '\n…' : '')
        + '\n\n请关闭其它窗口后重试；若仍失败，可退出应用后手动删除上述目录。',
      buttons: ['好的'],
    }).catch(() => {});
    return;
  }

  // 成功时不弹窗打扰，仅在主进程日志留痕
  console.log('[IndexedDB] 已物理删除：' + dirs.length + ' 个目录 / 0 个残留文件，页面已重新加载');
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const devtoolsAccel = isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I';

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '新建标签页', accelerator: 'CmdOrCtrl+T', click: menuNewTab },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => { if (activeTab()) closeTab(activeTabId); } },
        { type: 'separator' },
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: menuOpenFile },
        { label: '打开位置…', accelerator: 'CmdOrCtrl+L', click: focusAddressBar },
        { type: 'separator' },
        { label: '清空 IndexedDB 数据…', accelerator: 'CmdOrCtrl+Shift+Delete', click: menuClearIndexedDB },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => { const t = activeTab(); if (t) t.view.webContents.reload(); } },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', click: () => { const t = activeTab(); if (t) t.view.webContents.reloadIgnoringCache(); } },
        { label: '主页', click: () => navigate(HOME_URL) },
        { type: 'separator' },
        { label: '切换开发者工具', accelerator: devtoolsAccel, click: () => { const t = activeTab(); if (t) t.view.webContents.toggleDevTools(); } },
        { label: '切换浏览器栏开发者工具', click: () => { if (chrome && !chrome.webContents.isDestroyed()) chrome.webContents.toggleDevTools(); } },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' }] : [{ role: 'close' }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: '关于',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: '关于',
            message: 'chatbot-zero 浏览器',
            detail: 'Electron 多标签浏览器外壳\nElectron ' + process.versions.electron
              + '\n主页：' + HOME_URL,
          }),
        },
        { label: '打开应用目录', click: () => shell.openPath(__dirname) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC（来自 chrome UI）─────────────────────────────────
function stateSnapshot() {
  const list = [];
  for (const t of tabs.values()) {
    list.push({
      id: t.id, url: t.url, title: t.title,
      loading: t.loading, canGoBack: t.canGoBack, canGoForward: t.canGoForward,
    });
  }
  return { tabs: list, activeId: activeTabId };
}

ipcMain.handle('browser:get-state', () => stateSnapshot());
ipcMain.handle('tab:new', (_e, url) => createTab(url || BLANK_URL));
ipcMain.handle('tab:close', (_e, id) => { closeTab(id); return true; });
ipcMain.handle('tab:activate', (_e, id) => { activateTab(id); return true; });
ipcMain.handle('nav:go', (_e, input) => { navigate(input); return true; });
ipcMain.handle('nav:back', () => {
  const t = activeTab();
  if (t && t.canGoBack) {
    const wc = t.view.webContents;
    (wc.navigationHistory ? wc.navigationHistory.goBack() : wc.goBack());
  }
  return true;
});
ipcMain.handle('nav:forward', () => {
  const t = activeTab();
  if (t && t.canGoForward) {
    const wc = t.view.webContents;
    (wc.navigationHistory ? wc.navigationHistory.goForward() : wc.goForward());
  }
  return true;
});
ipcMain.handle('nav:reload', () => { const t = activeTab(); if (t) t.view.webContents.reload(); return true; });
ipcMain.handle('nav:stop', () => { const t = activeTab(); if (t) t.view.webContents.stop(); return true; });
ipcMain.handle('nav:home', () => { navigate(HOME_URL); return true; });
ipcMain.handle('nav:devtools', () => { const t = activeTab(); if (t) t.view.webContents.toggleDevTools(); return true; });

// ── 内嵌 PostgreSQL（dbclient 已并入启动程序，无端口直连 PGlite）──────────
// 打开数据库视图：新开一个标签页加载 renderer/dbview/index.html（自带 db-preload）。
ipcMain.handle('db:open', () => {
  const url = pathToFileURL(rendererAsset('dbview/index.html')).toString();
  const id = createTab(url, {
    activate: true,
    preloadFile: rendererAsset('dbview/db-preload.js'),
    trusted: true,
  });
  return { ok: true, id };
});

function dbUnavailable() { return { error: '数据库后端不可用（PGlite 未安装）', columns: [], rows: [] }; }

ipcMain.handle('db:status', async () => {
  if (!embeddedDb) return { connected: false, error: 'embedded-db unavailable' };
  try { return await embeddedDb.status(); }
  catch (e) { return { connected: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('db:objects', async () => {
  if (!embeddedDb) return { tables: [], views: [], functions: [], triggers: [], error: 'embedded-db unavailable' };
  try { return await embeddedDb.objects(); }
  catch (e) { return { tables: [], views: [], functions: [], triggers: [], error: String(e && e.message || e) }; }
});
ipcMain.handle('db:saved', async () => {
  if (!embeddedDb) return { queries: [] };
  try { return await embeddedDb.saved(); } catch (_) { return { queries: [] }; }
});
ipcMain.handle('db:query', async (_e, sql) => {
  if (!embeddedDb) return dbUnavailable();
  try { return await embeddedDb.query(sql); } catch (e) { return { error: String(e && e.message || e), columns: [], rows: [] }; }
});
ipcMain.handle('db:table', async (_e, name) => {
  if (!embeddedDb) return dbUnavailable();
  try { return await embeddedDb.tableRows(name); } catch (e) { return { error: String(e && e.message || e), columns: [], rows: [] }; }
});
ipcMain.handle('db:apply', async (_e, payload) => {
  if (!embeddedDb) return { error: '数据库后端不可用' };
  try { return await embeddedDb.applyChanges(payload); } catch (e) { return { error: String(e && e.message || e) }; }
});

// ── CDP 直连：让 AI Agent 操控内置浏览器（webContents.debugger 原生通道）──────
// 不引外部 Chrome / Puppeteer：直接 attach 目标标签的 webContents.debugger，
// 发 Accessibility/DOM/Input/Page/Runtime 命令。仅受信来源（工作台主页）可调用。
// 缺失 browser-cdp.js 时降级：AI 浏览器控制不可用，但应用照常启动。
try {
  const { registerBrowserCdp } = require('./browser-cdp');
  registerBrowserCdp({
    ipcMain,
    getTab: (id) => tabs.get(id),
    getAllTabs: () => [...tabs.values()],
    activeTabId: () => activeTabId,
    // 注入新建标签能力：当 browser_navigate 的目标是「工作台标签」时，
    // 控制器会改为新开一个网页标签来承载 URL，从而不破坏 AI 对话页。
    createTab: (url, opts) => createTab(url, opts),
    isTrustedSender,
  });
} catch (err) {
  console.warn('[main] browser-cdp 未加载，AI 浏览器控制不可用：', err && err.message);
}

// ── 无头 Agent Runner（Super-agent 模块 5.1 · A 档）：runner:start / runner:stop / runner:status。
//    纯驱动核心见 renderer/runner/runner-core.js；此处仅注册 IPC。未注入 hasWork/driveStep 时为空转
//    （不改变任何既有行为）。缺失 agent-runner.js 时降级：应用照常启动。
try {
  const { registerAgentRunner } = require('./renderer/runner/agent-runner');
  registerAgentRunner({
    ipcMain,
    app,
    hasWork: () => false, // 预留：接入「未完成任务」判定后即可关页常驻推进
    driveStep: null
  });
} catch (err) {
  console.warn('[main] agent-runner 未加载，无头 Runner 不可用：', err && err.message);
}

// ── 系统通知（知识库复审到期提醒）──────────────────────────
// 仅接受 { title, body } 两个纯文本字段；渲染进程注入了 preload 才可达。
ipcMain.handle('app:notify', async (_e, payload) => {
  try {
    const title = String((payload && payload.title) || '提醒').slice(0, 120);
    const body = String((payload && payload.body) || '').slice(0, 500);
    if (Notification.isSupported()) {
      const n = new Notification({ title, body, silent: false });
      n.show();
      return { ok: true };
    }
    return { ok: false, reason: 'notifications-unsupported' };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
});

// ── 路径授权（fileAPI 的权限闸门）────────────────────────
// 默认「零授权」：只有用户显式拖入的文件/文件夹、或在系统对话框里选中的目录才登记；
// 系统目录 / 密钥目录 / 应用自身配置目录永远拒绝。实现见 fs-grant.js。
const grantStore = createGrantStore ? createGrantStore({ platform: process.platform }) : null;
let grantsLoaded = false;

function grantsFile() { return path.join(app.getPath('userData'), 'fs-grants.json'); }
function grantsProtectedDir() { try { return app.getPath('userData'); } catch (_) { return ''; } }

function ensureGrantsLoaded() {
  if (grantsLoaded) return;
  grantsLoaded = true;
  if (!grantStore) return;
  const prot = grantsProtectedDir();
  if (prot) grantStore.addProtected(prot);
  try {
    const json = JSON.parse(fs.readFileSync(grantsFile(), 'utf8'));
    (json && json.grants ? json.grants : []).forEach((g) => {
      try { grantStore.add(g.path, g.kind === 'file' ? 'file' : 'dir'); } catch (_) { /* 旧授权已失效 */ }
    });
  } catch (_) { /* 首次运行 / 文件损坏：视为无授权 */ }
}

function persistGrants() {
  if (!grantStore) return;
  try {
    const f = grantsFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ grants: grantStore.list() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
  } catch (_) { /* 持久化失败不影响内存授权 */ }
}

// 解析真实路径；目标不存在时退到「父目录 realpath + 文件名」，防止 symlink 逃逸
async function realTargetPath(target) {
  const abs = path.resolve(String(target || ''));
  try { return await fs.promises.realpath(abs); } catch (_) {
    try { return path.join(await fs.promises.realpath(path.dirname(abs)), path.basename(abs)); }
    catch (_2) { return abs; }
  }
}

async function assertFsAccess(e, target) {
  if (!isTrustedSender(e)) {
    const err = new Error('EPERM_UNTRUSTED：该文件接口只能由工作台页面调用');
    err.code = 'EPERM_UNTRUSTED';
    throw err;
  }
  ensureGrantsLoaded();
  if (!grantStore) {
    const err = new Error('EPERM_UNAVAILABLE：路径授权模块未加载（安装包不完整），已拒绝文件访问');
    err.code = 'EPERM_UNAVAILABLE';
    throw err;
  }
  const real = await realTargetPath(target);
  if (!grantStore.allows(real)) {
    const err = new Error('EPERM_NO_GRANT：未授权路径 ' + String(target) +
      '。请先把该文件 / 文件夹拖入工作台，或在对话框里重新选择目录后再操作。');
    err.code = 'EPERM_NO_GRANT';
    throw err;
  }
  return real;
}

ipcMain.handle('fs:grant', async (e, target) => {
  if (!isTrustedSender(e)) return { ok: false, reason: 'untrusted' };
  if (!grantStore) return { ok: false, reason: 'EPERM_UNAVAILABLE' };
  ensureGrantsLoaded();
  const real = await realTargetPath(target);
  // 已在授权范围内（重复拖入同一目录）→ 直接放行，不重复打扰
  if (grantStore.allows(real)) return { ok: true, path: real, kind: 'existing' };
  // 二次确认：路径字符串来自渲染层，必须由用户在原生对话框里点头才扩权，
  // 防止页面里的脚本（XSS / 恶意插件）自行 grant('C:\\Users\\me') 后读取全盘。
  let choice = 1;
  try {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      title: '路径授权',
      message: '是否允许工作台读写该路径？',
      detail: real + '\n\n只有你主动拖入工作台 / 在对话框里选择的文件才需要授权；来源不明的请求请点「拒绝」。',
      buttons: ['允许访问', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    choice = r.response;
  } catch (_) { choice = 1; }
  if (choice !== 0) return { ok: false, reason: 'denied' };
  let kind = 'file';
  try { const st = await fs.promises.stat(real); kind = st.isDirectory() ? 'dir' : 'file'; } catch (_) {}
  try {
    const rec = grantStore.add(real, kind);
    persistGrants();
    return { ok: true, path: rec.path, kind: rec.kind };
  } catch (err) {
    return { ok: false, reason: (err && err.code) || 'error', error: String((err && err.message) || err) };
  }
});

// 拖入路径「免确认授权」：拖放本身已是用户的显式动作，不再弹「路径授权」框。
// 但仍不允许渲染层空手扩权 —— 请求必须携带「证明」：webUtils.getPathForFile()
// 取到的真实文件路径（合成 File 只会得到空串，脚本伪造不了），且每条待授权
// 路径都必须等于某个真实拖入文件、或是它的祖先目录（拖入文件夹时一次授权整个目录）。
// 敏感路径（系统目录 / 密钥 / 应用配置）继续由 grantStore.add() 拒绝。
ipcMain.handle('fs:grant-dropped', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, reason: 'untrusted', granted: [], rejected: [] };
  if (!grantStore) return { ok: false, reason: 'EPERM_UNAVAILABLE', granted: [], rejected: [] };
  if (!createDropGrantVerifier) return { ok: false, reason: 'EPERM_NO_VERIFIER', granted: [], rejected: [] };
  ensureGrantsLoaded();

  const body = (payload && typeof payload === 'object') ? payload : {};
  const requested = Array.isArray(body.paths) ? body.paths : [];
  const proofCandidates = Array.isArray(body.proofs) ? body.proofs : [];
  if (!requested.length) return { ok: true, granted: [], rejected: [] };

  // 证明路径先 realpath 并确认磁盘上确实存在（防 symlink 逃逸 / 伪造路径）
  const proofs = [];
  for (const p of proofCandidates) {
    try {
      const real = await realTargetPath(p);
      await fs.promises.stat(real);
      proofs.push(real);
    } catch (_) { /* 不存在 / 无权限的证明一律作废 */ }
  }

  const verdict = createDropGrantVerifier({ platform: process.platform }).verify(requested, proofs);
  const granted = [];
  const rejected = verdict.rejected.slice();

  for (const p of verdict.allowed) {
    let real = p;
    try { real = await realTargetPath(p); } catch (_) { /* 保留原路径，下面 stat 决定类型 */ }
    let kind = 'file';
    try { const st = await fs.promises.stat(real); kind = st.isDirectory() ? 'dir' : 'file'; }
    catch (_) {
      rejected.push({ path: p, reason: 'EPERM_NOT_FOUND' });
      continue;
    }
    try { granted.push(grantStore.add(real, kind)); }
    catch (err) { rejected.push({ path: p, reason: (err && err.code) || 'error' }); }
  }

  if (granted.length) persistGrants();
  return { ok: true, granted, rejected };
});

ipcMain.handle('fs:grants', async (e) => {
  if (!isTrustedSender(e)) return { ok: false, reason: 'untrusted' };
  if (!grantStore) return { ok: false, reason: 'EPERM_UNAVAILABLE', grants: [] };
  ensureGrantsLoaded();
  return { ok: true, grants: grantStore.list() };
});

ipcMain.handle('fs:revoke-grants', async (e) => {
  if (!isTrustedSender(e)) return { ok: false, reason: 'untrusted' };
  if (!grantStore) return { ok: false, reason: 'EPERM_UNAVAILABLE' };
  ensureGrantsLoaded();
  grantStore.revokeAll();
  persistGrants();
  return { ok: true };
});

// ── 密钥存储（safeStorage 加密落盘；不写 localStorage、不写明文）──
function secretsFile() { return path.join(app.getPath('userData'), 'secrets.json'); }
let secretsCache = null;

function loadSecrets() {
  if (secretsCache) return secretsCache;
  try { secretsCache = JSON.parse(fs.readFileSync(secretsFile(), 'utf8')) || {}; }
  catch (_) { secretsCache = {}; }
  return secretsCache;
}

function persistSecrets() {
  const f = secretsFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(secretsCache), { mode: 0o600 });
  fs.renameSync(tmp, f);
  try { fs.chmodSync(f, 0o600); } catch (_) { /* Windows 上无意义 */ }
}

function secretBackend() {
  try {
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
      return safeStorage.getSelectedStorageBackend();
    }
  } catch (_) {}
  if (process.platform === 'win32') return 'dpapi';
  if (process.platform === 'darwin') return 'keychain';
  return 'unknown';
}

function secretAvailable() {
  try { return !!safeStorage.isEncryptionAvailable(); } catch (_) { return false; }
}

function validSecretName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(name);
}

function secretSet(name, value) {
  if (!validSecretName(name)) return { ok: false, reason: 'bad-name' };
  const v = String(value == null ? '' : value);
  if (!v) return secretRemove(name);
  if (!secretAvailable()) return { ok: false, reason: 'unavailable' };
  try {
    loadSecrets()[name] = safeStorage.encryptString(v).toString('base64');
    persistSecrets();
    return { ok: true, backend: secretBackend() };
  } catch (err) {
    return { ok: false, reason: 'encrypt-failed', error: String((err && err.message) || err) };
  }
}

function secretGet(name) {
  if (!validSecretName(name) || !secretAvailable()) return '';
  const enc = loadSecrets()[name];
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(String(enc), 'base64')); }
  catch (_) { return ''; }
}

function secretRemove(name) {
  if (!validSecretName(name)) return { ok: false, reason: 'bad-name' };
  const s = loadSecrets();
  if (Object.prototype.hasOwnProperty.call(s, name)) {
    delete s[name];
    try { persistSecrets(); } catch (_) {}
  }
  return { ok: true };
}

ipcMain.handle('secret:set', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, reason: 'untrusted' };
  const p = payload || {};
  return secretSet(p.name, p.value);
});

ipcMain.handle('secret:remove', async (e, name) => {
  if (!isTrustedSender(e)) return { ok: false, reason: 'untrusted' };
  return secretRemove(name);
});

ipcMain.handle('secret:status', async () => ({ available: secretAvailable(), backend: secretBackend() }));

// 同步读取：渲染层启动时要同步拿回 API Key（persist.load 是同步接口）
ipcMain.on('secret:get-sync', (e, name) => {
  let out = '';
  try { if (isTrustedSender(e)) out = secretGet(name); } catch (_) { out = ''; }
  e.returnValue = out;
});

ipcMain.on('secret:status-sync', (e) => {
  e.returnValue = { available: secretAvailable(), backend: secretBackend() };
});

// ── 文件系统 IPC（workbench 拖拽文件 → 真实磁盘读写）────────
// 仅由注入了 preload.js 的 workbench 页调用：拖拽文件时记录其磁盘真实路径，
// AI 编辑虚拟 FS 后据此把内容写回真实目录。
ipcMain.handle('fs:read', async (e, filePath) => {
  await assertFsAccess(e, filePath);
  return fs.promises.readFile(filePath);
});

ipcMain.handle('fs:write', async (e, filePath, content) => {
  await assertFsAccess(e, filePath);
  // content 可能是字符串，也可能是渲染进程传来的二进制（Uint8Array，经 IPC 结构化克隆）；
  // 统一成 Buffer 再写盘，保证图片 / PDF 等字节完全一致。
  let data = content;
  if (content && typeof content === 'object' && !Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    data = Uint8Array.from(Object.values(content));
  }
  // tmp + fsync + rename：写到一半被杀进程 / 断电 / 磁盘满，也不会把用户原文件截成半截。
  // 这是全系统唯一不可恢复的动作，不能再用「截断后原地覆盖」的 writeFile。
  if (typeof writeFileAtomic === 'function') {
    const r = await writeFileAtomic(filePath, data);
    if (r && r.mode === 'fallback-inplace') {
      console.warn('[main] 目标被占用，已退化为原地覆盖：', filePath, r.reason);
    }
  } else {
    try { await fs.promises.mkdir(path.dirname(filePath), { recursive: true }); } catch (_) { /* 父目录已存在 */ }
    await fs.promises.writeFile(filePath, data);
  }
  return true;
});

ipcMain.handle('fs:stat', async (e, targetPath) => {
  await assertFsAccess(e, targetPath);
  const st = await fs.promises.stat(targetPath);
  return { isFile: st.isFile(), isDirectory: st.isDirectory(), size: st.size, mtimeMs: st.mtimeMs };
});

ipcMain.handle('fs:exists', async (e, targetPath) => {
  await assertFsAccess(e, targetPath);
  try { await fs.promises.access(targetPath); return true; } catch (_) { return false; }
});

ipcMain.handle('fs:remove', async (e, targetPath) => {
  await assertFsAccess(e, targetPath);
  await fs.promises.rm(targetPath, { recursive: true, force: true });
  return true;
});

// 创建目录（含父级）；用于把「新增的空目录」同步回磁盘真实目录
ipcMain.handle('fs:mkdir', async (e, targetPath) => {
  await assertFsAccess(e, targetPath);
  await fs.promises.mkdir(targetPath, { recursive: true });
  return true;
});

ipcMain.handle('fs:walk', async (e, dirPath) => {
  await assertFsAccess(e, dirPath);
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(dirPath);
  return out;
});

// ── 知识库「本地路径」IPC ──────────────────────────────────
// 支持把磁盘上的某个文件夹配置为知识库的数据源：选择文件夹 → 递归扫描
// （按扩展名过滤）→ 渲染层逐篇读取正文 → 摄取入库 → 提问即在该路径内容上作答。
// 仅受信来源（注入了 preload 的工作台主页）可调用。
const KB_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '$RECYCLE.BIN', 'System Volume Information']);
const KB_MAX_FILES_DEFAULT = 2000;
const KB_MAX_FILES_CAP = 20000;

ipcMain.handle('kb:pick-dir', async (e) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择知识库本地文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    // 用户主动选择的目录 = 一次显式授权（知识库扫描 / 读取需要）
    if (!grantStore) return { ok: false, error: 'EPERM_UNAVAILABLE：路径授权模块未加载' };
    ensureGrantsLoaded();
    try {
      const rec = grantStore.add(await realTargetPath(r.filePaths[0]), 'dir');
      persistGrants();
      return { ok: true, path: rec.path };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('kb:scan', async (e, rootPath, opts) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  try { await assertFsAccess(e, rootPath); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  opts = opts || {};
  const exts = (Array.isArray(opts.exts) && opts.exts.length)
    ? opts.exts.map((x) => String(x).toLowerCase())
    : null;
  const subdirs = opts.subdirs !== false;
  const maxFiles = Math.max(1, Math.min(Number(opts.maxFiles) || KB_MAX_FILES_DEFAULT, KB_MAX_FILES_CAP));
  const files = [];
  let scanned = 0, truncated = false;

  async function walk(dir) {
    if (truncated) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (truncated) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!subdirs) continue;
        if (KB_SKIP_DIRS.has(ent.name)) continue;
        if (ent.name.startsWith('.')) continue;
        await walk(full);
      } else if (ent.isFile()) {
        if (ent.name.startsWith('.')) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (exts && exts.indexOf(ext) < 0) continue;
        scanned++;
        if (files.length >= maxFiles) { truncated = true; return; }
        let st = null;
        try { st = await fs.promises.stat(full); } catch (_) { /* 忽略单个文件错误 */ }
        files.push({ path: full, name: ent.name, ext, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 });
      }
    }
  }

  try {
    const st = await fs.promises.stat(rootPath);
    if (!st.isDirectory()) return { ok: false, error: '不是文件夹：' + rootPath };
    await walk(rootPath);
    return { ok: true, rootPath, files, scanned, truncated, total: files.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ════════════════════════════════════════════════════════════════════
//  运行工作区 Run Workspace（方案 B：虚拟 FS → 物化 → 真实执行 → 回收）
// ════════════════════════════════════════════════════════════════════
//  渲染层（受信 workbench 视图）把要执行的项目文件，按「工作区相对路径」+ base64
//  传来；主进程把它们物化到「应用目录下的 workspace/」（见下方 RUN_ROOT），再用
//  child_process 执行命令/测试。
//  · 真实磁盘上的工程文件不受影响；「🔁 同步」仍是唯一的发布闸门。
//  · 只允许受信来源调用（isTrustedSender）；命令默认 shell 执行，带超时/输出上限。
//  · node_modules / .git 由物化逻辑保留（依赖缓存走 run:cache 由渲染层决定）。
// ── 应用数据目录解析 ─────────────────────────────────────
// 运行工作区(workspace/) 与会话事件日志(messages/) 等应用级数据统一放在「当前应用目录」下，
// 而不是系统临时目录。解析顺序：应用目录(app.getAppPath()) → main.js 所在目录(__dirname) →
// 可执行文件目录 → 系统临时目录；逐个「创建 + 写入探测」，取第一个可写者
// （打包进 asar 时前两者只读，会回退到 exe 所在目录 / 临时目录）。
function resolveAppDir() {
  const candidates = [];
  try { if (app && typeof app.getAppPath === 'function') candidates.push(app.getAppPath()); } catch (_) {}
  candidates.push(__dirname);
  try { if (app && typeof app.getPath === 'function') candidates.push(path.dirname(app.getPath('exe'))); } catch (_) {}
  candidates.push(os.tmpdir());
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      return dir;
    } catch (_) { /* 试下一个候选目录 */ }
  }
  return os.tmpdir();
}
const APP_DIR = resolveAppDir();
const RUN_ROOT = path.join(APP_DIR, 'workspace');      // 物化 → 真实执行 → 回收
const MESSAGES_ROOT = path.join(APP_DIR, 'messages');  // 会话事件日志（append-only 事实源）
const PGDATA_DIR = path.join(APP_DIR, 'pgdata');       // PGlite 数据目录（与 messages/ 平级，落盘持久化）
const runWorkspaces = new Map();   // wsId -> { dir, children:Set, manifest:{rel:sha1} }
const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 120000; // 单条命令默认 2 分钟
const MAX_TIMEOUT_MS = 600000;     // 上限 10 分钟

function isTrustedSender(e) {
  try { return !!(e && e.sender && trustedSenders.has(e.sender.id)); } catch (_) { return false; }
}
function safeWsId(id) {
  const s = String(id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return s || 'default';
}
// 只接受「工作区内的相对路径」，拒绝绝对路径与 .. 逃逸
function safeRel(rel) {
  let r = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+/, '');
  // 去掉开头的 /home/pyodide 前缀（渲染层可能传虚拟绝对路径）
  r = r.replace(/^home\/pyodide\//, '');
  if (!r) return null;
  const parts = r.split('/');
  if (parts.some((p) => p === '..' || p === '')) return null;
  return parts.join('/');
}
// 工具运行期内部路径（结果溢出 .spill / 运行清单）：不属于项目内容，物化时直接跳过，
// 双保险——即便渲染层仍送来，也不会写进真实运行目录、更不会被当成项目文件。
function isInternalRunRel(rel) {
  if (!rel) return false;
  const segs = String(rel).replace(/\\/g, '/').split('/').filter(Boolean);
  for (const s of segs) {
    // 工具运行期产物 + 沙箱运行期目录（TMP/HOME 重定向目标），都不物化到真实运行目录
    if (s === '.spill' || s === '.chatbot-run-manifest.json' ||
        s === '.tmp' || s === '.home' || s === '.sandbox') return true;
  }
  return false;
}
function wsDirOf(wsId) { return path.join(RUN_ROOT, safeWsId(wsId)); }

async function getRunWorkspace(wsId, create) {
  const id = safeWsId(wsId);
  let ws = runWorkspaces.get(id);
  if (!ws) {
    const dir = wsDirOf(id);
    if (create) { try { await fs.promises.mkdir(dir, { recursive: true }); } catch (_) {} }
    ws = { dir, children: new Set(), manifest: null };
    runWorkspaces.set(id, ws);
  }
  return ws;
}
async function loadRunManifest(ws) {
  if (ws.manifest) return ws.manifest;
  try {
    const txt = await fs.promises.readFile(path.join(ws.dir, '.chatbot-run-manifest.json'), 'utf8');
    ws.manifest = JSON.parse(txt) || {};
  } catch (_) { ws.manifest = {}; }
  return ws.manifest;
}
async function saveRunManifest(ws) {
  try {
    await fs.promises.writeFile(
      path.join(ws.dir, '.chatbot-run-manifest.json'),
      JSON.stringify(ws.manifest || {}, null, 0)
    );
  } catch (_) { /* 忽略 */ }
}
// 流式 sha1：回收时逐个文件比对清单，避免把大文件整读进内存
function hashFileSha1(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(filePath);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}
// 递归删除路径（优先 promise 版 rm；老内核/受限运行时回退到 rmSync / unlinkSync）
async function rmPath(target) {
  if (fs.promises && typeof fs.promises.rm === 'function') {
    try { await fs.promises.rm(target, { recursive: true, force: true }); return; } catch (_) {}
  }
  try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (_) {}
  try { fs.unlinkSync(target); } catch (_) {}
}

// 递归累计目录占用字节数（用于「清空沙箱」后报告释放空间；任何读取失败都静默跳过）
async function dirSize(target) {
  let total = 0;
  async function walk(p) {
    let entries;
    try { entries = await fs.promises.readdir(p, { withFileTypes: true }); }
    catch (_) { return; }
    for (const ent of entries) {
      const fp = path.join(p, ent.name);
      if (ent.isDirectory()) { await walk(fp); continue; }
      try { const st = await fs.promises.stat(fp); total += st.size || 0; } catch (_) {}
    }
  }
  await walk(target);
  return total;
}

// 结束进程树（Windows 用 taskkill /T，类 Unix 用进程组负 PID）
function killProcessTree(child, signal) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    } else {
      try { process.kill(-child.pid, signal || 'SIGTERM'); }
      catch (_) { try { child.kill(signal || 'SIGTERM'); } catch (_) {} }
    }
  } catch (_) { /* 忽略 */ }
}

// run:materialize —— 把渲染层传来的文件增量物化到真实运行目录
ipcMain.handle('run:materialize', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  payload = payload || {};
  const files = Array.isArray(payload.files) ? payload.files : [];
  const ws = await getRunWorkspace(payload.workspaceId, true);
  const manifest = await loadRunManifest(ws);
  const next = {};
  let written = 0, skipped = 0, removed = 0;

  for (const f of files) {
    const rel = safeRel(f && f.path);
    if (!rel) continue;
    if (isInternalRunRel(rel)) continue; // 内部产物不物化到真实目录
    let buf;
    if (f && typeof f.dataBase64 === 'string') buf = Buffer.from(f.dataBase64, 'base64');
    else buf = Buffer.from(f && f.data != null ? f.data : '', 'utf8');

    const hash = crypto.createHash('sha1').update(buf).digest('hex');
    next[rel] = hash;
    const target = path.join(ws.dir, rel);

    // 增量：内容哈希一致且文件大小一致 → 跳过
    if (manifest[rel] === hash) {
      try {
        const st = await fs.promises.stat(target);
        if (st.isFile() && st.size === buf.length) { skipped++; continue; }
      } catch (_) { /* 缺失 → 重写 */ }
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, buf);
    written++;
  }

  // 删除工作区中已不存在的文件（保留依赖目录与版本库元数据）
  for (const rel of Object.keys(manifest)) {
    if (next[rel]) continue;
    if (rel === 'node_modules' || rel.startsWith('node_modules/') ||
        rel === '.git' || rel.startsWith('.git/')) { next[rel] = manifest[rel]; continue; }
    try { await rmPath(path.join(ws.dir, rel)); removed++; }
    catch (_) { /* 忽略 */ }
  }

  ws.manifest = next;
  await saveRunManifest(ws);
  return {
    ok: true, workspaceId: safeWsId(payload.workspaceId), dir: ws.dir,
    written, skipped, removed, total: Object.keys(next).length,
  };
});

// run:collect —— 把「真实执行后」运行目录里的变化回收给渲染层，由它写回虚拟工作区
//   · 以物化清单（manifest: rel → sha1）为基线：哈希不变 = 没动过，不搬字节；
//   · 只返回新增/修改文件的 base64 与已删除文件的相对路径；
//   · node_modules / .git / .sandbox / 运行清单永不回收（规则见 run-collect.js）；
//   · 单文件 4MB / 单次 32MB / 最多 2000 个文件，超限记入 skipped 并从清单删条目，
//     下次物化会用虚拟 FS 的旧内容重新覆盖 —— 宁可回退，不静默丢改动。
ipcMain.handle('run:collect', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  if (!RunCollect) return { ok: false, error: 'run-collect 模块未加载' };
  payload = payload || {};
  const ws = await getRunWorkspace(payload.workspaceId, true);
  const manifest = await loadRunManifest(ws);
  // 可选的追加忽略配置（结构见 run-collect.js isIgnoredRunPath 的 opts）；
  // 缺省 undefined 时用内置默认规则（已覆盖构建产物/缓存/日志/临时文件）
  const ignores = payload.ignores || undefined;
  // ── 逻辑保证（白名单 / 来源准入）────────────────────────────────────────
  // 虚拟空间只吸收「有必要的新增 / 编辑」，不再依赖逐个文件名黑名单治理垃圾：
  //   · 已有项目文件（物化清单 manifest 的键）的「修改 / 删除」→ 永远回收；
  //   · 命令「新生成」的文件 → 默认一律拒绝（allowNew=false）。因此任何陌生的
  //     .tmp/.home/缓存/未知产物都进不来 —— 与名字无关，是结构性拦截。
  //   · 确需“生成代码/产物”时，显式 allowNew=true（可再用 includeGlobs 收窄）。
  const allowNew = payload.allowNew === true;
  const includeGlobs = Array.isArray(payload.includeGlobs) ? payload.includeGlobs : [];
  const baseline = new Set(Object.keys(manifest).map((k) => RunCollect.toRel(k)));
  const admitCtx = { baseline: baseline, allowNew: allowNew, includeGlobs: includeGlobs, ignores: ignores };
  let deniedNew = 0;

  // 1) 遍历运行目录，收集「准入」文件的 rel / size（已知垃圾目录整棵剪枝，但仍向下递归）
  const entries = [];
  async function walk(absDir, relBase) {
    let list;
    try { list = await fs.promises.readdir(absDir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const ent of list) {
      const rel = relBase ? relBase + '/' + ent.name : ent.name;
      // 目录：黑名单剪枝（.tmp/.home/node_modules/缓存…），不整体拒绝，继续向下找合理编辑
      if (RunCollect.isIgnoredRunPath(rel, ignores)) continue;
      const full = path.join(absDir, ent.name);
      if (ent.isDirectory()) { await walk(full, rel); continue; }
      if (!ent.isFile()) continue;
      // 文件：白名单准入（已有文件的编辑/删除 or 显式允许的新增）
      if (!RunCollect.isAdmitted(rel, admitCtx)) {
        if (!baseline.has(RunCollect.toRel(rel))) deniedNew++;
        continue;
      }
      let st = null;
      try { st = await fs.promises.stat(full); } catch (_) { continue; }
      if (!st || !st.isFile()) continue;
      entries.push({ rel: rel, size: st.size, full: full });
    }
  }
  await walk(ws.dir, '');

  // 2) 清单只存哈希，因此仍需流式哈希才能判「变没变」
  for (const it of entries) {
    try { it.hash = await hashFileSha1(it.full); }
    catch (_) { it.hash = ''; }
    delete it.full;
  }
  const hashed = entries.filter((it) => it.hash);
  const diff = RunCollect.diffRunDir(manifest, hashed);
  // 安全阀：manifest 里可能有「如今已被忽略规则命中」的路径（例如后加的忽略规则，
  // 或某源文件恰在 dist/ 之类目录下）。这些不能算作「已删除」，否则会把虚拟 FS
  // 里的真实文件误删——此处从 removed 中剔除，清单条目也保留。
  const removedSafe = diff.removed.filter((rel) => RunCollect.isAdmitted(RunCollect.toRel(rel), admitCtx));
  const byRel = new Map();
  for (const it of hashed) byRel.set(it.rel, it);

  // 3) 限额挑选 → 读字节（只读真正要回收的，且已被 take 限流）
  const changedItems = diff.changed.map((rel) => byRel.get(rel)).filter(Boolean);
  const picked = RunCollect.selectCollectable(changedItems, payload.limits || undefined);
  const files = [];
  const collected = {};
  let bytes = 0;
  for (const rel of picked.take) {
    const it = byRel.get(rel);
    if (!it) continue;
    let buf = null;
    try { buf = await fs.promises.readFile(path.join(ws.dir, rel)); } catch (_) { continue; }
    files.push({ path: rel, dataBase64: buf.toString('base64') });
    collected[rel] = it.hash;
    bytes += buf.length;
  }

  // 4) 更新清单：收集的采用新哈希，删除/超限的删条目
  ws.manifest = RunCollect.buildNextManifest(manifest, {
    collected: collected,
    removed: removedSafe,
    skipped: picked.skipped
  });
  await saveRunManifest(ws);

  return {
    ok: true,
    workspaceId: safeWsId(payload.workspaceId),
    dir: ws.dir,
    files: files,
    removed: removedSafe,
    changed: diff.changed.length,
    unchanged: diff.unchanged.length,
    skipped: picked.skipped.length,
    skippedPaths: picked.skipped.slice(0, 20),
    bytes: bytes,
    allowNew: allowNew,
    deniedNew: deniedNew
  };
});

// ── 子进程输出解码（Windows 控制台编码修复）──────────────────────────
// 背景：Windows 上同一条命令的输出常混着两种编码 ——
//   · node.exe / npm / tsc 等程序直接往管道写 UTF-8；
//   · cmd.exe 的「内建」消息（如 `'head' 不是内部或外部命令…`）、本地化错误
//     DLL、原生 EXE 的 stderr 走控制台 OEM 代码页（简体中文 = CP936/GBK）。
//   光 `chcp 65001` 治不了后者，统一按 UTF-8 解就得到 `'head' �����ڲ�…` 的乱码。
// 方案（对齐 opencode 的 smartDecodeOutput）：
//   ① win32 上先 `chcp 65001`，让大多数程序输出 UTF-8（能治的先治）；
//   ② 默认解码器逐行 sniff —— 严格 UTF-8 成功即 UTF-8，失败且 win32 则按
//      GB18030 重解，都失败才 lossy UTF-8（逻辑在 renderer/console-encoding.js）。
//      逐行判定既保证实时输出，又不会「一段 GBK 把后面 UTF-8 也连坐成乱码」；
//   ③ 仍保留 encoding 显式覆盖（gbk/big5/utf16le/…）给不认 chcp 的老程序兜底，
//      解不干净时回一个 encodingHint 提示。
const CONSOLE_ENCODINGS = {
  'utf8': 'utf-8', 'utf-8': 'utf-8', '65001': 'utf-8', 'ascii': 'utf-8',
  'gbk': 'gb18030', 'gb2312': 'gb18030', 'gb-2312': 'gb18030', 'gb18030': 'gb18030',
  'cp936': 'gb18030', 'ms936': 'gb18030', 'windows-936': 'gb18030', '936': 'gb18030', 'chinese': 'gb18030',
  'big5': 'big5', 'cp950': 'big5', '950': 'big5',
  'shiftjis': 'shift_jis', 'shift-jis': 'shift_jis', 'sjis': 'shift_jis', 'cp932': 'shift_jis', 'ms932': 'shift_jis', '932': 'shift_jis',
  'euc-kr': 'euc-kr', 'cp949': 'euc-kr', '949': 'euc-kr',
  'utf16le': 'utf-16le', 'utf-16le': 'utf-16le', 'ucs2': 'utf-16le', 'ucs-2': 'utf-16le',
  'utf16be': 'utf-16be', 'utf-16be': 'utf-16be',
  'latin1': 'windows-1252', 'binary': 'windows-1252', 'iso-8859-1': 'windows-1252', 'cp1252': 'windows-1252',
};
function normalizeEncoding(enc) {
  const e = String(enc == null ? '' : enc).trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!e) return null;
  return CONSOLE_ENCODINGS[e] || e;
}
// 单个输出流的流式解码器：内部保存「半个字符」状态，flush() 吐出残留
function createOutputDecoder(encoding) {
  const TD = typeof TextDecoder === 'function' ? TextDecoder : require('node:util').TextDecoder;
  const label = normalizeEncoding(encoding) || 'utf-8';
  let dec = null;
  try { dec = new TD(label, { fatal: false }); } catch (_) { dec = null; }
  let iconv = null;
  if (!dec) { try { iconv = require('iconv-lite'); } catch (_) { iconv = null; } }
  const countFffd = (s) => { let n = 0, i = -1; while ((i = s.indexOf('\uFFFD', i + 1)) !== -1) n++; return n; };
  let badBytes = 0;
  return {
    label,
    write(chunk) {
      if (!chunk || chunk.length === 0) return '';
      let s;
      if (dec) s = dec.decode(chunk, { stream: true });
      else if (iconv) { try { s = iconv.decode(chunk, label === 'gb18030' ? 'gbk' : label); } catch (_) { s = chunk.toString('latin1'); } }
      else s = chunk.toString('utf8');
      if (label === 'utf-8' && s.indexOf('\uFFFD') !== -1) badBytes += countFffd(s);
      return s;
    },
    flush() {
      if (!dec) return '';
      try { return dec.decode(); } catch (_) { return ''; }
    },
    takeBadBytes() { const n = badBytes; badBytes = 0; return n; },
  };
}

// 统一命令启动点：解析沙箱配置 → 生成启动计划（Windows = PowerShell + Job Object）→ spawn。
// run:exec 与 run:start 共用，保证所有真实命令都经过同一层（env 清洗 / HOME 重定向 / Job 限制）。
function spawnSandboxed(command, opts) {
  opts = opts || {};
  const payload = opts.payload || {};
  const plan = sandbox.buildLaunchPlan({
    command,
    cwd: opts.cwd,
    payload,
    cfg: payload.sandbox || {},
    platform: process.platform,
  });
  const child = spawn(plan.file, plan.args, {
    cwd: plan.cwd,
    shell: plan.shell === true,
    detached: process.platform !== 'win32',
    windowsHide: payload.showWindow !== true,
    env: plan.env,
  });
  return { child, meta: plan.meta, cleanup: plan.cleanup };
}

// run:exec —— 在物化后的真实目录里执行命令（shell），流式回传 + 聚合返回
ipcMain.handle('run:exec', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, code: -1, stdout: '', stderr: '', error: 'untrusted sender' };
  payload = payload || {};
  const ws = await getRunWorkspace(payload.workspaceId, true);
  let cwd = ws.dir;
  if (payload.cwd) { const rel = safeRel(payload.cwd); if (rel) cwd = path.join(ws.dir, rel); }

  const command = String(payload.command || '').trim();
  if (!command) return { ok: false, code: -1, stdout: '', stderr: '', error: 'empty command' };

  const timeoutMs = Math.max(1000, Math.min(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const sender = e.sender;
  const startedAt = Date.now();

  // 编码决策：
  //   · 默认（不传 payload.encoding）→ 智能解码：先 chcp 65001 让程序输出 UTF-8，
  //     再逐行 sniff（严格 UTF-8 → win32 下 GB18030），cmd 内建消息也还原正确。
  //   · 传 payload.encoding（gbk / big5 / utf16le …）→ 固定按该编码解码（老程序兜底）。
  //   · payload.chcp === false → 不注入 chcp。
  const isWin = process.platform === 'win32';
  const explicitEnc = normalizeEncoding(payload.encoding);
  const winConsoleUtf8 = isWin && payload.chcp !== false && (explicitEnc || 'utf-8') === 'utf-8';
  const encoding = explicitEnc || (isWin ? (winConsoleUtf8 ? 'utf-8' : 'gb18030') : 'utf-8');
  // 注入 chcp 时用 `>nul 2>nul` 静音它自己的输出；用 & 而非 && —— 即使 chcp 失败也照常执行用户命令
  const fullCommand = winConsoleUtf8 ? ('chcp 65001>nul 2>nul & ' + command) : command;

  return await new Promise((resolve) => {
    let child, __sp;
    try {
      __sp = spawnSandboxed(fullCommand, { cwd, workspaceId: payload.workspaceId, payload });
      child = __sp.child;
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: String((err && err.message) || err), encoding, sandbox: { level: 'error' } });
      return;
    }

    ws.children.add(child);
    let stdout = '', stderr = '', outBytes = 0, timedOut = false, capped = false;
    // 统一出口：按字符数截断到 MAX_OUTPUT_BYTES，并流式转发给渲染层
    const emit = (stream, text) => {
      if (!text) return;
      if (outBytes >= MAX_OUTPUT_BYTES) { capped = true; return; }
      const remain = MAX_OUTPUT_BYTES - outBytes;
      const piece = text.length > remain ? text.slice(0, remain) : text;
      outBytes += Buffer.byteLength(piece);
      if (stream === 'stderr') stderr += piece; else stdout += piece;
      if (!sender.isDestroyed()) {
        try { sender.send('run:output', { workspaceId: safeWsId(payload.workspaceId), stream, data: piece }); } catch (_) {}
      }
    };
    // 显式 encoding → 固定解码器；默认 → 逐行 sniff 的智能解码器（UTF-8 / GB18030）
    const makeDecoder = (stream) => {
      if (explicitEnc) {
        const d = createOutputDecoder(explicitEnc);
        return {
          push: (chunk) => {
            let text;
            try { text = d.write(chunk); } catch (_) { text = Buffer.from(chunk).toString('utf8'); }
            emit(stream, text);
          },
          flush: () => emit(stream, d.flush()),
          takeFallbackCount: () => d.takeBadBytes(),
        };
      }
      return consoleEncoding.createConsoleStreamDecoder({
        platform: process.platform,
        onText: (text) => emit(stream, text),
      });
    };
    const decOut = makeDecoder('stdout');
    const decErr = makeDecoder('stderr');
    child.stdout.on('data', (c) => decOut.push(c));
    child.stderr.on('data', (c) => decErr.push(c));

    const timer = setTimeout(() => { timedOut = true; killProcessTree(child, 'SIGKILL'); }, timeoutMs);

    // 收尾：把解码器里残留的半个多字节字符吐出来，避免末尾吞字
    const drain = () => { decOut.flush(); decErr.flush(); };
    const badHint = () => {
      const bad = decOut.takeFallbackCount() + decErr.takeFallbackCount();
      if (bad > 0) {
        return explicitEnc
          ? `输出中有 ${bad} 段无法按 ${encoding} 解码，可换一个 encoding（如 gbk / big5 / utf16le）重试`
          : `输出中有 ${bad} 段既非 UTF-8 也非 GB18030，可能来自其它控制台代码页；可传 encoding（如 gbk / big5）重试`;
      }
      return undefined;
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      ws.children.delete(child);
      drain();
      const msg = String((err && err.message) || err);
      const res = { ok: false, code: -1, stdout, stderr: stderr ? (stderr + '\n' + msg) : msg, error: msg, durationMs: Date.now() - startedAt, timedOut, capped, encoding };
      const hint = badHint(); if (hint) res.encodingHint = hint;
      if (__sp) { res.sandbox = __sp.meta; try { __sp.cleanup(); } catch (_) {} }
      resolve(res);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      ws.children.delete(child);
      drain();
      const res = { ok: code === 0, code, signal: signal || null, stdout, stderr, durationMs: Date.now() - startedAt, timedOut, capped, cwd, encoding };
      const hint = badHint(); if (hint) res.encodingHint = hint;
      if (__sp) {
        res.sandbox = __sp.meta;
        try { sandbox.appendAudit(ws.dir, { command: fullCommand, sandboxLevel: __sp.meta.level, exitCode: code, durationMs: Date.now() - startedAt }); } catch (_) {}
        try { __sp.cleanup(); } catch (_) {}
      }
      resolve(res);
    });
  });
});

// run:kill —— 结束该工作区里仍在跑的进程
ipcMain.handle('run:kill', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false };
  const ws = await getRunWorkspace(payload && payload.workspaceId, false);
  const n = ws.children.size;
  for (const c of Array.from(ws.children)) killProcessTree(c, 'SIGKILL');
  return { ok: true, killed: n };
});

// ── 后台任务（Background Jobs）─────────────────────────────
// run_shell(run_in_background=true) → run:start 立即返回 job_id；
// 之后用 job_list / job_output / job_kill 读取与终止。
const backgroundJobs = new Map();
let backgroundJobSeq = 0;
function safeJobId(x) { return String(x || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80); }

// 任务记录 + 输出落盘（<APP_DIR>/jobs/），关窗/重启后仍可读取与续跑
let jobStore = null;
function ensureJobStore() {
  if (jobStore) return jobStore;
  if (!createJobStore) return null;
  try { jobStore = createJobStore({ dir: path.join(APP_DIR, 'jobs') }); } catch (_) { jobStore = null; }
  return jobStore;
}
function jobRecordOf(j) {
  return {
    id: j.id, workspaceId: j.workspaceId, command: j.command, cwd: j.cwd,
    status: j.status, exitCode: j.exitCode, signal: j.signal || null,
    startedAt: j.startedAt, endedAt: j.endedAt, encoding: j.encoding,
    capped: !!j.capped, stdoutBytes: j.stdoutBytes || 0, stderrBytes: j.stderrBytes || 0,
    resumedFrom: j.resumedFrom || null, error: j.error || '', hint: j.hint || ''
  };
}
function persistJob(j) { try { const st = ensureJobStore(); if (st) st.save(jobRecordOf(j)); } catch (_) {} }
function publicJob(j) {
  return {
    id: j.id, workspaceId: j.workspaceId, command: j.command, status: j.status, exitCode: j.exitCode,
    startedAt: j.startedAt, endedAt: j.endedAt, stdoutBytes: j.stdoutBytes || 0, stderrBytes: j.stderrBytes || 0,
    capped: !!j.capped, resumedFrom: j.resumedFrom || null, hint: j.hint || ''
  };
}

async function startBackgroundJob(e, payload, extra) {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  payload = payload || {};
  const ws = await getRunWorkspace(payload.workspaceId, true);
  let cwd = ws.dir;
  if (payload.cwd) { const rel = safeRel(payload.cwd); if (rel) cwd = path.join(ws.dir, rel); }
  const command = String(payload.command || '').trim();
  if (!command) return { ok: false, error: 'empty command' };

  const isWin = process.platform === 'win32';
  const explicitEnc = normalizeEncoding(payload.encoding);
  const winConsoleUtf8 = isWin && payload.chcp !== false && (explicitEnc || 'utf-8') === 'utf-8';
  const encoding = explicitEnc || (isWin ? (winConsoleUtf8 ? 'utf-8' : 'gb18030') : 'utf-8');
  const fullCommand = winConsoleUtf8 ? ('chcp 65001>nul 2>nul & ' + command) : command;

  let child, __sp;
  try {
    __sp = spawnSandboxed(fullCommand, { cwd, workspaceId: payload.workspaceId, payload });
    child = __sp.child;
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }

  const id = 'job-' + (++backgroundJobSeq) + '-' + Date.now().toString(36);
  const job = {
    id, workspaceId: safeWsId(payload.workspaceId), command, cwd, child,
    stdout: '', stderr: '', startedAt: Date.now(), endedAt: null,
    status: 'running', exitCode: null, capped: false, encoding,
    sandbox: __sp.meta,
    resumedFrom: (extra && extra.resumedFrom) || null,
  };
  backgroundJobs.set(id, job);
  ws.children.add(child);
  const sender = e.sender;
  persistJob(job);

  const store = ensureJobStore();
  const emit = (stream, text) => {
    if (!text) return;
    const total = job.stdoutBytes + job.stderrBytes;
    if (total >= MAX_OUTPUT_BYTES * 2) { job.capped = true; return; }
    if (stream === 'stderr') { job.stderr += text; job.stderrBytes += text.length; }
    else { job.stdout += text; job.stdoutBytes += text.length; }
    if (store) { try { store.append(id, stream, text); } catch (_) {} }
    if (!sender.isDestroyed()) {
      try { sender.send('run:output', { workspaceId: job.workspaceId, jobId: id, stream, data: text }); } catch (_) {}
    }
  };
  const decOut = consoleEncoding.createConsoleStreamDecoder({ platform: process.platform, onText: (t) => emit('stdout', t) });
  const decErr = consoleEncoding.createConsoleStreamDecoder({ platform: process.platform, onText: (t) => emit('stderr', t) });
  child.stdout.on('data', (c) => decOut.push(c));
  child.stderr.on('data', (c) => decErr.push(c));
  child.on('error', (err) => {
    try { decOut.flush(); decErr.flush(); } catch (_) {}
    job.status = 'failed'; job.error = String((err && err.message) || err); job.endedAt = Date.now();
    ws.children.delete(child);
    try { if (__sp) __sp.cleanup(); } catch (_) {}
    persistJob(job);
  });
  child.on('close', (code, signal) => {
    try { decOut.flush(); decErr.flush(); } catch (_) {}
    job.exitCode = code; job.signal = signal || null; job.endedAt = Date.now();
    job.status = (code === 0) ? 'exited' : 'failed';
    ws.children.delete(child);
    try { if (__sp) __sp.cleanup(); } catch (_) {}
    persistJob(job);
  });

  return { ok: true, jobId: id, status: 'running', command, cwd, resumedFrom: job.resumedFrom };
}

ipcMain.handle('run:start', async (e, payload) => startBackgroundJob(e, payload, {}));

ipcMain.handle('job:list', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  payload = payload || {};
  const wsFilter = payload.workspaceId ? safeWsId(payload.workspaceId) : '';
  const out = [];
  const seen = new Set();
  for (const j of backgroundJobs.values()) {
    if (wsFilter && j.workspaceId !== wsFilter) continue;
    seen.add(j.id);
    out.push(publicJob(j));
  }
  // 磁盘上的历史任务（含上次被中断的）：关窗/重启后依然可见
  try {
    const store = ensureJobStore();
    if (store) {
      for (const rec of store.list()) {
        if (seen.has(rec.id)) continue;
        if (wsFilter && rec.workspaceId !== wsFilter) continue;
        out.push({
          id: rec.id, workspaceId: rec.workspaceId, command: rec.command, status: rec.status,
          exitCode: rec.exitCode, startedAt: rec.startedAt, endedAt: rec.endedAt,
          stdoutBytes: rec.stdoutBytes || 0, stderrBytes: rec.stderrBytes || 0,
          capped: !!rec.capped, resumedFrom: rec.resumedFrom || null, hint: rec.hint || '', fromDisk: true
        });
      }
    }
  } catch (_) {}
  out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return { ok: true, jobs: out };
});

ipcMain.handle('job:output', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  payload = payload || {};
  const id = safeJobId(payload.jobId);
  const off = Math.max(0, Number(payload.offset) || 0);
  const max = Math.max(1000, Math.min(Number(payload.maxChars) || 20000, 200000));
  const live = backgroundJobs.get(id);
  if (live) {
    const stdout = live.stdout.slice(off, off + max);
    const stderr = live.stderr.slice(0, max);
    return {
      ok: true,
      job: { id: live.id, command: live.command, status: live.status, exitCode: live.exitCode, startedAt: live.startedAt, endedAt: live.endedAt },
      stdout, stderr, nextOffset: off + stdout.length,
      hasMore: live.stdout.length > off + stdout.length, capped: live.capped,
    };
  }
  // 不在内存 → 从落盘日志读（重启后的历史任务 / 续跑前的输出）
  try {
    const store = ensureJobStore();
    const rec = store && store.read(id);
    if (!rec) return { ok: false, error: 'unknown job' };
    const outSlice = store.slice(id, 'stdout', off, max);
    const errSlice = store.slice(id, 'stderr', 0, max);
    return {
      ok: true,
      job: { id: rec.id, command: rec.command, status: rec.status, exitCode: rec.exitCode, startedAt: rec.startedAt, endedAt: rec.endedAt },
      stdout: outSlice.text, stderr: errSlice.text,
      nextOffset: outSlice.nextOffset, hasMore: outSlice.hasMore,
      capped: !!rec.capped, hint: rec.hint || '', fromDisk: true,
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('job:kill', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  const id = safeJobId(payload && payload.jobId);
  const j = backgroundJobs.get(id);
  if (j) {
    try { killProcessTree(j.child, 'SIGKILL'); } catch (_) {}
    j.status = 'killed'; j.endedAt = Date.now();
    persistJob(j);
    return { ok: true, id: j.id };
  }
  // 历史任务：只更新落盘状态（进程早已不在）
  try {
    const store = ensureJobStore();
    const rec = store && store.read(id);
    if (!rec) return { ok: false, error: 'unknown job' };
    rec.status = 'killed'; rec.endedAt = Date.now();
    store.save(rec);
    return { ok: true, id: rec.id, fromDisk: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// job:resume —— 用「原命令 + 原工作区」重新执行；输出继续追加到同一 job 的日志
ipcMain.handle('job:resume', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  payload = payload || {};
  const id = safeJobId(payload.jobId);
  let rec = null;
  try { const store = ensureJobStore(); rec = store && store.read(id); } catch (_) {}
  if (!rec) return { ok: false, error: 'unknown job' };
  if (rec.status === 'running') return { ok: false, error: '任务仍在运行，无需续跑' };
  const resumed = await startBackgroundJob(e, {
    workspaceId: rec.workspaceId,
    command: rec.command,
    cwd: '',
    encoding: rec.encoding,
  }, { resumedFrom: rec.id });
  if (resumed && resumed.ok) {
    try {
      const store = ensureJobStore();
      const old = store.read(id);
      if (old) { old.status = 'resumed'; old.resumedBy = resumed.jobId; store.save(old); }
    } catch (_) {}
  }
  return resumed;
});

// ── 任务中心：任务态落盘（<APP_DIR>/tasks/<id>.json）──────────────
function tasksDir() {
  const d = path.join(APP_DIR, 'tasks');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function safeTaskId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64); }
const TASK_MAX_BYTES = 4 * 1024 * 1024;

ipcMain.handle('task:list', async (e) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  try {
    const dir = tasksDir();
    const out = [];
    for (const name of fs.readdirSync(dir)) {
      if (!/\.json$/.test(name)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (rec && rec.id) out.push(rec);
      } catch (_) { /* 损坏的记录跳过，不阻塞其它任务 */ }
      if (out.length >= 200) break;
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { ok: true, tasks: out };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('task:save', async (e, task) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  const id = safeTaskId(task && task.id);
  if (!id) return { ok: false, error: 'bad task id' };
  let data;
  try { data = JSON.stringify(task); } catch (_) { return { ok: false, error: 'not serializable' }; }
  if (data.length > TASK_MAX_BYTES) return { ok: false, error: 'task too large' };
  try {
    const dir = tasksDir();
    const f = path.join(dir, id + '.json');
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, f);
    return { ok: true, id };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('task:read', async (e, id) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  try { return { ok: true, task: JSON.parse(fs.readFileSync(path.join(tasksDir(), safeTaskId(id) + '.json'), 'utf8')) }; }
  catch (_) { return { ok: false, error: 'not found' }; }
});

ipcMain.handle('task:remove', async (e, id) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  try { fs.unlinkSync(path.join(tasksDir(), safeTaskId(id) + '.json')); return { ok: true }; }
  catch (_) { return { ok: false, error: 'not found' }; }
});

// ── 接口配置固化：应用目录 config/interface.json 读写 ──────────────────
//   · 把「⚙️ Interface Configuration」里可固化的配置落成人类可编辑的 JSON 文件；
//   · 渲染层启动时用 config:read-sync 同步回读（persist.load 是同步接口）；
//   · 页面保存配置后经 config:write 原子写回同名文件；
//   · 密钥（apiKey / provider.apiKey / ssh.password）由渲染层剥离，绝不写入本文件。
function configDir() {
  const d = path.join(APP_DIR, 'config');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
function configFilePath() { return path.join(configDir(), 'interface.json'); }
const CONFIG_MAX_BYTES = 2 * 1024 * 1024;

function readConfigFile() {
  const f = configFilePath();
  if (!fs.existsSync(f)) return { ok: true, exists: false, config: null, path: f };
  try {
    const raw = fs.readFileSync(f, 'utf8');
    return { ok: true, exists: true, config: JSON.parse(raw), path: f };
  } catch (err) {
    return { ok: false, exists: true, config: null, path: f, error: String((err && err.message) || err) };
  }
}

ipcMain.handle('config:read', async (e) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  try { return readConfigFile(); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

ipcMain.handle('config:write', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  let data;
  try { data = JSON.stringify(payload == null ? {} : payload, null, 2); }
  catch (_) { return { ok: false, error: 'not serializable' }; }
  if (data.length > CONFIG_MAX_BYTES) return { ok: false, error: 'config too large' };
  try {
    const f = configFilePath();
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, f);            // tmp + rename：写一半被杀进程也不会留下半截文件
    return { ok: true, path: f };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 同步读取（渲染层启动、persist.load 同步语义）：与 secret:get-sync 同款 sendSync。
ipcMain.on('config:read-sync', (e) => {
  let res;
  try {
    if (isTrustedSender(e)) res = readConfigFile();
    else res = { ok: false, error: 'untrusted sender' };
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  e.returnValue = res;
});

// run:cleanup —— 结束进程并删除该运行目录（依赖缓存随之清除）
ipcMain.handle('run:cleanup', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false };
  const id = safeWsId(payload && payload.workspaceId);
  for (const j of backgroundJobs.values()) {
    if (j.workspaceId === id) { try { killProcessTree(j.child, 'SIGKILL'); } catch (_) {} j.status = 'killed'; j.endedAt = Date.now(); }
  }
  const ws = runWorkspaces.get(id);
  if (ws) { for (const c of Array.from(ws.children)) killProcessTree(c, 'SIGKILL'); runWorkspaces.delete(id); }
  try { await rmPath(wsDirOf(id)); } catch (_) {}
  return { ok: true };
});

// run:cleanupAll —— 一键清空「实际沙箱空间」：终止全部后台任务 + 删除整个物化运行目录（workspace/）
//   · 只回收「物化 → 真实执行 → 回收」产生的真实磁盘目录（含 node_modules 等依赖缓存）；
//   · 虚拟工作区 /home/pyodide（almostnode，IndexedDB）与 🔁 同步落地的真实工程文件均不受影响；
//   · 删除后各 workspace 会在下次 run_shell / run_tests 时按需重新物化。
ipcMain.handle('run:cleanupAll', async (e) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  // 1) 终止所有仍在跑的后台任务进程
  for (const j of backgroundJobs.values()) {
    try { killProcessTree(j.child, 'SIGKILL'); } catch (_) {}
    j.status = 'killed'; j.endedAt = Date.now();
    persistJob(j);
  }
  // 2) 终止所有运行工作区里仍在跑的进程，并清空内存登记
  for (const ws of runWorkspaces.values()) {
    for (const c of Array.from(ws.children)) { try { killProcessTree(c, 'SIGKILL'); } catch (_) {} }
  }
  // 3) 统计并删除整个运行根目录（含所有 workspace 子目录）
  let freedBytes = 0;
  try { freedBytes = await dirSize(RUN_ROOT); } catch (_) {}
  let workspaces = 0;
  try { workspaces = (await fs.promises.readdir(RUN_ROOT)).length; } catch (_) {}
  runWorkspaces.clear();
  try { await rmPath(RUN_ROOT); } catch (_) {}
  return { ok: true, workspaces, freedBytes, dir: RUN_ROOT };
});

// ── 重新聚焦窗口 + 当前页面（修复原生 confirm/alert 关闭后整窗失焦）──────
//   现象：点「清空沙箱」→ 原生确认框关闭后，鼠标点输入框打不了字，必须先点一下
//   系统任务栏图标再点输入框才恢复——这是 Electron 原生弹窗导致 Window/webContents
//   丢失「OS 级」焦点（DOM 仍 active，但键盘事件进不来）。
//   仅靠渲染层 window.focus() 无效；这里由主进程把窗口与发起请求的那个 webContents
//   重新聚焦，等价于「点任务栏 + 点输入框」的动作。
ipcMain.handle('win:refocus', async (e) => {
  try {
    if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
    if (!win || win.isDestroyed()) return { ok: false, error: 'no-window' };
    try { if (typeof win.isMinimized === 'function' && win.isMinimized()) win.restore(); } catch (_) {}
    try { win.focus(); } catch (_) {}
    try { if (e.sender && !e.sender.isDestroyed()) e.sender.focus(); } catch (_) {}
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 应用退出：清理所有运行工作区进程 + 关闭 pglite-server（释放端口/连接/数据库）
app.on('will-quit', () => {
  for (const ws of runWorkspaces.values()) for (const c of Array.from(ws.children)) killProcessTree(c, 'SIGKILL');
  if (stopPgliteServer) { try { stopPgliteServer().catch(() => {}); } catch (_) { /* ignore */ } }
});

// ════════════════════════════════════════════════════════════════════
//  会话事件日志 Session Event Log（append-only，dsh 式「事实源」）
// ════════════════════════════════════════════════════════════════════
//  每个会话 = 应用目录（APP_DIR）下 messages/<sid>/ 一个目录：
//    · events.jsonl  追加写（open 'a'，永不 truncate）——唯一事实源
//    · meta.json     会话元数据（标题 / 创建时间 / 分支来源），可覆盖写
//  渲染层只经 messagesAPI 追加/读取；主进程保证「只追加」，并提供
//  list / fork(复制前缀) / remove。全部通道仅受信来源（工作台主页）可调。
//  价值：对话不再只活在内存/localStorage，而是磁盘上可 replay / fork /
//  崩溃恢复的 append-only 日志（模型可见的载荷先入日志，见 model.request）。
function safeSid(id) {
  const s = String(id == null ? '' : id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return s || 'default';
}
function sessionDirOf(sid) { return path.join(MESSAGES_ROOT, safeSid(sid)); }
function eventsFileOf(sid) { return path.join(sessionDirOf(sid), 'events.jsonl'); }
function parseJsonl(txt) {
  const out = [];
  for (const line of String(txt).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* 崩溃恢复：跳过损坏/半截行 */ }
  }
  return out;
}

// 追加事件（唯一写入口；永远 append，绝不覆盖）
ipcMain.handle('msg:append', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'forbidden' };
  const p = payload || {};
  const sid = safeSid(p.sid);
  const events = Array.isArray(p.events) ? p.events : (p.event ? [p.event] : []);
  if (!events.length) return { ok: true, appended: 0 };
  try {
    await fs.promises.mkdir(sessionDirOf(sid), { recursive: true });
    const text = events.map((ev) => JSON.stringify(ev) + '\n').join('');
    await fs.promises.appendFile(eventsFileOf(sid), text, 'utf8');
    return { ok: true, appended: events.length, bytes: Buffer.byteLength(text) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 读取事件（可按 fromSeq 增量拉取；损坏行自动跳过）
ipcMain.handle('msg:read', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'forbidden' };
  const p = payload || {};
  const sid = safeSid(p.sid);
  try {
    const txt = await fs.promises.readFile(eventsFileOf(sid), 'utf8');
    const all = parseJsonl(txt);
    const from = Number(p.fromSeq || 0) || 0;
    const events = from > 0 ? all.filter((ev) => ((ev && ev.seq) || 0) > from) : all;
    return { ok: true, events, total: all.length };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, events: [], total: 0, missing: true };
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 列出所有会话（目录 + 事件文件大小 + 元数据）
ipcMain.handle('msg:list', async (e) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'forbidden' };
  try {
    const entries = await fs.promises.readdir(MESSAGES_ROOT, { withFileTypes: true }).catch(() => []);
    const sessions = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const sid = ent.name;
      const dir = path.join(MESSAGES_ROOT, sid);
      let stat = null;
      try { stat = await fs.promises.stat(path.join(dir, 'events.jsonl')); } catch (_) {}
      let meta = null;
      try { meta = JSON.parse(await fs.promises.readFile(path.join(dir, 'meta.json'), 'utf8')); } catch (_) {}
      sessions.push({ sid, size: stat ? stat.size : 0, mtimeMs: stat ? stat.mtimeMs : 0, meta: meta || null });
    }
    return { ok: true, sessions };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ── 转录全文检索（硬切窗口的「可查询历史」）─────────────────────────
// 跨 messages/<sid>/events.jsonl 做关键词检索：把事件流折叠成消息视图，
// 逐条打分并返回「会话指针 + 命中片段」。这样旧窗口的完整对话不必留在上下文里，
// 模型需要时按需检索即可。
function hcMessageText(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === 'string') ? p.text : '').join('\n');
  return '';
}
function hcClip(s, n) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function hcSnippet(text, at, width) {
  text = String(text == null ? '' : text);
  width = width || 180;
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return (start > 0 ? '…' : '') + hcClip(text.slice(start, end), width + 20) + (end < text.length ? '…' : '');
}
function hcFoldMessages(events) {
  let msgs = [];
  for (const ev of events || []) {
    if (!ev || !ev.type) continue;
    if (ev.type === 'msg.append' && Array.isArray(ev.msgs)) msgs = msgs.concat(ev.msgs);
    else if (ev.type === 'msg.truncate') msgs = msgs.slice(0, Math.max(0, ev.toLen | 0));
    else if (ev.type === 'msg.replace') msgs = Array.isArray(ev.msgs) ? ev.msgs.slice() : [];
  }
  return msgs;
}

ipcMain.handle('msg:search', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'forbidden', results: [] };
  const p = payload || {};
  const q = String(p.query == null ? '' : p.query).trim();
  if (!q) return { ok: false, error: 'empty query', results: [] };
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const limit = Math.max(1, Math.min(20, Number(p.limit) || 5));
  const maxSessions = Math.max(1, Math.min(200, Number(p.maxSessions) || 100));
  const hitsPerSession = Math.max(1, Math.min(10, Number(p.hitsPerSession) || 3));
  const sidFilter = Array.isArray(p.sids) ? new Set(p.sids.map(String)) : null;
  const roleFilter = Array.isArray(p.roles) ? new Set(p.roles.map(String)) : null;
  try {
    const entries = await fs.promises.readdir(MESSAGES_ROOT, { withFileTypes: true }).catch(() => []);
    let dirs = entries.filter((d) => d.isDirectory()).map((d) => d.name);
    if (sidFilter) dirs = dirs.filter((s) => sidFilter.has(s));
    const metas = [];
    for (const sid of dirs) {
      let st = null;
      try { st = await fs.promises.stat(path.join(MESSAGES_ROOT, sid, 'events.jsonl')); } catch (_) {}
      if (st) metas.push({ sid, size: st.size, mtimeMs: st.mtimeMs });
    }
    metas.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const results = [];
    for (const m of metas.slice(0, maxSessions)) {
      if (m.size > 8 * 1024 * 1024) continue; // 超大日志跳过，避免卡顿
      let txt = '';
      try { txt = await fs.promises.readFile(path.join(MESSAGES_ROOT, m.sid, 'events.jsonl'), 'utf8'); } catch (_) { continue; }
      const msgs = hcFoldMessages(parseJsonl(txt));
      const hits = [];
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        if (!msg) continue;
        const role = msg.role || '';
        if (roleFilter && !roleFilter.has(role)) continue;
        const text = hcMessageText(msg);
        if (!text) continue;
        const low = text.toLowerCase();
        let score = 0, first = -1;
        for (const t of terms) {
          const idx = low.indexOf(t);
          if (idx >= 0) { score += 1; if (first < 0 || idx < first) first = idx; }
        }
        if (!score) continue;
        hits.push({ index: i + 1, role, score, snippet: hcSnippet(text, first, 180) });
      }
      if (!hits.length) continue;
      hits.sort((a, b) => b.score - a.score);
      let meta = null;
      try { meta = JSON.parse(await fs.promises.readFile(path.join(MESSAGES_ROOT, m.sid, 'meta.json'), 'utf8')); } catch (_) {}
      let title = (meta && meta.title) || '';
      if (!title) {
        const fu = msgs.find((x) => x && x.role === 'user');
        if (fu) title = hcClip(hcMessageText(fu), 80);
      }
      results.push({
        sid: m.sid, title, ts: m.mtimeMs,
        score: hits.reduce((n, h) => n + h.score, 0),
        hits: hits.slice(0, hitsPerSession)
      });
    }
    results.sort((a, b) => b.score - a.score || (b.ts || 0) - (a.ts || 0));
    return { ok: true, source: 'session-log', query: q, total: results.length, results: results.slice(0, limit) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), results: [] };
  }
});

// 读写会话元数据（meta 传入 = 写；不传 = 读）
ipcMain.handle('msg:meta', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'forbidden' };
  const p = payload || {};
  const sid = safeSid(p.sid);
  const file = path.join(sessionDirOf(sid), 'meta.json');
  try {
    if (p.meta && typeof p.meta === 'object') {
      await fs.promises.mkdir(sessionDirOf(sid), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(p.meta, null, 2), 'utf8');
      return { ok: true };
    }
    return { ok: true, meta: JSON.parse(await fs.promises.readFile(file, 'utf8')) };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, meta: null };
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// fork：复制源会话「直到 upToSeq（含）」的事件到新会话，并追加分支标记
ipcMain.handle('msg:fork', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'forbidden' };
  const p = payload || {};
  const src = safeSid(p.from);
  const dst = safeSid(p.to);
  if (src === dst) return { ok: false, error: 'same sid' };
  const upToSeq = (p.upToSeq == null || p.upToSeq === '') ? Infinity : Number(p.upToSeq);
  try {
    const txt = await fs.promises.readFile(eventsFileOf(src), 'utf8');
    const evs = parseJsonl(txt).sort((a, b) => ((a.seq || 0) - (b.seq || 0)));
    const kept = [];
    let maxSeq = 0;
    for (const ev of evs) {
      if (ev && ev.seq != null && ev.seq > upToSeq) break;
      kept.push(ev);
      if (ev && ev.seq != null) maxSeq = Math.max(maxSeq, ev.seq);
    }
    // 追加分支标记：标注来源与切点（不改动消息视图）
    kept.push({ seq: maxSeq + 1, ts: Date.now(), type: 'session.branch', sid: dst, from: src, fromSeq: isFinite(upToSeq) ? upToSeq : maxSeq });
    await fs.promises.mkdir(sessionDirOf(dst), { recursive: true });
    await fs.promises.writeFile(eventsFileOf(dst), kept.map((ev) => JSON.stringify(ev)).join('\n') + '\n', 'utf8');
    return { ok: true, to: dst, copied: Math.max(0, kept.length - 1) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 删除某会话的日志目录（事实源落盘后，删除仅在用户显式要求时进行）
ipcMain.handle('msg:remove', async (e, payload) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'forbidden' };
  const sid = safeSid((payload || {}).sid);
  try { await rmPath(sessionDirOf(sid)); return { ok: true }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// ── 网络抓取 IPC（read_url 工具）─────────────────────────
// 由工作台页（注入 preload.js）调用：在主进程用 Electron net 发起请求，
// 绕过渲染进程的 CORS 限制；返回 base64 以便二进制（PDF/Office/图片）也能落盘。
ipcMain.handle('net:fetch', async (_e, url, opts) => {
  opts = opts || {};
  const maxBytes = Math.max(1024, Math.min(opts.maxBytes || 5 * 1024 * 1024, 50 * 1024 * 1024));
  const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs || 20000, 120000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await net.fetch(String(url), {
      method: opts.method || 'GET',
      redirect: 'follow',
      headers: opts.headers || undefined,
      signal: controller.signal,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    const sliced = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText || '',
      contentType: resp.headers.get('content-type') || '',
      finalUrl: resp.url || String(url),
      base64: sliced.toString('base64'),
      truncated: buf.length > maxBytes,
    };
  } catch (err) {
    return { ok: false, status: 0, statusText: '', contentType: '', finalUrl: String(url), base64: '', error: (err && err.message) ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
});

// ── 网页搜索抓取 IPC（web_search 工具）─────────────────────────
// 通用 GET：由渲染层决定抓哪个搜索端点（Bing RSS / Bing HTML / DuckDuckGo HTML /
// Instant Answer JSON），主进程用 Electron net 发起请求以绕过 CORS，
// 返回文本供 web-search.js 解析。payload.headers 可覆盖默认请求头。
ipcMain.handle('net:search', async (_e, payload) => {
  payload = payload || {};
  const url = String(payload.url || '').trim();
  if (!url) return { ok: false, status: 0, error: 'empty url', text: '' };
  const timeoutMs = Math.max(1000, Math.min(payload.timeoutMs || 15000, 60000));
  const extraHeaders = (payload.headers && typeof payload.headers === 'object') ? payload.headers : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await net.fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, application/json, text/html;q=0.9, */*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }, extraHeaders || {}),
      signal: controller.signal,
    });
    const text = await resp.text();
    return { ok: resp.ok, status: resp.status, url: resp.url || url, contentType: resp.headers.get('content-type') || '', text: text.slice(0, 300000) };
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || String(err), text: '' };
  } finally {
    clearTimeout(timer);
  }
});


// ── SSH / SFTP IPC（MCP ssh 工具 + VFS 上传/下载）──────────────────────
// 由工作台页（注入 preload.js 的 sshAPI）调用；ssh2 缺失时 handlers 不注册，
// 渲染层调用会走「channel 无 handler」错误，ssh-mcp 工具返回可读降级提示。
try {
  if (registerSshIpc) {
    registerSshIpc(ipcMain, isTrustedSender);
    console.log('[main] ssh: IPC 已注册（ssh-manager）');
  }
} catch (err) { console.warn('[main] ssh IPC 注册失败：', err && err.message); }


// ── 静默下载：保存到系统「下载」目录，不弹保存对话框 ─────────────
// 背景：各导出/下载按钮（Office 编辑器 ⬇️下载、doc-tools 的 download=true 等）
// 本质都是浏览器 <a download> 下载。未注册 will-download 时 Electron 会默认
// 每次都弹系统「另存为」框。这里统一拦截：直接落到 app.getPath('downloads')，
// 同名文件自动加 (1)(2)… 序号，全程无对话框。
function uniqueDownloadPath(dir, filename) {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length) || 'download';
  let candidate = path.join(dir, filename);
  let i = 1;
  // 逐个试探，直到找到一个当前不存在的路径（避免静默覆盖已有文件）
  while (true) {
    try { fs.accessSync(candidate); } catch (_) { return candidate; } // 不存在 → 可用
    candidate = path.join(dir, base + ' (' + i + ')' + ext);
    i++;
  }
}

// 下载完成后弹一条系统通知（提示已存到哪个目录）；点通知→资源管理器打开并选中该文件
// 注意：该通知默认被 DOWNLOAD_NOTIFY_ENABLED 关闭（导出后不打扰），仅在开启时才弹出。
function notifyDownloadSaved(savePath) {
  if (!DOWNLOAD_NOTIFY_ENABLED) return;
  try {
    if (!Notification.isSupported()) return;
    const name = path.basename(savePath || '');
    const dir = path.dirname(savePath || '');
    const n = new Notification({
      title: '文件已保存到「下载」目录',
      body: (name ? name + '\n' : '') + '位置：' + (dir || savePath || ''),
      silent: false,
    });
    n.on('click', () => {
      try { shell.showItemInFolder(savePath); } catch (_) { /* 文件已被移动/删除，忽略 */ }
    });
    n.show();
  } catch (err) {
    console.error('[download] 发送通知失败：', err);
  }
}

function setupSilentDownloads() {
  let dlDir;
  try { dlDir = app.getPath('downloads'); }
  catch (_) { dlDir = path.join(os.homedir(), 'Downloads'); }
  try { fs.mkdirSync(dlDir, { recursive: true }); } catch (_) {}

  session.defaultSession.on('will-download', (event, item) => {
    try {
      const name = item.getFilename() || ('download-' + Date.now());
      item.setSavePath(uniqueDownloadPath(dlDir, name));
    } catch (err) {
      // 兜底：即便取不到文件名/路径，也不要让异常中断下载流程
      console.error('[download] 设置保存路径失败：', err);
    }
    // 下载结束（state: completed | cancelled | interrupted）→ 仅成功时提示
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        let sp = '';
        try { sp = item.getSavePath(); } catch (_) { sp = ''; }
        notifyDownloadSaved(sp);
      }
    });
  });
}

// ── vfs:// 协议：内置浏览器直接浏览 VFS（almostnode 虚拟文件系统）里的文件 ──
// VFS 数据不在磁盘上，而在工作台渲染层的 almostnode FS 里，所以协议处理器
// 向工作台页面要字节（window.__vfsServeRead，见 renderer/assets/js/05-fs-tools.js），
// 再按 MIME / 目录列表返回给浏览器标签。只读；路径越界（不在 /home/pyodide 下）
// 已在 url-resolve.vfsPathFromUrl 里拒绝。
function findWorkbenchWebContents() {
  for (const t of tabs.values()) {
    const wc = t && t.view && t.view.webContents;
    if (t && t.isWorkbench && wc && !wc.isDestroyed()) return wc;
  }
  return null;
}
function registerVfsProtocol() {
  if (!UrlResolve || typeof protocol.handle !== 'function') return;
  try {
    protocol.handle('vfs', async (request) => {
      const errPage = (title, detail) =>
        new Response(UrlResolve.renderVfsErrorHtml(title, detail), {
          status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      const vpath = UrlResolve.vfsPathFromUrl(request.url);
      if (!vpath) return errPage('路径无效', request.url + '（VFS 文件须位于 /home/pyodide 下）');
      const wc = findWorkbenchWebContents();
      if (!wc) return errPage('工作台未就绪', 'VFS 数据存放在工作台页面里，请等工作台加载完成后再试。');
      let res;
      try {
        res = await Promise.race([
          wc.executeJavaScript(
            'window.__vfsServeRead ? window.__vfsServeRead(' + JSON.stringify(vpath) +
            ') : { ok:false, error:"工作台未提供 __vfsServeRead（请重启应用）" }', true),
          new Promise((_, rej) => setTimeout(() => rej(new Error('读取 VFS 超时（10s）')), 10000)),
        ]);
      } catch (e) { return errPage('读取 VFS 失败', (e && e.message) || e); }
      if (!res || !res.ok) return errPage('无法找到该文件', (res && res.error) || vpath);
      if (res.isDir) {
        return new Response(UrlResolve.renderDirectoryHtml(vpath, res.entries || []), {
          status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      const buf = Buffer.from(res.dataBase64 || '', 'base64');
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': UrlResolve.mimeFromVPath(vpath), 'Content-Length': String(buf.length) },
      });
    });
    console.log('[main] vfs:// 协议已注册（内置浏览器可浏览 VFS 文件）');
  } catch (e) { console.warn('[main] vfs:// 协议注册失败（浏览 VFS 文件不可用）：', e && e.message); }
}

// ── 应用生命周期 ─────────────────────────────────────────
app.whenReady().then(() => {
  setupSilentDownloads();
  registerVfsProtocol();
  // 后台任务：启动时把上次仍 running 的记录标记为 interrupted（进程已随应用退出），
  // 这样 job_list 能显示「上次中断」并允许 job_resume 续跑。
  try { const st = ensureJobStore(); if (st) st.markInterrupted(); } catch (_) {}
  // 内嵌 PostgreSQL：应用启动即初始化进程内 PGlite（db:* IPC 直连），
  // 就绪后再开一个 wire-protocol 端口供外部 psql 连接。异步且只告警：数据库问题绝不能挡住窗口创建。
  if (embeddedDb) {
    // 数据目录固定到「应用目录/pgdata」，与 messages/ 平级，落盘持久化。
    embeddedDb.init({ dataDir: PGDATA_DIR })
      .then(() => {
        // 内嵌库就绪后，在同一 PGlite 实例上再开一个 Postgres wire-protocol 端口，
        // 让外部 psql / DBeaver / GoNavi(dbclient) 等客户端能连进同一个库。
        // 默认 127.0.0.1:5432（占用自动回退）；PGLITE_HOST=0.0.0.0 可对局域网开放。
        // 设 PGLITE_DISABLE_TCP=1 可完全关闭对外监听。失败只告警，不影响窗口与内嵌 dbclient。
        if (startWireServer && !process.env.PGLITE_DISABLE_TCP) {
          return startWireServer().catch((err) => {
            console.warn('[main] 外部 psql 监听启动失败：', err && err.message);
          });
        }
      })
      .catch((err) => {
        console.warn('[main] 内嵌 PostgreSQL 初始化失败：', err && err.message);
      });
  }
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BaseWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
