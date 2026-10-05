-- Two things a block got wrong, both from the first security audit (2026-10-04).
--
-- ## 1. Blocking then unblocking your OWN request made it a friendship
--
-- `0009` says "only a friendship can be blocked; a request is refused", and no
-- body ever said so. `block_friend`'s only status guard was "not already
-- blocked by them", so it would block a PENDING row -- including one the caller
-- had just sent -- and `unblock_friend` restores every lifted block to
-- 'accepted' without asking what it was before. So:
--
--     request_friend(victim)   -> pending, requested_by = me
--     block_friend(victim)     -> blocked, blocked_by = me
--     unblock_friend(victim)   -> accepted
--
-- three calls to an accepted friendship nobody accepted, walking straight round
-- `accept_friend`'s `requested_by <> me`. That is the outcome `0015` closed for
-- the table and left open through the functions it said were unaffected:
-- the pair topic, the watch feed, ranked registration, match consent.
--
-- The fix is the rule as `0009` wrote it. `unblock_friend` keeps answering
-- 'accepted', which is now true by construction: the only row it can lift is
-- one that was a friendship when it was blocked. The client only ever offered
-- Block on an accepted row, so nothing it does changes. Production holds no
-- blocked rows today, so there is no ambiguous history to repair.
--
-- ## 2. The blocked party could read that they were blocked
--
-- `0009` and `20260913010000` both say a block must look exactly like the
-- blocker not existing, and `request_friend` answers NULL for a blocked pair
-- for that reason. The reads never followed: `list_friends` returned the row
-- with status 'blocked' and the blocker's current name, `friendships_read`
-- returned `blocked_by`, and `profiles_read` let the blocked party go on
-- reading the blocker's whole profile -- renames included. Only
-- `screens/friends.ts` hid the row, and a rule the client states is a rule the
-- client can decline to state.
--
-- Now a row blocked by the OTHER person is invisible to all three reads. The
-- blocker still sees it, because they need it to lift the block --
-- `20260912000000_tighten_reads` gave that reason and it still holds.
--
-- Compatible with the release before: that client already filtered these rows
-- out, so it renders the same list from fewer rows.

create or replace function public.block_friend(their_id uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  row public.friendships;
begin
  perform public.assert_allowed();
  update public.friendships
     set status = 'blocked', blocked_by = me, updated_at = now()
   where user_a = least(me, their_id)
     and user_b = greatest(me, their_id)
     -- A friendship, or a block of mine already (which makes this a no-op).
     -- Never a request: blocking one used to be the first half of forging an
     -- acceptance. A request you do not want is declined, not blocked.
     and (status = 'accepted' or (status = 'blocked' and blocked_by = me))
  returning * into row;
  if row is null then
    raise exception 'no friendship to block' using errcode = 'P0002';
  end if;
  return row;
end;
$$;

revoke all on function public.block_friend(uuid) from public, anon;
grant execute on function public.block_friend(uuid) to authenticated;

create or replace function public.list_friends()
returns table(id uuid, username text, status text, "theirMove" boolean, "ourMove" boolean, "blockedByMe" boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, f.status::text,
    f.status = 'pending' and f.requested_by = auth.uid(),
    f.status = 'pending' and f.requested_by <> auth.uid(),
    f.status = 'blocked' and f.blocked_by = auth.uid()
  from public.friendships f join public.profiles p
    on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
  where public.caller_allowed() and auth.uid() in(f.user_a, f.user_b)
    -- Somebody else's block is not mine to see. See the header.
    and not (f.status = 'blocked' and f.blocked_by <> auth.uid())
  order by p.username
$$;
revoke all on function public.list_friends() from public, anon;
grant execute on function public.list_friends() to authenticated;

drop policy if exists friendships_read on public.friendships;
create policy friendships_read on public.friendships
  for select to authenticated
  using (public.is_member(user_a, user_b)
         and (select public.caller_allowed())
         and not (status = 'blocked'
                  and blocked_by is distinct from (select auth.uid())));

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated
  using (
    (select public.caller_allowed())
    and (
      id = (select auth.uid())
      or exists (
        select 1 from public.friendships f
         where ((f.user_a = (select auth.uid()) and f.user_b = public.profiles.id)
             or (f.user_b = (select auth.uid()) and f.user_a = public.profiles.id))
           and not (f.status = 'blocked'
                    and f.blocked_by is distinct from (select auth.uid()))
      )
    )
  );
