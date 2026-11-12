const { contextBridge, ipcRenderer } = require('electron');
const on = (ch) => (cb) => ipcRenderer.on(ch, (_e, v) => cb(v));

contextBridge.exposeInMainWorld('isla', {
  // media
  onMedia: on('media'),
  onLyrics: on('lyrics'),
  cmd: (c) => ipcRenderer.send('media-cmd', c),
  // sistema (volumen, batería)
  sys: () => ipcRenderer.invoke('sys:get'),
  onSys: on('sys'),
  sysCmd: (c) => ipcRenderer.send('sys-cmd', c),
  onToast: on('toast'),
  hover: (over) => ipcRenderer.send('hover', over),
  // portapapeles
  clips: () => ipcRenderer.invoke('clips:list'),
  clipCount: () => ipcRenderer.invoke('clips:count'),
  onClips: on('clips'),
  clipCopy: (id) => ipcRenderer.send('clips:copy', id),
  clipPin: (id) => ipcRenderer.send('clips:pin', id),
  clipRemove: (id) => ipcRenderer.send('clips:remove', id),
  clipClear: () => ipcRenderer.send('clips:clear'),
  // actividades
  cache: () => ipcRenderer.invoke('cache:get'),
  onNotif: on('notif'),
  onNotifPresent: on('notif-present'),
  onDolar: on('dolar'),
  onMatch: on('match'),
  onGoal: on('goal'),
  onMeetings: on('meetings'),
  onDownloads: on('downloads'),
  onDownloadDone: on('download-done'),
  onClaude: on('claude'),
  onClaudeDone: on('claude-done'),
  openUrl: (u) => ipcRenderer.send('open-url', u),
  openDownload: (p) => ipcRenderer.send('open-download', p),
  dragClip: (id) => ipcRenderer.send('drag-clip', id),
  onDragEnd: on('drag-end'),
  // apps
  launch: (appId) => ipcRenderer.send('launch', appId),
  apps: () => ipcRenderer.invoke('apps:list'),
  icon: (appId) => ipcRenderer.invoke('apps:icon', appId),
  fileIcon: (file) => ipcRenderer.invoke('icon:file', file),
  pickExe: () => ipcRenderer.invoke('apps:pickExe'),
  // ajustes
  settings: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.send('settings:set', patch),
  reset: () => ipcRenderer.send('settings:reset'),
  openSettings: () => ipcRenderer.send('settings:open'),
  onSettings: on('settings'),
});
