-- Grandparents' read-only family page: one secret token, parents only.
create table if not exists public.wb_share_links (
  id int primary key default 1 check (id = 1),
  token text not null,
  created_at timestamptz not null default now()
);
alter table public.wb_share_links enable row level security;
create policy wb_share_links_parents on public.wb_share_links for select to authenticated
  using ((select private.wb_is_parent()));
revoke all on public.wb_share_links from anon;

create or replace function public.wb_rotate_share_link() returns text
language plpgsql security definer set search_path = '' as $$
declare t text;
begin
  if not private.wb_is_parent() then raise exception 'not allowed'; end if;
  t := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  insert into public.wb_share_links (id, token, created_at) values (1, t, now())
    on conflict (id) do update set token = excluded.token, created_at = now();
  return t;
end $$;
revoke all on function public.wb_rotate_share_link() from public, anon;
grant execute on function public.wb_rotate_share_link() to authenticated;

insert into public.wb_share_links (id, token)
  values (1, translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_'))
  on conflict do nothing;
