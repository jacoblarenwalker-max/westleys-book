// wb-family-email: grandparents' "new photos of Westley" email updates.
//   public  POST {action:'subscribe', k, email}   (k = current family link token)
//   public  POST {action:'unsubscribe', u}        (u = per-subscriber secret from the email)
//   cron    POST {action:'digest'} + x-wb-secret  (one email per batch of new photo memories)
// Email provider: Brevo free tier. Needs Edge Function secrets BREVO_API_KEY and BREVO_SENDER_EMAIL (a Brevo-verified sender).
import postgres from "npm:postgres@3.4.5";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2, idle_timeout: 20 });
const SITE = "https://jacoblarenwalker-max.github.io/westleys-book/family.html";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
function same(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function token() { const r = await sql`select token from public.wb_share_links where id = 1`; return r[0]?.token as string | undefined; }

async function digest() {
  const key = Deno.env.get("BREVO_API_KEY"), from = Deno.env.get("BREVO_SENDER_EMAIL");
  if (!key || !from) return { skipped: "email provider not set up" };
  const [st] = await sql`select last_sent_at from public.wb_family_email_state where id = 1`;
  const mems = await sql`select happened_on, caption, created_at, coalesce(cardinality(photo_paths),0) + (case when photo_path is not null and coalesce(cardinality(photo_paths),0)=0 then 1 else 0 end) as n
    from public.wb_memories where created_at > ${st.last_sent_at} and (coalesce(cardinality(photo_paths),0) > 0 or photo_path is not null) order by created_at`;
  if (!mems.length) return { skipped: "nothing new" };
  const newest = mems[mems.length - 1].created_at;
  if (Date.now() - new Date(newest).getTime() < 9 * 60e3) return { skipped: "waiting for quiet" };
  // claim the batch first so overlapping runs can't double-send
  const claimed = await sql`update public.wb_family_email_state set last_sent_at = ${newest} where id = 1 and last_sent_at = ${st.last_sent_at} returning 1`;
  if (!claimed.length) return { skipped: "already sent" };
  const tok = await token(); if (!tok) return { skipped: "no link" };
  const link = `${SITE}?k=${encodeURIComponent(tok)}`;
  const photos = mems.reduce((a, m) => a + Number(m.n), 0);
  const fmt = (d: string | Date) => new Date(String(d).slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const items = mems.map((m) => `<li style="margin:0 0 10px"><b>${esc(fmt(m.happened_on instanceof Date ? m.happened_on.toISOString() : m.happened_on))}</b>${m.caption ? "<br>" + esc(String(m.caption)).slice(0, 300) : ""}</li>`).join("");
  const subject = photos === 1 ? "A new photo of Westley 💙" : "New photos of Westley 💙";
  const subs = await sql`select email, unsub_token from public.wb_family_subscribers`;
  let sent = 0, failed = 0;
  for (const s of subs) {
    const unsub = `${SITE}?unsub=${encodeURIComponent(s.unsub_token)}`;
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;color:#1C2A3F">
<h2 style="color:#1B5E96;margin:0 0 8px">🌙 New photos of Westley</h2>
<p>Daddy and Momma just added ${photos === 1 ? "a new photo" : photos + " new photos"}.</p><ul style="padding-left:18px">${items}</ul>
<p><a href="${link}" style="display:inline-block;background:#4BA3E3;color:#0F2747;padding:12px 20px;border-radius:99px;text-decoration:none;font-weight:700">See the photos</a></p>
<p style="font-size:12px;color:#505B6B;margin-top:28px">Made with love from Daddy and Momma. <a href="${unsub}" style="color:#505B6B">Unsubscribe</a></p></div>`;
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", headers: { "api-key": key, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "Westley's Book", email: from }, to: [{ email: s.email }], subject, htmlContent: html,
        headers: { "List-Unsubscribe": `<${unsub}>` } }),
    });
    r.ok ? sent++ : failed++;
    if (!r.ok) console.log("brevo", r.status, (await r.text()).slice(0, 200));
  }
  const res = { sent, failed, memories: mems.length };
  await sql`update public.wb_family_email_state set last_result = ${sql.json(res)} where id = 1`;
  return res;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "not found" }, 404);
  let b: Record<string, any> = {};
  try { b = await req.json(); } catch { return json({ error: "bad request" }, 400); }
  try {
    if (b.action === "subscribe") {
      const k = String(b.k ?? ""), email = String(b.email ?? "").trim().toLowerCase();
      const t = await token();
      if (!t || k.length < 32 || !same(t, k)) return json({ error: "not found" }, 404);
      if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "bad email" }, 400);
      const [{ n }] = await sql`select count(*)::int n from public.wb_family_subscribers`;
      if (n >= 50) return json({ error: "full" }, 429);
      await sql`insert into public.wb_family_subscribers (email) values (${email}) on conflict ((lower(email))) do nothing`;
      return json({ ok: true });
    }
    if (b.action === "unsubscribe") {
      const u = String(b.u ?? "");
      if (u.length < 20) return json({ error: "not found" }, 404);
      await sql`delete from public.wb_family_subscribers where unsub_token = ${u}`;
      return json({ ok: true });
    }
    if (b.action === "digest") {
      const given = req.headers.get("x-wb-secret") || "";
      const [v] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'wb_push_webhook_secret' limit 1`;
      if (!given || !v || !same(given, v.decrypted_secret)) return json({ error: "unauthorized" }, 401);
      return json(await digest());
    }
    return json({ error: "not found" }, 404);
  } catch (e) { console.log(e); return json({ error: "unavailable" }, 500); }
});
