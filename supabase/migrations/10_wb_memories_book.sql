-- Westley's Book: memories-first book. Additive tables for hearts, comments, first-year
-- firsts, monthly portraits and letters to Westley. Unschedule feed/med reminder crons;
-- those tables and all of their data stay saved. Parents-only RLS, same as other wb_ tables.

-- 1) stop reminder pushes (functions, tables and history are kept) --------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'wb-feed-reminders';
select cron.unschedule(jobid) from cron.job where jobname = 'wb-med-reminders';

-- 2) shared author / user triggers ----------------------------------------------------------------
create or replace function private.wb_keep_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (select auth.uid()) is not null then new.created_by := (select auth.uid()); end if;
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;
revoke all on function private.wb_keep_author() from public, anon, authenticated;

create or replace function private.wb_keep_user_id()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if (select auth.uid()) is not null then new.user_id := (select auth.uid()); end if;
  else
    new.user_id := old.user_id;
  end if;
  return new;
end;
$$;
revoke all on function private.wb_keep_user_id() from public, anon, authenticated;

-- 3) hearts on a memory (one per parent) ----------------------------------------------------------
create table if not exists public.wb_memory_hearts (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.wb_memories(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (memory_id, user_id)
);
create index if not exists wb_memory_hearts_memory_idx on public.wb_memory_hearts (memory_id);

drop trigger if exists wb_memory_hearts_user on public.wb_memory_hearts;
create trigger wb_memory_hearts_user before insert or update on public.wb_memory_hearts
  for each row execute function private.wb_keep_user_id();

-- 4) short comments on a memory -------------------------------------------------------------------
create table if not exists public.wb_memory_comments (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.wb_memories(id) on delete cascade,
  body text not null check (length(body) between 1 and 400),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wb_memory_comments_memory_idx on public.wb_memory_comments (memory_id, created_at);

drop trigger if exists wb_memory_comments_author on public.wb_memory_comments;
create trigger wb_memory_comments_author before insert or update on public.wb_memory_comments
  for each row execute function private.wb_keep_author();

-- 5) first-year firsts (id = slug from the app, e.g. 'smile') -------------------------------------
create table if not exists public.wb_firsts (
  id text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  memory_id uuid references public.wb_memories(id) on delete set null,
  happened_on date,
  note text check (note is null or length(note) <= 500),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (happened_on is not null or memory_id is not null)
);

-- 6) monthly milestone portraits (id = 1..12 for "Westley at N months") ---------------------------
create table if not exists public.wb_month_portraits (
  id smallint primary key check (id between 1 and 12),
  memory_id uuid not null references public.wb_memories(id) on delete cascade,
  photo_path text not null check (photo_path ~ '^[0-9a-f-]{36}\.jpg$'),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 7) private letters to Westley -------------------------------------------------------------------
create table if not exists public.wb_letters (
  id uuid primary key default gen_random_uuid(),
  written_on date not null default ((now() at time zone 'America/Denver')::date),
  body text not null check (length(body) between 1 and 10000),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists wb_letters_written_idx on public.wb_letters (written_on desc, created_at desc);

drop trigger if exists wb_letters_author on public.wb_letters;
create trigger wb_letters_author before insert or update on public.wb_letters
  for each row execute function private.wb_keep_author();

-- 8) RLS, grants, touch triggers, realtime --------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['wb_memory_hearts', 'wb_memory_comments', 'wb_firsts', 'wb_month_portraits', 'wb_letters'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_parents', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using ((select private.wb_is_parent())) with check ((select private.wb_is_parent()))',
      t || '_parents', t);
    if t <> 'wb_memory_hearts' then
      execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
      execute format('create trigger %I before update on public.%I for each row execute function private.wb_touch()', t || '_touch', t);
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
