import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, VAPID_PUBLIC_KEY, PUSH_FUNCTION, PHOTO_BUCKET } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ================= state ================= */
const TABLES = ['wb_feedings', 'wb_diapers', 'wb_sleeps', 'wb_memories', 'wb_visits', 'wb_growth', 'wb_vaccines', 'wb_questions', 'wb_meds', 'wb_med_doses'];
const SORT = {
  wb_feedings: (a, b) => cmp(b.started_at, a.started_at),
  wb_diapers: (a, b) => cmp(b.at, a.at),
  wb_sleeps: (a, b) => cmp(b.started_at, a.started_at),
  wb_memories: (a, b) => cmp(b.happened_on, a.happened_on) || cmp(b.created_at, a.created_at),
  wb_visits: (a, b) => cmp(b.visit_date, a.visit_date),
  wb_growth: (a, b) => cmp(b.measured_on, a.measured_on),
  wb_vaccines: (a, b) => cmp(b.given_on, a.given_on),
  wb_questions: (a, b) => cmp(a.created_at, b.created_at),
  wb_meds: (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || cmp(a.created_at, b.created_at),
  wb_med_doses: (a, b) => cmp(b.taken_at, a.taken_at),
};
const DEFAULT_FAMILY = { id: 1, baby_name: 'Westley', birth_date: null, feed_reminder_enabled: true, feed_reminder_minutes: 180, volume_unit: 'oz', weight_unit: 'lb' };
const S = {
  session: null,
  parent: null,          // my wb_parents row
  parents: [],
  family: { ...DEFAULT_FAMILY },
  rows: Object.fromEntries(TABLES.map((t) => [t, []])),
  loaded: false,
  doctorTab: sessionStorage.getItem('wb-doctor-tab') || 'questions',
};
const appEl = document.getElementById('app');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ================= helpers ================= */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'html') el.innerHTML = v; // only ever used with our own static SVG strings
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const uuid = () => crypto.randomUUID();
const buzz = () => { try { navigator.vibrate?.(12); } catch { /* ignore */ } };
const babyName = () => S.family.baby_name || 'Westley';

let toastTimer;
function toast(text, isError = false, action = null) {
  const t = document.getElementById('toast');
  t.replaceChildren(h('span', null, text));
  if (action) {
    const b = h('button', { type: 'button', class: 'toast-action' }, action.label);
    b.addEventListener('click', () => { clearTimeout(toastTimer); t.className = 'toast'; t.replaceChildren(); action.onClick(); });
    t.append(b);
  }
  t.className = 'toast show' + (isError ? ' error' : '') + (action ? ' has-action' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 5000 : action ? 6000 : 2400);
}
function friendlyError(err) {
  if (!err) return 'Something went wrong.';
  const msg = err.message || String(err);
  if (err.code === '42501' || /row-level security|permission denied/i.test(msg)) return "This account can't change Westley's Book.";
  if (err.code === '23514') return 'One of those values is out of range.';
  if (/Invalid login credentials/i.test(msg)) return 'Email or password is incorrect.';
  if (/Email not confirmed/i.test(msg)) return 'Please confirm your email first, then sign in.';
  if (isNetworkError(err)) return "Couldn't reach the server. Check your connection.";
  return msg;
}
const isNetworkError = (err) => /Failed to fetch|NetworkError|Load failed|network|fetch failed/i.test(err?.message || String(err || '')) && !err?.code;

/* ---------- time ---------- */
const now = () => Date.now();
const ms = (ts) => (ts ? new Date(ts).getTime() : NaN);
const isoNow = () => new Date().toISOString();
const localDay = (d = new Date()) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDayLabel = (ts) => {
  const d = new Date(ts); const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  if (localDay(d) === localDay(today)) return 'Today';
  if (localDay(d) === localDay(y)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
};
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = (s, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => parseDate(s).toLocaleDateString([], opts);
// "45s", "12m", "2h 05m"
function fmtDur(msec, { secs = false } = {}) {
  const t = Math.max(0, Math.floor(msec / 1000));
  const hh = Math.floor(t / 3600); const mm = Math.floor((t % 3600) / 60); const ss = t % 60;
  if (secs) return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  if (hh) return `${hh}h ${String(mm).padStart(2, '0')}m`;
  return `${mm}m`;
}
const fmtMin = (msec) => (msec > 0 && msec < 60000 ? '<1 min' : `${Math.round(msec / 60000)} min`);
function fmtAgo(ts) {
  const d = now() - ms(ts);
  if (d < 60000) return 'just now';
  return `${fmtDur(d)} ago`;
}
// value for <input type=datetime-local> in device time
const toLocalInput = (ts) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);
function ageText(birth) {
  if (!birth) return null;
  const b = parseDate(birth); const t = new Date(); t.setHours(0, 0, 0, 0);
  const days = Math.round((t - b) / 86400000);
  if (days < 0) return 'Arriving soon';
  if (days === 0) return 'Born today 💙';
  if (days < 14) return `${days} day${days === 1 ? '' : 's'} old`;
  if (days < 7 * 13) { const w = Math.floor(days / 7); const r = days % 7; return `${w} weeks${r ? `, ${r} day${r === 1 ? '' : 's'}` : ''} old`; }
  let m = (t.getFullYear() - b.getFullYear()) * 12 + (t.getMonth() - b.getMonth()); if (t.getDate() < b.getDate()) m--;
  return m < 24 ? `${m} months old` : `${Math.floor(m / 12)} years old`;
}
function ageAt(dateStr) {
  const birth = S.family.birth_date; if (!birth || !dateStr) return null;
  const days = Math.round((parseDate(dateStr) - parseDate(birth)) / 86400000);
  if (days < 0) return null;
  if (days === 0) return 'Birthday';
  if (days < 14) return `Day ${days}`;
  if (days < 7 * 13) return `Week ${Math.floor(days / 7)}`;
  const b = parseDate(birth); const d = parseDate(dateStr);
  let m = (d.getFullYear() - b.getFullYear()) * 12 + (d.getMonth() - b.getMonth()); if (d.getDate() < b.getDate()) m--;
  return `${m} months`;
}

/* ---------- units ---------- */
const ML_PER_OZ = 29.5735;
const volUnit = () => S.family.volume_unit || 'oz';
const fmtVol = (ml) => (ml == null ? '' : volUnit() === 'oz' ? `${+(ml / ML_PER_OZ).toFixed(1)} oz` : `${Math.round(ml)} mL`);
const toMl = (v) => (volUnit() === 'oz' ? v * ML_PER_OZ : v);
const fromMl = (ml) => (volUnit() === 'oz' ? +(ml / ML_PER_OZ).toFixed(1) : Math.round(ml));
const imperial = () => (S.family.weight_unit || 'lb') === 'lb';
function fmtWeight(g) {
  if (g == null) return '—';
  if (!imperial()) return `${(g / 1000).toFixed(2)} kg`;
  const oz = g / 28.3495; let lb = Math.floor(oz / 16); let r = Math.round(oz - lb * 16); if (r === 16) { lb++; r = 0; }
  return `${lb} lb ${r} oz`;
}
const fmtLen = (cm) => (cm == null ? '—' : imperial() ? `${+(cm / 2.54).toFixed(2)} in` : `${+(+cm).toFixed(1)} cm`);
const num = (v) => { const s = String(v ?? '').trim().replace(',', '.'); if (!s) return null; const n = Number(s); return Number.isFinite(n) ? n : NaN; };

/* ================= data: cache, outbox, realtime ================= */
const CACHE_KEY = 'wb-cache-v1';
const OUTBOX_KEY = 'wb-outbox-v1';
function saveCache() {
  if (!S.session) return;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ uid: S.session.user.id, family: S.family, parents: S.parents, rows: S.rows })); } catch { /* quota */ }
}
function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!c || c.uid !== S.session?.user?.id) return false;
    S.family = { ...DEFAULT_FAMILY, ...c.family }; S.parents = c.parents || [];
    S.parent = S.parents.find((p) => p.user_id === c.uid) || null;
    for (const t of TABLES) S.rows[t] = c.rows?.[t] || [];
    return !!S.parent;
  } catch { return false; }
}
let outbox = (() => { try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; } })();
const saveOutbox = () => localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
const pendingIds = () => new Set(outbox.map((o) => o.row?.id || o.id));

function putLocal(table, row) {
  const list = S.rows[table];
  const i = list.findIndex((r) => r.id === row.id);
  if (i >= 0) list[i] = { ...list[i], ...row }; else list.push(row);
  list.sort(SORT[table]);
}
function dropLocal(table, id) { S.rows[table] = S.rows[table].filter((r) => r.id !== id); }

// Every write goes through here: applied on screen right away, kept in an outbox until Supabase confirms,
// so a feed logged with bad signal at 3 AM is never lost (ids are made on the phone, so retries are safe).
function save(table, row) {
  putLocal(table, row);
  outbox = outbox.filter((o) => !(o.table === table && o.op === 'upsert' && o.row.id === row.id));
  outbox.push({ op: 'upsert', table, row: S.rows[table].find((r) => r.id === row.id) });
  saveOutbox(); saveCache(); flushSoon();
}
function remove(table, id) {
  dropLocal(table, id);
  outbox = outbox.filter((o) => !(o.table === table && o.row?.id === id));
  outbox.push({ op: 'delete', table, id });
  saveOutbox(); saveCache(); flushSoon();
}
let flushing = false; let flushTimer;
const flushSoon = (delay = 0) => { clearTimeout(flushTimer); flushTimer = setTimeout(flush, delay); };
const CLIENT_ONLY = new Set(['created_at', 'updated_at']);
async function flush() {
  if (flushing || !outbox.length || !S.parent) return;
  flushing = true;
  try {
    while (outbox.length) {
      const o = outbox[0];
      let error;
      if (o.op === 'upsert') {
        const row = Object.fromEntries(Object.entries(o.row).filter(([k]) => !CLIENT_ONLY.has(k)));
        ({ error } = await sb.from(o.table).upsert(row, { onConflict: 'id' }));
      } else {
        ({ error } = await sb.from(o.table).delete().eq('id', o.id));
      }
      if (error && (isNetworkError(error) || /JWT|token/i.test(error.message || ''))) { setSync('offline'); flushSoon(15000); return; }
      outbox.shift(); saveOutbox();
      if (error) { toast(friendlyError(error), true); refreshTable(o.table); }
    }
    setSync('ok');
  } catch (err) {
    setSync('offline'); flushSoon(15000);
  } finally { flushing = false; }
}
window.addEventListener('online', () => flushSoon());
let syncState = 'ok';
function setSync(s) { if (syncState === s) return; syncState = s; document.body.classList.toggle('offline', s === 'offline'); }

async function fetchTable(t) {
  const since = new Date(now() - 21 * 86400000).toISOString();
  let q = sb.from(t).select('*');
  if (t === 'wb_feedings') q = q.or(`started_at.gte.${since},ended_at.is.null`).order('started_at', { ascending: false }).limit(1000);
  else if (t === 'wb_sleeps') q = q.or(`started_at.gte.${since},ended_at.is.null`).order('started_at', { ascending: false }).limit(1000);
  else if (t === 'wb_diapers') q = q.gte('at', since).order('at', { ascending: false }).limit(1000);
  else if (t === 'wb_med_doses') q = q.order('taken_at', { ascending: false }).limit(2000);
  else q = q.limit(2000);
  const { data, error } = await q;
  if (error) throw error;
  // keep local rows that are still waiting in the outbox
  const pend = pendingIds();
  const keep = S.rows[t].filter((r) => pend.has(r.id));
  const merged = (data || []).filter((r) => !pend.has(r.id)).concat(keep);
  const deleted = new Set(outbox.filter((o) => o.op === 'delete' && o.table === t).map((o) => o.id));
  S.rows[t] = merged.filter((r) => !deleted.has(r.id)).sort(SORT[t]);
}
async function refreshTable(t) { try { await fetchTable(t); saveCache(); renderSoon(); } catch { /* offline */ } }

async function loadAll() {
  if (!S.session) return;
  const uid = S.session.user.id;
  const { data: parents, error } = await sb.from('wb_parents').select('user_id, email, display_name');
  if (error) { if (!S.parent) throw error; return; }
  S.parents = parents || [];
  S.parent = S.parents.find((p) => p.user_id === uid) || null;
  if (!S.parent) return;
  const fam = await sb.from('wb_family').select('*').eq('id', 1).maybeSingle();
  if (fam.data) S.family = { ...DEFAULT_FAMILY, ...fam.data };
  await Promise.all(TABLES.map(fetchTable));
  S.loaded = true;
  saveCache();
  setSync('ok');
}

let channel = null;
function subscribeRealtime() {
  if (channel || !S.parent) return;
  channel = sb.channel('wb-live');
  for (const t of [...TABLES, 'wb_family']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table: t }, (p) => {
      if (t === 'wb_family') { if (p.new) S.family = { ...DEFAULT_FAMILY, ...p.new }; }
      else if (p.eventType === 'DELETE') { if (p.old?.id) dropLocal(t, p.old.id); }
      else if (p.new?.id && !pendingIds().has(p.new.id)) putLocal(t, p.new);
      saveCache(); renderSoon();
    });
  }
  channel.subscribe((status) => {
    // after a reconnect, catch up on anything missed while asleep / offline
    if (status === 'SUBSCRIBED' && S.loaded) refreshAllQuietly();
  });
}
let lastRefresh = 0;
async function refreshAllQuietly() {
  if (!S.parent || now() - lastRefresh < 5000) return;
  lastRefresh = now();
  try { await loadAll(); renderSoon(); } catch { setSync('offline'); }
  flushSoon();
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshAllQuietly(); tick(); } });

/* ================= feeding model ================= */
const feeds = () => S.rows.wb_feedings;
const activeFeed = () => feeds().find((f) => !f.ended_at && (f.segments || []).length) || null;
const segs = (f) => f.segments || [];
const openSeg = (f) => segs(f).find((s) => !s.end) || null;
function sideMs(f, side, at = now()) {
  return segs(f).filter((s) => s.side === side).reduce((n, s) => n + Math.max(0, (s.end ? ms(s.end) : at) - ms(s.start)), 0);
}
const feedMs = (f, at = now()) => sideMs(f, 'L', at) + sideMs(f, 'R', at);
const lastSide = (f) => { const b = segs(f).filter((s) => s.side === 'L' || s.side === 'R'); return b.length ? b[b.length - 1].side : null; };
const firstSide = (f) => { const b = segs(f).filter((s) => s.side === 'L' || s.side === 'R'); return b.length ? b[0].side : null; };
const SIDE = { L: 'Left', R: 'Right' };
function lastFinishedFeed() { return feeds().find((f) => f.ended_at) || null; }
// Start the next feed on the side the last one ENDED on (bottle-only feeds don't count).
const lastBreastFeed = () => feeds().find((x) => x.ended_at && lastSide(x)) || null;
function suggestedSide() {
  const f = lastBreastFeed();
  return f ? lastSide(f) : null;
}
function feedSummary(f) {
  const parts = [];
  const l = sideMs(f, 'L'); const r = sideMs(f, 'R');
  const order = firstSide(f) === 'R' ? [['R', r], ['L', l]] : [['L', l], ['R', r]];
  for (const [s, v] of order) if (v > 0 || segs(f).some((x) => x.side === s)) parts.push(`${s} ${Math.max(1, Math.round(v / 60000))}m`);
  if (f.bottle_ml != null) parts.push(`🍼 ${fmtVol(f.bottle_ml)}`);
  return parts.join(' · ') || '—';
}

function startFeed(side) {
  buzz();
  const t = isoNow();
  save('wb_feedings', { id: uuid(), started_at: t, ended_at: null, segments: [{ side, start: t, end: null }], bottle_ml: null, created_by: S.session.user.id });
  render();
}
function switchSide(side) {
  const f = activeFeed(); if (!f) return startFeed(side);
  const cur = openSeg(f);
  if (cur?.side === side) return;
  buzz();
  const t = isoNow();
  const s2 = segs(f).map((s) => (s.end ? s : { ...s, end: t }));
  s2.push({ side, start: t, end: null });
  save('wb_feedings', { ...f, segments: s2 });
  render();
}
function stopFeed() {
  const f = activeFeed(); if (!f) return;
  buzz();
  const t = isoNow();
  const done = { ...f, ended_at: t, segments: segs(f).map((s) => (s.end ? s : { ...s, end: t })) };
  save('wb_feedings', done);
  render();
  toast(`Saved · ${fmtMin(feedMs(done))}`, false, { label: 'Undo', onClick: () => { save('wb_feedings', { ...f }); render(); } });
}

/* ================= tick (live clocks without re-rendering) ================= */
function tick() {
  for (const el of document.querySelectorAll('[data-since]')) {
    el.textContent = el.dataset.mode === 'clock' ? fmtDur(now() - Number(el.dataset.since), { secs: true }) : fmtAgo(Number(el.dataset.since));
  }
  for (const el of document.querySelectorAll('[data-side-ms]')) {
    const f = activeFeed(); if (!f) continue;
    el.textContent = fmtDur(sideMs(f, el.dataset.sideMs), { secs: true });
  }
}
setInterval(tick, 1000);
// the Meds tab's "Due in …" labels move with the clock
setInterval(() => { if (S.parent && !sheetEl && route() === 'meds' && document.visibilityState === 'visible') render(); }, 30000);

/* ================= shell, routing ================= */
const ICONS = {
  feed: '<svg class="ico" viewBox="0 0 24 24"><path d="M9 3h6M10 3v3l-2 3v10a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V9l-2-3V3"/><path d="M8 13h8"/></svg>',
  diaper: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 7h18v3a9 9 0 0 1-18 0z"/><path d="M8 7v2.5M16 7v2.5"/></svg>',
  sleep: '<svg class="ico" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  photos: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  doctor: '<svg class="ico" viewBox="0 0 24 24"><path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v2a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="11" r="2"/></svg>',
  gear: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  moon: '<svg class="ico" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
  sun: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  meds: '<svg class="ico" viewBox="0 0 24 24"><path d="M10.5 20.5l10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7z"/><path d="M8.5 8.5l7 7"/></svg>',
  share: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/></svg>',
  addhome: '<svg class="ico" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
  compass: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
  key: '<svg class="ico" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  bell: '<svg class="ico" viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  dots: '<svg class="ico" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/></svg>',
  check: '<svg class="ico" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  phone: '<svg class="ico" viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>',
};
const icon = (name) => h('span', { class: 'ico-wrap', 'aria-hidden': 'true', html: ICONS[name] });
const TABS = [['feed', 'Feed'], ['diaper', 'Diapers'], ['sleep', 'Sleep'], ['meds', 'Meds'], ['photos', 'Memories'], ['doctor', 'Doctor']];

function route() {
  const v = location.hash.replace(/^#\/?/, '').split('/')[0];
  return [...TABS.map((t) => t[0]), 'settings'].includes(v) ? v : 'feed';
}
window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });

/* theme: night by default (dim, for 3 AM), day = the household-meals look */
const theme = () => localStorage.getItem('wb-theme') || 'night';
function applyTheme() {
  const t = theme();
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'night' ? '#0B1525' : '#4BA3E3');
}
applyTheme();

function topbar(title, sub) {
  const t = theme();
  return h('header', { class: 'topbar' },
    h('div', { class: 'row spread' },
      h('div', { class: 'grow' }, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null),
      h('div', { class: 'row tight' },
        h('button', { class: 'icon', 'aria-label': t === 'night' ? 'Day colors' : 'Night colors', onclick: () => { localStorage.setItem('wb-theme', t === 'night' ? 'day' : 'night'); applyTheme(); render(); } }, icon(t === 'night' ? 'sun' : 'moon')),
        h('a', { class: 'icon', href: '#/settings', 'aria-label': 'Settings' }, icon('gear')))));
}
function tabbar(active) {
  return h('nav', { class: 'tabbar', 'aria-label': 'Main' }, h('div', { class: 'inner' },
    TABS.map(([k, label]) => h('a', { href: `#/${k}`, class: active === k ? 'active' : '', 'aria-current': active === k ? 'page' : null }, icon(k), h('span', null, label)))));
}
function mount(view, { title, sub, main, dock }) {
  appEl.className = 'app' + (dock ? ' has-dock' : '');
  const dockEl = dock ? h('div', { class: 'dock' }, h('div', { class: 'inner' }, dock)) : null;
  appEl.replaceChildren(...[topbar(title, sub), h('main', { class: 'content' }, main), dockEl, tabbar(view)].filter(Boolean)); // (a bare null would render as the text "null")
  // content and toasts clear the dock, whatever its height (one row idle, two rows mid-feed)
  document.documentElement.style.setProperty('--dock-h', `${dockEl ? dockEl.offsetHeight : 0}px`);
  tick();
}

let renderTimer; let renderPending = false;
function renderSoon() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 60); }
function render() {
  const a = document.activeElement;
  if (a && appEl.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { renderPending = true; return; }
  renderPending = false;
  if (!S.session) return renderAuth();
  if (!S.parent) return renderNotParent();
  const v = route();
  ({ feed: renderFeed, diaper: renderDiaper, sleep: renderSleep, meds: renderMeds, photos: renderPhotos, doctor: renderDoctor, settings: renderSettings })[v]();
}
appEl.addEventListener('focusout', () => setTimeout(() => { if (renderPending) render(); }, 0));

/* ================= sheet (bottom modal) ================= */
let sheetEl = null;
function openSheet(title, body, { onClose } = {}) {
  closeSheet();
  const close = () => { closeSheet(); onClose?.(); };
  sheetEl = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === sheetEl) close(); } },
    h('section', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { class: 'icon', 'aria-label': 'Close', onclick: close }, '✕')),
      body));
  document.body.append(sheetEl);
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => sheetEl?.classList.add('show'));
  return close;
}
function closeSheet() {
  if (!sheetEl) return;
  sheetEl.remove(); sheetEl = null;
  document.body.classList.remove('sheet-open');
  if (renderPending) render();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
const field = (label, input, hint) => h('label', null, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
function seg(options, value, onPick) {
  const wrap = h('div', { class: `seg c${options.length}`, role: 'radiogroup' });
  const draw = (v) => wrap.replaceChildren(...options.map(([k, label]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(k === v), class: k === v ? 'on' : '', onclick: () => { draw(k); onPick(k); } }, label)));
  draw(value);
  return wrap;
}
function confirmDelete(btn, what, onYes) {
  if (btn.dataset.armed) return onYes();
  btn.dataset.armed = '1'; btn.textContent = `Tap again to delete ${what}`;
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = `Delete ${what}`; } }, 3500);
}

/* ================= auth ================= */
function renderAuth(notice) {
  const msg = h('div', { class: notice ? `msg ${notice.type}` : 'hidden' }, notice?.text || '');
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, placeholder: 'you@example.com', inputmode: 'email' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { type: 'submit', class: 'block big' }, 'Sign in');
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true;
    try {
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
      if (error) { msg.className = 'msg error'; msg.textContent = friendlyError(error); }
    } catch (err) { msg.className = 'msg error'; msg.textContent = friendlyError(err); } finally { btn.disabled = false; }
  } },
  msg, field('Email', email), field('Password', pw), btn,
  h('p', { class: 'small muted center' }, 'Same email and password as the Meals app.'));
  const help = isStandalone() ? null : h('button', { type: 'button', class: 'ghost', onclick: () => installGuide() }, icon('phone'), 'How to put it on your phone');
  appEl.className = 'app';
  appEl.replaceChildren(h('main', { class: 'auth' },
    h('div', { class: 'hero' }, h('img', { src: 'icon.svg?v=wb1', alt: '' }), h('h1', null, 'Westley’s Book'), h('p', null, 'Feeds, naps, diapers and little moments, together.')),
    form, help));
}
function renderNotParent() {
  appEl.className = 'app';
  appEl.replaceChildren(h('main', { class: 'auth' },
    h('div', { class: 'hero' }, h('img', { src: 'icon.svg?v=wb1', alt: '' }), h('h1', null, 'Westley’s Book')),
    h('div', { class: 'card stack' },
      h('p', null, 'Signed in as ', h('strong', null, S.session.user.email), '.'),
      h('p', { class: 'muted' }, 'This book is private to Jacob and Sophie, so this account can’t open it.'),
      h('button', { class: 'secondary block', onclick: () => sb.auth.signOut() }, 'Sign out'))));
}

/* ================= Feed (home) ================= */
const isToday = (ts) => ms(ts) >= startOfToday();
function stat(label, value) { return h('div', { class: 'stat' }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label)); }
let showEarlierFeeds = false;

function renderFeed() {
  const f = activeFeed();
  const last = feeds().find((x) => x.ended_at) || null;
  const next = suggestedSide();
  const name = babyName();
  let hero;
  if (f) {
    const cur = openSeg(f);
    hero = h('section', { class: 'hero-card live' },
      h('div', { class: 'eyebrow' }, h('span', { class: 'pulse' }), `${name} is eating · ${SIDE[cur?.side] || ''}`),
      h('div', { class: 'big', 'data-since': ms(f.started_at), 'data-mode': 'clock' }, fmtDur(now() - ms(f.started_at), { secs: true })),
      h('div', { class: 'sides' },
        ['L', 'R'].map((s) => h('div', { class: 'side' + (cur?.side === s ? ' on' : '') }, h('span', null, SIDE[s]), h('strong', { 'data-side-ms': s }, fmtDur(sideMs(f, s), { secs: true }))))),
      f.bottle_ml != null ? h('p', { class: 'sub' }, `+ bottle ${fmtVol(f.bottle_ml)}`) : null);
  } else if (last) {
    const ls = next;
    hero = h('section', { class: 'hero-card' },
      h('div', { class: 'eyebrow' }, `${name} last ate`),
      h('div', { class: 'big', 'data-since': ms(last.started_at) }, fmtAgo(last.started_at)),
      h('p', { class: 'sub' }, `${fmtTime(last.started_at)} · ${feedSummary(last)}`),
      h('div', { class: 'chips' },
        ls ? h('span', { class: 'chip side-chip' }, `Ended on: ${ls}`) : null,
        next ? h('span', { class: 'chip next-chip' }, `Start on: ${SIDE[next]}`) : null));
  } else {
    hero = h('section', { class: 'hero-card' },
      h('div', { class: 'eyebrow' }, `Hi, ${name} 💙`),
      h('div', { class: 'big small-big' }, 'No feeds yet'),
      h('p', { class: 'sub' }, 'Tap a side below to start the timer.'));
  }

  const today = feeds().filter((x) => isToday(x.started_at));
  const l = today.reduce((n, x) => n + sideMs(x, 'L'), 0);
  const r = today.reduce((n, x) => n + sideMs(x, 'R'), 0);
  const bottle = today.reduce((n, x) => n + (+x.bottle_ml || 0), 0);
  const totals = h('section', { class: 'card today' },
    h('div', { class: 'stats' },
      stat('feeds', today.length),
      stat('minutes', Math.round((l + r) / 60000)),
      stat('left / right', `${Math.round(l / 60000)} / ${Math.round(r / 60000)}`),
      stat('bottle', bottle ? fmtVol(bottle) : '—')));

  const rows = (list) => list.map((x) => h('button', { class: 'logrow', onclick: () => feedSheet(x) },
    h('span', { class: 'when' }, fmtTime(x.started_at)),
    h('span', { class: 'what' }, feedSummary(x)),
    h('span', { class: 'dur' }, x.ended_at ? (feedMs(x) ? fmtMin(feedMs(x)) : '') : 'now')));
  const earlier = feeds().filter((x) => !isToday(x.started_at) && ms(x.started_at) > now() - 7 * 86400000);
  const byDay = groupBy(earlier, (x) => fmtDayLabel(x.started_at));
  const list = h('section', { class: 'card list' },
    h('div', { class: 'list-head' }, h('h2', null, 'Today'), h('button', { class: 'ghost', onclick: () => feedSheet(null) }, '+ Add past feed')),
    today.length ? rows(today) : h('p', { class: 'muted empty' }, 'Nothing yet today.'),
    earlier.length ? (showEarlierFeeds
      ? [...byDay].map(([day, xs]) => [h('h3', { class: 'day-head' }, day, h('span', { class: 'muted' }, ` · ${xs.length} feeds`)), rows(xs)])
      : h('button', { class: 'ghost block', onclick: () => { showEarlierFeeds = true; render(); } }, 'Show earlier days')) : null);

  let dock;
  if (f) {
    const cur = openSeg(f)?.side;
    dock = [
      h('div', { class: 'dock-row three' },
        ['L', 'R'].map((s) => h('button', { class: 'side-btn' + (cur === s ? ' on' : ''), onclick: () => switchSide(s), 'aria-pressed': String(cur === s) },
          h('span', { class: 'letter' }, s), h('span', { class: 'lbl' }, cur === s ? 'Feeding' : 'Switch'))),
        h('button', { class: 'side-btn bottle', onclick: () => bottleSheet(f) }, h('span', { class: 'letter' }, '🍼'), h('span', { class: 'lbl' }, '+ Bottle'))),
      h('button', { class: 'stop-btn', onclick: stopFeed }, 'Stop feeding')];
  } else {
    dock = h('div', { class: 'dock-row three' },
      ['L', 'R'].map((s) => h('button', { class: 'side-btn start' + (next === s ? ' suggest' : ''), onclick: () => startFeed(s) },
        h('span', { class: 'letter' }, s), h('span', { class: 'lbl' }, next === s ? `Start ${SIDE[s]}` : SIDE[s]))),
      h('button', { class: 'side-btn bottle', onclick: () => bottleSheet(null) }, h('span', { class: 'letter' }, '🍼'), h('span', { class: 'lbl' }, 'Bottle')));
  }
  mount('feed', { title: 'Feeding', sub: ageText(S.family.birth_date) || `${name}’s Book`, main: [hero, totals, list], dock });
}
function groupBy(list, key) { const m = new Map(); for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }

function amountPicker(initialMl) {
  const unit = volUnit();
  const presets = unit === 'oz' ? [1, 2, 3, 4, 5] : [30, 60, 90, 120, 150];
  const input = h('input', { type: 'number', inputmode: 'decimal', step: unit === 'oz' ? '0.5' : '5', min: '0', placeholder: unit, value: initialMl != null ? fromMl(initialMl) : '' });
  const chips = h('div', { class: 'chip-row' }, presets.map((p) => h('button', { type: 'button', class: 'pick', onclick: () => { input.value = p; buzz(); } }, `${p} ${unit === 'oz' ? 'oz' : 'mL'}`)));
  return { el: h('div', { class: 'stack tight' }, chips, field(`Amount (${unit === 'oz' ? 'oz' : 'mL'})`, input)), value: () => num(input.value) };
}
function bottleSheet(active) {
  const amt = amountPicker(active?.bottle_ml ?? null);
  let kind = active?.bottle_kind || localStorage.getItem('wb-bottle-kind') || 'breastmilk';
  const when = h('input', { type: 'datetime-local', value: toLocalInput(now()) });
  const save1 = h('button', { class: 'block big', onclick: () => {
    const v = amt.value();
    if (v == null || Number.isNaN(v) || v <= 0) return toast('Enter how much he drank.', true);
    localStorage.setItem('wb-bottle-kind', kind);
    if (active) {
      save('wb_feedings', { ...active, bottle_ml: Math.round(toMl(v) * 10) / 10, bottle_kind: kind });
    } else {
      const t = fromLocalInput(when.value) || isoNow();
      save('wb_feedings', { id: uuid(), started_at: t, ended_at: t, segments: [], bottle_ml: Math.round(toMl(v) * 10) / 10, bottle_kind: kind, created_by: S.session.user.id });
    }
    buzz(); closeSheet(); render(); toast(`Bottle saved · ${fmtVol(toMl(v))}`);
  } }, active ? 'Add to this feed' : 'Save bottle');
  openSheet(active ? 'Add a bottle' : 'Bottle', h('div', { class: 'stack' },
    amt.el,
    seg([['breastmilk', 'Breast milk'], ['formula', 'Formula']], kind, (k) => { kind = k; }),
    active ? null : field('When', when),
    save1));
}

// edit an existing feed or add a forgotten one
function feedSheet(f) {
  const isNew = !f;
  const base = f || { id: uuid(), started_at: new Date(now() - 30 * 60000).toISOString(), ended_at: null, segments: [], bottle_ml: null };
  const live = !isNew && !base.ended_at;
  const start = h('input', { type: 'datetime-local', value: toLocalInput(base.started_at) });
  const minL = h('input', { type: 'number', inputmode: 'numeric', min: '0', max: '180', placeholder: '0', value: isNew ? '' : Math.round(sideMs(base, 'L') / 60000) || '' });
  const minR = h('input', { type: 'number', inputmode: 'numeric', min: '0', max: '180', placeholder: '0', value: isNew ? '' : Math.round(sideMs(base, 'R') / 60000) || '' });
  const amt = amountPicker(base.bottle_ml);
  const note = h('input', { type: 'text', maxlength: '1000', placeholder: 'Optional', value: base.note || '' });
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete feed');
  del.addEventListener('click', () => confirmDelete(del, 'feed', () => {
    remove('wb_feedings', base.id); closeSheet(); render();
    toast('Feed deleted', false, { label: 'Undo', onClick: () => { save('wb_feedings', base); render(); } });
  }));
  const saveBtn = h('button', { class: 'block big', onclick: () => {
    const st = fromLocalInput(start.value);
    const l = num(minL.value) || 0; const r = num(minR.value) || 0; const b = amt.value();
    if (!st) return toast('Pick a start time.', true);
    if ([l, r].some((x) => Number.isNaN(x) || x < 0 || x > 300) || Number.isNaN(b)) return toast('Check the numbers.', true);
    if (!live && !l && !r && !b) return toast('Add minutes or a bottle amount.', true);
    const row = { ...base, started_at: st, note: note.value.trim() || null, bottle_ml: b ? Math.round(toMl(b) * 10) / 10 : null };
    if (!live) {
      const changed = isNew || Math.round(sideMs(base, 'L') / 60000) !== l || Math.round(sideMs(base, 'R') / 60000) !== r || base.started_at !== st;
      if (changed) {
        const order = firstSide(base) === 'R' ? [['R', r], ['L', l]] : [['L', l], ['R', r]];
        let t = ms(st); const s2 = [];
        for (const [side, m] of order) if (m > 0) { s2.push({ side, start: new Date(t).toISOString(), end: new Date(t + m * 60000).toISOString() }); t += m * 60000; }
        row.segments = s2; row.ended_at = new Date(t).toISOString();
      }
    } else {
      // running feed: only the start time can move (the timer keeps going)
      const shift = ms(st) - ms(base.started_at);
      if (shift) row.segments = segs(base).map((s, i) => (i === 0 ? { ...s, start: new Date(ms(s.start) + shift).toISOString() } : s));
      if (shift && ms(row.segments[0].start) > (row.segments[0].end ? ms(row.segments[0].end) : now())) return toast('Start time is too late.', true);
    }
    if (isNew) row.created_by = S.session.user.id;
    save('wb_feedings', row); closeSheet(); render(); toast(isNew ? 'Feed added' : 'Feed updated');
  } }, isNew ? 'Add feed' : 'Save');
  openSheet(isNew ? 'Add a past feed' : 'Edit feed', h('div', { class: 'stack' },
    field('Started', start),
    live ? h('p', { class: 'small muted' }, 'This feed is still running. Stop it first to change the minutes.')
      : h('div', { class: 'grid2' }, field('Left (min)', minL), field('Right (min)', minR)),
    h('details', { class: 'more', open: base.bottle_ml != null ? true : null }, h('summary', null, 'Bottle'), amt.el),
    field('Note', note),
    saveBtn, isNew ? null : del));
}

/* ================= Diapers ================= */
const DIAPER = { wet: ['💧', 'Wet'], dirty: ['💩', 'Dirty'], both: ['💧💩', 'Both'], dry: ['○', 'Dry'] };
function logDiaper(kind) {
  buzz();
  const row = { id: uuid(), at: isoNow(), kind, created_by: S.session.user.id };
  save('wb_diapers', row); render();
  toast(`${DIAPER[kind][1]} diaper logged`, false, { label: 'Undo', onClick: () => { remove('wb_diapers', row.id); render(); } });
}
function renderDiaper() {
  const all = S.rows.wb_diapers;
  const last = all[0];
  const today = all.filter((d) => isToday(d.at));
  const wet = today.filter((d) => d.kind === 'wet' || d.kind === 'both').length;
  const dirty = today.filter((d) => d.kind === 'dirty' || d.kind === 'both').length;
  const hero = h('section', { class: 'hero-card' },
    h('div', { class: 'eyebrow' }, 'Last diaper'),
    last ? h('div', { class: 'big', 'data-since': ms(last.at) }, fmtAgo(last.at)) : h('div', { class: 'big small-big' }, 'None yet'),
    last ? h('p', { class: 'sub' }, `${DIAPER[last.kind][1]} · ${fmtTime(last.at)}`) : h('p', { class: 'sub' }, 'One tap below logs a change.'));
  const totals = h('section', { class: 'card today' }, h('div', { class: 'stats three' }, stat('changes today', today.length), stat('wet', wet), stat('dirty', dirty)));
  const rows = (xs) => xs.map((d) => h('button', { class: 'logrow', onclick: () => diaperSheet(d) },
    h('span', { class: 'when' }, fmtTime(d.at)), h('span', { class: 'what' }, `${DIAPER[d.kind][0]}  ${DIAPER[d.kind][1]}`), h('span', { class: 'dur' }, d.note ? '✎' : '')));
  const earlier = all.filter((d) => !isToday(d.at) && ms(d.at) > now() - 3 * 86400000);
  const list = h('section', { class: 'card list' },
    h('div', { class: 'list-head' }, h('h2', null, 'Today'), h('button', { class: 'ghost', onclick: () => diaperSheet(null) }, '+ Add earlier')),
    today.length ? rows(today) : h('p', { class: 'muted empty' }, 'No changes yet today.'),
    [...groupBy(earlier, (d) => fmtDayLabel(d.at))].map(([day, xs]) => [h('h3', { class: 'day-head' }, day, h('span', { class: 'muted' }, ` · ${xs.length}`)), rows(xs)]));
  const dock = h('div', { class: 'dock-row three' },
    ['wet', 'dirty', 'both'].map((k) => h('button', { class: `side-btn diaper ${k}`, onclick: () => logDiaper(k) }, h('span', { class: 'letter emoji' }, DIAPER[k][0]), h('span', { class: 'lbl' }, DIAPER[k][1]))));
  mount('diaper', { title: 'Diapers', sub: ageText(S.family.birth_date) || `${babyName()}’s Book`, main: [hero, totals, list], dock });
}
function diaperSheet(d) {
  const isNew = !d;
  const base = d || { id: uuid(), at: isoNow(), kind: 'wet' };
  let kind = base.kind;
  const at = h('input', { type: 'datetime-local', value: toLocalInput(base.at) });
  const note = h('input', { type: 'text', maxlength: '1000', placeholder: 'Optional (color, rash…)', value: base.note || '' });
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete change');
  del.addEventListener('click', () => confirmDelete(del, 'change', () => { remove('wb_diapers', base.id); closeSheet(); render(); toast('Deleted', false, { label: 'Undo', onClick: () => { save('wb_diapers', base); render(); } }); }));
  openSheet(isNew ? 'Add a diaper' : 'Edit diaper', h('div', { class: 'stack' },
    seg(Object.entries(DIAPER).map(([k, [e, l]]) => [k, `${e} ${l}`]), kind, (k) => { kind = k; }),
    field('When', at), field('Note', note),
    h('button', { class: 'block big', onclick: () => {
      const t = fromLocalInput(at.value); if (!t) return toast('Pick a time.', true);
      save('wb_diapers', { ...base, at: t, kind, note: note.value.trim() || null, ...(isNew ? { created_by: S.session.user.id } : {}) });
      closeSheet(); render(); toast(isNew ? 'Added' : 'Updated');
    } }, isNew ? 'Add' : 'Save'),
    isNew ? null : del));
}

/* ================= Sleep ================= */
const sleeps = () => S.rows.wb_sleeps;
const activeSleep = () => sleeps().find((s) => !s.ended_at) || null;
const sleepMs = (s, at = now()) => Math.max(0, (s.ended_at ? ms(s.ended_at) : at) - ms(s.started_at));
// minutes of sleep that fall inside today (a nap across midnight only counts its part)
function sleepToday(s) { const a = Math.max(ms(s.started_at), startOfToday()); const b = s.ended_at ? ms(s.ended_at) : now(); return Math.max(0, b - a); }
function toggleSleep() {
  buzz();
  const a = activeSleep();
  if (a) {
    const done = { ...a, ended_at: isoNow() };
    save('wb_sleeps', done); render();
    toast(`Slept ${fmtDur(sleepMs(done))}`, false, { label: 'Undo', onClick: () => { save('wb_sleeps', a); render(); } });
  } else {
    save('wb_sleeps', { id: uuid(), started_at: isoNow(), ended_at: null, created_by: S.session.user.id }); render();
  }
}
function renderSleep() {
  const a = activeSleep();
  const last = sleeps().find((s) => s.ended_at);
  const name = babyName();
  const hero = a
    ? h('section', { class: 'hero-card live sleep' },
      h('div', { class: 'eyebrow' }, h('span', { class: 'pulse' }), `${name} is sleeping`),
      h('div', { class: 'big', 'data-since': ms(a.started_at), 'data-mode': 'clock' }, fmtDur(sleepMs(a), { secs: true })),
      h('p', { class: 'sub' }, `Since ${fmtTime(a.started_at)}`))
    : h('section', { class: 'hero-card' },
      h('div', { class: 'eyebrow' }, last ? `${name} has been awake` : 'Sleep'),
      last ? h('div', { class: 'big', 'data-since': ms(last.ended_at) }, fmtAgo(last.ended_at)) : h('div', { class: 'big small-big' }, 'No naps yet'),
      h('p', { class: 'sub' }, last ? `Last sleep ${fmtDur(sleepMs(last))} · woke ${fmtTime(last.ended_at)}` : 'Tap below when he falls asleep.'));
  const today = sleeps().filter((s) => sleepToday(s) > 0);
  const total = today.reduce((n, s) => n + sleepToday(s), 0);
  const longest = today.reduce((m, s) => Math.max(m, sleepMs(s)), 0);
  const totals = h('section', { class: 'card today' }, h('div', { class: 'stats three' }, stat('asleep today', fmtDur(total)), stat('sleeps', today.length), stat('longest', longest ? fmtDur(longest) : '—')));
  const rows = (xs) => xs.map((s) => h('button', { class: 'logrow', onclick: () => sleepSheet(s) },
    h('span', { class: 'when' }, fmtTime(s.started_at)), h('span', { class: 'what' }, s.ended_at ? `to ${fmtTime(s.ended_at)}` : 'sleeping…'), h('span', { class: 'dur' }, fmtDur(sleepMs(s)))));
  const earlier = sleeps().filter((s) => sleepToday(s) === 0 && ms(s.started_at) > now() - 3 * 86400000);
  const list = h('section', { class: 'card list' },
    h('div', { class: 'list-head' }, h('h2', null, 'Today'), h('button', { class: 'ghost', onclick: () => sleepSheet(null) }, '+ Add earlier')),
    today.length ? rows(today) : h('p', { class: 'muted empty' }, 'No sleep logged today.'),
    [...groupBy(earlier, (s) => fmtDayLabel(s.started_at))].map(([day, xs]) => [h('h3', { class: 'day-head' }, day), rows(xs)]));
  const dock = h('button', { class: 'stop-btn' + (a ? '' : ' go'), onclick: toggleSleep }, a ? `☀️  ${name} woke up` : '🌙  Start sleep');
  mount('sleep', { title: 'Sleep', sub: ageText(S.family.birth_date) || `${name}’s Book`, main: [hero, totals, list], dock });
}
function sleepSheet(s) {
  const isNew = !s;
  const base = s || { id: uuid(), started_at: new Date(now() - 60 * 60000).toISOString(), ended_at: isoNow() };
  const st = h('input', { type: 'datetime-local', value: toLocalInput(base.started_at) });
  const en = h('input', { type: 'datetime-local', value: base.ended_at ? toLocalInput(base.ended_at) : '' });
  const note = h('input', { type: 'text', maxlength: '1000', placeholder: 'Optional', value: base.note || '' });
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete sleep');
  del.addEventListener('click', () => confirmDelete(del, 'sleep', () => { remove('wb_sleeps', base.id); closeSheet(); render(); toast('Deleted', false, { label: 'Undo', onClick: () => { save('wb_sleeps', base); render(); } }); }));
  openSheet(isNew ? 'Add a sleep' : 'Edit sleep', h('div', { class: 'stack' },
    field('Fell asleep', st), field('Woke up', en, base.ended_at ? null : 'Leave empty if he’s still asleep.'), field('Note', note),
    h('button', { class: 'block big', onclick: () => {
      const a = fromLocalInput(st.value); const b = fromLocalInput(en.value);
      if (!a) return toast('Pick when he fell asleep.', true);
      if (b && ms(b) < ms(a)) return toast('Woke up is before fell asleep.', true);
      if (!b && activeSleep() && activeSleep().id !== base.id) return toast('Another sleep is already running.', true);
      save('wb_sleeps', { ...base, started_at: a, ended_at: b, note: note.value.trim() || null, ...(isNew ? { created_by: S.session.user.id } : {}) });
      closeSheet(); render(); toast(isNew ? 'Added' : 'Updated');
    } }, isNew ? 'Add' : 'Save'),
    isNew ? null : del));
}

/* ================= Memories ================= */
async function decodeImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* older Safari: fall back below */ }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function downscaleToJpeg(file, max = 2048, quality = 0.85) {
  const src = await decodeImage(file);
  const w0 = src.width || src.naturalWidth; const h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new Error('That photo couldn’t be read. Try another one.');
  const k = Math.min(1, max / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)); const hh = Math.max(1, Math.round(h0 * k));
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, w, hh); ctx.drawImage(src, 0, 0, w, hh);
  src.close?.();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('That photo couldn’t be read. Try another one.'))), 'image/jpeg', quality));
}
const signedCache = new Map(); // path -> { url, until }
async function photoUrl(path) {
  const hit = signedCache.get(path);
  if (hit && hit.until > now()) return hit.url;
  const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) return null;
  signedCache.set(path, { url: data.signedUrl, until: now() + 50 * 60000 });
  return data.signedUrl;
}
function photoImg(path, cls = 'memory-photo') {
  const img = h('img', { class: cls, alt: 'Memory photo', loading: 'lazy', decoding: 'async' });
  photoUrl(path).then((u) => { if (u) img.src = u; else img.replaceWith(h('div', { class: `${cls} missing` }, 'Photo unavailable offline')); });
  return img;
}
function pickPhoto(onFile) {
  const input = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  input.addEventListener('change', () => { const f = input.files?.[0]; input.remove(); if (f) onFile(f); });
  document.body.append(input); input.click();
}
function renderPhotos() {
  const mems = S.rows.wb_memories;
  const byMonth = groupBy(mems, (m) => fmtDate(m.happened_on, { month: 'long', year: 'numeric' }));
  const main = mems.length
    ? [...byMonth].map(([month, xs]) => h('section', { class: 'timeline' }, h('h2', { class: 'month' }, month),
      xs.map((m) => h('article', { class: 'memory', onclick: () => memorySheet(m, null) },
        m.photo_path ? photoImg(m.photo_path) : null,
        h('div', { class: 'memory-body' },
          h('div', { class: 'memory-date' }, fmtDate(m.happened_on, { weekday: 'short', month: 'short', day: 'numeric' }), ageAt(m.happened_on) ? h('span', { class: 'chip' }, ageAt(m.happened_on)) : null),
          m.caption ? h('p', { class: 'caption' }, m.caption) : null)))))
    : [h('section', { class: 'hero-card' }, h('div', { class: 'eyebrow' }, 'Memories'), h('div', { class: 'big small-big' }, `${babyName()}’s first moments`), h('p', { class: 'sub' }, 'Add a photo or a little note. Only you two can see them.'))];
  const dock = h('div', { class: 'dock-row two' },
    h('button', { class: 'side-btn start suggest', onclick: () => pickPhoto((file) => memorySheet(null, file)) }, h('span', { class: 'letter emoji' }, '📷'), h('span', { class: 'lbl' }, 'Add photo')),
    h('button', { class: 'side-btn', onclick: () => memorySheet(null, null) }, h('span', { class: 'letter emoji' }, '✎'), h('span', { class: 'lbl' }, 'Write a note')));
  mount('photos', { title: 'Memories', sub: ageText(S.family.birth_date) || `${babyName()}’s Book`, main, dock });
}
function memorySheet(m, file) {
  const isNew = !m;
  const base = m || { id: uuid(), happened_on: localDay(), caption: null, photo_path: null };
  let previewUrl = null;
  const preview = file ? h('img', { class: 'memory-photo', alt: '' }) : base.photo_path ? photoImg(base.photo_path) : null;
  if (file) { previewUrl = URL.createObjectURL(file); preview.src = previewUrl; }
  const date = h('input', { type: 'date', value: base.happened_on, max: localDay() });
  const cap = h('textarea', { maxlength: '2000', rows: '3', placeholder: isNew ? 'First smile, first bath, tiny yawns…' : '' }, base.caption || '');
  const status = h('p', { class: 'small muted hidden' });
  const btn = h('button', { class: 'block big' }, isNew ? 'Save memory' : 'Save');
  const cleanup = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); };
  btn.addEventListener('click', async () => {
    const caption = cap.value.trim() || null;
    if (!file && !base.photo_path && !caption) return toast('Write a few words or add a photo.', true);
    btn.disabled = true;
    try {
      let photo_path = base.photo_path;
      if (file) {
        status.className = 'small muted'; status.textContent = 'Preparing photo…';
        const blob = await downscaleToJpeg(file);
        photo_path = `${uuid()}.jpg`;
        status.textContent = 'Uploading…';
        const up = await sb.storage.from(PHOTO_BUCKET).upload(photo_path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '3600' });
        if (up.error) throw up.error;
      }
      save('wb_memories', { ...base, happened_on: date.value || localDay(), caption, photo_path, ...(isNew ? { created_by: S.session.user.id } : {}) });
      cleanup(); closeSheet(); render(); toast(isNew ? 'Memory saved 💙' : 'Saved');
    } catch (err) {
      status.className = 'msg error'; status.textContent = isNetworkError(err) ? 'Photos need a connection. Try again in a moment.' : friendlyError(err);
      btn.disabled = false;
    }
  });
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete memory');
  del.addEventListener('click', () => confirmDelete(del, 'memory', async () => {
    remove('wb_memories', base.id);
    if (base.photo_path) sb.storage.from(PHOTO_BUCKET).remove([base.photo_path]).catch(() => {});
    closeSheet(); render(); toast('Memory deleted');
  }));
  openSheet(isNew ? 'New memory' : 'Memory', h('div', { class: 'stack' },
    preview ? h('div', { class: 'preview' }, preview) : null,
    !isNew && base.photo_path ? h('button', { type: 'button', class: 'ghost', onclick: async () => { const u = await photoUrl(base.photo_path); if (u) window.open(u, '_blank', 'noopener'); } }, 'Open full size ↗') : null,
    field('Caption', cap), field('Date', date), status, btn, isNew ? null : del), { onClose: cleanup });
}

/* ================= Doctor ================= */
const DOC_TABS = [['questions', 'Questions'], ['growth', 'Growth'], ['shots', 'Shots'], ['visits', 'Visits']];
function renderDoctor() {
  const tab = DOC_TABS.some((t) => t[0] === S.doctorTab) ? S.doctorTab : 'questions';
  const tabs = h('div', { class: 'seg c4 doc-tabs' },
    DOC_TABS.map(([k, l]) => h('button', { class: k === tab ? 'on' : '', onclick: () => { S.doctorTab = k; sessionStorage.setItem('wb-doctor-tab', k); render(); } }, l)));
  const body = { questions: doctorQuestions, growth: doctorGrowth, shots: doctorShots, visits: doctorVisits }[tab]();
  const addLabel = { questions: '+ Add a question', growth: '+ Add measurement', shots: '+ Add a shot', visits: '+ Add a visit' }[tab];
  const onAdd = { questions: () => questionSheet(null), growth: () => growthSheet(null), shots: () => shotSheet(null), visits: () => visitSheet(null) }[tab];
  mount('doctor', { title: 'Doctor', sub: ageText(S.family.birth_date) || `${babyName()}’s Book`, main: [tabs, ...body], dock: h('button', { class: 'stop-btn go', onclick: onAdd }, addLabel) });
}

function doctorQuestions() {
  const qs = S.rows.wb_questions;
  const open = qs.filter((q) => !q.done); const done = qs.filter((q) => q.done).sort((a, b) => cmp(b.updated_at || '', a.updated_at || ''));
  const row = (q) => h('div', { class: 'qrow' + (q.done ? ' done' : '') },
    h('button', { class: 'check', 'aria-label': q.done ? 'Mark not asked' : 'Mark asked', 'aria-pressed': String(q.done), onclick: () => { buzz(); save('wb_questions', { ...q, done: !q.done, updated_at: isoNow() }); render(); } }, q.done ? '✓' : ''),
    h('button', { class: 'qtext', onclick: () => questionSheet(q) }, q.question, q.answer ? h('span', { class: 'answer' }, q.answer) : null));
  return [
    h('section', { class: 'card list' }, h('div', { class: 'list-head' }, h('h2', null, 'For the next visit'), h('span', { class: 'chip' }, open.length)),
      open.length ? open.map(row) : h('p', { class: 'muted empty' }, 'Jot questions down as they come up, then check them off at the visit.')),
    done.length ? h('details', { class: 'card list more' }, h('summary', null, `Asked (${done.length})`), done.map(row)) : null];
}
function questionSheet(q) {
  const isNew = !q;
  const base = q || { id: uuid(), question: '', done: false };
  const text = h('textarea', { rows: '2', maxlength: '1000', placeholder: 'Is it normal that…' }, base.question);
  const ans = h('textarea', { rows: '3', maxlength: '4000', placeholder: 'What the doctor said' }, base.answer || '');
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete question');
  del.addEventListener('click', () => confirmDelete(del, 'question', () => { remove('wb_questions', base.id); closeSheet(); render(); }));
  openSheet(isNew ? 'New question' : 'Question', h('div', { class: 'stack' },
    field('Question', text), isNew ? null : field('Answer', ans),
    h('button', { class: 'block big', onclick: () => {
      const t = text.value.trim(); if (!t) return toast('Type the question.', true);
      save('wb_questions', { ...base, question: t, answer: isNew ? null : (ans.value.trim() || null), ...(isNew ? { created_by: S.session.user.id, created_at: isoNow() } : {}) });
      closeSheet(); render();
    } }, isNew ? 'Add question' : 'Save'),
    isNew ? null : del));
  setTimeout(() => text.focus(), 50);
}

function lineChart(points, fmtY) {
  const W = 320; const H = 120; const P = { l: 8, r: 8, t: 14, b: 18 };
  if (points.length < 2) return h('p', { class: 'small muted' }, points.length ? 'Add one more to see the line.' : 'No entries yet.');
  const xs = points.map((p) => p.x); const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs); let y0 = Math.min(...ys); let y1 = Math.max(...ys);
  const pad = (y1 - y0) * 0.15 || 1; y0 -= pad; y1 += pad;
  const X = (x) => P.l + ((x - x0) / (x1 - x0 || 1)) * (W - P.l - P.r);
  const Y = (y) => H - P.b - ((y - y0) / (y1 - y0)) * (H - P.t - P.b);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `From ${fmtY(ys[0])} to ${fmtY(ys[ys.length - 1])}` });
  for (let i = 0; i < 3; i++) { const y = P.t + (i * (H - P.t - P.b)) / 2; svg.append(el('line', { x1: P.l, x2: W - P.r, y1: y, y2: y, class: 'grid' })); }
  svg.append(el('polyline', { points: points.map((p) => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' '), class: 'line' }));
  for (const p of points) svg.append(el('circle', { cx: X(p.x).toFixed(1), cy: Y(p.y).toFixed(1), r: 4, class: 'dot' }));
  const lab = (x, y, text, anchor) => { const t = el('text', { x, y, 'text-anchor': anchor, class: 'lab' }); t.textContent = text; svg.append(t); };
  const d = (x) => new Date(x).toLocaleDateString([], { month: 'short', day: 'numeric' });
  lab(P.l, H - 3, d(x0), 'start'); lab(W - P.r, H - 3, d(x1), 'end');
  return svg;
}
function doctorGrowth() {
  const g = [...S.rows.wb_growth].sort((a, b) => cmp(a.measured_on, b.measured_on));
  const series = (k) => g.filter((x) => x[k] != null).map((x) => ({ x: parseDate(x.measured_on).getTime(), y: +x[k], d: x.measured_on }));
  const card = (title, k, fmt, diffFmt) => {
    const s = series(k); const last = s[s.length - 1]; const prev = s[s.length - 2];
    const diff = last && prev ? last.y - prev.y : null;
    return h('section', { class: 'card growth' },
      h('div', { class: 'list-head' }, h('h2', null, title), last ? h('strong', { class: 'gval' }, fmt(last.y)) : null),
      diff != null ? h('p', { class: 'small muted' }, `${diff >= 0 ? '+' : '−'}${diffFmt(Math.abs(diff))} since ${fmtDate(prev.d, { month: 'short', day: 'numeric' })}`) : null,
      lineChart(s, fmt));
  };
  const wDiff = (gr) => (imperial() ? `${+(gr / 28.3495).toFixed(1)} oz` : `${Math.round(gr)} g`);
  const lDiff = (cm) => (imperial() ? `${+(cm / 2.54).toFixed(2)} in` : `${+cm.toFixed(1)} cm`);
  const list = g.length ? h('section', { class: 'card list' }, h('div', { class: 'list-head' }, h('h2', null, 'All measurements')),
    [...g].reverse().map((x) => h('button', { class: 'logrow', onclick: () => growthSheet(x) },
      h('span', { class: 'when' }, fmtDate(x.measured_on, { month: 'short', day: 'numeric' })),
      h('span', { class: 'what' }, [x.weight_g != null ? fmtWeight(+x.weight_g) : null, x.length_cm != null ? fmtLen(+x.length_cm) : null, x.head_cm != null ? `head ${fmtLen(+x.head_cm)}` : null].filter(Boolean).join(' · ')),
      h('span', { class: 'dur' }, '›')))) : null;
  return [card('Weight', 'weight_g', (v) => fmtWeight(v), wDiff), card('Length', 'length_cm', fmtLen, lDiff), card('Head', 'head_cm', fmtLen, lDiff), list];
}
function growthSheet(x) {
  const isNew = !x;
  const base = x || { id: uuid(), measured_on: localDay() };
  const imp = imperial();
  const date = h('input', { type: 'date', value: base.measured_on, max: localDay() });
  const g = base.weight_g != null ? +base.weight_g : null;
  const lb = h('input', { type: 'number', inputmode: 'numeric', min: '0', max: '60', placeholder: 'lb', value: g != null && imp ? Math.floor(g / 28.3495 / 16) : '' });
  const oz = h('input', { type: 'number', inputmode: 'decimal', min: '0', max: '15.9', step: '0.1', placeholder: 'oz', value: g != null && imp ? +((g / 28.3495) % 16).toFixed(1) : '' });
  const kg = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: 'kg', value: g != null && !imp ? +(g / 1000).toFixed(3) : '' });
  const lenU = imp ? 'in' : 'cm'; const toCm = (v) => (imp ? v * 2.54 : v); const fromCm = (v) => (v == null ? '' : imp ? +(v / 2.54).toFixed(2) : +(+v).toFixed(1));
  const len = h('input', { type: 'number', inputmode: 'decimal', step: '0.25', min: '0', placeholder: lenU, value: fromCm(base.length_cm) });
  const head = h('input', { type: 'number', inputmode: 'decimal', step: '0.25', min: '0', placeholder: lenU, value: fromCm(base.head_cm) });
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete measurement');
  del.addEventListener('click', () => confirmDelete(del, 'measurement', () => { remove('wb_growth', base.id); closeSheet(); render(); }));
  openSheet(isNew ? 'New measurement' : 'Measurement', h('div', { class: 'stack' },
    field('Date', date),
    imp ? h('div', { class: 'grid2' }, field('Weight (lb)', lb), field('+ oz', oz)) : field('Weight (kg)', kg),
    h('div', { class: 'grid2' }, field(`Length (${lenU})`, len), field(`Head (${lenU})`, head)),
    h('button', { class: 'block big', onclick: () => {
      let wg = null;
      if (imp) { const a = num(lb.value); const b = num(oz.value); if (a != null || b != null) wg = ((a || 0) * 16 + (b || 0)) * 28.3495; if (Number.isNaN(a) || Number.isNaN(b)) wg = NaN; } else { const k = num(kg.value); wg = k == null ? null : k * 1000; }
      const l = num(len.value); const hd = num(head.value);
      if ([wg, l, hd].some((v) => Number.isNaN(v))) return toast('Check the numbers.', true);
      if (wg == null && l == null && hd == null) return toast('Add at least one measurement.', true);
      save('wb_growth', { ...base, measured_on: date.value || localDay(), weight_g: wg == null ? null : Math.round(wg * 10) / 10, length_cm: l == null ? null : Math.round(toCm(l) * 10) / 10, head_cm: hd == null ? null : Math.round(toCm(hd) * 10) / 10, ...(isNew ? { created_by: S.session.user.id } : {}) });
      closeSheet(); render();
    } }, isNew ? 'Add' : 'Save'),
    isNew ? null : del));
}

const VACCINES = ['Hepatitis B (HepB)', 'Rotavirus (RV)', 'DTaP', 'Hib', 'Pneumococcal (PCV)', 'Polio (IPV)', 'RSV antibody (nirsevimab)', 'Influenza (flu)', 'COVID-19', 'MMR', 'Varicella (chickenpox)', 'Hepatitis A (HepA)'];
function doctorShots() {
  const v = S.rows.wb_vaccines;
  return [h('section', { class: 'card list' }, h('div', { class: 'list-head' }, h('h2', null, 'Shots given')),
    v.length ? v.map((x) => h('button', { class: 'logrow', onclick: () => shotSheet(x) },
      h('span', { class: 'when' }, fmtDate(x.given_on, { month: 'short', day: 'numeric' })), h('span', { class: 'what' }, x.name, x.dose ? h('span', { class: 'muted' }, ` · ${x.dose}`) : null), h('span', { class: 'dur' }, '›')))
      : h('p', { class: 'muted empty' }, 'Log each shot after the visit so you always have the record handy.'))];
}
function shotSheet(x) {
  const isNew = !x;
  const base = x || { id: uuid(), given_on: localDay() };
  const name = h('input', { type: 'text', list: 'wb-vaccines', maxlength: '160', placeholder: 'e.g. DTaP', value: base.name || '' });
  const list = h('datalist', { id: 'wb-vaccines' }, VACCINES.map((n) => h('option', { value: n })));
  const date = h('input', { type: 'date', value: base.given_on, max: localDay() });
  const dose = h('input', { type: 'text', maxlength: '60', placeholder: 'e.g. Dose 1', value: base.dose || '' });
  const note = h('input', { type: 'text', maxlength: '1000', placeholder: 'Optional (reaction, lot #…)', value: base.note || '' });
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete shot');
  del.addEventListener('click', () => confirmDelete(del, 'shot', () => { remove('wb_vaccines', base.id); closeSheet(); render(); }));
  openSheet(isNew ? 'New shot' : 'Shot', h('div', { class: 'stack' },
    field('Vaccine', name), list, h('div', { class: 'grid2' }, field('Date', date), field('Dose', dose)), field('Note', note),
    h('button', { class: 'block big', onclick: () => {
      const n = name.value.trim(); if (!n) return toast('Which vaccine?', true);
      save('wb_vaccines', { ...base, name: n, given_on: date.value || localDay(), dose: dose.value.trim() || null, note: note.value.trim() || null, ...(isNew ? { created_by: S.session.user.id } : {}) });
      closeSheet(); render();
    } }, isNew ? 'Add' : 'Save'),
    isNew ? null : del));
}

function doctorVisits() {
  const v = S.rows.wb_visits;
  return [h('section', { class: 'card list' }, h('div', { class: 'list-head' }, h('h2', null, 'Visits')),
    v.length ? v.map((x) => h('button', { class: 'logrow visit', onclick: () => visitSheet(x) },
      h('span', { class: 'when' }, fmtDate(x.visit_date, { month: 'short', day: 'numeric' })),
      h('span', { class: 'what' }, h('strong', null, x.title), x.provider ? h('span', { class: 'muted' }, ` · ${x.provider}`) : null, x.notes ? h('span', { class: 'answer' }, x.notes) : null),
      h('span', { class: 'dur' }, '›')))
      : h('p', { class: 'muted empty' }, 'Keep notes from each checkup here.'))];
}
function visitSheet(x) {
  const isNew = !x;
  const base = x || { id: uuid(), visit_date: localDay(), title: '' };
  const title = h('input', { type: 'text', maxlength: '120', placeholder: 'e.g. 2-week checkup', value: base.title || '' });
  const date = h('input', { type: 'date', value: base.visit_date });
  const prov = h('input', { type: 'text', maxlength: '120', placeholder: 'Doctor or clinic', value: base.provider || '' });
  const notes = h('textarea', { rows: '6', maxlength: '10000', placeholder: 'What the doctor said, next steps…' }, base.notes || '');
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete visit');
  del.addEventListener('click', () => confirmDelete(del, 'visit', () => { remove('wb_visits', base.id); closeSheet(); render(); }));
  openSheet(isNew ? 'New visit' : 'Visit', h('div', { class: 'stack' },
    field('Visit', title), h('div', { class: 'grid2' }, field('Date', date), field('With', prov)), field('Notes', notes),
    h('button', { class: 'block big', onclick: () => {
      save('wb_visits', { ...base, title: title.value.trim() || 'Checkup', visit_date: date.value || localDay(), provider: prov.value.trim() || null, notes: notes.value.trim() || null, ...(isNew ? { created_by: S.session.user.id } : {}) });
      closeSheet(); render();
    } }, isNew ? 'Add visit' : 'Save'),
    isNew ? null : del));
}

/* ================= Meds ================= */
// Schedules: 'interval' = every N hours from the last dose; 'daily' = once a day at remind_at;
// 'every_other_day' = remind_at two days after the last dose. Mirrors private.wb_med_due_at() in the database,
// which sends the push reminders (one per due dose, to every parent phone with notifications on).
const meds = () => S.rows.wb_meds;
const medDoses = (m) => S.rows.wb_med_doses.filter((d) => d.med_id === m.id);
const hhmm = (t) => String(t || '09:00').slice(0, 5);
function atClock(dayMs, t) { const [H, M] = hhmm(t).split(':').map(Number); const d = new Date(dayMs); d.setHours(H, M, 0, 0); return d.getTime(); }
function dayStart(tsMs, plusDays = 0) { const d = new Date(tsMs); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + plusDays); return d.getTime(); }
const fmtClock = (t) => new Date(atClock(now(), t)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtHours = (h) => { const n = +h; return n === 1 ? 'hour' : `${+n.toFixed(1)} hours`; };
function medSchedText(m) {
  if (m.schedule === 'interval') return `Every ${fmtHours(m.every_hours)}`;
  if (m.schedule === 'every_other_day') return `Every other day · ${fmtClock(m.remind_at)}`;
  return `Daily · ${fmtClock(m.remind_at)}`;
}
function medDue(m) {
  const last = medDoses(m)[0]; const lastMs = last ? ms(last.taken_at) : null;
  if (m.schedule === 'interval') return lastMs == null ? null : lastMs + (+m.every_hours) * 3600000;
  if (m.schedule === 'every_other_day') return atClock(lastMs == null ? startOfToday() : dayStart(lastMs, 2), m.remind_at);
  const doneToday = lastMs != null && lastMs >= startOfToday();
  return atClock(dayStart(now(), doneToday ? 1 : 0), m.remind_at);
}
function fmtWhen(tsMs) {
  const t = new Date(tsMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const d = dayStart(tsMs);
  if (d === startOfToday()) return t;
  if (d === dayStart(now(), 1)) return `tomorrow ${t}`;
  if (d === dayStart(now(), -1)) return `yesterday ${t}`;
  return `${new Date(tsMs).toLocaleDateString([], { weekday: 'short' })} ${t}`;
}
// { state: 'due' | 'soon' | 'done' | 'later' | 'none', label }
function medStatus(m) {
  const due = medDue(m); const last = medDoses(m)[0];
  const takenToday = last && ms(last.taken_at) >= startOfToday();
  if (due == null) return { state: 'none', label: 'Not taken yet' };
  if (due <= now()) return { state: 'due', label: 'Due now' };
  if (m.schedule !== 'interval' && takenToday) return { state: 'done', label: 'Done today' };
  if (m.schedule === 'every_other_day' && dayStart(due) !== startOfToday()) return { state: 'later', label: dayStart(due) === dayStart(now(), 1) ? 'Tomorrow' : 'Not today' };
  return { state: 'soon', label: `Due in ${fmtDur(due - now())}` };
}
function takeMed(m) {
  buzz();
  const row = { id: uuid(), med_id: m.id, taken_at: isoNow(), created_by: S.session.user.id };
  save('wb_med_doses', row); render();
  toast(`${m.name} · ${fmtTime(row.taken_at)}`, false, { label: 'Undo', onClick: () => { remove('wb_med_doses', row.id); render(); } });
}
const whoName = (uid) => S.parents.find((p) => p.user_id === uid)?.display_name || '';
function medCard(m) {
  const st = medStatus(m); const doses = medDoses(m); const last = doses[0]; const due = medDue(m);
  const lastLine = last ? `Last dose ${fmtWhen(ms(last.taken_at))} · ${fmtAgo(last.taken_at)}` : 'No doses logged yet';
  const nextLine = due != null && st.state !== 'due' ? `Next ${fmtWhen(due)}` : null;
  return h('section', { class: `card med med-${st.state}` },
    h('button', { class: 'med-head', onclick: () => medSheet(m), 'aria-label': `Edit ${m.name}` },
      h('span', { class: 'med-title' }, h('strong', null, m.name), h('span', { class: 'med-who' }, `${m.for_whom}${m.reminders_on ? '' : ' · reminders off'}`)),
      h('span', { class: `chip med-chip ${st.state}` }, st.label)),
    h('p', { class: 'med-meta' }, medSchedText(m), nextLine ? ` · ${nextLine}` : ''),
    h('p', { class: 'med-meta' }, lastLine),
    h('div', { class: 'med-actions' },
      h('button', { class: 'big take' + (st.state === 'due' || st.state === 'none' ? '' : ' secondary'), onclick: () => takeMed(m) }, '✓  Took it'),
      h('button', { class: 'secondary big more', onclick: () => medSheet(m), 'aria-label': `${m.name} history and settings` }, 'History')),
    doses.length ? h('p', { class: 'med-hist' }, doses.slice(0, 3).map((d) => fmtWhen(ms(d.taken_at))).join(' · ')) : null);
}
function renderMeds() {
  const list = meds();
  const dueNow = list.filter((m) => medStatus(m).state === 'due');
  const intro = h('section', { class: 'hero-card med-hero' },
    h('div', { class: 'eyebrow' }, 'Medicine'),
    h('div', { class: 'big small-big' }, dueNow.length ? `${dueNow.length} due now` : 'All caught up'),
    h('p', { class: 'sub' }, dueNow.length ? dueNow.map((m) => m.name).join(', ') : 'Tap “Took it” after each dose.'));
  const cards = list.length ? list.map(medCard) : [h('section', { class: 'card' }, h('p', { class: 'muted' }, 'No medicines yet.'))];
  const add = h('button', { class: 'secondary block big', onclick: () => medSheet(null) }, '+ Add a medicine');
  const note = h('p', { class: 'small muted center med-note' }, 'Reminders go to every phone with notifications on (Settings).');
  mount('meds', { title: 'Meds', sub: 'Sophie & Westley', main: [intro, ...cards, add, note] });
}
const MED_SCHED = [['interval', 'Every few hours'], ['daily', 'Daily'], ['every_other_day', 'Every other day']];
function medSheet(m) {
  const isNew = !m;
  const base = m || { id: uuid(), name: '', for_whom: 'Sophie', schedule: 'interval', every_hours: 8, remind_at: '09:00', reminders_on: true, sort_order: (meds().reduce((n, x) => Math.max(n, x.sort_order || 0), 0) + 1) };
  let who = base.for_whom; let sched = base.schedule; let on = base.reminders_on !== false;
  const name = h('input', { type: 'text', maxlength: '80', placeholder: 'e.g. Ibuprofen', value: base.name || '' });
  const people = [...new Set(['Sophie', babyName(), ...S.parents.map((p) => p.display_name), who].filter(Boolean))];
  const hours = h('input', { type: 'number', inputmode: 'decimal', min: '0.5', max: '72', step: '0.5', value: base.every_hours ?? 8 });
  const time = h('input', { type: 'time', value: hhmm(base.remind_at) });
  const hourPicks = h('div', { class: 'chip-row' }, [4, 6, 8, 12, 24].map((n) => h('button', { type: 'button', class: 'pick', onclick: () => { hours.value = n; buzz(); } }, `${n}h`)));
  const intervalBox = h('div', { class: 'stack tight' }, hourPicks, field('Every (hours)', hours, 'Counted from the last dose.'));
  const timeBox = field('Reminder time', time);
  const showSched = () => { intervalBox.classList.toggle('hidden', sched !== 'interval'); timeBox.classList.toggle('hidden', sched === 'interval'); };
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Remove medicine');
  del.addEventListener('click', () => confirmDelete(del, 'medicine', () => { remove('wb_meds', base.id); S.rows.wb_med_doses = S.rows.wb_med_doses.filter((d) => d.med_id !== base.id); saveCache(); closeSheet(); render(); toast('Removed'); }));
  const doses = isNew ? [] : medDoses(base);
  const hist = isNew ? null : h('section', { class: 'card list med-hist-list' },
    h('div', { class: 'list-head' }, h('h2', null, 'History'), h('button', { type: 'button', class: 'ghost', onclick: () => doseSheet(base, null) }, '+ Earlier dose')),
    doses.length ? doses.slice(0, 30).map((d) => h('button', { type: 'button', class: 'logrow', onclick: () => doseSheet(base, d) },
      h('span', { class: 'when' }, fmtTime(d.taken_at)), h('span', { class: 'what' }, fmtDayLabel(d.taken_at)), h('span', { class: 'dur' }, whoName(d.created_by))))
      : h('p', { class: 'muted empty' }, 'No doses yet.'));
  const body = h('div', { class: 'stack' },
    hist,
    field('Name', name),
    h('p', { class: 'small label' }, 'For'), seg(people.map((p) => [p, p]), who, (k) => { who = k; }),
    h('p', { class: 'small label' }, 'How often'), seg(MED_SCHED, sched, (k) => { sched = k; showSched(); }),
    intervalBox, timeBox,
    h('p', { class: 'small label' }, 'Reminders'), seg([['on', 'On'], ['off', 'Off']], on ? 'on' : 'off', (k) => { on = k === 'on'; }),
    h('button', { class: 'block big', onclick: () => {
      const n = name.value.trim(); if (!n) return toast('Name the medicine.', true);
      const hv = num(hours.value);
      if (sched === 'interval' && (hv == null || Number.isNaN(hv) || hv < 0.5 || hv > 72)) return toast('Hours should be between 0.5 and 72.', true);
      if (sched !== 'interval' && !time.value) return toast('Pick a reminder time.', true);
      save('wb_meds', { ...base, name: n, for_whom: who, schedule: sched, every_hours: sched === 'interval' ? Math.round(hv * 10) / 10 : null, remind_at: sched === 'interval' ? null : time.value, reminders_on: on, ...(isNew ? { created_by: S.session.user.id } : {}) });
      closeSheet(); render(); toast(isNew ? 'Added' : 'Saved');
    } }, isNew ? 'Add medicine' : 'Save'),
    isNew ? null : del);
  showSched();
  openSheet(isNew ? 'New medicine' : base.name, body);
}
function doseSheet(m, d) {
  const isNew = !d;
  const base = d || { id: uuid(), med_id: m.id, taken_at: isoNow() };
  const at = h('input', { type: 'datetime-local', value: toLocalInput(base.taken_at) });
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete dose');
  del.addEventListener('click', () => confirmDelete(del, 'dose', () => { remove('wb_med_doses', base.id); closeSheet(); render(); toast('Deleted', false, { label: 'Undo', onClick: () => { save('wb_med_doses', base); render(); } }); }));
  openSheet(isNew ? `Earlier dose · ${m.name}` : `Dose · ${m.name}`, h('div', { class: 'stack' },
    field('Taken at', at),
    h('button', { class: 'block big', onclick: () => {
      const t = fromLocalInput(at.value); if (!t) return toast('Pick a time.', true);
      if (ms(t) > now() + 5 * 60000) return toast('That time is in the future.', true);
      save('wb_med_doses', { ...base, taken_at: t, ...(isNew ? { created_by: S.session.user.id } : {}) });
      closeSheet(); render(); toast(isNew ? 'Added' : 'Updated');
    } }, isNew ? 'Add dose' : 'Save'),
    isNew ? null : del));
}

/* ================= Settings ================= */
async function saveFamily(patch) {
  const prev = S.family;
  S.family = { ...S.family, ...patch }; saveCache(); render();
  const { error } = await sb.from('wb_family').update(patch).eq('id', 1);
  if (error) { S.family = prev; render(); toast(friendlyError(error), true); }
}
const REMIND = [[120, '2h'], [150, '2½h'], [180, '3h'], [210, '3½h'], [240, '4h']];
function renderSettings() {
  const f = S.family;
  const name = h('input', { type: 'text', maxlength: '60', value: f.baby_name });
  const birth = h('input', { type: 'date', value: f.birth_date || '', max: localDay() });
  const babyCard = h('section', { class: 'card stack' }, h('h2', null, 'Baby'),
    h('div', { class: 'grid2' }, field('Name', name), field('Birthday', birth)),
    h('button', { class: 'secondary', onclick: () => { const n = name.value.trim(); if (!n) return toast('Name can’t be empty.', true); saveFamily({ baby_name: n, birth_date: birth.value || null }); toast('Saved'); } }, 'Save'));
  const remindCard = h('section', { class: 'card stack' }, h('h2', null, 'Feeding reminder'),
    h('p', { class: 'small muted' }, `A notification when it’s been this long since the last feed started. Goes to every phone with notifications on.`),
    seg([['off', 'Off'], ...REMIND.map(([m, l]) => [String(m), l])], f.feed_reminder_enabled ? String(f.feed_reminder_minutes) : 'off',
      (k) => saveFamily(k === 'off' ? { feed_reminder_enabled: false } : { feed_reminder_enabled: true, feed_reminder_minutes: Number(k) })));
  const unitsCard = h('section', { class: 'card stack' }, h('h2', null, 'Units & colors'),
    h('p', { class: 'small label' }, 'Bottles'), seg([['oz', 'oz'], ['ml', 'mL']], f.volume_unit, (k) => saveFamily({ volume_unit: k })),
    h('p', { class: 'small label' }, 'Growth'), seg([['lb', 'lb · in'], ['kg', 'kg · cm']], f.weight_unit, (k) => saveFamily({ weight_unit: k })),
    h('p', { class: 'small label' }, 'Colors (this phone)'), seg([['night', '🌙 Night'], ['day', '☀️ Day']], theme(), (k) => { localStorage.setItem('wb-theme', k); applyTheme(); render(); }));
  const acct = h('section', { class: 'card stack' }, h('h2', null, 'Account'),
    h('p', { class: 'small muted' }, `Signed in as ${S.parent.display_name} (${S.session.user.email}). Shared with ${S.parents.filter((p) => p.user_id !== S.parent.user_id).map((p) => p.display_name).join(' & ') || 'no one yet'}.`),
    outbox.length ? h('p', { class: 'small' }, `${outbox.length} change${outbox.length === 1 ? '' : 's'} waiting to sync.`) : null,
    h('button', { class: 'secondary block', onclick: async () => { await forgetPushSub(); await sb.auth.signOut(); location.hash = '#/feed'; } }, 'Sign out'));
  const helpCard = h('section', { class: 'card stack' }, h('h2', null, 'Install & setup'),
    h('p', { class: 'small muted' }, isStandalone() ? 'You’re using the Home Screen app. Here are the steps if the other phone needs them.' : 'Put Westley on your Home Screen so it opens like an app and can send reminders.'),
    h('button', { class: 'secondary block', onclick: () => installGuide() }, icon('phone'), 'How to install'));
  mount('settings', { title: 'Settings', sub: `${babyName()}’s Book`, main: [babyCard, remindCard, notificationsCard(), helpCard, unitsCard, acct] });
}

/* ---------- Web Push ---------- */
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function swRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) || navigator.serviceWorker.register('sw.js');
}
async function currentPushSub() {
  try { const reg = await swRegistration(); return reg ? await reg.pushManager.getSubscription() : null; } catch { return null; }
}
async function savePushSub(sub) {
  const j = sub.toJSON();
  const { error } = await sb.from('wb_push_subscriptions').upsert({ user_id: S.session.user.id, endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, user_agent: navigator.userAgent.slice(0, 300) }, { onConflict: 'endpoint' });
  if (error) throw error;
}
async function forgetPushSub() {
  const sub = await currentPushSub(); if (!sub) return;
  try { await sb.from('wb_push_subscriptions').delete().eq('endpoint', sub.endpoint); } catch { /* ignore */ }
  try { await sub.unsubscribe(); } catch { /* ignore */ }
}
function notificationsCard() {
  const body = h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Checking this phone…'));
  const card = h('section', { class: 'card stack' }, h('h2', null, 'Notifications'), body);
  const note = (text, cls = 'small muted') => h('p', { class: cls }, text);
  const draw = async () => {
    if (isIOS() && !isStandalone()) {
      body.replaceChildren(h('div', { class: 'msg info' }, h('strong', null, 'First, add the app to your Home Screen.'),
        h('ol', { class: 'steps' }, h('li', null, 'In Safari, tap Share (square with an arrow).'), h('li', null, 'Tap “Add to Home Screen”, then “Add”.'), h('li', null, 'Open Westley from your Home Screen and come back here.'))));
      return;
    }
    if (!pushSupported()) return body.replaceChildren(note('This browser can’t show notifications. Try Chrome, or Safari from the Home Screen app.'));
    if (Notification.permission === 'denied') return body.replaceChildren(note(isIOS() ? 'Notifications are blocked. Turn them on in iPhone Settings → Notifications → Westley.' : 'Notifications are blocked for this site. Allow them in the browser’s site settings.', 'msg error'));
    const sub = Notification.permission === 'granted' ? await currentPushSub() : null;
    if (sub) {
      savePushSub(sub).catch(() => {});
      const test = h('button', { class: 'secondary' }, 'Send a test');
      const off = h('button', { class: 'ghost danger' }, 'Turn off');
      test.addEventListener('click', async () => {
        test.disabled = true;
        try {
          const { data, error } = await sb.functions.invoke(PUSH_FUNCTION, { body: { action: 'test' } });
          if (error) throw error;
          toast(data?.sent ? 'Sent! It should pop up in a few seconds.' : 'Couldn’t reach this phone. Turn notifications off and on again.', !data?.sent);
        } catch (err) { toast(friendlyError(err), true); }
        test.disabled = false;
      });
      off.addEventListener('click', async () => {
        off.disabled = true;
        await sb.from('wb_push_subscriptions').delete().eq('endpoint', sub.endpoint);
        try { await sub.unsubscribe(); } catch { /* ignore */ }
        toast('Notifications off on this phone.'); draw();
      });
      return body.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'chip on' }, 'On'), h('span', { class: 'small' }, 'This phone gets feeding reminders.')), h('div', { class: 'row wrap' }, test, off));
    }
    const on = h('button', { class: 'block' }, 'Turn on notifications');
    on.addEventListener('click', async () => {
      on.disabled = true;
      try {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Notifications weren’t allowed.', true); return draw(); }
        const reg = await swRegistration(); await navigator.serviceWorker.ready;
        const s2 = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC_KEY) }));
        await savePushSub(s2);
        toast('Notifications are on 💙');
      } catch (err) { toast(`Couldn’t turn on notifications. ${err?.message || ''}`, true); }
      on.disabled = false; draw();
    });
    body.replaceChildren(on, note('Each phone is set up separately.'));
  };
  draw();
  return card;
}

/* ================= install & welcome guide ================= */
// Shown once on the first visit in a browser tab (never inside the installed Home Screen app); reopen from
// Settings → Install & setup, or from the sign-in screen.
const GUIDE_KEY = 'wb-guide-seen';
const inAppBrowser = () => /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|Snapchat|LinkedInApp|Line\/|Pinterest|Twitter/.test(navigator.userAgent);
const appLink = () => location.origin + location.pathname;
function installGuide() {
  try { localStorage.setItem(GUIDE_KEY, '1'); } catch { /* ignore */ }
  let i = 0;
  let plat = /Android/i.test(navigator.userAgent) ? 'android' : 'ios';
  const box = h('div', { class: 'guide' });
  const step = (ico, html) => h('li', null, h('span', { class: 'gi' }, ico), h('span', null, html));
  const k = (text) => h('span', { class: 'key' }, text);
  const STEPS = () => {
    const ios = plat === 'ios';
    return [
      { icon: 'compass', title: ios ? 'Open it in Safari' : 'Open it in Chrome',
        text: 'It takes about a minute, and then Westley’s Book lives on your Home Screen like any other app.',
        body: [
          ios && isIOS() && inAppBrowser() ? h('div', { class: 'msg error' }, 'You’re not in Safari right now. Copy the link, then paste it into Safari.') : null,
          h('ol', { class: 'guide-steps' },
            ios ? step(icon('compass'), ['Use ', h('strong', null, 'Safari'), ', not Chrome or the browser inside Messages, Gmail or Instagram.'])
              : step(icon('compass'), ['Use ', h('strong', null, 'Chrome'), '.']),
            step(icon('share'), ['Opened it from a text or email? Tap ', k('⋯'), ' or the compass, then ', k(ios ? 'Open in Safari' : 'Open in Chrome'), '.'])),
          h('button', { type: 'button', class: 'secondary block', onclick: async () => { try { await navigator.clipboard.writeText(appLink()); toast('Link copied'); } catch { toast(appLink()); } } }, 'Copy the link'),
        ] },
      { icon: 'key', title: 'Sign in',
        text: 'Use the same email and password as the Meals app. Each phone signs in once.',
        body: [h('ol', { class: 'guide-steps' },
          step(h('span', { class: 'gn' }, '1'), 'Type your Meals app email.'),
          step(h('span', { class: 'gn' }, '2'), 'Type your Meals app password, then tap Sign in.'))] },
      ios
        ? { icon: 'addhome', title: 'Add it to your Home Screen',
          text: 'Do this in Safari.',
          body: [h('ol', { class: 'guide-steps' },
            step(icon('share'), ['Tap ', h('strong', null, 'Share'), ', the square with an arrow. (No Share button? Tap ', k('⋯'), ' first.)']),
            step(icon('addhome'), ['Scroll down and tap ', k('Add to Home Screen'), '.']),
            step(icon('check'), ['Tap ', k('Add'), ' in the top corner.']))] }
        : { icon: 'addhome', title: 'Install the app',
          text: 'Do this in Chrome.',
          body: [h('ol', { class: 'guide-steps' },
            step(icon('dots'), ['Tap the ', k('⋮'), ' menu in the top corner.']),
            step(icon('addhome'), ['Tap ', k('Install app'), ' or ', k('Add to Home screen'), '.']),
            step(icon('check'), ['Tap ', k('Install'), '.']))] },
      { icon: null, title: 'Open Westley from your Home Screen',
        text: 'Look for the blue W named Westley. It opens full screen, just like an app. You can close the browser tab.',
        body: [] },
      { icon: 'bell', title: 'Turn on feeding reminders',
        text: 'Do this inside the Home Screen app, on each phone.',
        body: [h('ol', { class: 'guide-steps' },
          step(icon('gear'), ['Tap the ', h('strong', null, 'gear'), ' at the top right.']),
          step(icon('bell'), ['Tap ', k('Turn on notifications'), '.']),
          step(icon('check'), ['Tap ', k('Allow'), '. That’s it 💙']))] },
    ];
  };
  const draw = () => {
    const all = STEPS(); const s = all[i]; const last = i === all.length - 1;
    box.replaceChildren(
      seg([['ios', 'iPhone'], ['android', 'Android']], plat, (v) => { plat = v; draw(); }),
      h('div', { class: 'guide-dots', 'aria-hidden': 'true' }, all.map((_, n) => h('span', { class: n === i ? 'on' : '' }))),
      h('div', { class: 'guide-hero' },
        s.icon ? h('span', { class: 'guide-badge' }, icon(s.icon)) : h('span', { class: 'guide-app' }, h('img', { src: 'icon.svg?v=wb1', alt: '' }), h('span', null, 'Westley')),
        h('p', { class: 'guide-count' }, `Step ${i + 1} of ${all.length}`),
        h('h3', null, s.title),
        h('p', { class: 'muted' }, s.text)),
      ...s.body.filter(Boolean),
      h('div', { class: 'guide-nav' },
        i > 0 ? h('button', { type: 'button', class: 'secondary', onclick: () => { i -= 1; draw(); } }, 'Back') : h('button', { type: 'button', class: 'ghost', onclick: () => closeSheet() }, 'Skip'),
        h('button', { type: 'button', class: 'big', onclick: () => { if (last) closeSheet(); else { i += 1; draw(); } } }, last ? 'Got it' : 'Next')));
    box.parentElement?.scrollTo?.(0, 0);
  };
  draw();
  openSheet('Get Westley on your phone', box);
}
function maybeShowGuide() {
  if (isStandalone()) return;
  try { if (localStorage.getItem(GUIDE_KEY)) return; } catch { return; }
  installGuide();
}

/* ================= boot ================= */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'open') return;
    const hash = new URL(e.data.url, location.href).hash || '#/feed';
    if (location.hash !== hash) location.hash = hash; else render();
  });
}
let booted = false;
async function afterSignIn() {
  const cached = loadCache();
  if (cached) render(); // instant, even offline
  try {
    await loadAll();
  } catch (err) {
    if (!cached) { appEl.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'card stack' }, h('p', null, friendlyError(err)), h('button', { onclick: () => location.reload() }, 'Try again')))); return; }
    setSync('offline');
  }
  render();
  subscribeRealtime();
  flushSoon();
}
async function boot() {
  registerServiceWorker();
  const { data } = await sb.auth.getSession();
  S.session = data.session;
  sb.auth.onAuthStateChange((event, session) => {
    const prev = S.session?.user?.id || null;
    S.session = session;
    if (!booted) return;
    if ((session?.user?.id || null) !== prev) {
      setTimeout(async () => {
        if (channel) { sb.removeChannel(channel); channel = null; }
        S.parent = null; S.parents = []; S.loaded = false;
        for (const t of TABLES) S.rows[t] = [];
        if (!session) { outbox = []; saveOutbox(); localStorage.removeItem(CACHE_KEY); render(); return; }
        await afterSignIn();
      }, 0);
    }
  });
  if (S.session) await afterSignIn(); else render();
  booted = true;
  maybeShowGuide();
}
boot();
