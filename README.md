# Westley’s Book

A small, private, phone-first baby book for Jacob and Sophie and their son Westley. Memories come first:
photos, firsts, and letters he’ll read someday. Built to be used one-handed.

Plain static site (HTML/CSS/JS, [supabase-js](https://github.com/supabase/supabase-js) pinned from jsDelivr) on
GitHub Pages, backed by the **household-meals** Supabase project (`voydoxmxdnjnewxlwzse`). Everything Westley’s Book
adds there is prefixed `wb_` / `wb-` and nothing from household-meals was changed. All free tier.

**Live:** https://jacoblarenwalker-max.github.io/westleys-book/

## Screens (bottom tabs, big buttons in thumb reach)

- **Memories** (home): a photo-first timeline grouped by month. Each memory shows Westley’s age that day
  (“3 weeks old”, “1 month old”), who saved it, a heart from Jake and/or Sophie, and short comments.
  The latest photo opens the book; when a memory falls on this date last week, last month, or last year, an
  “On this day” card looks back. Each month with a few photos has a **Recap** slideshow. Add up to 10 photos
  at once (resized on the phone to max 2048 px JPEG at quality ~0.8, no video) with progress; tapping a photo
  opens a swipeable full-screen viewer with pinch or double-tap to zoom.
- **Firsts**: monthly portrait slots (“Westley at 1 month” through 12 months) plus a first-year checklist
  (first smile, laugh, rolling over, and so on — no medical content). Each first can be dated and linked to a memory.
- **Letters**: a private time capsule. Both parents can write letters to Westley; they never appear on the
  grandparents’ page.
- **Doctor**: four simple tabs: **Questions** for the next visit (check them off, add the answer),
  **Growth** (weight / length / head with small line charts and change since last time), **Shots**, **Visits**.
- **Settings** (gear): baby name + birthday (shows his age in the header), growth units, Night/Day colors,
  notifications for this phone, the grandparents’ link, sign out.

The **Feed**, **Diapers**, **Meds** and **Sleep** tabs have been retired so Memories can come first. Their tables
and every row are still in the database; nothing was deleted. Feeding and medication reminder crons
(`wb-feed-reminders`, `wb-med-reminders`) were unscheduled.

**Night** colors (dim navy, no bright white) are the default; the ☀️/🌙 button in the header switches to **Day**,
which is the household-meals look (baby blue band, white cards, beige accents).

## Reliability

- Every change is shown immediately and kept in a small **outbox** (localStorage) until Supabase confirms it, so a
  change logged with no signal is never lost; it syncs when the phone is back online. Ids are made on the phone, so
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

## Database (`supabase/migrations/`, applied as `wb_schema`, `wb_push_reminders`, …, `wb_memories_book`)

| table | what |
|---|---|
| `wb_parents` | allowlist (`user_id`, `email`, `display_name`) |
| `wb_family` | one row: `baby_name`, `birth_date`, `feed_reminder_enabled`, `feed_reminder_minutes`, `volume_unit`, `weight_unit` |
| `wb_feedings` | `started_at`, `ended_at` (null = running), `segments` `[{side: L/R, start, end}]`, `bottle_ml`, `bottle_kind`, `note` |
| `wb_diapers` | `at`, `kind` (wet/dirty/both/dry), `note` |
| `wb_sleeps` | `started_at`, `ended_at` (null = asleep), `note`. The Sleep tab was retired Oct 9 2026; the table and its data are kept, the app no longer reads it. |
| `wb_memories` | `happened_on`, `caption`, `photo_paths` (up to 10 `<uuid>.jpg` in `wb-photos`; `photo_path` = the first one, and older memories only have `photo_path`), `created_by` (the author, set by the server on insert and never changed) |
| `wb_memory_hearts` | one heart per parent per memory (`memory_id`, `user_id`) |
| `wb_memory_comments` | short notes on a memory (`body` up to 400 characters, author frozen) |
| `wb_firsts` | marked firsts (`id` = slug such as `smile`, optional `memory_id`, `happened_on`, `note`) |
| `wb_month_portraits` | `id` 1–12, linked `memory_id` + `photo_path` for “Westley at N months” |
| `wb_letters` | private letters (`written_on`, `body`, author frozen) |
| `wb_visits`, `wb_growth` (`weight_g`, `length_cm`, `head_cm`), `wb_vaccines`, `wb_questions` | doctor |
| `wb_push_subscriptions` | one row per phone (each user sees only their own) |
| `wb_feed_reminders` | one row per feed that got a reminder (de-dupe + log; no client access). The cron was unscheduled; the table stays. |

## Notifications (Web Push, free)

Feeding and medication reminder crons (`wb-feed-reminders`, `wb-med-reminders`) were unscheduled when those tabs
were retired. The `wb-push` Edge Function, VAPID keys in Vault, and `wb_push_subscriptions` stay in place so a
signed-in parent can still send themselves a test from Settings. The reminder functions and history tables were
not deleted.

iPhone: needs iOS 16.4+. In Safari: Share → **Add to Home Screen**, open **Westley** from the Home Screen, sign in,
then Settings → **Turn on notifications** → Allow.

## Icons

White **W** with a beige heart and a flat navy shadow on solid baby blue (same style as the Meals icon).
`icon.svg` (rounded, “any”), `icon-full.svg` (source of `apple-touch-icon.png`), `icon-maskable.svg`, with PNG
exports. Every reference carries `?v=wb1`; bump it (and `VERSION` in `sw.js`) when assets change.

## Local development

`python3 -m http.server 8765` in this folder, then open http://127.0.0.1:8765/ (that origin is allowed by `wb-push`).
