-- Westley's Book: the next feed starts on the side the last breast feed ENDED on (Jacob, Oct 8 2026).
-- Only replaces the reminder function's text; no table or row changes. Bottle-only feeds are ignored when
-- working out the side.
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
  v_start text;
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

  -- the final breast side of the most recent finished feed that had one (same rule as the app)
  select x.side into v_last_side
    from (
      select fd.started_at, s->>'side' as side, i
        from public.wb_feedings fd
        cross join lateral jsonb_array_elements(fd.segments) with ordinality as e(s, i)
       where fd.ended_at is not null and fd.started_at <= p_now and fd.started_at > p_now - interval '7 days'
         and s->>'side' in ('L', 'R')
    ) x
   order by x.started_at desc, x.i desc
   limit 1;
  v_start := case v_last_side when 'L' then 'left' when 'R' then 'right' end;
  v_ago := floor(extract(epoch from (p_now - last_feed.started_at)) / 60);
  v_title := 'Time to feed ' || f.baby_name || '? 🍼';
  v_body := 'Last feed started ' || (v_ago / 60) || 'h ' || lpad((v_ago % 60)::text, 2, '0') || 'm ago ('
            || to_char(last_feed.started_at at time zone 'America/Denver', 'FMHH12:MI AM') || ').'
            || coalesce(' Start on the ' || v_start || ' (where the last feed ended).', '');

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
