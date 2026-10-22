-- Grandparents email updates: subscribers + "new photos" digest (pg_cron -> wb-family-email).
create table if not exists public.wb_family_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  unsub_token text not null default translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/=', '-_'),
  created_at timestamptz not null default now(),
  constraint wb_family_subscribers_email_ok check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(email) <= 254)
);
create unique index if not exists wb_family_subscribers_email_uq on public.wb_family_subscribers (lower(email));
create unique index if not exists wb_family_subscribers_unsub_uq on public.wb_family_subscribers (unsub_token);
alter table public.wb_family_subscribers enable row level security;
revoke all on public.wb_family_subscribers from anon;
revoke all on public.wb_family_subscribers from authenticated;
grant select (id, email, created_at), delete on public.wb_family_subscribers to authenticated;
create policy wb_family_subscribers_read on public.wb_family_subscribers for select to authenticated
  using ((select private.wb_is_parent()));
create policy wb_family_subscribers_del on public.wb_family_subscribers for delete to authenticated
  using ((select private.wb_is_parent()));

-- watermark: memories created after this get announced (starts now, so old memories never email)
create table if not exists public.wb_family_email_state (
  id int primary key default 1 check (id = 1),
  last_sent_at timestamptz not null default now(),
  last_result jsonb
);
alter table public.wb_family_email_state enable row level security;
revoke all on public.wb_family_email_state from anon, authenticated;
insert into public.wb_family_email_state (id) values (1) on conflict do nothing;

-- every 5 min: if photo memories are pending and the newest is >=10 min old (quiet period), ask the function to send
create or replace function private.wb_family_email_tick() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_since timestamptz; v_newest timestamptz; v_secret text; v_req bigint;
begin
  select last_sent_at into v_since from public.wb_family_email_state where id = 1;
  select max(created_at) into v_newest from public.wb_memories
   where created_at > v_since and (coalesce(cardinality(photo_paths), 0) > 0 or photo_path is not null);
  if v_newest is null then return jsonb_build_object('skipped', 'nothing new'); end if;
  if v_newest > now() - interval '10 minutes' then return jsonb_build_object('skipped', 'waiting for quiet'); end if;
  if not exists (select 1 from public.wb_family_subscribers) then
    update public.wb_family_email_state set last_sent_at = v_newest, last_result = '{"skipped":"no subscribers"}' where id = 1;
    return jsonb_build_object('skipped', 'no subscribers');
  end if;
  select ds.decrypted_secret into v_secret from vault.decrypted_secrets ds where ds.name = 'wb_push_webhook_secret' limit 1;
  select net.http_post(
    url := 'https://voydoxmxdnjnewxlwzse.supabase.co/functions/v1/wb-family-email',
    body := jsonb_build_object('action', 'digest'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-wb-secret', v_secret),
    timeout_milliseconds := 20000) into v_req;
  return jsonb_build_object('called', v_req);
end $$;
revoke all on function private.wb_family_email_tick() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'wb-family-email';
select cron.schedule('wb-family-email', '*/5 * * * *', $$select private.wb_family_email_tick();$$);
