-- Westley's Book (Oct 9 2026): twice-daily meds (morning + night), and Colace moves to it.
-- Additive: one new nullable column, two widened CHECK constraints (existing rows all still satisfy them),
-- one new helper function and a replaced reminder function. No dose is touched.

-- 1) schema -------------------------------------------------------------------------------------------------
alter table public.wb_meds add column if not exists remind_at2 time;
alter table public.wb_meds drop constraint if exists wb_meds_schedule_check;
alter table public.wb_meds add constraint wb_meds_schedule_check
  check (schedule in ('interval', 'daily', 'every_other_day', 'twice_daily'));
alter table public.wb_meds drop constraint if exists wb_meds_check;
alter table public.wb_meds add constraint wb_meds_check check (
  (schedule = 'interval' and every_hours is not null)
  or (schedule in ('daily', 'every_other_day') and remind_at is not null)
  or (schedule = 'twice_daily' and remind_at is not null and remind_at2 is not null and remind_at <> remind_at2));

-- 2) next due time for a twice-daily med (Denver time). Today's two slots are the earlier / later reminder time.
--    A dose taken today before the midpoint of the two slots counts for the morning slot, otherwise the night slot.
--    Next due = morning slot (if neither it nor the night slot is done and it's before the midpoint), else the
--    night slot, else tomorrow's morning slot once the night dose is taken. Mirrored in app.js twiceState().
create or replace function private.wb_twice_due_at(p_med_id uuid, p_a time, p_b time, p_now timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  tz constant text := 'America/Denver';
  d date := (p_now at time zone tz)::date;
  t1 timestamptz := (d + least(p_a, p_b))::timestamp at time zone tz;
  t2 timestamptz := (d + greatest(p_a, p_b))::timestamp at time zone tz;
  mid timestamptz;
  m_done boolean; n_done boolean;
begin
  mid := t1 + (t2 - t1) / 2;
  select coalesce(bool_or(x.taken_at < mid), false), coalesce(bool_or(x.taken_at >= mid), false)
    into m_done, n_done
    from public.wb_med_doses x
   where x.med_id = p_med_id and x.taken_at <= p_now
     and x.taken_at >= (d::timestamp at time zone tz) and x.taken_at < ((d + 1)::timestamp at time zone tz);
  if n_done then return ((d + 1) + least(p_a, p_b))::timestamp at time zone tz; end if;
  if m_done or p_now >= mid then return t2; end if;
  return t1;
end;
$$;
revoke all on function private.wb_twice_due_at(uuid, time, time, timestamptz) from public, anon, authenticated;

-- 3) reminders: same as before, plus twice_daily (one push per slot: "morning dose" / "night dose")
create or replace function private.wb_send_med_reminders(p_now timestamptz default now(), p_mode text default 'send')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_out jsonb := '[]'::jsonb;
  v_title text;
  v_body text;
  v_ago int;
  v_slot text;
  v_secret text;
  v_req bigint;
  v_checked boolean := false;
begin
  if p_mode not in ('send', 'plan', 'dry_run') then raise exception 'bad mode %', p_mode; end if;
  for r in
    select m.id, m.name, m.for_whom, m.schedule, m.remind_at, m.remind_at2, d.last_at,
           case when m.schedule = 'twice_daily'
                then private.wb_twice_due_at(m.id, m.remind_at, m.remind_at2, p_now)
                else private.wb_med_due_at(m.schedule, m.every_hours, m.remind_at, d.last_at, p_now) end as due_at
      from public.wb_meds m
      left join lateral (select max(x.taken_at) as last_at from public.wb_med_doses x
                          where x.med_id = m.id and x.taken_at <= p_now) d on true
     where m.reminders_on
     order by m.sort_order, m.created_at
  loop
    continue when r.due_at is null or p_now < r.due_at or p_now >= r.due_at + interval '3 hours';
    continue when exists (select 1 from public.wb_med_reminders x where x.med_id = r.id and x.due_at = r.due_at);
    v_title := '💊 ' || r.name
               || case when position(lower(r.for_whom) in lower(r.name)) > 0 then '' else ' for ' || r.for_whom end;
    if r.schedule = 'interval' then
      v_ago := floor(extract(epoch from (p_now - r.last_at)) / 60);
      v_body := 'Due now. Last dose ' || (v_ago / 60) || 'h ' || lpad((v_ago % 60)::text, 2, '0') || 'm ago ('
                || to_char(r.last_at at time zone 'America/Denver', 'FMHH12:MI AM') || ').';
    elsif r.schedule = 'twice_daily' then
      v_slot := case when (r.due_at at time zone 'America/Denver')::time = least(r.remind_at, r.remind_at2) then 'morning' else 'night' end;
      v_body := 'Time for the ' || v_slot || ' dose (' || to_char(r.due_at at time zone 'America/Denver', 'FMHH12:MI AM') || ').';
    else
      v_body := 'Time for today’s dose (' || to_char(r.due_at at time zone 'America/Denver', 'FMHH12:MI AM') || ').';
    end if;
    if p_mode = 'plan' then
      v_out := v_out || jsonb_build_object('med_id', r.id, 'due_at', r.due_at, 'title', v_title, 'body', v_body);
      continue;
    end if;
    if not v_checked then
      if not exists (select 1 from public.wb_push_subscriptions s join public.wb_parents p on p.user_id = s.user_id) then
        return jsonb_build_object('skipped', 'no devices with notifications on');
      end if;
      select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'wb_push_webhook_secret' limit 1;
      if v_secret is null then return jsonb_build_object('skipped', 'wb_push_webhook_secret missing'); end if;
      v_checked := true;
    end if;
    insert into public.wb_med_reminders (med_id, due_at, title, body, dry_run)
    values (r.id, r.due_at, v_title, v_body, p_mode = 'dry_run')
    on conflict do nothing;
    continue when not found;
    select net.http_post(
      url := 'https://voydoxmxdnjnewxlwzse.supabase.co/functions/v1/wb-push',
      body := jsonb_build_object('action', 'med_reminder', 'med_id', r.id, 'due_at', r.due_at),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-wb-secret', v_secret),
      timeout_milliseconds := 10000) into v_req;
    update public.wb_med_reminders set request_id = v_req where med_id = r.id and due_at = r.due_at;
    v_out := v_out || jsonb_build_object('med_id', r.id, 'due_at', r.due_at, 'request_id', v_req);
  end loop;
  return jsonb_build_object('mode', p_mode, 'reminders', v_out);
end;
$$;
revoke all on function private.wb_send_med_reminders(timestamptz, text) from public, anon, authenticated;

-- 4) Colace: morning 8:00 AM + night 8:00 PM (its dose history is untouched)
update public.wb_meds set schedule = 'twice_daily', remind_at = '08:00', remind_at2 = '20:00'
 where name = 'Colace' and for_whom = 'Sophie' and schedule = 'daily';

-- 5) no surprise push at deploy: any slot of today that is already due is marked handled (logged as dry-run)
insert into public.wb_med_reminders (med_id, due_at, title, body, dry_run)
select m.id, s.due, 'setup', 'skipped: slot already due when twice-daily was added', true
  from public.wb_meds m
 cross join lateral (values (((now() at time zone 'America/Denver')::date + least(m.remind_at, m.remind_at2))::timestamp at time zone 'America/Denver'),
                            (((now() at time zone 'America/Denver')::date + greatest(m.remind_at, m.remind_at2))::timestamp at time zone 'America/Denver')) s(due)
 where m.schedule = 'twice_daily' and s.due <= now()
on conflict do nothing;
