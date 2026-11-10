import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, VAPID_PUBLIC_KEY, PUSH_FUNCTION, PHOTO_BUCKET } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/* ================= state ================= */
// wb_sleeps, wb_feedings, wb_diapers, wb_meds and wb_med_doses still exist with their data.
// Those tabs were retired so Memories can come first; nothing was deleted.
const TABLES = ['wb_memories', 'wb_visits', 'wb_growth', 'wb_vaccines', 'wb_questions', 'wb_memory_hearts', 'wb_memory_comments', 'wb_firsts', 'wb_month_portraits', 'wb_letters'];
const SORT = {
  wb_memories: (a, b) => cmp(b.happened_on, a.happened_on) || cmp(b.created_at, a.created_at),
  wb_visits: (a, b) => cmp(b.visit_date, a.visit_date),
  wb_growth: (a, b) => cmp(b.measured_on, a.measured_on),
  wb_vaccines: (a, b) => cmp(b.given_on, a.given_on),
  wb_questions: (a, b) => cmp(a.created_at, b.created_at),
  wb_memory_hearts: (a, b) => cmp(a.created_at, b.created_at),
  wb_memory_comments: (a, b) => cmp(a.created_at, b.created_at),
  wb_firsts: (a, b) => cmp(a.id, b.id),
  wb_month_portraits: (a, b) => (a.id ?? 0) - (b.id ?? 0),
  wb_letters: (a, b) => cmp(b.written_on, a.written_on) || cmp(b.created_at, a.created_at),
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
const whoName = (uid) => S.parents.find((p) => p.user_id === uid)?.display_name || '';
function groupBy(list, key) { const m = new Map(); for (const x of list) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
const previewText = (s, n = 160) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : `${t.slice(0, n).trim()}…`; };


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
  if (days === 0) return 'Born today';
  if (days === 1) return '1 day old';
  if (days < 14) return `${days} days old`;
  if (days < 7 * 13) {
    const w = Math.floor(days / 7);
    return w === 1 ? '1 week old' : `${w} weeks old`;
  }
  const b = parseDate(birth); const d = parseDate(dateStr);
  let mo = (d.getFullYear() - b.getFullYear()) * 12 + (d.getMonth() - b.getMonth()); if (d.getDate() < b.getDate()) mo--;
  if (mo < 1) { const w = Math.max(1, Math.floor(days / 7)); return w === 1 ? '1 week old' : `${w} weeks old`; }
  if (mo < 24) return mo === 1 ? '1 month old' : `${mo} months old`;
  const y = Math.floor(mo / 12);
  return y === 1 ? '1 year old' : `${y} years old`;
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
const CACHE_KEY = 'wb-cache-v2';
try { localStorage.removeItem('wb-cache-v1'); } catch { /* ignore */ }
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
  const q = sb.from(t).select('*').limit(2000);
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

/* ================= tick (live clocks without re-rendering) ================= */
function tick() {
  for (const el of document.querySelectorAll('[data-since]')) {
    el.textContent = el.dataset.mode === 'clock' ? fmtDur(now() - Number(el.dataset.since), { secs: true }) : fmtAgo(Number(el.dataset.since));
  }
}
setInterval(tick, 1000);

/* ================= shell, routing ================= */
const ICONS = {
  feed: '<svg class="ico" viewBox="0 0 24 24"><path d="M9 3h6M10 3v3l-2 3v10a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V9l-2-3V3"/><path d="M8 13h8"/></svg>',
  diaper: '<svg class="ico" viewBox="0 0 24 24"><path d="M3 7h18v3a9 9 0 0 1-18 0z"/><path d="M8 7v2.5M16 7v2.5"/></svg>',
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
  firsts: '<svg class="ico" viewBox="0 0 24 24"><path d="M12 3l2.2 6.6H21l-5.4 4 2.1 6.4L12 16.8 6.3 20l2.1-6.4L3 9.6h6.8z"/></svg>',
  letters: '<svg class="ico" viewBox="0 0 24 24"><path d="M4 6h16v12H4z"/><path d="M4 6l8 7 8-7"/></svg>',
};
const icon = (name) => h('span', { class: 'ico-wrap', 'aria-hidden': 'true', html: ICONS[name] });
const TABS = [['photos', 'Memories'], ['firsts', 'Firsts'], ['letters', 'Letters'], ['doctor', 'Doctor']];

function route() {
  const v = location.hash.replace(/^#\/?/, '').split('/')[0];
  if (['feed', 'diaper', 'diapers', 'meds'].includes(v)) return 'photos';
  return [...TABS.map((t) => t[0]), 'settings'].includes(v) ? v : 'photos';
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
  ({ photos: renderPhotos, firsts: renderFirsts, letters: renderLetters, doctor: renderDoctor, settings: renderSettings })[v]();
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
    h('div', { class: 'hero' }, h('img', { src: 'icon.svg?v=wb1', alt: '' }), h('h1', null, 'Westley’s Book'), h('p', null, 'Photos, firsts and little notes, just for the two of you.')),
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

/* ================= Memories ================= */
async function decodeImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* older Safari: fall back below */ }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
async function downscaleToJpeg(file, max = 2048, quality = 0.8) {
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
const MAX_PHOTOS = 10;
// a memory's photos: the new photo_paths list, or the original single photo_path (older memories) as a one-item list
const memPaths = (m) => (Array.isArray(m.photo_paths) && m.photo_paths.length ? m.photo_paths : m.photo_path ? [m.photo_path] : []);
function pickPhotos(onFiles, max = MAX_PHOTOS) {
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden' });
  input.addEventListener('change', () => {
    let skippedVideo = false;
    const files = [...(input.files || [])].filter((f) => {
      if (f.type.startsWith('video/')) { skippedVideo = true; return false; }
      return !f.type || f.type.startsWith('image/');
    });
    input.remove();
    if (skippedVideo) toast('Photos only — videos would fill up the book’s free storage.');
    if (files.length > max) toast(`Up to ${MAX_PHOTOS} photos per memory, so the first ${max} were added.`);
    if (files.length) onFiles(files.slice(0, max));
  });
  document.body.append(input); input.click();
}

function attachZoom(slide, img) {
  let scale = 1, tx = 0, ty = 0, startDist = 0, startScale = 1, lastTap = 0;
  let panning = false, panX = 0, panY = 0, startTx = 0, startTy = 0;
  const strip = () => slide.parentElement;
  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    slide.dataset.zoomed = scale > 1 ? '1' : '';
    const el = strip();
    if (el) el.style.overflowX = scale > 1 ? 'hidden' : '';
  };
  slide.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      startDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      startScale = scale;
    } else if (e.touches.length === 1) {
      const t = Date.now();
      if (t - lastTap < 280) {
        if (scale > 1) { scale = 1; tx = 0; ty = 0; } else scale = 2.4;
        apply();
      }
      lastTap = t;
      if (scale > 1) { panning = true; panX = e.touches[0].clientX; panY = e.touches[0].clientY; startTx = tx; startTy = ty; }
    }
  }, { passive: true });
  slide.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && startDist) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      scale = Math.min(4, Math.max(1, startScale * (d / Math.max(1, startDist))));
      if (scale === 1) { tx = 0; ty = 0; }
      apply();
    } else if (panning && e.touches.length === 1 && scale > 1) {
      tx = startTx + (e.touches[0].clientX - panX);
      ty = startTy + (e.touches[0].clientY - panY);
      apply();
    }
  }, { passive: true });
  slide.addEventListener('touchend', () => { panning = false; if (scale <= 1) { scale = 1; tx = 0; ty = 0; apply(); } }, { passive: true });
}

let viewerEl = null;
function closeViewer() {
  if (!viewerEl) return;
  viewerEl.dispatchEvent(new Event('wb-close'));
  viewerEl.remove(); viewerEl = null;
  if (!sheetEl) document.body.classList.remove('sheet-open');
}
function openViewer(paths, start = 0) {
  closeViewer();
  const count = h('span', { class: 'viewer-count' }, paths.length > 1 ? `${start + 1} / ${paths.length}` : '');
  const slides = paths.map((p) => {
    const img = photoImg(p, 'viewer-img');
    const slide = h('div', { class: 'viewer-slide' }, img);
    attachZoom(slide, img);
    return slide;
  });
  const strip = h('div', { class: 'viewer-strip' }, slides);
  strip.addEventListener('scroll', () => { const k = Math.round(strip.scrollLeft / Math.max(1, strip.clientWidth)); if (paths.length > 1) count.textContent = `${k + 1} / ${paths.length}`; }, { passive: true });
  const step = (dir) => { strip.scrollBy({ left: dir * strip.clientWidth, behavior: 'smooth' }); };
  viewerEl = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photos' },
    h('div', { class: 'viewer-bar' }, count, h('button', { class: 'icon', 'aria-label': 'Close', onclick: closeViewer }, '✕')), strip);
  viewerEl.addEventListener('wb-step', (e) => step(e.detail));
  document.body.append(viewerEl); document.body.classList.add('sheet-open');
  requestAnimationFrame(() => { strip.scrollLeft = start * strip.clientWidth; });
}
function openSlideshow(slides, title) {
  if (!slides.length) return;
  closeViewer();
  let i = 0, timer = null, playing = false;
  const img = h('img', { class: 'viewer-img', alt: '' });
  const cap = h('div', { class: 'recap-cap' });
  const count = h('span', { class: 'viewer-count' });
  const playBtn = h('button', { type: 'button', class: 'icon', 'aria-label': 'Play' }, '▶');
  const show = (n) => {
    i = (n + slides.length) % slides.length;
    const s = slides[i];
    count.textContent = `${title ? `${title} · ` : ''}${i + 1} / ${slides.length}`;
    photoUrl(s.path).then((u) => { if (img.isConnected && u) img.src = u; });
    cap.replaceChildren(
      h('div', { class: 'recap-date' }, [fmtDate(s.date, { weekday: 'short', month: 'short', day: 'numeric' }), s.age ? ` · ${s.age}` : ''].filter(Boolean).join('')),
      s.caption ? h('p', null, s.caption) : null);
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; playing = false; playBtn.textContent = '▶'; playBtn.setAttribute('aria-label', 'Play'); };
  const start = () => {
    stop(); playing = true; playBtn.textContent = '❚❚'; playBtn.setAttribute('aria-label', 'Pause');
    timer = setInterval(() => show(i + 1), 3200);
  };
  playBtn.addEventListener('click', () => { if (playing) stop(); else { show(i + 1); start(); } });
  const go = (dir) => { show(i + dir); if (playing) start(); };
  let x0 = null;
  const stage = h('div', { class: 'viewer-slide recap-slide' }, img, cap,
    slides.length > 1 ? h('button', { type: 'button', class: 'recap-nav prev', 'aria-label': 'Previous', onclick: () => go(-1) }, '‹') : null,
    slides.length > 1 ? h('button', { type: 'button', class: 'recap-nav next', 'aria-label': 'Next', onclick: () => go(1) }, '›') : null);
  stage.addEventListener('touchstart', (e) => { if (e.touches.length === 1) x0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
  });
  viewerEl = h('div', { class: 'viewer recap', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Recap' },
    h('div', { class: 'viewer-bar' }, count, h('div', { class: 'row tight' }, playBtn, h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => { stop(); closeViewer(); } }, '✕'))),
    stage);
  viewerEl.addEventListener('wb-close', stop);
  viewerEl.addEventListener('wb-step', (e) => go(e.detail));
  document.body.append(viewerEl); document.body.classList.add('sheet-open');
  show(0);
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) start();
}
document.addEventListener('keydown', (e) => {
  if (!viewerEl) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') viewerEl.dispatchEvent(new CustomEvent('wb-step', { detail: -1 }));
  if (e.key === 'ArrowRight') viewerEl.dispatchEvent(new CustomEvent('wb-step', { detail: 1 }));
});
window.addEventListener('hashchange', closeViewer);

function memoryPhotos(m) {
  const paths = memPaths(m);
  if (!paths.length) return null;
  if (paths.length === 1) return h('div', { class: 'mem-one', onclick: (e) => { e.stopPropagation(); openViewer(paths, 0); } }, photoImg(paths[0]));
  const shown = paths.slice(0, 4);
  return h('div', { class: `mem-grid n${Math.min(paths.length, 4)}` }, shown.map((p, k) => h('button', { type: 'button', class: 'mem-cell', 'aria-label': `Photo ${k + 1} of ${paths.length}`, onclick: (e) => { e.stopPropagation(); openViewer(paths, k); } },
    photoImg(p, 'mem-thumb'), k === 3 && paths.length > 4 ? h('span', { class: 'mem-more' }, `+${paths.length - 4}`) : null)));
}

const heartsFor = (id) => S.rows.wb_memory_hearts.filter((x) => x.memory_id === id);
const commentsFor = (id) => S.rows.wb_memory_comments.filter((x) => x.memory_id === id);
const myHeart = (id) => heartsFor(id).find((x) => x.user_id === S.session.user.id);
function toggleHeart(id) {
  buzz();
  const mine = myHeart(id);
  if (mine) remove('wb_memory_hearts', mine.id);
  else save('wb_memory_hearts', { id: uuid(), memory_id: id, user_id: S.session.user.id, created_at: isoNow() });
}
function heartNames(id) {
  return heartsFor(id).map((x) => whoName(x.user_id)).filter(Boolean);
}
function heartBtn(id, { stop = true } = {}) {
  const mine = !!myHeart(id);
  const names = heartNames(id);
  return h('button', { type: 'button', class: 'heart-btn' + (mine ? ' on' : ''), 'aria-pressed': String(mine), 'aria-label': mine ? 'Remove heart' : 'Heart this memory', onclick: (e) => { if (stop) e.stopPropagation(); toggleHeart(id); render(); } },
    mine ? '💙' : '♡', h('span', null, names.length ? names.join(' · ') : 'Love this'));
}
function memoriesOn(day) { return S.rows.wb_memories.filter((m) => m.happened_on === day); }
function lookingBack() {
  const today = localDay();
  const cards = [];
  const birthYear = S.family.birth_date ? parseDate(S.family.birth_date).getFullYear() : new Date().getFullYear();
  for (let y = new Date().getFullYear() - 1; y >= birthYear; y--) {
    const day = `${y}-${today.slice(5)}`;
    const mems = memoriesOn(day);
    if (mems.length) cards.push({ title: y === new Date().getFullYear() - 1 ? 'On this day last year' : `On this day in ${y}`, day, mems });
  }
  const monthAgo = (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return localDay(d); })();
  if (monthAgo !== today) {
    const mems = memoriesOn(monthAgo);
    if (mems.length) cards.push({ title: 'One month ago', day: monthAgo, mems });
  }
  const weekAgo = (() => { const d = new Date(); d.setDate(d.getDate() - 7); return localDay(d); })();
  const weekMems = memoriesOn(weekAgo);
  if (weekMems.length) cards.push({ title: 'One week ago', day: weekAgo, mems: weekMems });
  return cards;
}
function lookbackCards() {
  return lookingBack().slice(0, 2).map((c) => {
    const m = c.mems[0];
    const path = memPaths(m)[0];
    return h('article', { class: 'card lookback', onclick: () => memoryDetail(m) },
      h('div', { class: 'eyebrow' }, c.title),
      h('div', { class: 'lookback-row' },
        path ? h('div', { class: 'lookback-thumb' }, photoImg(path, 'lookback-img')) : null,
        h('div', { class: 'lookback-text' },
          h('div', { class: 'memory-date' }, h('span', null, fmtDate(c.day, { month: 'short', day: 'numeric', year: 'numeric' })), ageAt(c.day) ? h('span', { class: 'chip' }, ageAt(c.day)) : null),
          m.caption ? h('p', { class: 'caption' }, m.caption) : null,
          c.mems.length > 1 ? h('p', { class: 'small muted' }, `and ${c.mems.length - 1} more`) : null)));
  });
}
function monthPhotoCount(mems) { return mems.reduce((n, m) => n + memPaths(m).length, 0); }
function playMonthRecap(mems, month) {
  const chrono = [...mems].sort((a, b) => cmp(a.happened_on, b.happened_on) || cmp(a.created_at, b.created_at));
  const slides = [];
  for (const m of chrono) {
    for (const p of memPaths(m)) slides.push({ path: p, caption: m.caption, date: m.happened_on, age: ageAt(m.happened_on) });
  }
  if (!slides.length) return toast('No photos in that month yet.');
  openSlideshow(slides, month);
}
function renderPhotos() {
  const mems = S.rows.wb_memories;
  const photoCount = monthPhotoCount(mems);
  const latest = mems.find((m) => memPaths(m).length);
  const hero = latest
    ? h('section', { class: 'mem-hero', onclick: () => memoryDetail(latest) },
      photoImg(memPaths(latest)[0], 'mem-hero-photo'),
      h('div', { class: 'mem-hero-fade' },
        h('div', { class: 'mem-hero-name' }, babyName()),
        h('div', { class: 'mem-hero-age' }, ageText(S.family.birth_date) || `${babyName()}’s Book`),
        h('div', { class: 'mem-hero-meta' }, `${mems.length} memor${mems.length === 1 ? 'y' : 'ies'} · ${photoCount} photo${photoCount === 1 ? '' : 's'}`)))
    : null;
  const empty = h('section', { class: 'hero-card' }, h('div', { class: 'eyebrow' }, 'Memories'), h('div', { class: 'big small-big' }, `${babyName()}’s first moments`), h('p', { class: 'sub' }, 'Add photos or a little note. Only you two can see them.'));
  const byMonth = groupBy(mems, (m) => fmtDate(m.happened_on, { month: 'long', year: 'numeric' }));
  const timeline = [...byMonth].map(([month, xs]) => {
    const n = monthPhotoCount(xs);
    return h('section', { class: 'timeline' },
      h('div', { class: 'month-head' },
        h('h2', { class: 'month' }, month),
        n >= 2 ? h('button', { type: 'button', class: 'ghost recap-btn', onclick: () => playMonthRecap(xs, month) }, '▶ Recap') : null),
      xs.map((m) => {
        const by = whoName(m.created_by);
        const nC = commentsFor(m.id).length;
        return h('article', { class: 'memory', onclick: () => memoryDetail(m) },
          memoryPhotos(m),
          h('div', { class: 'memory-body' },
            h('div', { class: 'memory-date' }, h('span', null, fmtDate(m.happened_on, { weekday: 'short', month: 'short', day: 'numeric' })), ageAt(m.happened_on) ? h('span', { class: 'chip' }, ageAt(m.happened_on)) : null, by ? h('span', { class: 'memory-by' }, `by ${by}`) : null),
            m.caption ? h('p', { class: 'caption' }, m.caption) : null,
            h('div', { class: 'mem-social' },
              heartBtn(m.id),
              h('span', { class: 'mem-cmt' }, nC ? `💬 ${nC}` : '💬'))));
      }));
  });
  const main = mems.length ? [hero, ...lookbackCards(), ...timeline].filter(Boolean) : [empty];
  const dock = h('div', { class: 'dock-row two' },
    h('button', { class: 'side-btn start suggest', onclick: () => pickPhotos((files) => memorySheet(null, files)) }, h('span', { class: 'letter emoji' }, '📷'), h('span', { class: 'lbl' }, 'Add photos')),
    h('button', { class: 'side-btn', onclick: () => memorySheet(null, null) }, h('span', { class: 'letter emoji' }, '✎'), h('span', { class: 'lbl' }, 'Write a note')));
  mount('photos', { title: 'Memories', sub: ageText(S.family.birth_date) || `${babyName()}’s Book`, main, dock });
}
function memoryDetail(m) {
  const get = () => S.rows.wb_memories.find((x) => x.id === m.id) || m;
  const box = h('div', { class: 'stack' });
  const draw = () => {
    const cur = get();
    const paths = memPaths(cur);
    const names = heartNames(cur.id);
    const mine = !!myHeart(cur.id);
    const cs = commentsFor(cur.id);
    const input = h('input', { type: 'text', maxlength: '400', placeholder: 'A little note…', 'aria-label': 'Comment' });
    const send = () => {
      const text = input.value.trim();
      if (!text) return;
      save('wb_memory_comments', { id: uuid(), memory_id: cur.id, body: text, created_by: S.session.user.id, created_at: isoNow() });
      input.value = '';
      draw(); renderSoon();
    };
    box.replaceChildren(
      paths.length ? memoryPhotos(cur) : null,
      h('div', { class: 'memory-date' },
        h('span', null, fmtDate(cur.happened_on, { weekday: 'short', month: 'short', day: 'numeric' })),
        ageAt(cur.happened_on) ? h('span', { class: 'chip' }, ageAt(cur.happened_on)) : null,
        whoName(cur.created_by) ? h('span', { class: 'memory-by' }, `by ${whoName(cur.created_by)}`) : null),
      cur.caption ? h('p', { class: 'caption' }, cur.caption) : null,
      h('button', { type: 'button', class: 'heart-btn' + (mine ? ' on' : ''), 'aria-pressed': String(mine), onclick: () => { toggleHeart(cur.id); draw(); renderSoon(); } },
        mine ? '💙' : '♡', h('span', null, names.length ? names.join(' · ') : 'Love this')),
      h('div', { class: 'comments' },
        cs.length
          ? cs.map((c) => h('div', { class: 'comment' },
            h('div', { class: 'comment-meta' },
              h('strong', null, whoName(c.created_by) || 'Parent'),
              h('span', { class: 'muted' }, c.created_at ? fmtAgo(c.created_at) : ''),
              h('button', { type: 'button', class: 'ghost comment-del', onclick: () => {
                const old = { ...c };
                remove('wb_memory_comments', c.id); draw(); renderSoon();
                toast('Comment removed', false, { label: 'Undo', onClick: () => { save('wb_memory_comments', old); draw(); renderSoon(); } });
              } }, 'Remove')),
            h('p', null, c.body)))
          : h('p', { class: 'small muted' }, 'No notes yet.')),
      h('div', { class: 'comment-add' }, input, h('button', { type: 'button', class: 'secondary', onclick: send }, 'Add')),
      h('button', { type: 'button', class: 'secondary block', onclick: () => memorySheet(cur, null) }, 'Edit memory'));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  };
  draw();
  openSheet('Memory', box);
}
function memorySheet(m, files) {
  const isNew = !m;
  const base = m || { id: uuid(), happened_on: localDay(), caption: null, photo_path: null, photo_paths: null };
  let items = memPaths(base).map((path) => ({ path }));
  const addFiles = (fs) => { for (const file of fs) if (items.length < MAX_PHOTOS) items.push({ file, url: URL.createObjectURL(file) }); drawGrid(); };
  const cleanup = () => { for (const it of items) if (it.url) URL.revokeObjectURL(it.url); };
  const grid = h('div', { class: 'pick-grid' });
  const drawGrid = () => {
    grid.replaceChildren(
      ...items.map((it, k) => h('div', { class: 'pick-cell' },
        it.file ? h('img', { class: 'pick-img', alt: '', src: it.url }) : photoImg(it.path, 'pick-img'),
        h('button', { type: 'button', class: 'pick-x', 'aria-label': `Remove photo ${k + 1}`, onclick: () => { if (it.url) URL.revokeObjectURL(it.url); items = items.filter((x) => x !== it); drawGrid(); } }, '✕'))),
      items.length < MAX_PHOTOS ? h('button', { type: 'button', class: 'pick-add', onclick: () => pickPhotos(addFiles, MAX_PHOTOS - items.length) }, h('span', { class: 'pick-plus' }, '+'), h('span', null, items.length ? 'Add more' : 'Add photos')) : null);
    count.textContent = items.length ? `${items.length} of ${MAX_PHOTOS} photos` : 'No photos';
  };
  const count = h('p', { class: 'small muted' });
  if (files) addFiles(files); else drawGrid();
  const date = h('input', { type: 'date', value: base.happened_on, max: localDay() });
  const cap = h('textarea', { maxlength: '2000', rows: '3', placeholder: isNew ? 'First smile, first bath, tiny yawns…' : '' }, base.caption || '');
  const status = h('p', { class: 'small muted hidden' });
  const bar = h('div', { class: 'progress hidden' }, h('span'));
  const btn = h('button', { class: 'block big' }, isNew ? 'Save memory' : 'Save');
  btn.addEventListener('click', async () => {
    const caption = cap.value.trim() || null;
    if (!items.length && !caption) return toast('Write a few words or add a photo.', true);
    btn.disabled = true;
    const todo = items.filter((it) => !it.path);
    try {
      let done = 0;
      const step = (text) => { status.className = 'small muted'; status.textContent = text; bar.classList.remove('hidden'); bar.firstChild.style.width = `${Math.round((done / Math.max(1, todo.length)) * 100)}%`; };
      for (const it of todo) {
        step(todo.length > 1 ? `Uploading photo ${done + 1} of ${todo.length}…` : 'Uploading photo…');
        const blob = await downscaleToJpeg(it.file);
        const path = `${uuid()}.jpg`;
        const up = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '3600' });
        if (up.error) throw up.error;
        it.path = path; done += 1; step(`Uploaded ${done} of ${todo.length}`);
      }
      const paths = items.map((it) => it.path);
      save('wb_memories', { ...base, happened_on: date.value || localDay(), caption, photo_path: paths[0] || null, photo_paths: paths.length ? paths : null, ...(isNew ? { created_by: S.session.user.id, created_at: isoNow() } : {}) });
      cleanup(); closeSheet(); render(); toast(isNew ? 'Memory saved 💙' : 'Saved');
    } catch (err) {
      bar.classList.add('hidden');
      status.className = 'msg error'; status.textContent = isNetworkError(err) ? 'Photos need a connection. Try again in a moment.' : friendlyError(err);
      btn.disabled = false;
    }
  });
  const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete memory');
  del.addEventListener('click', () => confirmDelete(del, 'memory', async () => {
    remove('wb_memories', base.id);
    const gone = memPaths(base);
    if (gone.length) sb.storage.from(PHOTO_BUCKET).remove(gone).catch(() => {});
    cleanup(); closeSheet(); render(); toast('Memory deleted');
  }));
  const by = isNew ? null : whoName(base.created_by);
  openSheet(isNew ? 'New memory' : 'Edit memory', h('div', { class: 'stack' },
    grid, count,
    field('Caption', cap), field('Date', date),
    by ? h('p', { class: 'small muted' }, `Saved by ${by}`) : null,
    status, bar, btn, isNew ? null : del), { onClose: cleanup });
}

/* ================= Firsts ================= */
const FIRSTS = [
  ['smile', 'First smile'],
  ['laugh', 'First laugh'],
  ['hands', 'Found his hands'],
  ['head_up', 'Held his head up'],
  ['roll', 'Rolled over'],
  ['reach', 'Reached for something'],
  ['sit', 'Sat up'],
  ['tooth', 'First tooth'],
  ['crawl', 'Started crawling'],
  ['wave', 'Waved hello'],
  ['clap', 'Clapped'],
  ['pull_up', 'Pulled up to stand'],
  ['steps', 'First steps'],
  ['word', 'First word'],
  ['bites', 'First bites'],
  ['haircut', 'First haircut'],
  ['outing', 'First outing'],
  ['birthday', 'First birthday'],
];
const monthTitle = (n) => (n === 1 ? 'Westley at 1 month' : `Westley at ${n} months`);
function portraitSlot(n) {
  const row = S.rows.wb_month_portraits.find((x) => Number(x.id) === n);
  const label = monthTitle(n);
  if (row) {
    return h('button', { type: 'button', class: 'portrait', onclick: () => portraitSheet(n) },
      photoImg(row.photo_path, 'portrait-img'),
      h('span', { class: 'portrait-lbl' }, label));
  }
  return h('button', { type: 'button', class: 'portrait empty', onclick: () => portraitSheet(n) },
    h('span', { class: 'portrait-plus' }, '+'),
    h('span', { class: 'portrait-lbl' }, label));
}
function portraitSheet(n) {
  const label = monthTitle(n);
  const existing = S.rows.wb_month_portraits.find((x) => Number(x.id) === n);
  let chosen = existing ? { memory_id: existing.memory_id, path: existing.photo_path } : null;
  const box = h('div', { class: 'stack' });
  const draw = () => {
    const mems = S.rows.wb_memories.filter((m) => memPaths(m).length);
    box.replaceChildren(
      h('p', { class: 'small muted' }, `Pick a photo for “${label}”.`),
      chosen ? photoImg(chosen.path, 'memory-photo') : null,
      mems.length
        ? h('div', { class: 'pick-grid' }, mems.flatMap((m) => memPaths(m).map((p) => h('button', { type: 'button', class: 'pick-cell' + (chosen?.path === p ? ' on' : ''), onclick: () => { chosen = { memory_id: m.id, path: p }; draw(); } }, photoImg(p, 'pick-img')))))
        : h('p', { class: 'muted' }, 'Add a photo to a memory first, then come back here.'),
      h('button', { class: 'block big', onclick: () => {
        if (!chosen) return toast('Pick a photo first.', true);
        save('wb_month_portraits', { id: n, memory_id: chosen.memory_id, photo_path: chosen.path, created_by: S.session.user.id });
        closeSheet(); render(); toast('Saved 💙');
      } }, 'Save'),
      existing ? h('button', { type: 'button', class: 'ghost danger block', onclick: (e) => confirmDelete(e.currentTarget, 'portrait', () => { remove('wb_month_portraits', n); closeSheet(); render(); toast('Removed'); }) }, 'Remove portrait') : null);
  };
  draw();
  openSheet(label, box);
}
function firstRow(slug, title) {
  const row = S.rows.wb_firsts.find((x) => x.id === slug);
  const mem = row?.memory_id ? S.rows.wb_memories.find((m) => m.id === row.memory_id) : null;
  const path = mem ? memPaths(mem)[0] : null;
  const when = row?.happened_on
    ? [fmtDate(row.happened_on, { month: 'short', day: 'numeric' }), ageAt(row.happened_on) ? ageAt(row.happened_on) : '', row.note || ''].filter(Boolean).join(' · ')
    : '';
  return h('div', { class: 'qrow' + (row ? ' done' : '') },
    h('button', { type: 'button', class: 'check', 'aria-label': row ? `Edit ${title}` : `Mark ${title}`, onclick: () => {
      if (row) return firstSheet(slug, title);
      save('wb_firsts', { id: slug, happened_on: localDay(), memory_id: null, note: null, created_by: S.session.user.id });
      render();
    } }, row ? '✓' : ''),
    h('button', { type: 'button', class: 'qtext', onclick: () => firstSheet(slug, title) }, title, when ? h('span', { class: 'answer' }, when) : null),
    path ? h('button', { type: 'button', class: 'first-thumb', 'aria-label': 'Open linked memory', onclick: () => memoryDetail(mem) }, photoImg(path, 'first-thumb-img')) : null);
}
function firstSheet(slug, title) {
  const existing = S.rows.wb_firsts.find((x) => x.id === slug);
  let linked = existing?.memory_id ? S.rows.wb_memories.find((m) => m.id === existing.memory_id) : null;
  const date = h('input', { type: 'date', value: existing?.happened_on || localDay(), max: localDay() });
  const note = h('textarea', { maxlength: '500', rows: '2', placeholder: 'A little note (optional)' }, existing?.note || '');
  const linkBox = h('div', { class: 'stack tight' });
  let picking = false;
  const drawLink = () => {
    if (picking) {
      const mems = S.rows.wb_memories;
      linkBox.replaceChildren(
        h('p', { class: 'small muted' }, mems.length ? 'Tap a memory to link it.' : 'No memories yet.'),
        ...mems.map((m) => h('button', { type: 'button', class: 'pick-mem', onclick: () => { linked = m; if (m.happened_on) date.value = m.happened_on; picking = false; drawLink(); } },
          memPaths(m)[0] ? photoImg(memPaths(m)[0], 'pick-mem-img') : h('div', { class: 'pick-mem-img missing' }),
          h('span', { class: 'pick-mem-text' }, h('strong', null, fmtDate(m.happened_on, { month: 'short', day: 'numeric' })), m.caption ? h('span', { class: 'muted' }, m.caption) : null))),
        h('button', { type: 'button', class: 'ghost', onclick: () => { picking = false; drawLink(); } }, 'Cancel'));
      return;
    }
    if (linked) {
      const path = memPaths(linked)[0];
      linkBox.replaceChildren(
        h('div', { class: 'pick-mem static' }, path ? photoImg(path, 'pick-mem-img') : h('div', { class: 'pick-mem-img missing' }), h('span', { class: 'pick-mem-text' }, h('strong', null, linked.caption || fmtDate(linked.happened_on)), h('span', { class: 'muted' }, fmtDate(linked.happened_on, { month: 'short', day: 'numeric' })))),
        h('div', { class: 'grid2' },
          h('button', { type: 'button', class: 'secondary', onclick: () => { picking = true; drawLink(); } }, 'Change'),
          h('button', { type: 'button', class: 'ghost', onclick: () => { linked = null; drawLink(); } }, 'Unlink')));
    } else {
      linkBox.replaceChildren(h('button', { type: 'button', class: 'secondary block', onclick: () => { picking = true; drawLink(); } }, 'Link a memory'));
    }
  };
  drawLink();
  const btn = h('button', { class: 'block big' }, 'Save');
  btn.addEventListener('click', () => {
    const happened = date.value || null;
    if (!happened && !linked) return toast('Add a date or link a memory.', true);
    save('wb_firsts', { id: slug, happened_on: happened || linked?.happened_on || localDay(), memory_id: linked?.id || null, note: note.value.trim() || null, created_by: existing?.created_by || S.session.user.id });
    closeSheet(); render(); toast('Saved 💙');
  });
  const clear = h('button', { type: 'button', class: 'ghost danger block' }, 'Clear this first');
  clear.addEventListener('click', () => confirmDelete(clear, 'first', () => { remove('wb_firsts', slug); closeSheet(); render(); toast('Cleared'); }));
  openSheet(title, h('div', { class: 'stack' }, field('Date', date), field('Note', note), h('p', { class: 'small label' }, 'Memory'), linkBox, btn, existing ? clear : null));
}
function renderFirsts() {
  const marked = FIRSTS.filter(([slug]) => S.rows.wb_firsts.some((r) => r.id === slug)).length;
  const portraits = h('section', { class: 'card stack' },
    h('h2', null, 'Monthly portraits'),
    h('p', { class: 'small muted' }, `A photo of ${babyName()} at each month this year.`),
    h('div', { class: 'portraits' }, Array.from({ length: 12 }, (_, i) => portraitSlot(i + 1))));
  const list = h('section', { class: 'card list' },
    h('div', { class: 'list-head' }, h('h2', null, 'First-year firsts'), h('span', { class: 'small muted' }, `${marked} of ${FIRSTS.length}`)),
    FIRSTS.map(([slug, title]) => firstRow(slug, title)));
  mount('firsts', { title: 'Firsts', sub: `${babyName()}’s first year`, main: [portraits, list] });
}

/* ================= Letters ================= */
function renderLetters() {
  const letters = S.rows.wb_letters;
  const main = letters.length
    ? letters.map((row) => h('article', { class: 'letter-card', onclick: () => letterRead(row) },
      h('div', { class: 'memory-date' }, h('span', null, fmtDate(row.written_on, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })), whoName(row.created_by) ? h('span', { class: 'memory-by' }, whoName(row.created_by)) : null),
      h('p', { class: 'letter-preview' }, previewText(row.body))))
    : [h('section', { class: 'hero-card' }, h('div', { class: 'eyebrow' }, 'A private time capsule'), h('div', { class: 'big small-big' }, `Letters to ${babyName()}`), h('p', { class: 'sub' }, 'Write him something he’ll read someday. Only the two of you can see these.'))];
  mount('letters', { title: 'Letters', sub: `For ${babyName()}, from you`, main, dock: h('button', { class: 'stop-btn go', onclick: () => letterSheet(null) }, 'Write a letter') });
}
function letterRead(row) {
  const cur = () => S.rows.wb_letters.find((x) => x.id === row.id) || row;
  const r = cur();
  openSheet('Letter', h('div', { class: 'stack' },
    h('div', { class: 'memory-date' }, h('span', null, fmtDate(r.written_on, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })), whoName(r.created_by) ? h('span', { class: 'memory-by' }, whoName(r.created_by)) : null),
    h('p', { class: 'letter-body' }, r.body),
    h('button', { type: 'button', class: 'secondary block', onclick: () => letterSheet(r) }, 'Edit'),
    (() => {
      const del = h('button', { type: 'button', class: 'ghost danger block' }, 'Delete letter');
      del.addEventListener('click', () => confirmDelete(del, 'letter', () => { remove('wb_letters', r.id); closeSheet(); render(); toast('Letter deleted'); }));
      return del;
    })()));
}
function letterSheet(row) {
  const isNew = !row;
  const base = row || { id: uuid(), written_on: localDay(), body: '' };
  const date = h('input', { type: 'date', value: base.written_on, max: localDay() });
  const body = h('textarea', { maxlength: '10000', rows: '12', placeholder: `Dear ${babyName()},…` }, base.body || '');
  const btn = h('button', { class: 'block big' }, isNew ? 'Save letter' : 'Save');
  btn.addEventListener('click', () => {
    const text = body.value.trim();
    if (!text) return toast('Write a few words for him.', true);
    save('wb_letters', { ...base, written_on: date.value || localDay(), body: text, ...(isNew ? { created_by: S.session.user.id, created_at: isoNow() } : {}) });
    closeSheet(); render(); toast(isNew ? 'Letter saved 💙' : 'Saved');
  });
  openSheet(isNew ? 'New letter' : 'Edit letter', h('div', { class: 'stack' }, field('Date', date), field('Letter', body), btn));
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

/* ================= Settings ================= */
async function saveFamily(patch) {
  const prev = S.family;
  S.family = { ...S.family, ...patch }; saveCache(); render();
  const { error } = await sb.from('wb_family').update(patch).eq('id', 1);
  if (error) { S.family = prev; render(); toast(friendlyError(error), true); }
}
function renderSettings() {
  const f = S.family;
  const name = h('input', { type: 'text', maxlength: '60', value: f.baby_name });
  const birth = h('input', { type: 'date', value: f.birth_date || '', max: localDay() });
  const babyCard = h('section', { class: 'card stack' }, h('h2', null, 'Baby'),
    h('div', { class: 'grid2' }, field('Name', name), field('Birthday', birth)),
    h('button', { class: 'secondary', onclick: () => { const n = name.value.trim(); if (!n) return toast('Name can’t be empty.', true); saveFamily({ baby_name: n, birth_date: birth.value || null }); toast('Saved'); } }, 'Save'));
  const unitsCard = h('section', { class: 'card stack' }, h('h2', null, 'Units & colors'),
    h('p', { class: 'small label' }, 'Growth'), seg([['lb', 'lb · in'], ['kg', 'kg · cm']], f.weight_unit, (k) => saveFamily({ weight_unit: k })),
    h('p', { class: 'small label' }, 'Colors (this phone)'), seg([['night', '🌙 Night'], ['day', '☀️ Day']], theme(), (k) => { localStorage.setItem('wb-theme', k); applyTheme(); render(); }));
  const acct = h('section', { class: 'card stack' }, h('h2', null, 'Account'),
    h('p', { class: 'small muted' }, `Signed in as ${S.parent.display_name} (${S.session.user.email}). Shared with ${S.parents.filter((p) => p.user_id !== S.parent.user_id).map((p) => p.display_name).join(' & ') || 'no one yet'}.`),
    outbox.length ? h('p', { class: 'small' }, `${outbox.length} change${outbox.length === 1 ? '' : 's'} waiting to sync.`) : null,
    h('button', { class: 'secondary block', onclick: async () => { await forgetPushSub(); await sb.auth.signOut(); location.hash = '#/photos'; } }, 'Sign out'));
  const helpCard = h('section', { class: 'card stack' }, h('h2', null, 'Install & setup'),
    h('p', { class: 'small muted' }, isStandalone() ? 'You’re using the Home Screen app. Here are the steps if the other phone needs them.' : 'Put Westley on your Home Screen so it opens like an app.'),
    h('button', { class: 'secondary block', onclick: () => installGuide() }, icon('phone'), 'How to install'));
  mount('settings', { title: 'Settings', sub: `${babyName()}’s Book`, main: [babyCard, notificationsCard(), familyLinkCard(), helpCard, unitsCard, acct] });
}

// Grandparents link: a read-only page with Memories only (date, words, photos, who wrote it).
function familyLinkCard() {
  const url = (t) => new URL(`family.html?k=${t}`, location.href.split('#')[0].replace(/[^/]*$/, '')).href;
  const box = h('input', { type: 'text', readonly: '', value: 'Loading…', 'aria-label': 'Grandparents link' });
  (async () => { const { data, error } = await sb.from('wb_share_links').select('token').eq('id', 1).maybeSingle(); box.value = error || !data ? 'Not available offline' : url(data.token); })();
  return h('section', { class: 'card stack' }, h('h2', null, 'Grandparents link'),
    h('p', { class: 'small muted' }, 'A view-only page with just your Memories and photos. Anyone with the link can see it.'),
    box,
    h('div', { class: 'grid2' },
      h('button', { class: 'secondary', onclick: async () => { if (!box.value.startsWith('http')) return; try { await navigator.clipboard.writeText(box.value); toast('Link copied'); } catch { box.select(); } } }, 'Copy link'),
      h('button', { class: 'secondary', onclick: async () => { if (!confirm('Make a new link? The old one will stop working.')) return; const { data, error } = await sb.rpc('wb_rotate_share_link'); if (error) return toast(friendlyError(error), true); box.value = url(data); toast('New link made'); } }, 'Reset link')));
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
      return body.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'chip on' }, 'On'), h('span', { class: 'small' }, 'This phone is set up for notifications.')), h('div', { class: 'row wrap' }, test, off));
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
      { icon: 'bell', title: 'Turn on notifications',
        text: 'Optional. Do this inside the Home Screen app, on each phone, if you’d like notifications.',
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
    const hash = new URL(e.data.url, location.href).hash || '#/photos';
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
