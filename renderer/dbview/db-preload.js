const { contextBridge, ipcRenderer } = require('electron');

// 内嵌 PostgreSQL 视图（renderer/dbview/index.html）专用 preload。
// 通过 IPC 直接访问主进程内的 PGlite（无 HTTP / 无端口）。
contextBridge.exposeInMainWorld('dbAPI', {
  status: () => ipcRenderer.invoke('db:status'),
  objects: () => ipcRenderer.invoke('db:objects'),
  saved: () => ipcRenderer.invoke('db:saved'),
  query: (sql) => ipcRenderer.invoke('db:query', String(sql == null ? '' : sql)),
  table: (name) => ipcRenderer.invoke('db:table', String(name == null ? '' : name)),
  apply: (payload) => ipcRenderer.invoke('db:apply', payload || {}),
});
