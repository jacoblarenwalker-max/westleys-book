# Westley’s Book

A small, private, phone-first baby tracker for Jacob and Sophie and their son Westley. Feeding comes first:
one tap starts the timer, one tap switches sides, one tap stops. Built to be used one-handed at 3 AM.

Plain static site (HTML/CSS/JS, [supabase-js](https://github.com/supabase/supabase-js) pinned from jsDelivr) on
GitHub Pages, backed by the **household-meals** Supabase project (`voydoxmxdnjnewxlwzse`). Everything Westley’s Book
adds there is prefixed `wb_` / `wb-` and nothing from household-meals was changed. All free tier.

**Live:** https://jacoblarenwalker-max.github.io/westleys-book/

## Screens (bottom tabs, big buttons in thumb reach)

- **Feed** (home): “Westley last ate *2h 14m ago*”, the time, sides and length of that feed, **Last side** and
  **Next** (the other side). Big **L / R / Bottle** buttons; the suggested side is highlighted. While feeding:
  a running clock, per-side clocks, tap the other letter to **switch sides**, **+ Bottle** for a top-up, and a
  big **Stop feeding** (with Undo). Today’s totals (feeds, minutes, left/right minutes, bottle volume), today’s
  list (tap to edit/delete), **+ Add past feed** for forgotten ones, and earlier days on demand.
  - The running feed is a database row with `ended_at = null`, so it survives closing the app and both phones
    see the same timer. Bottle = amount (oz or mL presets), breast milk or formula, logged instantly.
- **Diapers**: one tap **Wet / Dirty / Both** (with Undo), last change, today’s counts, edit or add earlier.
- **Sleep**: one big **Start sleep / Westley woke up** button, awake-since, today’s total and longest stretch.
- **Memories**: a timeline by month with photos and captions (with “Week 2”-style age tags once the birthday is
  set). **Add photo** (camera or library; shrunk on the phone to ≤ 2048 px JPEG) or **Write a note**.
- **Doctor**: four simple tabs: **Questions** for the next visit (check them off, add the answer),
  **Growth** (weight / length / head with small line charts and change since last time), **Shots**, **Visits**.
- **Settings** (gear): baby name + birthday (shows his age in the header), feeding reminder
  (Off / 2h / 2½h / 3h / 3½h / 4h after the last feed *started*), units (oz/mL, lb·in/kg·cm), Night/Day colors,
  notifications for this phone, sign out.

**Night** colors (dim navy, no bright white) are the default; the ☀️/🌙 button in the header switches to **Day**,
which is the household-meals look (baby blue band, white cards, beige accents).

## Reliability

- Every change is shown immediately and kept in a small **outbox** (localStorage) until Supabase confirms it, so a
  feed logged with no signal is never lost; it syncs when the phone is back online. Ids are made on the phone, so
  retries are safe.
- The last data is cached on the phone, so the app opens instantly (and offline).
- **Realtime**: both phones update live (Supabase Realtime, RLS applies). On reconnect the app re-syncs.
- `sw.js` caches the app shell (network-first) and the pinned supabase-js module, and shows push notifications.
  It never caches Supabase API data.

## Sign in & privacy

- Same accounts as the Meals app (email + password). Only users listed in `public.wb_parents` (Jacob and Sophie,
  seeded by email) can read or write anything; anyone else who signs in sees “This book is private”.
- Every `wb_` table has RLS `using/with check private.wb_is_parent()`; anon has no grants. Photos live in the
  **private** bucket `wb-photos` (JPEG only, 5 MB cap) and are shown with 1-hour signed URLs.
- It shares the `jacoblarenwalker-max.github.io` origin and the Supabase project with the Meals app, so in a
  regular browser tab you're already signed in if Meals is (and signing out of one signs out of the other there).
  Home Screen apps on iPhone keep their own sign-in.
- `config.js` only has the Supabase URL, the publishable key and the VAPID **public** key.

## Database (`supabase/migrations/`, applied as `wb_schema` and `wb_push_reminders`)

| table | what |
|---|---|
| `wb_parents` | allowlist (`user_id`, `email`, `display_name`) |
| `wb_family` | one row: `baby_name`, `birth_date`, `feed_reminder_enabled`, `feed_reminder_minutes`, `volume_unit`, `weight_unit` |
| `wb_feedings` | `started_at`, `ended_at` (null = running), `segments` `[{side: L/R, start, end}]`, `bottle_ml`, `bottle_kind`, `note` |
| `wb_diapers` | `at`, `kind` (wet/dirty/both/dry), `note` |
| `wb_sleeps` | `started_at`, `ended_at` (null = asleep), `note` |
| `wb_memories` | `happened_on`, `caption`, `photo_path` (`<uuid>.jpg` in `wb-photos`) |
| `wb_visits`, `wb_growth` (`weight_g`, `length_cm`, `head_cm`), `wb_vaccines`, `wb_questions` | doctor |
| `wb_push_subscriptions` | one row per phone (each user sees only their own) |
| `wb_feed_reminders` | one row per feed that got a reminder (de-dupe + log; no client access) |

## Feeding reminders (Web Push, free)

pg_cron job **`wb-feed-reminders`** runs `select private.wb_send_feed_reminders();` every 5 minutes. It sends one
reminder per feed when the last feed *started* `feed_reminder_minutes` ago, no feed is running, and that feed isn’t
older than the interval + 3 hours. It claims the feed in `wb_feed_reminders`, then calls the Edge Function
**`wb-push`** through pg_net with a shared secret from Vault (`wb_push_webhook_secret`). `wb-push` signs VAPID JWTs and
encrypts payloads (RFC 8291) with the private key in Vault (`wb_push_vapid_private_jwk`, created inside Supabase by
the function’s one-time `init`; never in this repo) and sends to every parent’s phone. Expired subscriptions are
removed. Signed-in parents can also send themselves a test from Settings.

Checking it (SQL editor):
```sql
select private.wb_send_feed_reminders(now() + interval '3 hours', 'plan');     -- what would be sent, writes nothing
select * from public.wb_feed_reminders order by created_at desc;               -- history
select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'wb-feed-reminders')
order by start_time desc limit 20;
```

iPhone: needs iOS 16.4+. In Safari: Share → **Add to Home Screen**, open **Westley** from the Home Screen, sign in,
then Settings → **Turn on notifications** → Allow.

## Icons

White **W** with a beige heart and a flat navy shadow on solid baby blue (same style as the Meals icon).
`icon.svg` (rounded, “any”), `icon-full.svg` (source of `apple-touch-icon.png`), `icon-maskable.svg`, with PNG
exports. Every reference carries `?v=wb1`; bump it (and `VERSION` in `sw.js`) when assets change.

## Local development

`python3 -m http.server 8765` in this folder, then open http://127.0.0.1:8765/ (that origin is allowed by `wb-push`).
