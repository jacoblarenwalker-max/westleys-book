// Westley's Book photo viewer, shared by the app and the grandparents' page (family.html).
// Swipe sideways to move between photos, slide down (or up) to close, pinch or double-tap to zoom,
// and Save fetches the exact stored file (no re-encoding) to share into Photos or download.
// items: [{ getUrl: () => Promise<string|null>, caption?, meta?, filename }]

const SWIPE_PX = 45, SWIPE_V = 0.35, CLOSE_PX = 70, CLOSE_V = 0.45, AXIS_PX = 10, MAX_ZOOM = 5;
let active = null;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isTouchDevice = () => matchMedia('(pointer: coarse)').matches || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

export function closeViewer() { active?.close(false); }
export const viewerOpen = () => !!active;

export function openViewer(items, start = 0, opts = {}) {
  if (!items?.length) return;
  closeViewer();
  let index = clamp(start, 0, items.length - 1);
  const urls = new Map();   // index -> Promise<url>
  const blobs = new Map();  // index -> Promise<Blob> (only the last few)
  const slides = new Map(); // index -> { root, img }
  const urlFor = (i) => { if (!urls.has(i)) urls.set(i, Promise.resolve(items[i].getUrl()).catch(() => null)); return urls.get(i); };

  const root = el('div', 'wbv'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', opts.label || 'Photos');
  const backdrop = el('div', 'wbv-bg');
  const stage = el('div', 'wbv-stage');
  const bar = el('div', 'wbv-bar');
  const count = el('span', 'wbv-count');
  const saveBtn = el('button', 'wbv-btn wbv-save'); saveBtn.type = 'button';
  const saveIco = el('span', 'wbv-ico', '↓'); const saveLbl = el('span', 'wbv-lbl', 'Save');
  saveBtn.append(saveIco, saveLbl); saveBtn.setAttribute('aria-label', 'Save this photo');
  const closeBtn = el('button', 'wbv-btn wbv-x', '✕'); closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', 'Close');
  const right = el('div', 'wbv-actions'); right.append(saveBtn, closeBtn);
  bar.append(count, right);
  const cap = el('div', 'wbv-cap'); const capMeta = el('div', 'wbv-meta'); const capText = el('p', 'wbv-text'); cap.append(capMeta, capText);
  const prevBtn = el('button', 'wbv-nav wbv-prev', '‹'); prevBtn.type = 'button'; prevBtn.setAttribute('aria-label', 'Previous photo');
  const nextBtn = el('button', 'wbv-nav wbv-next', '›'); nextBtn.type = 'button'; nextBtn.setAttribute('aria-label', 'Next photo');
  root.append(backdrop, stage, bar, cap, prevBtn, nextBtn);

  const W = () => stage.clientWidth || innerWidth;
  const H = () => stage.clientHeight || innerHeight;

  function slideFor(i) {
    if (slides.has(i)) return slides.get(i);
    const s = { root: el('div', 'wbv-slide'), img: el('img', 'wbv-img') };
    s.img.alt = items[i].caption || 'Photo'; s.img.draggable = false; s.img.decoding = 'async';
    s.root.append(s.img, el('div', 'wbv-spin'));
    urlFor(i).then((u) => { if (u) { s.img.src = u; s.img.addEventListener('load', () => s.root.classList.add('loaded'), { once: true }); } else s.root.classList.add('failed'); });
    slides.set(i, s);
    return s;
  }
  // zoom state for the current photo
  let z = { s: 1, x: 0, y: 0 };
  const applyZoom = (anim) => {
    const img = slides.get(index)?.img; if (!img) return;
    img.style.transition = anim ? 'transform 200ms cubic-bezier(.2,.7,.3,1)' : 'none';
    img.style.transform = `translate3d(${z.x}px, ${z.y}px, 0) scale(${z.s})`;
    root.classList.toggle('zoomed', z.s > 1.01);
  };
  const bounds = (s) => { const img = slides.get(index)?.img; const w = img?.offsetWidth || W(); const h = img?.offsetHeight || H(); return { x: Math.max(0, (w * s - W()) / 2), y: Math.max(0, (h * s - H()) / 2) }; };
  const clampPan = () => { const b = bounds(z.s); z.x = clamp(z.x, -b.x, b.x); z.y = clamp(z.y, -b.y, b.y); };
  const resetZoom = (anim) => { z = { s: 1, x: 0, y: 0 }; applyZoom(anim); };

  // position the three live slides (prev, current, next)
  function layout(dx = 0, dy = 0, anim = false) {
    const t = anim ? 'transform 230ms cubic-bezier(.2,.7,.3,1), opacity 230ms' : 'none';
    for (const [i, s] of slides) {
      const k = i - index;
      if (Math.abs(k) > 1) { s.root.remove(); continue; }
      if (!s.root.isConnected) stage.append(s.root);
      s.root.style.transition = t;
      const shrink = k === 0 && dy ? 1 - Math.min(Math.abs(dy) / 1400, 0.18) : 1;
      s.root.style.transform = `translate3d(${k * W() + dx}px, ${k === 0 ? dy : 0}px, 0) scale(${shrink})`;
    }
    backdrop.style.transition = anim ? 'opacity 230ms' : 'none';
    backdrop.style.opacity = String(dy ? Math.max(0.15, 1 - Math.abs(dy) / (H() * 0.6)) : 1);
  }
  function show() {
    for (const i of [index - 1, index, index + 1]) if (i >= 0 && i < items.length) slideFor(i);
    for (const i of [...slides.keys()]) if (Math.abs(i - index) > 3) { slides.get(i).root.remove(); slides.delete(i); }
    for (const i of [index + 2, index - 2]) if (i >= 0 && i < items.length) urlFor(i).then((u) => { if (u) { const im = new Image(); im.src = u; } });
    layout();
    const it = items[index];
    count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
    capMeta.textContent = it.meta || ''; capText.textContent = it.caption || '';
    cap.classList.toggle('empty', !it.meta && !it.caption);
    prevBtn.disabled = index === 0; nextBtn.disabled = index === items.length - 1;
    setSave('idle');
    clearTimeout(prefetchTimer);
    if (canShareFiles()) prefetchTimer = setTimeout(() => blobFor(index).catch(() => {}), 500);
  }
  let busy = false;
  function go(dir) {
    const to = index + dir;
    if (busy || to < 0 || to >= items.length) { layout(0, 0, true); return; }
    busy = true; resetZoom(false);
    for (const i of [to - 1, to, to + 1]) if (i >= 0 && i < items.length) slideFor(i);
    layout(-dir * W(), 0, true);
    setTimeout(() => { index = to; busy = false; show(); }, 235);
  }

  // ---------- full-quality save ----------
  let prefetchTimer;
  function blobFor(i) {
    if (!blobs.has(i)) {
      blobs.set(i, urlFor(i).then(async (u) => {
        if (!u) throw new Error('no url');
        const r = await fetch(u, { mode: 'cors', credentials: 'omit', cache: 'force-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      }));
      blobs.get(i).catch(() => blobs.delete(i));
      for (const k of [...blobs.keys()]) if (Math.abs(k - i) > 1) blobs.delete(k);
    }
    return blobs.get(i);
  }
  function canShareFiles() {
    try { return isTouchDevice() && !!navigator.canShare && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' })] }); } catch { return false; }
  }
  let saveState = 'idle', saveTimer;
  function setSave(state) {
    saveState = state; clearTimeout(saveTimer);
    saveBtn.disabled = state === 'saving';
    saveBtn.dataset.state = state;
    saveIco.textContent = state === 'done' ? '✓' : state === 'error' ? '!' : '↓';
    saveLbl.textContent = { idle: 'Save', saving: 'Saving…', done: 'Saved', error: 'Try again', ready: 'Tap to save' }[state];
    if (state === 'done' || state === 'error') saveTimer = setTimeout(() => setSave('idle'), 2200);
  }
  async function save() {
    if (saveState === 'saving') return;
    const i = index; const it = items[i];
    const name = it.filename || `westley-${i + 1}.jpg`;
    setSave('saving');
    try {
      const blob = await blobFor(i);
      const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
      if (canShareFiles() && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); setSave('done'); }
        catch (err) {
          if (err?.name === 'AbortError') setSave('idle');
          else if (err?.name === 'NotAllowedError') setSave('ready'); // the tap "expired" while downloading; the next tap shares instantly
          else throw err;
        }
        return;
      }
      const href = URL.createObjectURL(blob);
      const a = el('a'); a.href = href; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000);
      setSave('done');
    } catch (err) {
      console.warn('save photo', err);
      setSave('error');
    }
  }
  saveBtn.addEventListener('click', (e) => { e.stopPropagation(); save(); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(false); });
  prevBtn.addEventListener('click', (e) => { e.stopPropagation(); go(-1); });
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); go(1); });

  // ---------- gestures ----------
  const pts = new Map();
  let g = null; // current gesture
  let lastTap = 0, tapTimer = null;
  const center = () => { const r = stage.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const two = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; };

  stage.addEventListener('pointerdown', (e) => {
    if (busy) return;
    stage.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const t = two(); const c = center();
      g = { type: 'pinch', d0: t.d, s0: z.s, qx: (t.cx - c.x - z.x) / z.s, qy: (t.cy - c.y - z.y) / z.s };
      layout(0, 0);
    } else if (pts.size === 1) {
      g = { type: z.s > 1.01 ? 'pan' : 'drag', x0: e.clientX, y0: e.clientY, t0: performance.now(), zx: z.x, zy: z.y, axis: null, dx: 0, dy: 0, moved: false, samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.type === 'pinch' && pts.size >= 2) {
      const t = two(); const c = center();
      z.s = clamp(g.s0 * (t.d / Math.max(1, g.d0)), 1, MAX_ZOOM);
      z.x = t.cx - c.x - z.s * g.qx; z.y = t.cy - c.y - z.s * g.qy;
      if (z.s <= 1.01) { z.x = 0; z.y = 0; } else clampPan();
      applyZoom(false); return;
    }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (Math.hypot(dx, dy) > 6) g.moved = true;
    g.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() }); if (g.samples.length > 6) g.samples.shift();
    if (g.type === 'pan') { z.x = g.zx + dx; z.y = g.zy + dy; clampPan(); applyZoom(false); return; }
    if (!g.axis && Math.hypot(dx, dy) > AXIS_PX) g.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    if (g.axis === 'x') {
      const edge = (dx > 0 && index === 0) || (dx < 0 && index === items.length - 1);
      g.dx = edge ? dx * 0.35 : dx; layout(g.dx, 0);
    } else if (g.axis === 'y') { g.dy = dy; layout(0, dy); }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.type === 'pinch') {
      if (pts.size === 0) { if (z.s <= 1.05) resetZoom(true); else { clampPan(); applyZoom(true); } g = null; }
      else { const [p] = [...pts.values()]; g = { type: z.s > 1.01 ? 'pan' : 'drag', x0: p.x, y0: p.y, t0: performance.now(), zx: z.x, zy: z.y, axis: null, dx: 0, dy: 0, moved: true, samples: [{ ...p, t: performance.now() }] }; }
      return;
    }
    if (pts.size) return;
    const s = g.samples; const a = s[0], b = s[s.length - 1]; const dt = Math.max(1, b.t - a.t);
    const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    const cur = g; g = null;
    if (cur.type === 'pan') return;
    if (cur.axis === 'x') {
      const raw = (e.clientX ?? cur.x0) - cur.x0;
      if (raw <= -SWIPE_PX || (vx < -SWIPE_V && raw < -12)) go(1);
      else if (raw >= SWIPE_PX || (vx > SWIPE_V && raw > 12)) go(-1);
      else layout(0, 0, true);
      return;
    }
    if (cur.axis === 'y') {
      if (Math.abs(cur.dy) >= CLOSE_PX || (Math.abs(vy) > CLOSE_V && Math.abs(cur.dy) > 12)) close(true, Math.sign(cur.dy || vy) || 1);
      else layout(0, 0, true);
      return;
    }
    if (!cur.moved && e.type === 'pointerup') tap(e.clientX, e.clientY);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  function tap(x, y) {
    const t = performance.now();
    if (t - lastTap < 300) {
      clearTimeout(tapTimer); lastTap = 0;
      if (z.s > 1.01) resetZoom(true);
      else { const c = center(); const s = 2.5; z = { s, x: (x - c.x) * (1 - s), y: (y - c.y) * (1 - s) }; clampPan(); applyZoom(true); }
      return;
    }
    lastTap = t;
    tapTimer = setTimeout(() => root.classList.toggle('chrome-off'), 300);
  }
  stage.addEventListener('wheel', (e) => { if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 30 && !busy) go(e.deltaX > 0 ? 1 : -1); }, { passive: true });

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(false); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); go(-1); }
  };
  const onResize = () => { resetZoom(false); layout(); };

  function close(animated, dir = 1) {
    if (active !== api) return;
    active = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    clearTimeout(prefetchTimer); clearTimeout(tapTimer);
    const finish = () => { root.remove(); document.documentElement.classList.remove('wbv-open'); opts.onClose?.(); };
    if (!animated) return finish();
    const s = slides.get(index);
    if (s) { s.root.style.transition = 'transform 200ms ease-in, opacity 200ms'; s.root.style.transform = `translate3d(0, ${dir * H()}px, 0) scale(.85)`; s.root.style.opacity = '0'; }
    backdrop.style.transition = 'opacity 200ms'; backdrop.style.opacity = '0';
    bar.style.opacity = '0'; cap.style.opacity = '0';
    setTimeout(finish, 210);
  }
  const api = { close, go, get index() { return index; }, save };
  active = api;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  document.documentElement.classList.add('wbv-open');
  document.body.append(root);
  show();
  requestAnimationFrame(() => root.classList.add('in'));
  return api;
}
