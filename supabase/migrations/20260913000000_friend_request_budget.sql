-- Five friend requests an hour, counted before the name is looked up.
--
-- `request_friend` had no throttle at all. That was survivable when an invite
-- code stood in front of every account; it is not now, because making an
-- account takes one form and `20260912000000_tighten_reads` left this function
-- as the only thing that will still resolve a username for you.
--
-- ## Why the budget is spent BEFORE the lookup
--
-- This function answers `no such user` for a name nobody has and succeeds for
-- one somebody does, which makes it an existence oracle -- a smaller-shaped
-- version of the `profiles` table that was just closed. Charging only for
-- successful requests would leave probing free and the oracle wide open, so the
-- attempt is charged the moment it is made, before the name is even read.
--
-- Five per hour is deliberately tight. A friend list here is a handful of
-- people, so five is a normal day's worth and useless for walking a dictionary.
-- The cost is that a few typos in one sitting will hit it, which is why the
-- message says how long the wait is rather than just refusing -- somebody who
-- has mistyped twice should not have to guess whether they are broken or
-- blocked.

create table if not exists public.friend_request_budget (
  user_id      uuid not null references auth.users (id) on delete cascade,
  window_start timestamptz not null default now(),
  calls        integer not null default 0,
  primary key (user_id)
);

alter table public.friend_request_budget enable row level security;
-- No policies, the same shape as `progress_sync_budget`: there is no query a
-- signed-in account should run against its own rate limit, least of all one
-- that resets it.

/**
 * Ask to be somebody's friend.
 *
 * Unchanged from `0009` except for the budget at the top. Everything else --
 * the block check that answers `no such user` rather than admitting somebody
 * blocked you, and the crossed-request arm that reads two pending requests as
 * an acceptance -- is exactly as it was.
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
  existing public.friendships;
  row public.friendships;
  spent integer;
  waited interval;
begin
  perform public.assert_allowed();

  insert into public.friend_request_budget as b (user_id, calls)
  values (me, 1)
  on conflict (user_id) do update
    set calls = case when b.window_start < now() - interval '1 hour'
                     then 1 else b.calls + 1 end,
        window_start = case when b.window_start < now() - interval '1 hour'
                            then now() else b.window_start end
  returning b.calls, now() - b.window_start into spent, waited;

  if spent > 5 then
    raise exception 'too many friend requests; try again in % minutes',
      greatest(1, ceil(extract(epoch from (interval '1 hour' - waited)) / 60))
      using errcode = '53400';
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

  select * into existing from public.friendships
    where user_a = lo and user_b = hi;
  if existing.status = 'blocked' then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

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

revoke execute on function public.request_friend(text) from public;
revoke execute on function public.request_friend(text) from anon;
grant  execute on function public.request_friend(text) to authenticated;
