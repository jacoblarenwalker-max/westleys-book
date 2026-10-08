-- Westley's Book: Web Push + feeding reminders (free plan: pg_cron + pg_net + Vault + one Edge Function).
-- Additive only. Secrets live in Vault under wb_ names; the wb-push Edge Function holds the VAPID private key
-- (created inside Supabase by its one-time `init`, never in the repo).

-- 1) a device's push subscription (one per phone/browser), owned by the signed-in parent
create table if not exists public.wb_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://'),
  keys jsonb not null check (jsonb_typeof(keys) = 'object' and keys ? 'p256dh' and keys ? 'auth'),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_success_at timestamptz
);
create index if not exists wb_push_subscriptions_user_idx on public.wb_push_subscriptions (user_id);
alter table public.wb_push_subscriptions enable row level security;
revoke all on public.wb_push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.wb_push_subscriptions to authenticated;
drop policy if exists wb_push_subscriptions_select on public.wb_push_subscriptions;
create policy wb_push_subscriptions_select on public.wb_push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists wb_push_subscriptions_insert on public.wb_push_subscriptions;
create policy wb_push_subscriptions_insert on public.wb_push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.wb_is_parent()));
drop policy if exists wb_push_subscriptions_update on public.wb_push_subscriptions;
create policy wb_push_subscriptions_update on public.wb_push_subscriptions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (select private.wb_is_parent()));
drop policy if exists wb_push_subscriptions_delete on public.wb_push_subscriptions;
create policy wb_push_subscriptions_delete on public.wb_push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

-- 2) one reminder per feeding (de-duplication + small log); no client access
create table if not exists public.wb_feed_reminders (
  feeding_id uuid primary key references public.wb_feedings(id) on delete cascade,
  due_at timestamptz not null,
  title text not null,
  body text not null,
  dry_run boolean not null default false,
  request_id bigint,
  created_at timestamptz not null default now()
);
alter table public.wb_feed_reminders enable row level security;
revoke all on public.wb_feed_reminders from anon, authenticated;

-- 3) the reminder for "now": the last feed started more than feed_reminder_minutes ago, no feed is running,
--    and it's not stale (a feed older than interval + 3h never triggers one, e.g. right after turning it on).
--    p_mode: 'send' (default) | 'plan' (returns what it would send, writes nothing) | 'dry_run' (whole path, the
--    Edge Function only counts devices).
create or replace function private.wb_send_feed_reminders(p_now timestamptz default now(), p_mode text default 'send')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  f public.wb_family;
  last_feed public.wb_feedings;
  v_due timestamptz;
  v_last_side text;
  v_next text;
  v_ago int;
  v_title text;
  v_body text;
  v_secret text;
  v_req bigint;
begin
  if p_mode not in ('send', 'plan', 'dry_run') then raise exception 'bad mode %', p_mode; end if;
  select * into f from public.wb_family where id = 1;
  if not found or not f.feed_reminder_enabled then
    return jsonb_build_object('skipped', 'reminders off');
  end if;
  if exists (select 1 from public.wb_feedings where ended_at is null and started_at > p_now - interval '6 hours') then
    return jsonb_build_object('skipped', 'a feed is in progress');
  end if;
  select * into last_feed from public.wb_feedings where started_at <= p_now order by started_at desc limit 1;
  if not found then
    return jsonb_build_object('skipped', 'no feeds yet');
  end if;
  v_due := last_feed.started_at + make_interval(mins => f.feed_reminder_minutes);
  if p_now < v_due then
    return jsonb_build_object('skipped', 'not due yet', 'due_at', v_due);
  end if;
  if p_now > v_due + interval '3 hours' then
    return jsonb_build_object('skipped', 'last feed too old', 'due_at', v_due);
  end if;
  if exists (select 1 from public.wb_feed_reminders r where r.feeding_id = last_feed.id) then
    return jsonb_build_object('skipped', 'already reminded', 'feeding_id', last_feed.id);
  end if;

  select s->>'side' into v_last_side
    from jsonb_array_elements(last_feed.segments) with ordinality as x(s, i)
   where s->>'side' in ('L', 'R') order by i desc limit 1;
  v_next := case v_last_side when 'L' then 'right' when 'R' then 'left' end;
  v_ago := floor(extract(epoch from (p_now - last_feed.started_at)) / 60);
  v_title := 'Time to feed ' || f.baby_name || '? 🍼';
  v_body := 'Last feed started ' || (v_ago / 60) || 'h ' || lpad((v_ago % 60)::text, 2, '0') || 'm ago ('
            || to_char(last_feed.started_at at time zone 'America/Denver', 'FMHH12:MI AM') || ').'
            || coalesce(' Next side: ' || v_next || '.', '');

  if p_mode = 'plan' then
    return jsonb_build_object('would_send', true, 'feeding_id', last_feed.id, 'due_at', v_due, 'title', v_title, 'body', v_body);
  end if;
  if not exists (select 1 from public.wb_push_subscriptions s join public.wb_parents p on p.user_id = s.user_id) then
    return jsonb_build_object('skipped', 'no devices with notifications on');
  end if;
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'wb_push_webhook_secret' limit 1;
  if v_secret is null then
    return jsonb_build_object('skipped', 'wb_push_webhook_secret missing');
  end if;
  -- claim first so an overlapping run can't send twice
  insert into public.wb_feed_reminders (feeding_id, due_at, title, body, dry_run)
  values (last_feed.id, v_due, v_title, v_body, p_mode = 'dry_run')
  on conflict do nothing;
  if not found then
    return jsonb_build_object('skipped', 'already reminded', 'feeding_id', last_feed.id);
  end if;
  select net.http_post(
    url := 'https://voydoxmxdnjnewxlwzse.supabase.co/functions/v1/wb-push',
    body := jsonb_build_object('action', 'feed_reminder', 'feeding_id', last_feed.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-wb-secret', v_secret),
    timeout_milliseconds := 10000) into v_req;
  update public.wb_feed_reminders set request_id = v_req where feeding_id = last_feed.id;
  return jsonb_build_object('sent', true, 'feeding_id', last_feed.id, 'request_id', v_req, 'dry_run', p_mode = 'dry_run');
end;
$$;
revoke all on function private.wb_send_feed_reminders(timestamptz, text) from public, anon, authenticated;

-- 4) shared secret between the database and the wb-push Edge Function (random, generated inside the database)
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'wb_push_webhook_secret',
                           'Westley''s Book: x-wb-secret header for the wb-push Edge Function')
where not exists (select 1 from vault.secrets where name = 'wb_push_webhook_secret');

-- 5) every 5 minutes (cheap: a few indexed reads; only calls the Edge Function when a reminder is due)
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'wb-feed-reminders';
select cron.schedule('wb-feed-reminders', '*/5 * * * *', $$select private.wb_send_feed_reminders();$$);
