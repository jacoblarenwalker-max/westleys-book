-- Westley's Book (Oct 9 2026): several photos per memory + a trustworthy author. Additive only: existing
-- memories, their photo_path and their created_by are left exactly as they are.

-- 1) up to 10 photos per memory (wb-photos/<uuid>.jpg). Older memories keep using photo_path (read as a one-item
--    list). New saves also set photo_path to the first photo so the existing "caption or photo" rule still holds.
alter table public.wb_memories add column if not exists photo_paths text[];
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'wb_memories_photo_paths_ok') then
    alter table public.wb_memories add constraint wb_memories_photo_paths_ok check (
      photo_paths is null or (
        cardinality(photo_paths) between 1 and 10
        and array_to_string(photo_paths, ',') ~ '^[0-9a-f-]{36}\.jpg(,[0-9a-f-]{36}\.jpg)*$'
        and photo_path = photo_paths[1]));
  end if;
end $$;

-- 2) author: created_by (already filled by the app for every memory) becomes server-enforced. On insert it is
--    always the signed-in parent; on update it never changes. Rows without an author stay without one.
create or replace function private.wb_memories_author()
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
revoke all on function private.wb_memories_author() from public, anon, authenticated;
drop trigger if exists wb_memories_author on public.wb_memories;
create trigger wb_memories_author before insert or update on public.wb_memories
  for each row execute function private.wb_memories_author();
