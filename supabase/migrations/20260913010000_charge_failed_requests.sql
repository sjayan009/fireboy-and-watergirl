-- The budget in `20260913000000` charged nothing, and could not have.
--
-- It incremented a counter and then, for the case worth charging, raised:
--
--     if them is null then
--       raise exception 'no such user' using errcode = 'P0002';
--     end if;
--
-- A raise aborts the transaction, and PostgREST gives each request one. So the
-- increment rolled back with it, and seven probes in a row all answered
-- `no such user` with the counter still reading zero. Measured, not reasoned:
--
--     attempt 1..7: HTTP 500 {"code":"P0002","message":"no such user"}
--
-- Nothing in Postgres lets a function commit one write and then abort, so the
-- choice is to charge for failures or to keep raising on them. Charging is the
-- point: this function answers differently for a name that exists and one that
-- does not, which makes it the last existence oracle in the project now that
-- `profiles` is closed. An oracle nobody pays for is an oracle.
--
-- So a name that resolves to nobody returns NULL rather than raising, the
-- transaction commits, and the attempt is counted. `friends.ts` turns that NULL
-- back into the same message a person saw before, so nothing changes on screen.
--
-- The blocked arm returns NULL for the same reason it used to raise
-- `no such user`: somebody who has been blocked must not be able to tell that
-- apart from a name nobody has. It now also costs them an attempt, which is
-- strictly better.
--
-- `assert_allowed` still raises, and should: a caller with no profile is not
-- probing anything, and charging a budget to an account that cannot use the
-- function at all would be accounting for its own sake.

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
  -- NULL, not a raise. See the header: raising here would undo the line above.
  if them is null then
    return null;
  end if;
  if them = me then
    raise exception 'you cannot befriend yourself' using errcode = '22023';
  end if;

  lo := least(me, them);
  hi := greatest(me, them);

  select * into existing from public.friendships
    where user_a = lo and user_b = hi;
  -- Indistinguishable from a name nobody has, which is the whole point of it.
  if existing.status = 'blocked' then
    return null;
  end if;

  insert into public.friendships (user_a, user_b, status, requested_by)
  values (lo, hi, 'pending', me)
  on conflict (user_a, user_b) do update
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
