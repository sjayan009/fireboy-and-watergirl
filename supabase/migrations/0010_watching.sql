-- A second topic per friendship, for people who are only looking.
--
-- `pair:<lo>:<hi>` stays exactly as private as 0005 made it: two accounts, no
-- more, proved from a third in realtimetest.mjs. Spectating does not loosen it.
-- It gets its own topic, `watch:<lo>:<hi>`, carrying a copy of the input the
-- two players are already exchanging -- three bits per player per frame, and
-- nothing else. A watcher can see the game. It cannot see the channel that
-- carries their presence, their invitations, or the signalling for their peer
-- connection, and it cannot say anything on either.
--
-- Nobody publishes to it unless the pair has turned watching on for that game,
-- so a game nobody is sharing costs no messages at all.

/**
 * May the caller watch this topic?
 *
 * SECURITY DEFINER, and that is the interesting part -- 0005's equivalent is
 * deliberately invoker-rights, because the rule there is "are you in this
 * friendship", and `friendships` already hides rows from everyone else.
 *
 * The rule here is "are you friends with somebody in this friendship", and a
 * watcher cannot see the pair's row at all. That invisibility is exactly the
 * privacy `friendships` is enforcing, so the check has to run as the owner and
 * be narrow enough to be worth the privilege: it answers one boolean about one
 * topic, and reveals nothing else.
 *
 * The topic is rebuilt and compared rather than parsed apart, for the same
 * reason 0005 rebuilds: a stranger may ask to join any topic they like, so a
 * string that is not `watch:<uuid>:<uuid>` is the normal case rather than the
 * exception, and casting the halves of one would throw.
 */
create or replace function public.can_watch_pair_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.friendships theirs
     where theirs.status = 'accepted'
       and topic = 'watch:' || theirs.user_a::text || ':' || theirs.user_b::text
       and exists (
         -- ...and one of the two is somebody the caller is friends with. The
         -- players themselves pass this: they are friends with each other.
         select 1
           from public.friendships mine
          where mine.status = 'accepted'
            and auth.uid() in (mine.user_a, mine.user_b)
            and (theirs.user_a in (mine.user_a, mine.user_b)
              or theirs.user_b in (mine.user_a, mine.user_b))
       )
  )
$$;

revoke all on function public.can_watch_pair_topic(text) from public;
grant execute on function public.can_watch_pair_topic(text) to authenticated;

/**
 * May the caller publish to it?
 *
 * Only the two people playing. Invoker rights are enough here and so are the
 * right thing: this asks "is this your own game", and the row that answers it
 * is one the caller can already see.
 */
create or replace function public.can_feed_watch_topic(topic text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.friendships f
     where f.status = 'accepted'
       and auth.uid() in (f.user_a, f.user_b)
       and topic = 'watch:' || f.user_a::text || ':' || f.user_b::text
  )
$$;

revoke all on function public.can_feed_watch_topic(text) from public;
grant execute on function public.can_feed_watch_topic(text) to authenticated;

-- Added to the existing policies rather than replacing them: 0005's decide the
-- pair topic and must go on doing so untouched.
drop policy if exists watch_topic_read on realtime.messages;
create policy watch_topic_read on realtime.messages
  for select to authenticated
  using (public.can_watch_pair_topic(realtime.topic()));

drop policy if exists watch_topic_write on realtime.messages;
create policy watch_topic_write on realtime.messages
  for insert to authenticated
  with check (public.can_feed_watch_topic(realtime.topic()));
