-- Accounts.
--
-- A profile is the public half of a user: the unique name a friend types to
-- find them. Everything private stays in auth.users, which is Supabase's and
-- not ours to duplicate.
--
-- There is deliberately NO trigger creating a profile when a user signs up. A
-- username has to be chosen and has to be unique, so it cannot be invented on
-- the user's behalf; `claim_username` below is the one way in, and it does the
-- check and the write in a single statement so two people racing for the same
-- name cannot both win.

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 3-20 characters, letters, digits and underscores, not starting or ending
  -- with an underscore. Narrow on purpose: a username is typed by the other
  -- player from memory.
  constraint username_shape check (username ~ '^[A-Za-z0-9](_?[A-Za-z0-9]){2,19}$')
);

-- Case-insensitive uniqueness without the citext extension: "Jayan" and
-- "jayan" are the same person to anyone typing it.
create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

alter table public.profiles enable row level security;

-- A username is a public identifier -- you cannot add a friend you cannot
-- find -- so any signed-in user may read the directory. Nothing sensitive
-- lives here.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_write_own on public.profiles;
create policy profiles_write_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
  for delete to authenticated using (id = auth.uid());

-- No INSERT policy. Profiles are created only through claim_username, so
-- there is no path by which a row can be inserted for somebody else.

/**
 * Claim a username, creating the profile if it does not exist.
 *
 * SECURITY DEFINER because there is no insert policy: this function is the
 * only way a profile row comes into being, which is what makes "one profile
 * per user, name unique, chosen not assigned" true by construction rather than
 * by convention.
 */
create or replace function public.claim_username(new_username text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  row public.profiles;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if new_username !~ '^[A-Za-z0-9](_?[A-Za-z0-9]){2,19}$' then
    raise exception 'username must be 3-20 letters, digits or underscores'
      using errcode = '22023';
  end if;

  insert into public.profiles as p (id, username)
  values (me, new_username)
  on conflict (id) do update
    set username = excluded.username, updated_at = now()
  returning * into row;
  return row;
exception
  when unique_violation then
    raise exception 'that username is taken' using errcode = '23505';
end;
$$;

revoke all on function public.claim_username(text) from public;
grant execute on function public.claim_username(text) to authenticated;
