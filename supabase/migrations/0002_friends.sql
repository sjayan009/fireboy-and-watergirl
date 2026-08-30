-- Friends, and the pair they form.
--
-- A friendship is stored ONCE, with the two ids in a fixed order. Storing it
-- as an unordered pair would mean two rows for one relationship, and every
-- query would have to remember to look both ways -- the sort of thing that is
-- correct until the day someone writes `where user_a = me` and forgets the
-- other half.
--
-- The accepted friendship IS the co-op pair. There is no separate `pairs`
-- table because there is nothing a pair has that the friendship does not.

create or replace function public.pair_lo(a uuid, b uuid) returns uuid
  language sql immutable as $$ select least(a, b) $$;
create or replace function public.pair_hi(a uuid, b uuid) returns uuid
  language sql immutable as $$ select greatest(a, b) $$;

create table if not exists public.friendships (
  user_a       uuid not null references auth.users (id) on delete cascade,
  user_b       uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'pending'
                 check (status in ('pending', 'accepted', 'blocked')),
  requested_by uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  primary key (user_a, user_b),
  -- The ordering that makes the pair unique. Enforced rather than assumed.
  constraint ordered check (user_a < user_b),
  constraint requester_is_a_member check (requested_by in (user_a, user_b))
);

create index if not exists friendships_b_idx on public.friendships (user_b);

alter table public.friendships enable row level security;

/** Is the caller one of these two people? */
create or replace function public.is_member(a uuid, b uuid) returns boolean
  language sql stable as $$ select auth.uid() in (a, b) $$;

drop policy if exists friendships_read on public.friendships;
create policy friendships_read on public.friendships
  for select to authenticated using (public.is_member(user_a, user_b));

-- You may only create a request you are part of, and only as the requester:
-- inserting a row that claims someone else asked is exactly the forgery this
-- prevents.
drop policy if exists friendships_request on public.friendships;
create policy friendships_request on public.friendships
  for insert to authenticated
  with check (public.is_member(user_a, user_b) and requested_by = auth.uid());

drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships
  for update to authenticated
  using (public.is_member(user_a, user_b))
  with check (public.is_member(user_a, user_b));

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete to authenticated using (public.is_member(user_a, user_b));

/**
 * Send a friend request by username.
 *
 * Takes a name rather than an id because that is what the other player told
 * you, and it orders the pair for you so no caller has to remember to. If the
 * other person already asked you, this accepts instead -- two people both
 * pressing "add friend" should end up friends, not deadlocked.
 */
create or replace function public.request_friend(their_username text)
returns public.friendships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  them uuid;
  lo uuid; hi uuid;
  row public.friendships;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select id into them from public.profiles
    where lower(username) = lower(their_username);
  if them is null then
    raise exception 'no such user' using errcode = 'P0002';
  end if;
  if them = me then
    raise exception 'you cannot befriend yourself' using errcode = '22023';
  end if;

  lo := least(me, them);
  hi := greatest(me, them);

  insert into public.friendships (user_a, user_b, status, requested_by)
  values (lo, hi, 'pending', me)
  on conflict (user_a, user_b) do update
    -- they asked first, and now so have we: that is a yes
    set status = case
          when public.friendships.status = 'pending'
           and public.friendships.requested_by <> me then 'accepted'
          else public.friendships.status
        end,
        updated_at = now()
  returning * into row;
  return row;
end;
$$;

revoke all on function public.request_friend(text) from public;
grant execute on function public.request_friend(text) to authenticated;

/** Accept a pending request that somebody else sent you. */
create or replace function public.accept_friend(their_id uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  row public.friendships;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  update public.friendships
     set status = 'accepted', updated_at = now()
   where user_a = least(me, their_id)
     and user_b = greatest(me, their_id)
     and status = 'pending'
     -- you cannot accept your own request
     and requested_by <> me
  returning * into row;
  if row is null then
    raise exception 'no pending request from that user' using errcode = 'P0002';
  end if;
  return row;
end;
$$;

revoke all on function public.accept_friend(uuid) from public;
grant execute on function public.accept_friend(uuid) to authenticated;
