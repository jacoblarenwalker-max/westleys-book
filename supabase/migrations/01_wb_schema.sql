-- Westley's Book: baby tracker for Jacob + Sophie, living inside the household-meals Supabase project.
-- Purely additive: every object is new and prefixed wb_ / wb-; nothing from household-meals is changed.
-- Access: only users listed in public.wb_parents (Jacob and Sophie) can read or write any wb_ data.

-- 1) the allowlist ------------------------------------------------------------------------------------
create table if not exists public.wb_parents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text not null,
  created_at timestamptz not null default now()
);
alter table public.wb_parents enable row level security;
revoke all on public.wb_parents from anon, authenticated;
grant select on public.wb_parents to authenticated;

-- seed by email (no hard-coded ids): the two existing accounts
insert into public.wb_parents (user_id, email, display_name)
select u.id, lower(u.email), v.name
from auth.users u
join (values ('jacoblarenwalker@gmail.com', 'Jacob'), ('sophiegracest@gmail.com', 'Sophie')) v(email, name)
  on lower(u.email) = v.email
on conflict (user_id) do nothing;

-- is the signed-in user one of the parents?
create or replace function private.wb_is_parent()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.wb_parents p where p.user_id = (select auth.uid()));
$$;
revoke all on function private.wb_is_parent() from public, anon;
grant execute on function private.wb_is_parent() to authenticated;

drop policy if exists wb_parents_select on public.wb_parents;
create policy wb_parents_select on public.wb_parents for select to authenticated
  using ((select private.wb_is_parent()));

create or replace function private.wb_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.wb_touch() from public, anon, authenticated;

-- 2) family settings (one row) -----------------------------------------------------------------------
create table if not exists public.wb_family (
  id smallint primary key default 1 check (id = 1),
  baby_name text not null default 'Westley' check (length(baby_name) between 1 and 60),
  birth_date date,
  feed_reminder_enabled boolean not null default true,
  feed_reminder_minutes integer not null default 180 check (feed_reminder_minutes between 30 and 720),
  volume_unit text not null default 'oz' check (volume_unit in ('oz', 'ml')),
  weight_unit text not null default 'lb' check (weight_unit in ('lb', 'kg')),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
insert into public.wb_family (id) values (1) on conflict do nothing;

-- 3) logs ---------------------------------------------------------------------------------------------
-- A feeding is a list of segments [{ "side": "L"|"R"|"B", "start": iso, "end": iso|null }].
-- ended_at null = feed in progress (shared between both phones). bottle_ml for bottle feeds.
create table if not exists public.wb_feedings (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  ended_at timestamptz,
  segments jsonb not null default '[]' check (jsonb_typeof(segments) = 'array' and jsonb_array_length(segments) <= 50),
  bottle_ml numeric(6,1) check (bottle_ml is null or (bottle_ml >= 0 and bottle_ml <= 1000)),
  bottle_kind text check (bottle_kind is null or bottle_kind in ('breastmilk', 'formula')),
  note text check (note is null or length(note) <= 1000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists wb_feedings_started_idx on public.wb_feedings (started_at desc);

create table if not exists public.wb_diapers (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  kind text not null check (kind in ('wet', 'dirty', 'both', 'dry')),
  note text check (note is null or length(note) <= 1000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wb_diapers_at_idx on public.wb_diapers (at desc);

create table if not exists public.wb_sleeps (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  ended_at timestamptz,
  note text check (note is null or length(note) <= 1000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists wb_sleeps_started_idx on public.wb_sleeps (started_at desc);

-- 4) memories (photos live in the private bucket wb-photos as <uuid>.jpg) --------------------------------
create table if not exists public.wb_memories (
  id uuid primary key default gen_random_uuid(),
  happened_on date not null default ((now() at time zone 'America/Denver')::date),
  caption text check (caption is null or length(caption) <= 2000),
  photo_path text check (photo_path is null or photo_path ~ '^[0-9a-f-]{36}\.jpg$'),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (caption is not null or photo_path is not null)
);
create index if not exists wb_memories_date_idx on public.wb_memories (happened_on desc);

-- 5) doctor --------------------------------------------------------------------------------------------
create table if not exists public.wb_visits (
  id uuid primary key default gen_random_uuid(),
  visit_date date not null,
  title text not null default 'Checkup' check (length(title) between 1 and 120),
  provider text check (provider is null or length(provider) <= 120),
  notes text check (notes is null or length(notes) <= 10000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wb_growth (
  id uuid primary key default gen_random_uuid(),
  measured_on date not null,
  weight_g numeric(7,1) check (weight_g is null or weight_g between 300 and 30000),
  length_cm numeric(5,1) check (length_cm is null or length_cm between 20 and 130),
  head_cm numeric(5,1) check (head_cm is null or head_cm between 20 and 60),
  note text check (note is null or length(note) <= 1000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (weight_g is not null or length_cm is not null or head_cm is not null)
);

create table if not exists public.wb_vaccines (
  id uuid primary key default gen_random_uuid(),
  given_on date not null,
  name text not null check (length(name) between 1 and 160),
  dose text check (dose is null or length(dose) <= 60),
  note text check (note is null or length(note) <= 1000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wb_questions (
  id uuid primary key default gen_random_uuid(),
  question text not null check (length(question) between 1 and 1000),
  done boolean not null default false,
  answer text check (answer is null or length(answer) <= 4000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 6) RLS: parents only, everything shared between them --------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['wb_family', 'wb_feedings', 'wb_diapers', 'wb_sleeps', 'wb_memories',
                           'wb_visits', 'wb_growth', 'wb_vaccines', 'wb_questions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_parents', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select private.wb_is_parent())) with check ((select private.wb_is_parent()))', t || '_parents', t);
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before update on public.%I for each row execute function private.wb_touch()', t || '_touch', t);
  end loop;
end $$;
-- the single settings row can't be removed or duplicated from the app
revoke insert, delete on public.wb_family from authenticated;

-- live updates between the two phones (Realtime respects RLS)
do $$
declare t text;
begin
  foreach t in array array['wb_family', 'wb_feedings', 'wb_diapers', 'wb_sleeps', 'wb_memories',
                           'wb_visits', 'wb_growth', 'wb_vaccines', 'wb_questions'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 7) private photo bucket --------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wb-photos', 'wb-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists wb_photos_select on storage.objects;
create policy wb_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'wb-photos' and (select private.wb_is_parent()));
drop policy if exists wb_photos_insert on storage.objects;
create policy wb_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'wb-photos' and name ~ '^[0-9a-f-]{36}\.jpg$' and (select private.wb_is_parent()));
drop policy if exists wb_photos_update on storage.objects;
create policy wb_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'wb-photos' and (select private.wb_is_parent()))
  with check (bucket_id = 'wb-photos' and name ~ '^[0-9a-f-]{36}\.jpg$' and (select private.wb_is_parent()));
drop policy if exists wb_photos_delete on storage.objects;
create policy wb_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'wb-photos' and (select private.wb_is_parent()));
