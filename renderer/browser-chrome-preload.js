// 浏览器 chrome 的 preload：把主进程的标签/导航能力安全地暴露给 chrome UI。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browser', {
  // 标签
  newTab: (url) => ipcRenderer.invoke('tab:new', url),
  closeTab: (id) => ipcRenderer.invoke('tab:close', id),
  activateTab: (id) => ipcRenderer.invoke('tab:activate', id),
  // 导航
  navigate: (input) => ipcRenderer.invoke('nav:go', input),
  back: () => ipcRenderer.invoke('nav:back'),
  forward: () => ipcRenderer.invoke('nav:forward'),
  reload: () => ipcRenderer.invoke('nav:reload'),
  stop: () => ipcRenderer.invoke('nav:stop'),
  home: () => ipcRenderer.invoke('nav:home'),
  devtools: () => ipcRenderer.invoke('nav:devtools'),
  // 状态同步
  getState: () => ipcRenderer.invoke('browser:get-state'),
  onState: (cb) => ipcRenderer.on('browser:state', (_e, s) => cb(s)),
  onFocusAddress: (cb) => ipcRenderer.on('browser:focus-address', () => cb()),
});
