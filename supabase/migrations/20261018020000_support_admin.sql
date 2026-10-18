-- The developer's side of support: every ticket, and moving them along.
--
-- ## Who is an admin
--
-- An account listed in `play_private.support_admins`, by id, and nobody
-- else. Seeded here with the project owner's account, looked up by its
-- confirmed address; anybody added later is added by hand, as a row. Being
-- listed is not enough on its own: the session must also satisfy
-- `assurance_satisfied`, so an admin with two-factor on has answered it.
--
-- ## What an admin can do
--
-- Read every ticket with the player's username and address
-- (`admin_tickets`), open every attachment (a storage policy), and set any
-- ticket's stage (`admin_set_ticket_stage`). Nothing else: no deleting, no
-- editing what a player wrote.
--
-- ## Moving backward
--
-- `stamp_ticket_stage` used to only fill dates in. A stage set back by
-- mistake now clears the dates of the stages after it, so the player's track
-- never shows a step as reached that the ticket is no longer at.

create table if not exists play_private.support_admins (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table play_private.support_admins enable row level security;
revoke all on play_private.support_admins from public, anon, authenticated;

insert into play_private.support_admins (user_id)
select id from auth.users
 where lower(email) = 'sirikonda.jayan9@gmail.com' and email_confirmed_at is not null
on conflict do nothing;

create or replace function public.is_support_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.assurance_satisfied()
     and exists (select 1 from play_private.support_admins a where a.user_id = auth.uid())
$$;
revoke all on function public.is_support_admin() from public, anon;
grant execute on function public.is_support_admin() to authenticated;

/** Every ticket, newest first, with who sent it. Admins only. */
create or replace function public.admin_tickets()
returns table (
  id bigint, username text, email text, message text, stage text,
  attachments jsonb, created_at timestamptz, reviewed_at timestamptz,
  in_progress_at timestamptz, fixed_at timestamptz, deleted_at timestamptz,
  emailed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_support_admin() then
    raise exception 'support admins only' using errcode = '42501';
  end if;
  return query
    select t.id, p.username, u.email::text, t.message, t.stage, t.attachments,
           t.created_at, t.reviewed_at, t.in_progress_at, t.fixed_at,
           t.deleted_at, t.emailed_at
      from public.support_tickets t
      left join public.profiles p on p.id = t.user_id
      left join auth.users u on u.id = t.user_id
     order by t.created_at desc
     limit 500;
end $$;
revoke all on function public.admin_tickets() from public, anon;
grant execute on function public.admin_tickets() to authenticated;

/** Move a ticket to any stage. Admins only. */
create or replace function public.admin_set_ticket_stage(ticket bigint, new_stage text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_support_admin() then
    raise exception 'support admins only' using errcode = '42501';
  end if;
  update public.support_tickets set stage = new_stage where id = ticket;
  if not found then
    raise exception 'no such ticket' using errcode = '22023';
  end if;
end $$;
revoke all on function public.admin_set_ticket_stage(bigint, text) from public, anon;
grant execute on function public.admin_set_ticket_stage(bigint, text) to authenticated;

create or replace function public.stamp_ticket_stage()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- Back to an earlier stage: what came after it has not happened.
  if new.stage in ('sent', 'reviewed', 'in_progress') then new.fixed_at := null; end if;
  if new.stage in ('sent', 'reviewed') then new.in_progress_at := null; end if;
  if new.stage = 'sent' then new.reviewed_at := null; end if;
  -- Forward, past a skipped stage: fill that one in too.
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

drop policy if exists support_read_admin on storage.objects;
create policy support_read_admin on storage.objects
  for select to authenticated
  using (bucket_id = 'support-attachments' and (select public.is_support_admin()));
