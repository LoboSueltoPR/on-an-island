const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, dialog, net, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const createClipStore = require('./clipstore');
const services = require('./services');

// La ventana es transparente y más grande que la isla abierta; la isla se dibuja adentro.
const W = 620, H = 300;
let win, settingsWin, media, system, tray, clips;

// Los datos (ajustes, portapapeles) siempre en %APPDATA%\isla, aunque cambie el nombre de la app.
app.setPath('userData', path.join(app.getPath('appData'), 'isla'));
if (!app.requestSingleInstanceLock()) app.quit();
// Los .ps1 no se pueden ejecutar desde adentro de app.asar: electron-builder los deja en app.asar.unpacked.
const unpacked = (p) => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);

/* ── Ajustes ─────────────────────────────────────────────── */
const DEFAULTS = {
  // forma
  idleMode: 'line',        // 'line' | 'capsule'
  openOn: 'click',         // 'click' | 'hover'
  lineWidth: 140,
  lineThickness: 4,
  topOffset: 6,
  motion: 'gentle',        // 'gentle' | 'snappy' | 'off'
  // colores
  islandColor: '#000000',
  accentMode: 'cover',     // 'cover' | 'fixed'
  accentColor: '#7DD3FC',
  ambientArt: true,        // fondo con la carátula difuminada
  seekStyle: 'line',       // 'line' | 'wave' | 'bars'
  clockStyle: 'classic',   // 'classic' | 'bold' | 'dots'
  clock24h: true,
  // pestañas
  tabs: { media: true, clipboard: true, timer: true, apps: true },
  // media
  peekOnTrackChange: true,
  lyrics: true,
  showLaunchers: true,
  // avisos
  popVolume: true,
  popBattery: true,
  popClipboard: true,
  scrollVolume: true,
  autoHideFullscreen: true,
  timerSound: true,
  // portapapeles
  clipEnabled: true,
  clipRetentionDays: 0,    // 0 = para siempre
  clipMax: 200,
  clipExclude: 'Bitwarden, 1Password, KeePass, KeePassXC, LastPass, Dashlane, Proton Pass',
  // actividades
  calls: true,
  messages: true,
  notifExclude: '',
  meetings: true,
  calendarIcs: '',
  downloads: true,
  screenshots: true,
  privacyDots: true,
  focusBorder: true,
  claudeCode: true,
  dolar: true,
  football: true,
  footballTeam: 'Argentina',
  goalAlerts: true,          // goles de ligas y equipos que seguís
  goalLeagues: { ucl: true, epl: true, arg: true },
  goalTeams: 'Barcelona, Real Madrid',
  goalWindows: true,         // también como notificación de Windows si la isla está oculta
  pet: true,
  hotkey: 'Alt+H',
  launchers: [
    'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
    'Chrome',
    'Claude_pzs8sxrjxfjjc!Claude',
    '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App',
    'com.notion.app.desktop.notion_87smfmv0eebam!com.notion.app.desktop.notion',
    'Microsoft.VisualStudioCode',
    'com.stablyai.orca',
  ],
};
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULTS };

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...DEFAULTS, ...saved, tabs: { ...DEFAULTS.tabs, ...(saved.tabs || {}) },
      goalLeagues: { ...DEFAULTS.goalLeagues, ...(saved.goalLeagues || {}) } };
  } catch {}
}
function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}
// Lo último de cada actividad queda guardado: la isla lo pide al cargar o al recargarse.
const CACHED = new Set(['dolar', 'match', 'meetings', 'claude', 'downloads']);
const lastSent = {};
const send = (ch, payload, ...wins) => {
  if (CACHED.has(ch)) lastSent[ch] = payload;
  for (const w of wins.length ? wins : [win]) if (w && !w.isDestroyed()) w.webContents.send(ch, payload);
};
let svc = {};
const broadcast = () => send('settings', withLaunchers(), win, settingsWin);

// Abrir al iniciar Windows. Instalada: su .exe. Portable: el .exe portable (no la copia temporal).
// En desarrollo: electron.exe con la carpeta del proyecto.
function loginItem() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { path: process.env.PORTABLE_EXECUTABLE_FILE, args: [] };
  if (app.isPackaged) return { path: process.execPath, args: [] };
  return { path: process.execPath, args: [path.resolve(__dirname, '..')] };
}
const getOpenAtLogin = () => app.getLoginItemSettings(loginItem()).openAtLogin;
function setOpenAtLogin(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, ...loginItem() });
  buildTrayMenu();
}

function updateSettings(patch) {
  if ('openAtLogin' in patch) { // no se guarda en settings.json: lo sabe Windows
    setOpenAtLogin(patch.openAtLogin);
    patch = { ...patch }; delete patch.openAtLogin;
  }
  const prev = settings;
  settings = { ...settings, ...patch };
  if (!Object.values(settings.tabs).some(Boolean)) settings.tabs = { ...settings.tabs, media: true }; // al menos una pestaña
  saveSettings();
  if (patch.topOffset !== undefined) place();
  if (settings.hotkey !== prev.hotkey) registerHotkey();
  if (patch.clipMax !== undefined || patch.clipRetentionDays !== undefined) clips.prune();
  if (patch.autoHideFullscreen !== undefined) applyVisibility();
  if (patch.claudeCode !== undefined) syncClaudeHooks();
  if (patch.dolar || patch.football !== undefined || patch.footballTeam !== undefined) { svc.dolar?.refresh(); svc.futbol?.refresh(); }
  if (patch.goalAlerts !== undefined || patch.goalLeagues !== undefined || patch.goalTeams !== undefined) svc.goles?.refresh();
  if (patch.calendarIcs !== undefined || patch.meetings !== undefined) svc.calendar?.refresh();
  if (patch.dolar === false) send('dolar', null);
  if (patch.football === false) send('match', null);
  broadcast();
}

let claudeHookError = null;
function syncClaudeHooks() {
  const r = services.setClaudeHooks(!!settings.claudeCode);
  claudeHookError = r.ok ? null : r.error;
}

/* ── Apps instaladas e íconos reales ─────────────────────── */
let apps = [];
const iconCache = new Map();
const appsFile = () => path.join(app.getPath('userData'), 'apps.json');

function scanApps() {
  try { apps = JSON.parse(fs.readFileSync(appsFile(), 'utf8')); } catch {}
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', unpacked(path.join(__dirname, 'apps.ps1'))],
    { windowsHide: true, maxBuffer: 8 << 20, encoding: 'utf8' }, (err, out) => {
      if (err) return;
      try { apps = [].concat(JSON.parse(out)); fs.writeFileSync(appsFile(), JSON.stringify(apps)); iconCache.clear(); broadcast(); } catch {}
    });
}

async function iconFromFile(file) {
  if (!file) return null;
  if (iconCache.has(file)) return iconCache.get(file);
  let url = null;
  try {
    const img = /\.png$/i.test(file) ? nativeImage.createFromPath(file) : await app.getFileIcon(file, { size: 'large' });
    if (!img.isEmpty()) url = img.resize({ width: 64, height: 64, quality: 'best' }).toDataURL();
  } catch {}
  iconCache.set(file, url);
  return url;
}
const iconFor = (appId) => iconFromFile(apps.find((x) => x.appId === appId)?.icon);

function withLaunchers() {
  return {
    ...settings,
    appsCount: apps.length,
    openAtLogin: getOpenAtLogin(),
    claudeHookError,
    launchersInfo: settings.launchers.map((id) => {
      const a = apps.find((x) => x.appId === id);
      return { appId: id, name: a?.name || id.split(/[!.\\]/).pop().replace(/\.(exe|lnk)$/i, '') };
    }),
  };
}

/* ── Ventanas ────────────────────────────────────────────── */
function place() {
  if (!win || win.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const want = { x: Math.round(workArea.x + (workArea.width - W) / 2), y: workArea.y, width: W, height: H };
  const b = win.getBounds();
  if (b.x !== want.x || b.y !== want.y || b.width !== W || b.height !== H) win.setBounds(want);
}

function createWindow() {
  win = new BrowserWindow({
    width: W, height: H, show: false,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    focusable: false, // no le roba el foco a la app que estás usando
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  place();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true }); // lo transparente deja pasar los clicks
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', applyVisibility);
  // Con dos monitores Windows a veces mueve la ventana (al conectar uno, bloquear la PC, etc.).
  // La devolvemos siempre arriba al centro del monitor principal.
  const replace = () => setTimeout(place, 300);
  screen.on('display-metrics-changed', replace);
  screen.on('display-added', replace);
  screen.on('display-removed', replace);
  win.on('moved', replace);
  const { powerMonitor } = require('electron');
  powerMonitor.on('unlock-screen', replace);
  powerMonitor.on('resume', replace);
  setInterval(place, 3000);
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 800, height: 680, minWidth: 640, minHeight: 480, show: false,
    title: 'Ajustes de On An Island', backgroundColor: '#101012', autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#101012', symbolColor: '#c8c8cc', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
}

// Visible = no la escondiste con el atajo y no hay una app en pantalla completa.
let manualHidden = false, sys = {};
function applyVisibility() {
  if (!win || win.isDestroyed()) return;
  const show = !manualHidden && !(settings.autoHideFullscreen && sys.fs);
  if (show && !win.isVisible()) win.showInactive();
  if (!show && win.isVisible()) win.hide();
}
function toggleVisible() { manualHidden = !manualHidden; applyVisibility(); }

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.hotkey) return;
  try { globalShortcut.register(settings.hotkey, toggleVisible); } catch {}
}

/* ── Puentes con PowerShell ──────────────────────────────── */
function bridge(script, onMsg) {
  let proc;
  const start = () => {
    proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', unpacked(path.join(__dirname, script))], { windowsHide: true });
    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      onMsg(msg);
    });
    proc.on('exit', () => { if (!app.isQuitting) setTimeout(start, 1500); });
  };
  start();
  return { write: (cmd) => proc?.stdin.write(cmd + '\n'), kill: () => proc?.kill() };
}

let lastMediaKey = null;
function onMedia(msg) {
  send('media', msg);
  if (msg.type === 'state' && msg.key !== lastMediaKey) { lastMediaKey = msg.key; fetchLyrics(msg); }
}

function onSystem(msg) {
  const prev = sys;
  sys = msg;
  if (prev.fs !== msg.fs) applyVisibility();
  if (prev.seq !== undefined && msg.seq !== prev.seq) {
    // Algo se copió: lo guardamos con la app que estaba al frente.
    setTimeout(() => {
      const r = clips.capture({ app: msg.fg, appName: msg.fgName, appPath: msg.fgPath });
      if (!r?.isNew) return;
      if (r.item.kind === 'image' && settings.screenshots) {
        const shot = /screenclip|snipping|screensketch|sharex|greenshot|lightshot/i.test(`${msg.fg} ${msg.fgName}`);
        send('toast', { kind: 'image', shot, appName: r.item.appName, id: r.item.id, thumb: clips.list(1)[0]?.thumb });
      } else if (settings.popClipboard) send('toast', { kind: 'clip', appName: r.item.appName, appPath: r.item.appPath });
    }, 80);
  }
  send('sys', { vol: msg.vol, mute: msg.mute, bat: msg.bat, pct: msg.pct, ac: msg.ac, mic: msg.mic || [], cam: msg.cam || [] });
}

/* ── Notificaciones: llamadas y mensajes ─────────────────── */
const CALL_RE = /llamada|videollamada|incoming (voice |video )?call|is calling|te est[aá] llamando|calling you|llamando/i;
function onNotif(msg) {
  if (msg.type === 'present') { send('notif-present', msg.ids); return; }
  if (msg.type !== 'notif') return;
  const ex = (settings.notifExclude || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (ex.some((e) => (msg.app || '').toLowerCase().includes(e))) return;
  if (/^(isla|on an island|electron)$/i.test(msg.app || '')) return;
  const isCall = CALL_RE.test(`${msg.title} ${msg.body}`);
  if (isCall ? !settings.calls : !settings.messages) return;
  send('notif', { ...msg, call: isCall });
}

/* ── Letras sincronizadas (lrclib.net, gratis y sin cuenta) ── */
const lyricsCache = new Map();
const cleanTitle = (t = '') => t
  .replace(/\s+-\s+.*\b(remaster(ed)?|version|live|mono|stereo|edit|mix|en vivo)\b.*$/i, '')
  .replace(/\s*[([][^)\]]*\b(remaster(ed)?|version|feat\.?|ft\.?|live|en vivo)\b[^)\]]*[)\]]/gi, '')
  .trim();
function parseLrc(lrc) {
  if (!lrc) return null;
  const out = [];
  for (const line of lrc.split(/\r?\n/)) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (m) out.push({ t: +m[1] * 60 + +m[2], text: m[3].trim() });
  }
  return out.length ? out : null;
}
async function fetchLyrics(m) {
  if (!settings.lyrics || !m.active || !m.title) return;
  if (lyricsCache.has(m.key)) { send('lyrics', { key: m.key, lines: lyricsCache.get(m.key) }); return; }
  lyricsCache.set(m.key, null);
  const headers = { 'User-Agent': 'OnAnIsland/0.5 (Windows desktop island)' };
  const q = (p) => { const u = new URL('https://lrclib.net/api/' + p); return u; };
  try {
    const title = cleanTitle(m.title), artist = m.artist || '';
    let lines = null;
    const u = q('get');
    u.searchParams.set('track_name', title); u.searchParams.set('artist_name', artist);
    if (m.duration) u.searchParams.set('duration', Math.round(m.duration));
    let r = await net.fetch(u.href, { headers });
    if (r.ok) lines = parseLrc((await r.json()).syncedLyrics);
    if (!lines) {
      const s = q('search');
      s.searchParams.set('track_name', title); s.searchParams.set('artist_name', artist);
      r = await net.fetch(s.href, { headers });
      if (r.ok) {
        const hit = (await r.json()).find((x) => x.syncedLyrics && (!m.duration || Math.abs(x.duration - m.duration) < 4));
        lines = parseLrc(hit?.syncedLyrics);
      }
    }
    lyricsCache.set(m.key, lines);
    send('lyrics', { key: m.key, lines });
  } catch {}
}

// Ícono de bandeja dibujado a mano: una pastilla blanca de 16x16 (BGRA).
function trayIcon() {
  const S = 16, buf = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = Math.max(0, Math.abs(x - 7.5) - 3.5), dy = Math.abs(y - 7.5);
    const a = Math.max(0, Math.min(1, 3.5 - Math.hypot(dx, dy)));
    buf.fill(Math.round(255 * a), (y * S + x) * 4, (y * S + x) * 4 + 4);
  }
  return nativeImage.createFromBitmap(buf, { width: S, height: S });
}

app.whenReady().then(() => {
  loadSettings();
  clips = createClipStore({
    dir: app.getPath('userData'),
    settings: () => settings,
    onChange: () => send('clips', clips.list()),
  });
  scanApps();
  createWindow();
  media = bridge('media.ps1', onMedia);
  system = bridge('system.ps1', onSystem);
  bridge('notifs.ps1', onNotif);
  const ctx = { settings: () => settings, send: (ch, v) => send(ch, v) };
  svc = {
    dolar: services.dolar(ctx), futbol: services.futbol(ctx),
    goles: services.goles({ ...ctx, send: (ch, v) => notifyGoal(v), skipId: () => svc.futbol?.last()?.id }), calendar: services.calendar(ctx),
    downloads: services.downloads(ctx), claude: services.claude(ctx),
  };
  syncClaudeHooks();
  registerHotkey();

  // Gol de una liga o equipo que seguís: en la isla y, si está oculta (pantalla completa), como notificación de Windows.
  function notifyGoal(m) {
    send('goal', m);
    if (!settings.goalWindows || (win && win.isVisible())) return;
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return;
    const who = m[m.mine].name;
    new Notification({
      title: `¡Gol de ${who}!` + (m.league ? ` · ${m.league}` : ''),
      body: `${m.home.name} ${m.home.score} – ${m.away.score} ${m.away.name}` + (m.player ? `
${m.player}${m.pen ? ' (penal)' : m.own ? ' (en contra)' : ''} ${m.minute}` : ''),
      silent: false,
    }).show();
  }

  ipcMain.handle('cache:get', () => lastSent);
  ipcMain.on('open-url', (_e, url) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); });
  ipcMain.on('open-download', (_e, p) => {
    const dl = app.getPath('downloads');
    if (typeof p === 'string' && path.resolve(p).startsWith(path.resolve(dl))) shell.openPath(p);
  });
  ipcMain.on('drag-clip', (e, id) => {
    const src = clips.file(id);
    if (!src || !fs.existsSync(src)) return;
    // Copia con un nombre legible, que es el que verá la app donde lo sueltes.
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date(fs.statSync(src).mtime);
    const dir = path.join(app.getPath('temp'), 'Isla');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `Captura ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}.png`);
    try { if (!fs.existsSync(file)) fs.copyFileSync(src, file); } catch { return; }
    let icon = nativeImage.createFromPath(src);
    if (icon.isEmpty()) return;
    icon = icon.resize({ width: 96 });
    const t0 = Date.now();
    try { e.sender.startDrag({ file, icon }); } catch (err) { console.error('drag', err); }
    if (process.env.ISLA_DEBUG) console.log('[drag] startDrag volvió en', Date.now() - t0, 'ms');
    if (!e.sender.isDestroyed()) e.sender.send('drag-end');
  });

  ipcMain.handle('settings:get', () => withLaunchers());
  ipcMain.on('settings:set', (_e, patch) => updateSettings(patch));
  ipcMain.on('settings:reset', () => updateSettings({ ...DEFAULTS, launchers: settings.launchers }));
  ipcMain.on('settings:open', () => openSettings());
  ipcMain.handle('apps:list', () => apps.map(({ name, appId }) => ({ name, appId })));
  ipcMain.handle('apps:icon', (_e, appId) => iconFor(appId));
  ipcMain.handle('icon:file', (_e, file) => iconFromFile(file));
  ipcMain.handle('apps:pickExe', async () => {
    const r = await dialog.showOpenDialog(settingsWin, { title: 'Elegir programa', filters: [{ name: 'Programas', extensions: ['exe', 'lnk'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    if (!apps.some((a) => a.appId === p)) apps.push({ name: path.basename(p).replace(/\.(exe|lnk)$/i, ''), appId: p, icon: p });
    return p;
  });

  ipcMain.handle('clips:list', () => clips.list());
  ipcMain.handle('clips:count', () => clips.count());
  ipcMain.on('clips:copy', (_e, id) => clips.copy(id));
  ipcMain.on('clips:pin', (_e, id) => clips.pin(id));
  ipcMain.on('clips:remove', (_e, id) => clips.remove(id));
  ipcMain.on('clips:clear', () => clips.clear());

  ipcMain.handle('sys:get', () => sys);
  ipcMain.on('sys-cmd', (_e, cmd) => system.write(cmd));
  ipcMain.on('media-cmd', (_e, cmd) => media.write(cmd));
  ipcMain.on('launch', (_e, appId) => {
    if (/^[a-z]:\\/i.test(appId)) spawn('explorer.exe', [appId], { detached: true });
    else spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], { detached: true });
  });
  ipcMain.on('hover', (_e, over) => win.setIgnoreMouseEvents(!over, { forward: true }));

  tray = new Tray(trayIcon());
  tray.setToolTip('On An Island');
  tray.on('click', () => openSettings());
  buildTrayMenu();

  // Instalada: la primera vez queda configurada para abrirse al iniciar Windows (se puede apagar en Ajustes).
  if (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE && !settings.loginSetupDone) {
    setOpenAtLogin(true);
    updateSettings({ loginSetupDone: true });
  }
});

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ajustes…', click: openSettings },
    { label: 'Mostrar u ocultar', click: toggleVisible },
    { type: 'separator' },
    { label: 'Abrir al iniciar Windows', type: 'checkbox', checked: getOpenAtLogin(),
      click: (i) => { setOpenAtLogin(i.checked); broadcast(); } },
    { label: 'Recargar', click: () => win.reload() },
    { label: 'Salir', click: () => app.quit() },
  ]));
}

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { app.isQuitting = true; media?.kill(); system?.kill(); globalShortcut.unregisterAll(); });
