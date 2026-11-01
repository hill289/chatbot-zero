const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 暴露给渲染进程（页面）的安全 API
contextBridge.exposeInMainWorld('fileAPI', {
  // 关键：把拖进来的 File 对象转换成磁盘上的真实绝对路径
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // ── 路径授权 ────────────────────────────────────────────
  // 主进程默认「零授权」：读写前必须先 grant（拖入文件 / 选择目录时调用）。
  // 未授权的路径一律 EPERM_NO_GRANT，系统目录 / 密钥目录永远拒绝。
  grant: (targetPath) => ipcRenderer.invoke('fs:grant', targetPath),
  // 拖入路径的批量授权（不弹原生确认框）：
  //   payload = { paths: [待授权路径], proofs: [拖入 File 的真实路径] }
  //   proofs 由 getPathForFile() 取得 —— 合成 File 得到空串，主进程据此拒绝无证明的扩权。
  grantDropped: (payload) => ipcRenderer.invoke('fs:grant-dropped', payload || {}),
  grants: () => ipcRenderer.invoke('fs:grants'),
  revokeGrants: () => ipcRenderer.invoke('fs:revoke-grants'),
  // 读取文件文本内容
  read: (filePath) => ipcRenderer.invoke('fs:read', filePath),
  // 把内容写回（覆盖）原文件
  write: (filePath, content) => ipcRenderer.invoke('fs:write', filePath, content),
  // 写入二进制内容（Uint8Array）：vfs 唯一写入口钩子按字节同步回真实文件，图片/PDF 等不失真
  writeBytes: (filePath, bytes) => ipcRenderer.invoke('fs:write', filePath, bytes),
  // 判断路径类型
  stat: (targetPath) => ipcRenderer.invoke('fs:stat', targetPath),
  // 判断路径是否存在
  exists: (targetPath) => ipcRenderer.invoke('fs:exists', targetPath),
  // 删除文件或目录（递归）
  remove: (targetPath) => ipcRenderer.invoke('fs:remove', targetPath),
  // 创建目录（含父级）：把新增的空目录同步回真实目录
  mkdir: (targetPath) => ipcRenderer.invoke('fs:mkdir', targetPath),
  // 递归列出目录中的文件
  walk: (dirPath) => ipcRenderer.invoke('fs:walk', dirPath),
  // ── 知识库「本地路径」──────────────────────────────────────
  // 弹出系统文件夹选择框，返回 { ok, path } 或 { ok:false, canceled:true }
  pickDirectory: () => ipcRenderer.invoke('kb:pick-dir'),
  // 递归扫描文件夹（按扩展名过滤），返回 { ok, files:[{path,name,ext,size,mtimeMs}], scanned, truncated, total }
  scanDir: (dirPath, opts) => ipcRenderer.invoke('kb:scan', dirPath, opts || {}),
  // 抓取外部 URL（read_url 工具）：经主进程 net 发起，绕过渲染进程 CORS。
  // 返回 { ok, status, statusText, contentType, finalUrl, base64, truncated?, error? }
  fetchUrl: (url, options) => ipcRenderer.invoke('net:fetch', url, options || {}),
  // 系统通知（知识库复审到期提醒等）：仅受信来源（工作台主页）可调
  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),

});

// ── 密钥存储 API（safeStorage 加密，主进程落盘）─────────────────────────
// 渲染层不再把 API Key 写 localStorage：这里只做「取/存/删」，密文由主进程
// 用 OS 钥匙串（DPAPI / Keychain / libsecret）加密后写入 userData/secrets.json。
// 系统不支持加密时 available=false，渲染层会退化为「仅本次会话内存」并提示用户。
contextBridge.exposeInMainWorld('secretAPI', (() => {
  let status = { available: false, backend: 'unknown' };
  try { status = ipcRenderer.sendSync('secret:status-sync') || status; } catch (_) {}
  return {
    available: !!status.available,
    backend: status.backend || 'unknown',
    getSync: (name) => {
      try { return ipcRenderer.sendSync('secret:get-sync', String(name)) || ''; } catch (_) { return ''; }
    },
    set: (name, value) => ipcRenderer.invoke('secret:set', { name: String(name), value: String(value == null ? '' : value) }),
    remove: (name) => ipcRenderer.invoke('secret:remove', String(name)),
    status: () => ipcRenderer.invoke('secret:status'),
  };
})());

// ── 任务中心（任务态 + 产物 + 变更）落盘 API ──────────────────────────
contextBridge.exposeInMainWorld('tasksAPI', {
  list: () => ipcRenderer.invoke('task:list'),
  save: (task) => ipcRenderer.invoke('task:save', task),
  read: (id) => ipcRenderer.invoke('task:read', id),
  remove: (id) => ipcRenderer.invoke('task:remove', id),
});

// ── 内嵌 PostgreSQL 数据库：打开内嵌数据库工作台（新标签页，自动连接）──────
contextBridge.exposeInMainWorld('databaseAPI', {
  open: () => ipcRenderer.invoke('db:open'),
});

// ── 内嵌 PostgreSQL 直连查询 API（内置 db-mcp MCP 工具的数据通道）──────────
// 主进程 db:* IPC 直连进程内 PGlite（无端口 / 无 HTTP）。
// 与 renderer/dbview/db-preload.js 暴露的 dbAPI 同形，便于「工作台主页」的
// AI Agent 直接读写这个内嵌库（preload.js 仅注入给工作台主页）。
contextBridge.exposeInMainWorld('dbAPI', {
  status: () => ipcRenderer.invoke('db:status'),
  objects: () => ipcRenderer.invoke('db:objects'),
  saved: () => ipcRenderer.invoke('db:saved'),
  query: (sql) => ipcRenderer.invoke('db:query', String(sql == null ? '' : sql)),
  table: (name) => ipcRenderer.invoke('db:table', String(name == null ? '' : name)),
  apply: (payload) => ipcRenderer.invoke('db:apply', payload || {}),
});

// ── 网页搜索 API（web_search 工具）：主进程 net.fetch，绕过渲染进程 CORS ──
contextBridge.exposeInMainWorld('searchAPI', {
  fetchText: (payload) => ipcRenderer.invoke('net:search', payload || {}),
});

// ── 真实执行能力（方案 B：物化 → 执行 → 回收）─────────────────────────
// 仅在「工作台主页」这一支（preload.js 只注入给它）可用；远程网页标签没有此 preload。
// 主进程侧另有 isTrustedSender 二次校验，双保险。
contextBridge.exposeInMainWorld('shellAPI', {
  // 把工作区文件（[{ path(相对), dataBase64 }]）增量物化到真实运行目录
  materialize: (payload) => ipcRenderer.invoke('run:materialize', payload || {}),
  // 在物化后的真实目录执行命令（shell:true）；聚合返回 { ok, code, stdout, stderr, durationMs, timedOut, capped, cwd }
  exec: (payload) => ipcRenderer.invoke('run:exec', payload || {}),
  // 回收：命令执行后对比物化清单，返回新增/修改文件的 base64 与已删除路径，供渲染层写回虚拟 FS
  // 返回 { ok, files:[{path,dataBase64}], removed:[rel], changed, unchanged, skipped, bytes }
  collect: (payload) => ipcRenderer.invoke('run:collect', payload || {}),
  // 结束该工作区里仍在跑的进程
  kill: (payload) => ipcRenderer.invoke('run:kill', payload || {}),
  // 删除运行目录（连依赖缓存一起清）
  cleanup: (payload) => ipcRenderer.invoke('run:cleanup', payload || {}),
  // 一键清空「实际沙箱空间」：终止全部后台任务 + 删除整个物化运行目录（workspace/）
  cleanupAll: (payload) => ipcRenderer.invoke('run:cleanupAll', payload || {}),
  // 重新聚焦窗口 + 当前页面：修复原生 confirm/alert 关闭后窗口失焦、
  // 输入框「点了打不了字，得先点任务栏图标」的问题（主进程 win:refocus）。
  refocus: () => ipcRenderer.invoke('win:refocus'),
  // ── 后台任务（run_shell run_in_background）──
  start: (payload) => ipcRenderer.invoke('run:start', payload || {}),
  listJobs: (payload) => ipcRenderer.invoke('job:list', payload || {}),
  jobOutput: (payload) => ipcRenderer.invoke('job:output', payload || {}),
  killJob: (payload) => ipcRenderer.invoke('job:kill', payload || {}),
  // 续跑：用原命令在原工作区重新执行（输出继续追加到同一 job 的日志）
  jobResume: (payload) => ipcRenderer.invoke('job:resume', payload || {}),
  // 订阅流式输出：回调收到 { workspaceId, stream:'stdout'|'stderr', data }；返回取消订阅函数
  onOutput: (cb) => {
    const handler = (_e, msg) => { try { cb(msg); } catch (_) {} };
    ipcRenderer.on('run:output', handler);
    return () => ipcRenderer.removeListener('run:output', handler);
  },
});

// ── SSH / SFTP API（MCP ssh 工具 + VFS 上传/下载）────────────────────────
// 主进程 ssh-manager.js 维护多主机连接池；密码只进主进程内存，不回传渲染层。
// ssh2 缺失时主进程未注册 handler，invoke 返回 undefined → 渲染层按「SSH 不可用」降级。
contextBridge.exposeInMainWorld('sshAPI', {
  // 连接一台主机：{ host, port, username, password } → { ok, key, ... }
  connect: (cfg) => ipcRenderer.invoke('ssh:connect', cfg || {}),
  // 断开（key 省略 = 全部断开）→ { ok, result, status }
  disconnect: (key) => ipcRenderer.invoke('ssh:disconnect', { key: key || '' }),
  // 连接池状态 → { ok, status:[{ key, host, port, username, connected, connectedAt, lastError }] }
  status: () => ipcRenderer.invoke('ssh:status', {}),
  // 远程执行：{ key, command, timeoutMs? } → { ok, stdout, stderr, code }
  exec: (payload) => ipcRenderer.invoke('ssh:exec', payload || {}),
  // 列远程目录：{ key, path } → { ok, path, files:[{ name, type, size, mtime }] }
  ls: (payload) => ipcRenderer.invoke('ssh:ls', payload || {}),
  // 下载远程文件：{ key, path } → { ok, path, size, dataBase64 }
  read: (payload) => ipcRenderer.invoke('ssh:read', payload || {}),
  // 上传到远程：{ key, path, dataBase64 } → { ok, path, size }
  write: (payload) => ipcRenderer.invoke('ssh:write', payload || {}),
});

// ── CDP 浏览器控制 API（让 AI Agent 操控内置浏览器标签）─────────────────
// 仅「工作台主页」注入本 preload，远程网页标签无此 API；主进程 bcdp:* 处理器
// 另以 isTrustedSender 二次校验。底层走 webContents.debugger（原生 CDP）。
contextBridge.exposeInMainWorld('browserControl', {
  listTabs: () => ipcRenderer.invoke('bcdp:list-tabs'),
  snapshot: (tabId) => ipcRenderer.invoke('bcdp:snapshot', { tabId }),
  click: (payload) => ipcRenderer.invoke('bcdp:click', payload || {}),
  type: (payload) => ipcRenderer.invoke('bcdp:type', payload || {}),
  navigate: (tabId, url) => ipcRenderer.invoke('bcdp:navigate', { tabId, url }),
  evaluate: (tabId, expression) => ipcRenderer.invoke('bcdp:evaluate', { tabId, expression }),
  screenshot: (tabId, opts) => ipcRenderer.invoke('bcdp:screenshot', Object.assign({ tabId }, opts || {})),
});

// ── 会话事件日志 API（append-only，落盘「应用目录/messages/」）──────────
// 渲染层用它把每条会话事件追加到磁盘（main.js 保证只追加、不覆盖），并支持
// list（列出会话）/ read（replay）/ fork（从某会话分支复制前缀）/ remove。
// 仅在「工作台主页」这一支可用；远程网页标签没有此 preload，且主进程另有
// isTrustedSender 二次校验。无此 API 时（纯浏览器直开）会话日志自动降级。
contextBridge.exposeInMainWorld('messagesAPI', {
  // 追加事件：events = [{ type, ... }]，主进程补 seq/ts
  append: (sid, events) => ipcRenderer.invoke('msg:append', { sid, events }),
  // 读取事件：opts.fromSeq 增量拉取
  read: (sid, opts) => ipcRenderer.invoke('msg:read', Object.assign({ sid }, opts || {})),
  // 列出所有会话（磁盘）
  list: () => ipcRenderer.invoke('msg:list'),
  // 全文检索归档转录（硬切窗口的「可查询历史」）：返回会话指针 + 命中片段
  search: (payload) => ipcRenderer.invoke('msg:search', payload || {}),
  // 读/写会话元数据：传 meta 为写，不传为读
  meta: (sid, meta) => ipcRenderer.invoke('msg:meta', { sid, meta }),
  // 从 from 会话复制前缀到 to 新会话（upToSeq 为空 = 全量）
  fork: (from, to, upToSeq) => ipcRenderer.invoke('msg:fork', { from, to, upToSeq }),
  // 删除会话日志目录
  remove: (sid) => ipcRenderer.invoke('msg:remove', { sid }),
});

// ── 接口配置固化 API（应用目录 config/interface.json）────────────────────
//  · readSync()：启动时同步回读配置文件（persist.load 是同步接口，故用 sendSync）
//  · read()/write()：运行时异步回读 / 原子写回（页面设置保存后落盘）
//  · path()：取配置文件绝对路径（用于界面提示「改这个文件 + 刷新即可生效」）
// 仅「工作台主页」注入本 preload；主进程侧另以 isTrustedSender 二次校验。
contextBridge.exposeInMainWorld('configFileAPI', {
  readSync: () => { try { return ipcRenderer.sendSync('config:read-sync'); } catch (_) { return { ok: false }; } },
  read: () => ipcRenderer.invoke('config:read'),
  write: (config) => ipcRenderer.invoke('config:write', config),
  path: () => { try { const r = ipcRenderer.sendSync('config:read-sync'); return (r && r.path) || ''; } catch (_) { return ''; } },
});


