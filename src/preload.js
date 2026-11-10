// 화면에 허용한 기능만 넘김(노드 기능은 화면에서 직접 못 씀)
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  settings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: patch => ipcRenderer.invoke('settings:set', patch),
  pickVideo: () => ipcRenderer.invoke('video:pick'),
  pickOutDir: () => ipcRenderer.invoke('outdir:pick'),
  analyze: v => ipcRenderer.invoke('analyze', v),
  captions: v => ipcRenderer.invoke('captions', v),
  meta: v => ipcRenderer.invoke('meta', v),
  render: v => ipcRenderer.invoke('render', v),
  reveal: f => ipcRenderer.invoke('reveal', f),
  openUrl: u => ipcRenderer.invoke('open-url', u),
  onLog: fn => ipcRenderer.on('log', (_e, m) => fn(m)),
  onProgress: fn => ipcRenderer.on('progress', (_e, p) => fn(p)),
  // 윈도 경로(C:\\…)도 file:///C:/… 로
  fileUrl: p => { const u = p.replace(/\\/g, '/'); return (u.startsWith('/') ? 'file://' : 'file:///') + encodeURI(u).replace(/#/g, '%23').replace(/\?/g, '%3F'); },
});
