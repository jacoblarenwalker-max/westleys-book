// Read-only grandparents feed: memories (date, caption, author first name, 1h signed photo URLs) only.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (b: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), {
    status: s,
    headers: { ...cors, "Content-Type": "application/json", "X-Robots-Tag": "noindex", ...extra },
  });

function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "GET") return json({ error: "not found" }, 404);
  const k = new URL(req.url).searchParams.get("k") ?? "";
  if (k.length < 32 || k.length > 100) return json({ error: "not found" }, 404);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data: link } = await sb.from("wb_share_links").select("token").eq("id", 1).maybeSingle();
  if (!link || !same(link.token, k)) return json({ error: "not found" }, 404);

  const [{ data: mems, error }, { data: parents }] = await Promise.all([
    sb.from("wb_memories").select("id, happened_on, caption, photo_path, photo_paths, created_by, created_at")
      .order("happened_on", { ascending: false }).order("created_at", { ascending: false }).limit(500),
    sb.from("wb_parents").select("user_id, display_name"),
  ]);
  if (error) return json({ error: "unavailable" }, 500);
  const names = new Map((parents ?? []).map((p) => [p.user_id, String(p.display_name ?? "").trim().split(/\s+/)[0]]));

  const paths = new Set<string>();
  const perMem = (mems ?? []).map((m) => {
    const ps = (m.photo_paths?.length ? m.photo_paths : m.photo_path ? [m.photo_path] : []) as string[];
    ps.forEach((p) => paths.add(p));
    return ps;
  });
  const urls = new Map<string, string>();
  if (paths.size) {
    const { data: signed } = await sb.storage.from("wb-photos").createSignedUrls([...paths], 3600);
    (signed ?? []).forEach((s) => s.signedUrl && s.path && urls.set(s.path, s.signedUrl));
  }
  const memories = (mems ?? []).map((m, i) => ({
    date: m.happened_on,
    text: m.caption ?? "",
    author: names.get(m.created_by) || null,
    photos: perMem[i].map((p) => urls.get(p)).filter(Boolean),
  }));
  return json({ baby: "Westley", born: "2026-10-04", memories }, 200, { "Cache-Control": "private, max-age=300" });
});
