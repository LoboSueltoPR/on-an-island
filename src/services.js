// Fuentes externas de las actividades: dólar, fútbol, calendario, descargas y Claude Code.
const { net, app } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const UA = { 'User-Agent': 'Isla/0.4 (Windows desktop island)' };
const getJson = async (url) => { const r = await net.fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status); return r.json(); };

/* ── Dólar blue (dolarapi.com) ─────────────────────────── */
function dolar({ settings, send }) {
  const file = path.join(app.getPath('userData'), 'dolar.json');
  let mem = {}; try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let last = null;
  async function tick() {
    if (!settings().dolar) return;
    try {
      const d = await getJson('https://dolarapi.com/v1/dolares/blue');
      const today = new Date().toDateString();
      if (mem.day !== today) { mem = { day: today, open: mem.lastVenta ?? d.venta }; }
      mem.lastVenta = d.venta;
      fs.writeFile(file, JSON.stringify(mem), () => {});
      last = { compra: d.compra, venta: d.venta, change: mem.open ? (d.venta - mem.open) / mem.open : 0, t: d.fechaActualizacion };
      send('dolar', last);
    } catch {}
  }
  tick();
  setInterval(tick, 15 * 60e3);
  return { last: () => last, refresh: tick };
}

/* ── Fútbol en vivo (marcadores públicos de ESPN) ──────── */
const LEAGUES = ['fifa.world', 'fifa.worldq.conmebol', 'conmebol.america', 'fifa.friendly', 'arg.1', 'arg.copa', 'conmebol.libertadores', 'conmebol.sudamericana'];
const norm = (s = '') => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const logos = new Map();
async function logo(url) {
  if (!url) return null;
  if (logos.has(url)) return logos.get(url);
  let out = null;
  try {
    const r = await net.fetch(url.replace(/^http:/, 'https:') + (url.includes('?') ? '&' : '?') + 'w=64&h=64', { headers: UA });
    if (r.ok) out = `data:${r.headers.get('content-type') || 'image/png'};base64,` + Buffer.from(await r.arrayBuffer()).toString('base64');
  } catch {}
  logos.set(url, out);
  return out;
}
const side = async (c) => ({
  name: c.team.shortDisplayName || c.team.displayName, abbr: c.team.abbreviation, score: +c.score || 0,
  color: '#' + (c.team.color || '888888'), alt: '#' + (c.team.alternateColor || 'ffffff'), logo: await logo(c.team.logo),
});
const teamMatch = (c, name) => { const n = norm(name); return !!n && (norm(c.team.displayName) === n || norm(c.team.shortDisplayName) === n || norm(c.team.displayName).includes(n)); };

function futbol({ settings, send }) {
  let last = null, timer = null;
  async function tick() {
    clearTimeout(timer);
    const s = settings();
    let next = 15 * 60e3;
    if (s.football && s.footballTeam) {
      const team = norm(s.footballTeam);
      let found = null;
      for (const lg of LEAGUES) {
        try {
          const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard`);
          for (const ev of j.events || []) {
            const comp = ev.competitions?.[0];
            const cs = comp?.competitors || [];
            if (!cs.some((c) => norm(c.team.displayName).includes(team) || norm(c.team.shortDisplayName).includes(team))) continue;
            const state = ev.status.type.state; // pre | in | post
            const start = Date.parse(ev.date);
            const relevant = state === 'in' || (state === 'pre' && start - Date.now() < 3 * 3600e3) || (state === 'post' && Date.now() - start < 3.5 * 3600e3);
            if (relevant) { found = { ev, comp, cs, state, start }; break; }
          }
        } catch {}
        if (found) break;
      }
      if (found) {
        const home = found.cs.find((c) => c.homeAway === 'home') || found.cs[0];
        const away = found.cs.find((c) => c !== home);
        const m = {
          id: found.ev.id, state: found.state, start: found.start,
          clock: found.ev.status.displayClock, detail: found.ev.status.type.shortDetail,
          home: await side(home), away: await side(away),
          mine: norm(home.team.displayName).includes(norm(s.footballTeam)) ? 'home' : 'away',
        };
        // ¿Gol de tu equipo?
        if (last && last.id === m.id && m[m.mine].score > last[last.mine].score) send('goal', m);
        last = m;
        send('match', m);
        next = found.state === 'in' ? 45e3 : found.state === 'pre' ? 5 * 60e3 : 15 * 60e3;
      } else if (last) { last = null; send('match', null); }
    }
    timer = setTimeout(tick, next);
  }
  tick();
  return { last: () => last, refresh: tick };
}

/* ── Goles de ligas y equipos que seguís ───────────────── */
// Ligas completas: cualquier gol de cualquier partido. Equipos: sus goles (y en contra) en estas competiciones.
const GOAL_LEAGUES = { ucl: ['uefa.champions', 'Champions'], epl: ['eng.1', 'Premier'], arg: ['arg.1', 'Liga Argentina'] };
const TEAM_COMPS = ['esp.1', 'esp.copa_del_rey', 'esp.super_cup', 'uefa.champions', 'uefa.europa', 'fifa.cwc', 'club.friendly',
  'eng.1', 'eng.fa', 'ita.1', 'ger.1', 'fra.1', 'arg.1', 'arg.copa', 'conmebol.libertadores', 'conmebol.sudamericana'];
const COMP_NAME = { 'esp.1': 'LaLiga', 'esp.copa_del_rey': 'Copa del Rey', 'esp.super_cup': 'Supercopa', 'uefa.champions': 'Champions',
  'uefa.europa': 'Europa League', 'fifa.cwc': 'Mundial de Clubes', 'club.friendly': 'Amistoso', 'eng.1': 'Premier', 'eng.fa': 'FA Cup',
  'ita.1': 'Serie A', 'ger.1': 'Bundesliga', 'fra.1': 'Ligue 1', 'arg.1': 'Liga Argentina', 'arg.copa': 'Copa Argentina',
  'conmebol.libertadores': 'Libertadores', 'conmebol.sudamericana': 'Sudamericana' };

function goles({ settings, send, skipId = () => null }) {
  const scores = new Map(); // id del partido → "local-visitante" ya visto
  let timer = null, primed = false;
  const teams = () => (settings().goalTeams || '').split(',').map((x) => x.trim()).filter(Boolean);

  async function tick() {
    clearTimeout(timer);
    const s = settings();
    let next = 5 * 60e3;
    if (s.goalAlerts) {
      const leagues = Object.entries(GOAL_LEAGUES).filter(([k]) => s.goalLeagues?.[k]).map(([, [id]]) => id);
      const myTeams = teams();
      const comps = [...new Set([...leagues, ...(myTeams.length ? TEAM_COMPS : [])])];
      let hot = false;
      for (const lg of comps) {
        let j;
        try { j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/scoreboard`); } catch { continue; }
        for (const ev of j.events || []) {
          const comp = ev.competitions?.[0];
          const cs = comp?.competitors || [];
          if (cs.length !== 2) continue;
          const whole = leagues.includes(lg);
          const followed = cs.find((c) => myTeams.some((t) => teamMatch(c, t)));
          if (!whole && !followed) continue;
          const state = ev.status.type.state;
          const start = Date.parse(ev.date);
          if (state === 'in' || (state === 'pre' && start - Date.now() < 15 * 60e3)) hot = true;
          const home = cs.find((c) => c.homeAway === 'home') || cs[0];
          const away = cs.find((c) => c !== home);
          const key = `${+home.score || 0}-${+away.score || 0}`;
          const prev = scores.get(ev.id);
          scores.set(ev.id, key);
          if (!primed || prev === undefined || prev === key || state === 'pre' || ev.id === skipId()) continue;
          const [ph, pa] = prev.split('-').map(Number);
          const scorer = (+home.score || 0) > ph ? home : (+away.score || 0) > pa ? away : null;
          if (!scorer) continue; // gol anulado: el marcador bajó
          // Quién lo hizo, si ESPN lo informa.
          const play = [...(comp.details || [])].reverse().find((d) => d.scoringPlay && d.team?.id === scorer.team.id);
          const m = {
            id: ev.id, state, start, clock: ev.status.displayClock, detail: ev.status.type.shortDetail,
            home: await side(home), away: await side(away), mine: scorer === home ? 'home' : 'away',
            league: COMP_NAME[lg] || (GOAL_LEAGUES[Object.keys(GOAL_LEAGUES).find((k) => GOAL_LEAGUES[k][0] === lg)] || [])[1] || '',
            player: play?.athletesInvolved?.[0]?.shortName || play?.athletesInvolved?.[0]?.displayName || '',
            minute: play?.clock?.displayValue || ev.status.displayClock || '',
            own: !!play?.ownGoal, pen: !!play?.penaltyKick,
            followed: !!followed,
          };
          send('goal', m);
        }
      }
      primed = true;
      if (hot) next = 30e3;
      // Olvidar partidos viejos para que el mapa no crezca.
      if (scores.size > 400) scores.clear(), primed = false;
    }
    timer = setTimeout(tick, next);
  }
  tick();
  return { refresh: () => { primed = false; scores.clear(); tick(); }, tick };
}

/* ── Calendario (dirección secreta iCal de Google o Outlook) ── */
function parseIcsDate(v, params = '') {
  if (!v) return null;
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', z] = m;
  if (z) return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(); // TZID: se toma como hora local
}
function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = []; let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') { if (ev) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(';');
    const val = line.slice(i + 1);
    const p = params.join(';');
    if (name === 'DTSTART') { ev.start = parseIcsDate(val, p); ev.allDay = /VALUE=DATE(?!-)/.test(p) || val.length === 8; }
    else if (name === 'DTEND') ev.end = parseIcsDate(val, p);
    else if (name === 'SUMMARY') ev.title = val.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, ' ');
    else if (name === 'RRULE') ev.rrule = Object.fromEntries(val.split(';').map((kv) => kv.split('=')));
    else if (name === 'EXDATE') ev.exdates.push(...val.split(',').map((v) => parseIcsDate(v, p)));
    else if (name === 'RECURRENCE-ID') ev.recurrenceId = parseIcsDate(val, p);
    else if (name === 'UID') ev.uid = val;
    else if (name === 'STATUS') ev.status = val;
    else if (['LOCATION', 'DESCRIPTION', 'URL', 'X-GOOGLE-CONFERENCE'].includes(name)) ev.text = (ev.text || '') + ' ' + val;
  }
  return events;
}
const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function expand(ev, from, to) {
  const dur = (ev.end || ev.start + 30 * 60e3) - ev.start;
  if (!ev.rrule) return ev.start >= from && ev.start <= to ? [ev.start] : [];
  const r = ev.rrule, interval = +(r.INTERVAL || 1), until = r.UNTIL ? parseIcsDate(r.UNTIL) : Infinity, count = r.COUNT ? +r.COUNT : Infinity;
  const out = []; let n = 0;
  const base = new Date(ev.start);
  const days = r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS[d.slice(-2)]) : null;
  for (let k = 0; k < 2000 && n < count; k++) {
    let cands = [];
    if (r.FREQ === 'DAILY') { const d = new Date(base); d.setDate(base.getDate() + k * interval); cands = [d]; }
    else if (r.FREQ === 'WEEKLY') {
      const wk = new Date(base); wk.setDate(base.getDate() - base.getDay() + k * 7 * interval);
      cands = (days || [base.getDay()]).sort().map((dw) => { const d = new Date(wk); d.setDate(wk.getDate() + dw); d.setHours(base.getHours(), base.getMinutes(), base.getSeconds()); return d; });
    } else if (r.FREQ === 'MONTHLY') { const d = new Date(base); d.setMonth(base.getMonth() + k * interval); cands = [d]; }
    else if (r.FREQ === 'YEARLY') { const d = new Date(base); d.setFullYear(base.getFullYear() + k * interval); cands = [d]; }
    else break;
    for (const d of cands) {
      const t = d.getTime();
      if (t < ev.start) continue;
      if (t > until || n >= count) return out;
      n++;
      if (t + dur >= from && t <= to && !ev.exdates.includes(t)) out.push(t);
    }
    if (cands.length && cands[0].getTime() > to) break;
  }
  return out;
}
const meetLink = (s = '') => (s.match(/https:\/\/(meet\.google\.com\/[a-z-]+|[\w.-]*zoom\.us\/j\/\S+|teams\.microsoft\.com\/l\/meetup-join\/\S+)/i) || [])[0]?.replace(/\\[,;n]/g, '').replace(/[>"'].*$/, '');
function calendar({ settings, send }) {
  let last = [];
  async function tick() {
    const url = settings().meetings && settings().calendarIcs;
    if (!url || !/^https:\/\//i.test(url)) { if (last.length) { last = []; send('meetings', []); } return; }
    try {
      const r = await net.fetch(url, { headers: UA });
      if (!r.ok) throw new Error(r.status);
      const evs = parseIcs(await r.text()).filter((e) => e.start && !e.allDay && e.status !== 'CANCELLED');
      const from = Date.now() - 3600e3, to = Date.now() + 36 * 3600e3;
      const overrides = new Map(evs.filter((e) => e.recurrenceId).map((e) => [e.uid + e.recurrenceId, e]));
      const list = [];
      for (const e of evs.filter((x) => !x.recurrenceId)) {
        for (const t of expand(e, from, to)) {
          const o = overrides.get(e.uid + t) || e;
          const start = o === e ? t : o.start;
          list.push({ title: o.title || 'Evento', start, end: start + ((o.end || o.start + 1800e3) - o.start), link: meetLink(o.text) || meetLink(e.text) || null });
        }
      }
      for (const o of overrides.values()) if (o.start >= from && o.start <= to && !list.some((x) => x.start === o.start && x.title === o.title)) list.push({ title: o.title, start: o.start, end: o.end || o.start + 1800e3, link: meetLink(o.text) });
      last = list.filter((x) => x.end > Date.now()).sort((a, b) => a.start - b.start).slice(0, 10);
      send('meetings', last);
    } catch { send('meetings-error', 'No pude leer el calendario. Revisá la dirección iCal.'); }
  }
  tick();
  setInterval(tick, 10 * 60e3);
  return { last: () => last, refresh: tick };
}

/* ── Descargas (carpeta Descargas) ─────────────────────── */
const TEMP_RE = /\.(crdownload|part|partial|download|opdownload)$/i;
function downloads({ settings, send }) {
  const dir = app.getPath('downloads');
  const active = new Map(); // archivo temporal -> { size, prev, t, speed }
  let poll = null;
  const nice = (f) => f.replace(TEMP_RE, '').replace(/^Unconfirmed \d+$/i, 'Descargando…');
  function scan() {
    if (!settings().downloads) { if (active.size) { active.clear(); send('downloads', []); } return; }
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => TEMP_RE.test(f)); } catch {}
    const now = Date.now();
    for (const f of files) {
      let size = 0; try { size = fs.statSync(path.join(dir, f)).size; } catch {}
      const a = active.get(f) || { size, t: now, speed: 0, started: now };
      const dt = (now - a.t) / 1000;
      if (dt > 0.5) { a.speed = a.speed * 0.6 + Math.max(0, (size - a.size) / dt) * 0.4; a.size = size; a.t = now; }
      active.set(f, a);
    }
    for (const f of [...active.keys()]) {
      if (files.includes(f)) continue;
      active.delete(f);
      const final = f.replace(TEMP_RE, '');
      const p = path.join(dir, final);
      setTimeout(() => {
        if (fs.existsSync(p)) send('download-done', { name: final, path: p });
      }, 600);
    }
    send('downloads', [...active.entries()].map(([f, a]) => ({ name: nice(f), size: a.size, speed: a.speed })));
    if (!active.size && poll) { clearInterval(poll); poll = null; }
  }
  try {
    fs.watch(dir, () => { if (!poll) { poll = setInterval(scan, 1000); } scan(); });
  } catch {}
  scan();
  if (active.size && !poll) poll = setInterval(scan, 1000);
  return {};
}

/* ── Claude Code (hooks → puerto local) ────────────────── */
const PORT = 47823;
// Empaquetada, la app vive dentro de app.asar; el hook tiene que estar afuera (app.asar.unpacked) para que node lo lea.
const HOOK = path.join(__dirname, '..', 'hooks', 'claude-hook.js').replace('app.asar', 'app.asar.unpacked').replace(/\\/g, '/');
const HOOK_CMD = `node "${HOOK}"`;
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'Notification', 'Stop', 'SessionEnd'];

// Agrega o quita los hooks de Isla sin tocar los demás. Antes de la primera escritura deja una copia.
function setClaudeHooks(enable) {
  let raw;
  try { raw = fs.readFileSync(CLAUDE_SETTINGS, 'utf8'); } catch { raw = enable ? '{}' : null; }
  if (raw === null) return { ok: true };
  let cfg;
  try { cfg = JSON.parse(raw); } catch { return { ok: false, error: 'settings.json de Claude no es JSON válido; no lo toco.' }; }
  const isOurs = (h) => { const c = (h.command || '').toLowerCase(); return c.includes('claude-hook.js') && c.includes('isla'); };
  // Instalado = cada evento tiene nuestro hook con la ruta actual (si la ruta cambió, se reescribe).
  const has = EVENTS.every((ev) => (cfg.hooks?.[ev] || []).some((g) => (g.hooks || []).some((h) => h.command === HOOK_CMD)));
  const any = EVENTS.some((ev) => (cfg.hooks?.[ev] || []).some((g) => (g.hooks || []).some(isOurs)));
  if (!enable && !any) return { ok: true, changed: false };
  if (enable && has) return { ok: true, changed: false };
  const backup = CLAUDE_SETTINGS + '.antes-de-isla';
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);
  cfg.hooks = cfg.hooks || {};
  for (const ev of EVENTS) {
    const groups = (cfg.hooks[ev] || []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (enable) groups.push({ ...(ev === 'PreToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: HOOK_CMD, timeout: 3 }] });
    if (groups.length) cfg.hooks[ev] = groups; else delete cfg.hooks[ev];
  }
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2));
  return { ok: true, changed: true };
}

const short = (p = '') => p.split(/[\\/]/).pop();
function describeTool(name, input = {}) {
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return `Editando ${short(input.file_path || input.notebook_path)}`;
    case 'Read': return `Leyendo ${short(input.file_path)}`;
    case 'Bash': case 'PowerShell': return `Corriendo ${(input.description || input.command || '').slice(0, 48)}`;
    case 'Grep': case 'Glob': return 'Buscando en el código';
    case 'WebFetch': case 'WebSearch': return 'Buscando en la web';
    case 'Task': case 'Agent': return 'Delegando a un agente';
    default: return name?.startsWith('mcp__') ? `Usando ${name.split('__')[1]}` : `Usando ${name}`;
  }
}
function claude({ settings, send }) {
  const sessions = new Map(); // session_id -> { project, state, detail, t }
  const push = () => send('claude', [...sessions.values()].sort((a, b) => b.t - a.t));
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/claude' || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(404).end(); return; }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.writeHead(204).end();
      if (!settings().claudeCode) return;
      let e; try { e = JSON.parse(body); } catch { return; }
      const id = e.session_id || 'x';
      const s = sessions.get(id) || { id, project: short(e.cwd) || 'Claude', state: 'idle', detail: '', t: 0 };
      s.t = Date.now();
      if (e.cwd) s.project = short(e.cwd);
      switch (e.hook_event_name) {
        case 'UserPromptSubmit': s.state = 'working'; s.detail = 'Pensando'; break;
        case 'PreToolUse': s.state = 'working'; s.detail = describeTool(e.tool_name, e.tool_input); break;
        case 'Notification':
          if (/permission|permiso/i.test(e.message || '')) { s.state = 'permission'; s.detail = 'Necesita tu permiso'; }
          else { s.state = 'waiting'; s.detail = 'Te está esperando'; }
          break;
        case 'Stop': s.state = 'done'; s.detail = 'Terminó'; send('claude-done', { project: s.project }); break;
        case 'SessionEnd': sessions.delete(id); push(); return;
      }
      sessions.set(id, s);
      push();
    });
  });
  server.on('error', () => {});
  server.listen(PORT, '127.0.0.1');
  // las sesiones que no dan señales en 10 min se olvidan
  setInterval(() => { let ch = false; for (const [k, s] of sessions) if (Date.now() - s.t > 10 * 60e3) { sessions.delete(k); ch = true; } if (ch) push(); }, 60e3);
  return { setHooks: setClaudeHooks };
}

module.exports = { dolar, futbol, goles, calendar, downloads, claude, setClaudeHooks };
