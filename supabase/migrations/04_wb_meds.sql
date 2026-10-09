-- Westley's Book: Meds tab (Oct 8 2026). Additive only: new wb_ tables, functions and one new pg_cron job.
-- Same access rule as everything else: only users in public.wb_parents can read or write.

-- 1) medications ------------------------------------------------------------------------------------------
--    schedule: 'interval' (every N hours, counted from the last dose), 'daily' (once a day at remind_at),
--    'every_other_day' (remind_at, two days after the last dose). Times are America/Denver.
create table if not exists public.wb_meds (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  for_whom text not null default 'Sophie' check (length(for_whom) between 1 and 40),
  schedule text not null check (schedule in ('interval', 'daily', 'every_other_day')),
  every_hours numeric(4,1) check (every_hours is null or every_hours between 0.5 and 72),
  remind_at time,
  reminders_on boolean not null default true,
  sort_order integer not null default 0,
  note text check (note is null or length(note) <= 1000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((schedule = 'interval' and every_hours is not null) or (schedule <> 'interval' and remind_at is not null))
);

create table if not exists public.wb_med_doses (
  id uuid primary key default gen_random_uuid(),
  med_id uuid not null references public.wb_meds(id) on delete cascade,
  taken_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wb_med_doses_med_idx on public.wb_med_doses (med_id, taken_at desc);
create index if not exists wb_med_doses_taken_idx on public.wb_med_doses (taken_at desc);

do $$
declare t text;
begin
  foreach t in array array['wb_meds', 'wb_med_doses'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_parents', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select private.wb_is_parent())) with check ((select private.wb_is_parent()))', t || '_parents', t);
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.wb_touch()', t || '_touch', t);
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- the six meds Jacob listed (only if the table is empty; no dose history is preloaded)
insert into public.wb_meds (name, for_whom, schedule, every_hours, remind_at, sort_order)
select v.name, v.for_whom, v.schedule, v.every_hours, v.remind_at, v.sort_order
from (values
  ('Ibuprofen',          'Sophie',  'interval',        8::numeric, null::time, 1),
  ('Hydrocodone',        'Sophie',  'interval',        4,          null,       2),
  ('Colace',             'Sophie',  'daily',           null,       '20:00',    3),
  ('Iron',               'Sophie',  'every_other_day', null,       '09:00',    4),
  ('Sophie’s vitamin',   'Sophie',  'daily',           null,       '09:00',    5),
  ('Westley’s vitamin',  'Westley', 'daily',           null,       '09:00',    6)
) v(name, for_whom, schedule, every_hours, remind_at, sort_order)
where not exists (select 1 from public.wb_meds);

-- 2) when is the next dose due? (pure; mirrored in app.js medDue())
create or replace function private.wb_med_due_at(p_schedule text, p_every_hours numeric, p_remind_at time,
                                                 p_last timestamptz, p_now timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case p_schedule
    when 'interval' then p_last + make_interval(secs => (p_every_hours * 3600)::double precision)
    when 'daily' then
      ((((p_now at time zone 'America/Denver')::date
         + case when p_last is not null
                 and (p_last at time zone 'America/Denver')::date >= (p_now at time zone 'America/Denver')::date
                then 1 else 0 end) + p_remind_at)::timestamp at time zone 'America/Denver')
    when 'every_other_day' then
      (((coalesce((p_last at time zone 'America/Denver')::date + 2, (p_now at time zone 'America/Denver')::date))
        + p_remind_at)::timestamp at time zone 'America/Denver')
  end;
$$;
revoke all on function private.wb_med_due_at(text, numeric, time, timestamptz, timestamptz) from public, anon, authenticated;

-- 3) one reminder per med per due time (de-duplication + small log); no client access
create table if not exists public.wb_med_reminders (
  med_id uuid not null references public.wb_meds(id) on delete cascade,
  due_at timestamptz not null,
  title text not null,
  body text not null,
  dry_run boolean not null default false,
  request_id bigint,
  created_at timestamptz not null default now(),
  primary key (med_id, due_at)
);
alter table public.wb_med_reminders enable row level security;
revoke all on public.wb_med_reminders from anon, authenticated;

-- 4) send every reminder that's due now (within 3 hours of its due time, so turning one on never sends stale
--    ones). p_mode: 'send' | 'plan' (returns what it would send, writes nothing) | 'dry_run'.
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
  v_secret text;
  v_req bigint;
  v_checked boolean := false;
begin
  if p_mode not in ('send', 'plan', 'dry_run') then raise exception 'bad mode %', p_mode; end if;
  for r in
    select m.id, m.name, m.for_whom, m.schedule, d.last_at,
           private.wb_med_due_at(m.schedule, m.every_hours, m.remind_at, d.last_at, p_now) as due_at
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

-- doses that were already due before this feature existed never trigger a reminder (no surprise pushes at launch)
insert into public.wb_med_reminders (med_id, due_at, title, body, dry_run)
select m.id, private.wb_med_due_at(m.schedule, m.every_hours, m.remind_at, null, now()), 'setup', 'skipped: due before Meds existed', true
  from public.wb_meds m
 where private.wb_med_due_at(m.schedule, m.every_hours, m.remind_at, null, now()) <= now()
on conflict do nothing;

-- 5) every 5 minutes, alongside wb-feed-reminders
select cron.unschedule(jobid) from cron.job where jobname = 'wb-med-reminders';
select cron.schedule('wb-med-reminders', '*/5 * * * *', $$select private.wb_send_med_reminders();$$);
