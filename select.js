// Westley's Book multi-select, shared by the app and the grandparents' page (family.html).
// Tap "Select" (or long-press a photo), tap photos to pick them, then Share / Save sends the exact
// stored files to the share sheet ("Save N Images" on iPhone), or Download saves one photo or a
// ZIP of the originals (stored, not compressed, so every byte is the same as the stored file).
// items(): [{ key, getUrl: () => Promise<string|null> | string, filename }] in timeline order.

const LONG_MS = 450, MOVE_PX = 10, POOL = 4;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const isTouch = () => matchMedia('(pointer: coarse)').matches || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
export function canShareFiles() {
  try { return isTouch() && !!navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' })] }); } catch { return false; }
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ---------- tiny ZIP writer: "stored" entries (no compression), so the photos inside are the original bytes ---------- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
export async function makeZip(entries) { // entries: [{ name, blob }]
  const enc = new TextEncoder(), parts = [], central = [];
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const { name, blob } of entries) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nm = enc.encode(name), crc = crc32(data), size = data.length;
    if (offset + size > 0xFFFFFFF0) throw new Error('too big for one ZIP');
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
    lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
    parts.push(lh, nm, data); central.push(ch, nm);
    offset += 30 + nm.length + size;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a'); a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// edges(): { top } = the bottom of any sticky header, so auto-scroll starts below it (the bar covers the bottom)
export function createSelect({ items, onModeChange = () => {}, label = 'photos', edges: edgesOpt } = {}) {
  let on = false, gen = 0, busy = false, flashTimer = 0;
  const picked = new Set();
  const files = new Map();   // key -> File, ready to share instantly (inside the tap)
  const pending = new Map(); // key -> Promise<File>
  const groups = new Set();  // { btn, keys }
  let queue = [], running = 0;

  /* names: unique across the whole timeline, so two memories on one day don't collide */
  let nameCache = null;
  const names = () => {
    if (nameCache) return nameCache;
    const used = new Set(); nameCache = new Map();
    for (const it of items()) {
      let n = it.filename || 'westley.jpg';
      if (used.has(n)) { const base = n.replace(/\.jpe?g$/i, ''); let i = 2; while (used.has(`${base} (${i}).jpg`)) i++; n = `${base} (${i}).jpg`; }
      used.add(n); nameCache.set(String(it.key), n);
    }
    return nameCache;
  };
  const selected = () => items().filter((it) => picked.has(String(it.key)));

  function pump() {
    while (running < POOL && queue.length) {
      const job = queue.shift(); running++;
      job().finally(() => { running--; pump(); });
    }
  }
  function fileFor(it) {
    const key = String(it.key);
    if (files.has(key)) return Promise.resolve(files.get(key));
    if (!pending.has(key)) {
      const g = gen;
      const p = new Promise((resolve, reject) => {
        queue.push(async () => {
          try {
            const url = await it.getUrl();
            if (!url) throw new Error('no url');
            const r = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const b = await r.blob();
            const f = new File([b], names().get(key) || 'westley.jpg', { type: b.type || 'image/jpeg' });
            if (g === gen) files.set(key, f);
            resolve(f);
          } catch (e) { reject(e); }
        });
        pump();
      });
      p.catch(() => {}).finally(() => { if (pending.get(key) === p) pending.delete(key); });
      pending.set(key, p);
    }
    return pending.get(key);
  }
  async function fetchAll(list, progress) {
    let done = 0; progress(0, list.length);
    return Promise.all(list.map((it) => fileFor(it).then((f) => { progress(++done, list.length); return f; })));
  }

  /* ---------- the bottom bar ---------- */
  const bar = el('div', 'wbs-bar'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', `Selected ${label}`);
  const inner = el('div', 'wbs-inner');
  const top = el('div', 'wbs-top');
  const cancel = el('button', 'wbs-btn wbs-text', 'Cancel'); cancel.type = 'button';
  const count = el('span', 'wbs-count'); count.setAttribute('aria-live', 'polite');
  const allBtn = el('button', 'wbs-btn wbs-text wbs-all', 'Select all'); allBtn.type = 'button';
  top.append(cancel, count, allBtn);
  const acts = el('div', 'wbs-acts');
  const primary = el('button', 'wbs-btn wbs-primary'); primary.type = 'button';
  const zipBtn = el('button', 'wbs-btn wbs-secondary', 'Save ZIP'); zipBtn.type = 'button';
  acts.append(primary, zipBtn);
  inner.append(top, acts); bar.append(inner);

  let state = 'idle', progressText = '';
  const shareMode = () => canShareFiles();
  function setState(s, text = '') {
    state = s; progressText = text; clearTimeout(flashTimer);
    if (s === 'done' || s === 'error') flashTimer = setTimeout(() => setState('idle'), s === 'error' ? 3200 : 1800);
    paint();
  }
  function paint() {
    const n = picked.size, sm = shareMode();
    count.textContent = n ? `${n} selected` : `Select ${label}`;
    const total = items().length;
    allBtn.textContent = n && n === total ? 'Clear' : 'Select all';
    allBtn.hidden = !total;
    let text;
    if (state === 'busy') text = progressText;
    else if (state === 'ready') text = `Tap to share ${n} photo${n === 1 ? '' : 's'}`;
    else if (state === 'done' || state === 'error') text = progressText;
    else if (sm) text = 'Share / Save';
    else text = n > 1 ? `Download ZIP (${n})` : 'Download photo';
    primary.textContent = text;
    primary.dataset.state = state;
    primary.disabled = !n || state === 'busy';
    zipBtn.hidden = !(sm && n > 1);
    zipBtn.disabled = state === 'busy';
    acts.classList.toggle('two', !zipBtn.hidden);
  }
  function update() {
    for (const t of document.querySelectorAll('[data-wbs-key]')) {
      const s = picked.has(t.dataset.wbsKey);
      t.classList.toggle('wbs-sel', s);
      if (on) t.setAttribute('aria-pressed', String(s)); else t.removeAttribute('aria-pressed');
    }
    for (const g of [...groups]) {
      if (!g.btn.isConnected) { groups.delete(g); continue; }
      const ks = g.keys().map(String);
      const all = ks.length && ks.every((k) => picked.has(k));
      g.btn.textContent = all ? g.labels[1] : g.labels[0];
      g.btn.setAttribute('aria-pressed', String(!!all));
    }
    if (state === 'ready' || state === 'done' || state === 'error') { state = 'idle'; clearTimeout(flashTimer); }
    paint();
  }

  /* keep the photo under your finger in place when the page re-lays out (grids expand in select mode) */
  function withAnchor(key, fn) {
    const thumbs = [...document.querySelectorAll('[data-wbs-key]')];
    let a = key != null ? thumbs.find((t) => t.dataset.wbsKey === String(key)) : null;
    if (!a) a = thumbs.find((t) => t.getBoundingClientRect().bottom > 90);
    const k = a?.dataset.wbsKey, y0 = a?.getBoundingClientRect().top;
    fn();
    if (k == null) return;
    const b = [...document.querySelectorAll('[data-wbs-key]')].find((t) => t.dataset.wbsKey === k);
    if (b) { const dy = b.getBoundingClientRect().top - y0; if (Math.abs(dy) > 1) window.scrollBy(0, dy); }
  }
  function prefetch(key) {
    if (!shareMode()) return;
    const it = items().find((x) => String(x.key) === key);
    if (it) fileFor(it).catch(() => {});
  }
  function toggle(key, force) {
    key = String(key);
    const want = force ?? !picked.has(key);
    if (want) { picked.add(key); prefetch(key); } else picked.delete(key);
    update();
  }
  function enter(key, { pick: pickIt = true } = {}) {
    if (on) { if (key != null && pickIt) toggle(key, true); return; }
    withAnchor(key, () => {
      on = true; nameCache = null;
      document.documentElement.classList.add('wbs-on');
      document.body.append(bar);
      if (key != null && pickIt) { picked.add(String(key)); prefetch(String(key)); }
      setState('idle');
      onModeChange(true);
    });
    update();
  }
  function exit({ quiet = false } = {}) {
    if (!on) return;
    const go = () => {
      if (drag) endDrag();
      on = false; gen++; busy = false;
      picked.clear(); files.clear(); pending.clear(); queue = [];
      document.documentElement.classList.remove('wbs-on');
      bar.remove(); setState('idle');
      if (!quiet) onModeChange(false);
    };
    if (quiet) go(); else withAnchor(null, go);
    update();
  }

  async function share(list) {
    const n = list.length;
    if (list.every((it) => files.has(String(it.key)))) return doShare(list.map((it) => files.get(String(it.key))), list);
    busy = true;
    try {
      const fs = await fetchAll(list, (k, t) => setState('busy', `Preparing ${k} / ${t}…`));
      busy = false;
      return doShare(fs, list);
    } catch { busy = false; setState('error', n > 1 ? 'Couldn’t get the photos. Try again' : 'Couldn’t get the photo. Try again'); }
  }
  async function doShare(fs, list) {
    if (!navigator.canShare?.({ files: fs })) return download(list);
    try {
      const p = navigator.share({ files: fs }); // first thing in the tap, so iOS allows the share sheet
      setState('busy', 'Sharing…');
      await p;
      setState('done', '✓ Shared');
    } catch (err) {
      if (err?.name === 'AbortError') setState('idle');
      else if (err?.name === 'NotAllowedError') setState('ready'); // the tap "expired" while fetching; the next tap shares instantly
      else setState('error', 'Couldn’t share. Try Save ZIP');
    }
  }
  async function download(list) {
    const n = list.length;
    busy = true;
    try {
      const fs = await fetchAll(list, (k, t) => setState('busy', `Preparing ${k} / ${t}…`));
      if (n === 1) saveBlob(fs[0], fs[0].name);
      else {
        setState('busy', 'Making ZIP…');
        saveBlob(await makeZip(fs.map((f) => ({ name: f.name, blob: f }))), `westley-photos-${today()}.zip`);
      }
      busy = false; setState('done', '✓ Downloaded');
    } catch { busy = false; setState('error', 'Couldn’t download. Try again'); }
  }

  cancel.addEventListener('click', () => exit());
  allBtn.addEventListener('click', () => {
    const ks = items().map((it) => String(it.key));
    if (picked.size === ks.length) picked.clear(); else for (const k of ks) { picked.add(k); prefetch(k); }
    update();
  });
  primary.addEventListener('click', () => {
    if (busy) return;
    const list = selected();
    if (!list.length) return;
    if (shareMode()) share(list); else download(list);
  });
  zipBtn.addEventListener('click', () => { if (!busy && picked.size) download(selected()); });
  document.addEventListener('keydown', (e) => { if (on && e.key === 'Escape' && !document.querySelector('.wbv')) { e.preventDefault(); exit(); } });

  /* ---------- press-and-drag range selection (like Photos): hold, then slide across photos ---------- */
  // Hold a photo (briefly while selecting, a long-press otherwise) and slide: every photo between the one you
  // started on and the one under your finger flips to the same state; sliding back restores the rest.
  // Near the top or bottom edge the page scrolls by itself and keeps grabbing photos.
  const HOLD_MS = 230, EDGE = 90, MAX_SPEED = 22;
  let drag = null;  // { anchor, add, base: Set, last, x, y, raf }
  let press = null; // a touch or mouse press that may become a drag
  let suppressUntil = 0;
  const tiles = () => [...document.querySelectorAll('[data-wbs-key]')];
  const tileByKey = (k) => tiles().find((t) => t.dataset.wbsKey === k);
  function bounds() {
    const top = Math.max(0, Math.min(edgesOpt?.()?.top ?? 0, innerHeight * 0.35));
    const bottom = bar.isConnected ? Math.min(innerHeight, bar.getBoundingClientRect().top) : innerHeight;
    return { top, bottom };
  }
  function tileAt(x, y) {
    const { top, bottom } = bounds();
    const yy = Math.min(Math.max(y, top + 2), bottom - 2); // over the header or the bar: use the photo just inside
    return document.elementFromPoint(x, yy)?.closest?.('[data-wbs-key]') || null;
  }
  function applyRange(cur) {
    const keys = tiles().map((t) => t.dataset.wbsKey);
    const a = keys.indexOf(drag.anchor); if (a < 0) return;
    let b = keys.indexOf(cur); if (b < 0) b = a;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    picked.clear(); for (const k of drag.base) picked.add(k);
    for (let i = lo; i <= hi; i++) { if (drag.add) picked.add(keys[i]); else picked.delete(keys[i]); }
    drag.last = cur; update();
  }
  function startDrag(key, x, y) {
    let add;
    if (!on) { enter(key, { pick: false }); add = true; } else add = !picked.has(key);
    drag = { anchor: key, add, base: new Set(picked), last: key, x, y, raf: 0 };
    document.documentElement.classList.add('wbs-dragging');
    applyRange(key);
    navigator.vibrate?.(10);
    const t = tileByKey(key);
    if (t) { t.classList.remove('wbs-pulse'); void t.offsetWidth; t.classList.add('wbs-pulse'); setTimeout(() => t.classList.remove('wbs-pulse'), 320); }
  }
  function dragMove(x, y) {
    drag.x = x; drag.y = y;
    const t = tileAt(x, y);
    if (t && t.dataset.wbsKey !== drag.last) applyRange(t.dataset.wbsKey);
    if (!drag.raf) drag.raf = requestAnimationFrame(autoScroll);
  }
  function autoScroll() {
    if (!drag) return;
    drag.raf = 0;
    const { top, bottom } = bounds(), y = drag.y;
    let v = 0;
    if (y < top + EDGE) v = -MAX_SPEED * Math.min(1, Math.max(0.12, (top + EDGE - y) / EDGE));
    else if (y > bottom - EDGE) v = MAX_SPEED * Math.min(1, Math.max(0.12, (y - (bottom - EDGE)) / EDGE));
    if (!v) return;
    const before = scrollY;
    window.scrollBy(0, v);
    if (scrollY !== before) { const t = tileAt(drag.x, y); if (t && t.dataset.wbsKey !== drag.last) applyRange(t.dataset.wbsKey); }
    drag.raf = requestAnimationFrame(autoScroll);
  }
  function endDrag() {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    for (const k of picked) if (!drag.base.has(k)) prefetch(k);
    drag = null;
    document.documentElement.classList.remove('wbs-dragging');
    suppressUntil = performance.now() + 450; // the click the browser sends after lifting must not toggle the last photo back
  }
  function cancelPress() { if (press?.timer) clearTimeout(press.timer); press = null; }
  // the click after a drag lands on whatever is under the finger; swallow it once
  document.addEventListener('click', (e) => { if (performance.now() < suppressUntil) { e.preventDefault(); e.stopPropagation(); suppressUntil = 0; } }, true);
  // a new press means the next click is a real tap
  document.addEventListener('pointerdown', () => { suppressUntil = 0; }, true);

  /* touch: listen on the touched element itself, so the gesture survives the page redrawing on entering select mode */
  function onTouchStart(e, key) {
    if (e.touches.length !== 1 || drag) { cancelPress(); if (drag && e.touches.length > 1) endDrag(); return; }
    const p = e.touches[0], target = e.target;
    cancelPress();
    press = { key, id: p.identifier, x0: p.clientX, y0: p.clientY, x: p.clientX, y: p.clientY, target };
    press.timer = setTimeout(() => { if (!press) return; press.timer = 0; startDrag(key, press.x, press.y); }, on ? HOLD_MS : LONG_MS);
    const opts = { passive: false };
    const move = (ev) => {
      if (ev.__wbs) return; ev.__wbs = true;
      const q = [...ev.changedTouches].find((t) => t.identifier === press?.id); if (!q) return;
      press.x = q.clientX; press.y = q.clientY;
      if (drag) { if (ev.cancelable) ev.preventDefault(); dragMove(q.clientX, q.clientY); return; }
      if (!press.timer) return;
      const dx = q.clientX - press.x0, dy = q.clientY - press.y0;
      if (Math.hypot(dx, dy) <= MOVE_PX) return;
      if (on && Math.abs(dx) > Math.abs(dy) * 1.2 && ev.cancelable) { // sideways right away: start grabbing
        ev.preventDefault(); clearTimeout(press.timer); press.timer = 0;
        startDrag(key, press.x0, press.y0); dragMove(q.clientX, q.clientY);
      } else cancelPress(); // up/down: a normal scroll
    };
    const end = (ev) => {
      if (ev.__wbs) return; ev.__wbs = true;
      if (drag) { if (ev.cancelable && ev.type === 'touchend') ev.preventDefault(); endDrag(); }
      cancelPress(); detach();
    };
    const detach = () => { for (const n of [target, document]) { n.removeEventListener('touchmove', move, opts); n.removeEventListener('touchend', end); n.removeEventListener('touchcancel', end); } };
    for (const n of [target, document]) { n.addEventListener('touchmove', move, opts); n.addEventListener('touchend', end); n.addEventListener('touchcancel', end); }
  }
  /* mouse: while selecting, click-and-drag past 8px grabs a range; a long press starts selecting */
  function onPointerDown(e, key) {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    cancelPress();
    press = { key, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
    if (!on) press.timer = setTimeout(() => { if (!press) return; press.timer = 0; startDrag(key, press.x, press.y); }, LONG_MS);
    const move = (ev) => {
      if (!press && !drag) return;
      if (press) { press.x = ev.clientX; press.y = ev.clientY; }
      if (drag) { ev.preventDefault(); dragMove(ev.clientX, ev.clientY); return; }
      if (Math.hypot(ev.clientX - press.x0, ev.clientY - press.y0) <= 8) return;
      if (on) { const k = press.key; startDrag(k, press.x0, press.y0); dragMove(ev.clientX, ev.clientY); }
      else cancelPress();
    };
    const up = () => { endDrag(); cancelPress(); removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }

  /* ---------- thumbnails ---------- */
  function bindThumb(t, key, open) {
    key = String(key);
    t.dataset.wbsKey = key; t.classList.add('wbs-thumb');
    const badge = el('span', 'wbs-check'); badge.setAttribute('aria-hidden', 'true'); badge.innerHTML = CHECK;
    t.append(badge);
    for (const img of t.querySelectorAll('img')) img.draggable = false;
    t.addEventListener('touchstart', (e) => onTouchStart(e, key), { passive: true });
    t.addEventListener('pointerdown', (e) => onPointerDown(e, key));
    t.addEventListener('dragstart', (e) => e.preventDefault());
    t.addEventListener('contextmenu', (e) => { if (isTouch() || on) e.preventDefault(); });
    t.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (drag || performance.now() < suppressUntil) return;
      if (on) toggle(key); else open?.();
    });
    if (picked.has(key)) t.classList.add('wbs-sel');
    if (on) t.setAttribute('aria-pressed', String(picked.has(key)));
    return t;
  }
  function groupToggle(keys, labels = ['Select', 'Deselect']) {
    const btn = el('button', 'wbs-group', labels[0]); btn.type = 'button';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ks = keys().map(String);
      const all = ks.every((k) => picked.has(k));
      for (const k of ks) { if (all) picked.delete(k); else { picked.add(k); prefetch(k); } }
      update();
    });
    groups.add({ btn, keys, labels });
    queueMicrotask(update);
    return btn;
  }

  return { bindThumb, groupToggle, enter, exit, toggle, get active() { return on; }, get dragging() { return !!drag; }, get count() { return picked.size; }, has: (k) => picked.has(String(k)), refresh: update };
}
