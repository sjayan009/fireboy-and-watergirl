-- Support tickets: an account's own, with attachments, and nobody else's.
--
-- ## Who can send one
--
-- Somebody fully IN: signed in, address confirmed, second factor answered
-- if they have one, username claimed -- `assert_allowed`, the same gate as
-- every other write in this schema. Not a form anybody can post to: there is
-- no insert grant on the table at all, only `submit_ticket`.
--
-- ## How a ticket moves
--
-- `stage` goes sent -> reviewed -> in_progress -> fixed. It is changed by
-- hand in the Table Editor, and the trigger stamps the time each stage was
-- reached, so the player's timeline fills in by itself. A player can only
-- delete (`delete_ticket`), which hides it from the open pile and keeps it.
--
-- ## Attachments
--
-- A private bucket, under `<user id>/`. The bucket refuses any one file over
-- 10 MB, `submit_ticket` refuses a ticket whose files add up to more, and
-- sizes are read from Storage's own record, never from what the browser says.
-- Uploads are capped at 30 MB a day per account even when no ticket follows,
-- so the bucket cannot be filled by uploading and never submitting. The
-- `support-ticket` Edge Function removes attachments 90 days on.

create table if not exists public.support_tickets (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  message        text not null check (char_length(message) between 10 and 5000),
  stage          text not null default 'sent'
                 check (stage in ('sent', 'reviewed', 'in_progress', 'fixed')),
  attachments    jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  reviewed_at    timestamptz,
  in_progress_at timestamptz,
  fixed_at       timestamptz,
  deleted_at     timestamptz,
  emailed_at     timestamptz
);
create index if not exists support_tickets_user on public.support_tickets (user_id, created_at desc);

alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from public, anon, authenticated;
grant select on public.support_tickets to authenticated;

drop policy if exists support_tickets_read_own on public.support_tickets;
create policy support_tickets_read_own on public.support_tickets
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.assurance_satisfied()));

-- Moving a stage fills in when it happened. Moving forward past a stage that
-- was skipped fills that one too, so the track never shows a gap.
create or replace function public.stamp_ticket_stage()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.stage in ('reviewed', 'in_progress', 'fixed') then
    new.reviewed_at := coalesce(new.reviewed_at, now());
  end if;
  if new.stage in ('in_progress', 'fixed') then
    new.in_progress_at := coalesce(new.in_progress_at, now());
  end if;
  if new.stage = 'fixed' then
    new.fixed_at := coalesce(new.fixed_at, now());
  end if;
  return new;
end $$;
revoke all on function public.stamp_ticket_stage() from public, anon, authenticated;

drop trigger if exists support_tickets_stage on public.support_tickets;
create trigger support_tickets_stage before update of stage on public.support_tickets
  for each row execute function public.stamp_ticket_stage();

-- ---- the bucket ------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('support-attachments', 'support-attachments', false, 10485760)
on conflict (id) do update set public = false, file_size_limit = 10485760;

-- Whether the caller has uploaded less than 30 MB in the last day. A definer
-- function, because a policy on `storage.objects` that reads
-- `storage.objects` is evaluated through its own policies: infinite
-- recursion (42P17), measured on the first upload.
create or replace function public.support_upload_room()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0) < 31457280
    from storage.objects o
   where o.bucket_id = 'support-attachments'
     and o.owner_id = auth.uid()::text
     and o.created_at > now() - interval '1 day'
$$;
revoke all on function public.support_upload_room() from public, anon;
grant execute on function public.support_upload_room() to authenticated;

drop policy if exists support_upload_own on storage.objects;
create policy support_upload_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'support-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.assurance_satisfied())
    and (select public.support_upload_room())
  );

drop policy if exists support_read_own on storage.objects;
create policy support_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'support-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.assurance_satisfied())
  );

-- Taking back a file before the ticket is sent.
drop policy if exists support_delete_own on storage.objects;
create policy support_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'support-attachments'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and (select public.assurance_satisfied())
  );

-- ---- sending and deleting -------------------------------------------------

/**
 * File a ticket. `paths` are the caller's uploads for it, which must all be
 * theirs, all in the bucket, and together no more than 10 MB. Three a day.
 */
create or replace function public.submit_ticket(message text, paths text[] default '{}')
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  files jsonb;
  total bigint;
  found integer;
  ticket bigint;
begin
  perform public.assert_allowed();
  if (select count(*) from public.support_tickets
       where user_id = me and created_at > now() - interval '1 day') >= 3 then
    raise exception 'three tickets a day: try again tomorrow, or add to one you have sent'
      using errcode = '53400';
  end if;
  paths := coalesce(paths, '{}');
  if cardinality(paths) > 10 then
    raise exception 'up to 10 files' using errcode = '22023';
  end if;
  select count(*), coalesce(sum((o.metadata ->> 'size')::bigint), 0),
         coalesce(jsonb_agg(jsonb_build_object(
           'path', o.name,
           'name', regexp_replace(o.name, '^[^/]+/[^/]+/[0-9]+-', ''),
           'bytes', (o.metadata ->> 'size')::bigint,
           'type', o.metadata ->> 'mimetype') order by o.name), '[]'::jsonb)
    into found, total, files
    from storage.objects o
   where o.bucket_id = 'support-attachments'
     and o.name = any (paths)
     and o.owner_id = me::text
     and (storage.foldername(o.name))[1] = me::text;
  if found <> cardinality(paths) then
    raise exception 'an attachment did not upload; add it again' using errcode = '22023';
  end if;
  if total > 10485760 then
    raise exception 'attachments come to more than 10 MB' using errcode = '22023';
  end if;
  insert into public.support_tickets (user_id, message, attachments)
  values (me, btrim(message), files)
  returning id into ticket;
  return ticket;
end $$;
revoke all on function public.submit_ticket(text, text[]) from public, anon;
grant execute on function public.submit_ticket(text, text[]) to authenticated;

/** Hide one of your own tickets from the open pile. It is kept, as Deleted. */
create or replace function public.delete_ticket(ticket bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_allowed();
  update public.support_tickets
     set deleted_at = coalesce(deleted_at, now())
   where id = ticket and user_id = auth.uid();
  if not found then
    raise exception 'no such ticket' using errcode = '42501';
  end if;
end $$;
revoke all on function public.delete_ticket(bigint) from public, anon;
grant execute on function public.delete_ticket(bigint) to authenticated;
