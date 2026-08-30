-- One private Realtime channel per friendship.
--
-- Each accepted friendship gets the topic `pair:<user_a>:<user_b>`, in the same
-- canonical order `friendships` already enforces, and that single channel does
-- four jobs:
--
--   presence     is my friend online, in the lobby, or in a game
--   invites      broadcast, carrying the level and the role assignment
--   signalling   the SDP and ICE exchange for the peer connection
--   relay        the transport itself, when the peer connection will not come up
--
-- It is also the private option. One shared lobby channel would tell every
-- account who else is online; a channel per friendship tells exactly the two
-- people who already agreed to be friends.
--
-- Supabase gates private channels on row level security over `realtime.messages`,
-- which starts with RLS enabled and NO policies -- so today every private
-- channel is closed to everyone. These two policies open exactly the pair
-- topics, and nothing else: without them, knowing a channel's name would be
-- enough to join it.

/**
 * May the caller use this topic?
 *
 * Deliberately INVOKER rights, not definer. `friendships` already has a select
 * policy restricting rows to their two members, so running as the caller means
 * the row simply is not visible to anybody else and the check cannot be talked
 * round. A definer function here would be re-implementing, by hand, a rule that
 * already exists one layer down.
 *
 * The topic is rebuilt and compared rather than parsed apart. Splitting
 * `pair:<uuid>:<uuid>` and casting the halves would throw on a topic that is
 * not that shape -- and a stranger can ask to join any topic they like, so
 * malformed input is the normal case, not the exception.
 */
create or replace function public.can_use_pair_topic(topic text)
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
       and topic = 'pair:' || f.user_a::text || ':' || f.user_b::text
  )
$$;

revoke all on function public.can_use_pair_topic(text) from public;
grant execute on function public.can_use_pair_topic(text) to authenticated;

-- Reading covers both receiving broadcasts and seeing presence; writing covers
-- sending them and announcing yourself. A pending friendship grants neither:
-- somebody you have not accepted cannot open a channel to you.
drop policy if exists pair_topic_read on realtime.messages;
create policy pair_topic_read on realtime.messages
  for select to authenticated
  using (public.can_use_pair_topic(realtime.topic()));

drop policy if exists pair_topic_write on realtime.messages;
create policy pair_topic_write on realtime.messages
  for insert to authenticated
  with check (public.can_use_pair_topic(realtime.topic()));
