-- The contract half of the watch-topic change. NOT YET APPLIED -- see
-- supabase/deferred/README.md for how a file here becomes a migration.
--
-- `20260905002813_production_play.sql` moved the watch topic from
-- `watch:<lo>:<hi>`, which is derived from who the two players are, to
-- `watch:<match>:<feed>`, which the pair consents to and the server rotates on
-- every revocation. It kept the old shape working alongside the new one so
-- that the release before it -- which was still live while the migration
-- applied, and which `deployed` cannot wait for -- did not lose spectating.
--
-- This removes that compatibility arm, and with it the last way to reach a
-- spectator feed by naming two user ids instead of holding a consent the
-- players can withdraw. Until it runs, revoking consent still closes the new
-- topic but the derived one remains reachable by any friend of either player.
--
-- Apply it only once the client that stopped publishing to `watch:<lo>:<hi>`
-- is live, and check that first rather than assuming it: an early run breaks
-- spectating for anybody still on the old bundle.

create or replace function public.can_watch_pair_topic(topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.caller_allowed() and exists(
    select 1 from play_private.match_sharing m
    join public.friendships pair on pair.user_a = m.user_a and pair.user_b = m.user_b and pair.status = 'accepted'
    where m.consent_a and m.consent_b and m.expires_at > now() and topic = 'watch:' || m.id::text || ':' || m.feed::text
    and (auth.uid() in(m.user_a,m.user_b) or exists(select 1 from public.friendships f where f.status = 'accepted' and auth.uid() in(f.user_a,f.user_b) and (m.user_a in(f.user_a,f.user_b) or m.user_b in(f.user_a,f.user_b))))
  )
$$;

create or replace function public.can_feed_watch_topic(topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.caller_allowed() and exists(
    select 1 from play_private.match_sharing m join public.friendships pair on pair.user_a = m.user_a and pair.user_b = m.user_b and pair.status = 'accepted'
    where auth.uid() in(m.user_a,m.user_b) and m.consent_a and m.consent_b and m.expires_at > now() and topic = 'watch:' || m.id::text || ':' || m.feed::text
  )
$$;

-- Nothing derives a topic from user ids any more, so nothing should be sitting
-- on one. Rows are left alone: `match_sharing` is keyed by match, and the
-- feeds it holds are already the new shape.
