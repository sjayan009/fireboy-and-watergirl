-- A friendship is a state machine, and the table stopped being a second way
-- round it.
--
-- 0002 wrote two policies that read as if they were the rule and were not.
--
--   INSERT  "you must be one of the two, and the requester"
--   UPDATE  "you must be one of the two"
--
-- Neither says `pending`. So an authenticated account could POST
-- `{self, victim, status: 'accepted', requested_by: self}` straight at
-- PostgREST and the server stored an accepted friendship with somebody who had
-- never heard of them -- and even with INSERT narrowed to pending, the same
-- caller could PATCH their own request to accepted a moment later. `profiles`
-- was readable by every authenticated user, so the victim's id was one query
-- away.
--
-- What that buys the forger is everything keyed to an accepted friendship: the
-- pair's private Realtime topic, their presence, their invitations, the watch
-- feed, and every row of their shared progress. It was live-reproducible.
--
-- The transitions were always specified -- `request_friend` refuses to reopen a
-- block and turns a mutual request into an acceptance, `accept_friend` refuses
-- to let you accept your own, `block_friend` records who cast it and
-- `unblock_friend` refuses to lift somebody else's. Three of those four rules
-- had no expression in the policies at all. Rather than restate them as
-- predicates and keep two copies honest, the direct verbs go: the functions
-- become the only way a friendship changes, which is what the comments in 0002
-- and 0009 already claimed.
--
-- SELECT and DELETE stay. Reading is what the friends list and the lobby do,
-- and deleting is how you leave -- constrained since 0009 so a blocked party
-- cannot delete their way out of a block.
--
-- The shipped client never used either verb: it calls `request_friend`,
-- `accept_friend`, `block_friend` and `unblock_friend`, and deletes to unfriend.
-- So this tightens nothing the release before it was relying on.

drop policy if exists friendships_request on public.friendships;
drop policy if exists friendships_update on public.friendships;

-- Belt as well as braces: a policy is only consulted for a verb the role has
-- been granted, so taking the grant away means a future policy added by
-- accident cannot reopen this on its own.
revoke insert, update on public.friendships from authenticated;
revoke insert, update on public.friendships from anon;

-- The definer functions are unaffected -- they run as the owner, which is the
-- entire point of their being definer.

/**
 * Leave a friendship, through a function like everything else.
 *
 * The DELETE policy still exists and still says the same thing; this is here so
 * every transition in the state machine has one named entry point, and so the
 * one destructive one can say what it destroys. Unfriending cascades to
 * `pair_progress`: the levels the two of them finished together go with it.
 */
create or replace function public.remove_friend(their_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  gone integer;
begin
  perform public.assert_allowed();
  delete from public.friendships
   where user_a = least(me, their_id)
     and user_b = greatest(me, their_id)
     -- Somebody else's block is not yours to delete your way out of.
     and (status <> 'blocked' or blocked_by = me);
  get diagnostics gone = row_count;
  return gone > 0;
end;
$$;

revoke all on function public.remove_friend(uuid) from public;
grant execute on function public.remove_friend(uuid) to authenticated;
