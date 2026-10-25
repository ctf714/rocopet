// 渲染进程桥：只暴露最小的 IPC 面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getProfile: () => ipcRenderer.invoke('get-profile'),
  saveProfile: (p) => ipcRenderer.invoke('save-profile', p),
  getPack: () => ipcRenderer.invoke('get-pack'),
  getPos: () => ipcRenderer.invoke('get-pos'),
  setPos: (x, y) => ipcRenderer.invoke('set-pos', x, y),
  move: (dx, dy) => ipcRenderer.invoke('move-pet', dx, dy),
  setFocusable: (on) => ipcRenderer.invoke('set-focusable', on),
  resize: (w, h) => ipcRenderer.invoke('resize-pet', w, h),
  getWorkArea: () => ipcRenderer.invoke('get-workarea'),
  setPassthrough: (on) => ipcRenderer.invoke('set-passthrough', on),
  mouseThrough: (on) => ipcRenderer.invoke('set-mouse-through', on),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  openHistory: () => ipcRenderer.invoke('open-history'),
  pickPack: () => ipcRenderer.invoke('pick-pack'),
  quit: () => ipcRenderer.invoke('quit-app'),
  onProfile: (cb) => ipcRenderer.on('profile-changed', (_e, p) => cb(p)),
  onAction: (cb) => ipcRenderer.on('pet-action', (_e, a) => cb(a)),
});
