// Historial del portapapeles. Se guarda solo en tu PC: %APPDATA%\isla\clipboard.json + clips\*.png
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clipboard, nativeImage } = require('electron');

const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');

module.exports = function createClipStore({ dir, settings, onChange }) {
  const file = path.join(dir, 'clipboard.json');
  const imgDir = path.join(dir, 'clips');
  fs.mkdirSync(imgDir, { recursive: true });

  let items = [];
  try { items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const thumbs = new Map();

  let saveT;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => fs.writeFile(file, JSON.stringify(items), () => {}), 300);
  };
  const changed = () => { save(); onChange(); };

  function drop(i) {
    if (i.file) fs.unlink(path.join(imgDir, i.file), () => {});
    thumbs.delete(i.id);
  }

  function prune() {
    const s = settings();
    const now = Date.now();
    const keep = [];
    let unpinned = 0;
    for (const i of items) { // items va de más nuevo a más viejo
      const old = s.clipRetentionDays > 0 && now - i.t > s.clipRetentionDays * 864e5;
      if (!i.pinned && (old || unpinned >= s.clipMax)) { drop(i); continue; }
      if (!i.pinned) unpinned++;
      keep.push(i);
    }
    items = keep;
  }

  function excluded(src) {
    const s = settings();
    const who = `${src.app || ''} ${src.appName || ''}`.toLowerCase();
    return (s.clipExclude || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).some((e) => who.includes(e));
  }

  // Lee el portapapeles y lo guarda. Devuelve { item, isNew } o null.
  function capture(src = {}) {
    const s = settings();
    if (!s.clipEnabled || excluded(src)) return null;
    // Los gestores de contraseñas marcan lo que copian con este formato: no se guarda.
    try { if (clipboard.has('ExcludeClipboardContentFromMonitorProcessing')) return null; } catch {}

    const formats = clipboard.availableFormats();
    let item, png;
    if (formats.some((f) => f.startsWith('image/'))) {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
      png = img.toPNG();
      const { width, height } = img.getSize();
      item = { kind: 'image', hash: md5(png), w: width, h: height };
    } else {
      const text = clipboard.readText();
      if (!text || !text.trim()) return null;
      const t = text.trim();
      item = { kind: /^https?:\/\/\S+$/i.test(t) ? 'link' : 'text', text: text.slice(0, 20000), hash: md5(text) };
    }

    const existing = items.find((i) => i.hash === item.hash);
    if (existing) {
      existing.t = Date.now();
      items = [existing, ...items.filter((i) => i !== existing)];
      changed();
      return { item: existing, isNew: false };
    }
    Object.assign(item, {
      id: crypto.randomUUID(), t: Date.now(), pinned: false,
      app: src.app || '', appName: src.appName || '', appPath: src.appPath || '',
    });
    if (png) { item.file = item.id + '.png'; fs.writeFileSync(path.join(imgDir, item.file), png); }
    items.unshift(item);
    prune();
    changed();
    return { item, isNew: true };
  }

  function thumb(i) {
    if (!i.file) return null;
    if (!thumbs.has(i.id)) {
      try {
        const img = nativeImage.createFromPath(path.join(imgDir, i.file));
        thumbs.set(i.id, img.isEmpty() ? null : img.resize({ height: Math.min(220, img.getSize().height), quality: 'good' }).toDataURL());
      } catch { thumbs.set(i.id, null); }
    }
    return thumbs.get(i.id);
  }

  return {
    capture,
    prune: () => { prune(); changed(); },
    list: (limit = 80) => items.slice(0, limit).map((i) => ({
      id: i.id, kind: i.kind, text: i.text ? i.text.slice(0, 600) : undefined, t: i.t, pinned: i.pinned,
      app: i.app, appName: i.appName, appPath: i.appPath, w: i.w, h: i.h, thumb: thumb(i),
    })),
    count: () => items.length,
    file: (id) => { const i = items.find((x) => x.id === id); return i?.file ? path.join(imgDir, i.file) : null; },
    copy(id) {
      const i = items.find((x) => x.id === id);
      if (!i) return;
      if (i.kind === 'image') clipboard.writeImage(nativeImage.createFromPath(path.join(imgDir, i.file)));
      else clipboard.writeText(i.text);
    },
    pin(id) { const i = items.find((x) => x.id === id); if (i) { i.pinned = !i.pinned; changed(); } },
    remove(id) { const i = items.find((x) => x.id === id); if (i) { drop(i); items = items.filter((x) => x !== i); changed(); } },
    clear() { items = items.filter((i) => { if (!i.pinned) drop(i); return i.pinned; }); changed(); },
  };
};
