-- Hardening notes from the second security audit (run-2). None was a
-- demonstrated finding; each closes a gap the audit pointed at.
--
-- ## 1. TURN credentials had no budget that held across isolates
--
-- `turn-credentials` counted calls per warm Edge Function isolate, so the real
-- ceiling was eight per ten minutes TIMES the isolates running, and any
-- confirmed account could mint, with or without a profile. The function now
-- charges every credential here, as the caller: a player only (a profile and a
-- satisfied assurance level, like every other play surface), twenty-four an
-- hour. A credential lasts four hours and the client caches it, so a player
-- needs a handful a day.
--
-- ## 2. An expired match came back with the feed its watchers had joined
--
-- Realtime keeps a join's authorization, so a spectator already on a feed
-- stays on it after the 45-second consent expiry; only a new feed takes it
-- away. `match_watch_state` revived an expired row with the SAME feed, so a
-- watcher from before the lapse picked up where they left off. A revived row
-- now gets a new feed; the players' clients pick it up on their next poll and
-- spectators who are still entitled rejoin from the friends list.

-- ---- 1 ------------------------------------------------------------------

create or replace function public.spend_turn_credential()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_allowed();
  perform play_private.spend_hourly('turn', 24);
end $$;
revoke all on function public.spend_turn_credential() from public, anon;
grant execute on function public.spend_turn_credential() to authenticated;

-- ---- 2 ------------------------------------------------------------------

create or replace function public.match_watch_state(p_match uuid)
returns table(topic text, shared boolean, mine boolean, theirs boolean)
language plpgsql security definer set search_path = '' as $$
declare row play_private.match_sharing; me uuid := auth.uid();
begin
  perform public.assert_allowed();
  perform play_private.spend('watch_state', 60);
  select * into row from play_private.match_sharing where id = p_match and me in(user_a,user_b);
  if row.id is null then return; end if;
  if not exists(select 1 from public.friendships where user_a = row.user_a and user_b = row.user_b and status = 'accepted') then return; end if;
  if row.expires_at <= now() and (select count(*) from play_private.match_sharing
       where created_by = row.created_by and expires_at > now()) >= 8 then return; end if;
  -- See (2).
  update play_private.match_sharing
     set feed = case when expires_at <= now() then gen_random_uuid() else feed end,
         expires_at = now() + interval '45 seconds'
   where id = row.id returning * into row;
  return query select 'watch:' || row.id::text || ':' || row.feed::text, row.consent_a and row.consent_b,
    case when me = row.user_a then row.consent_a else row.consent_b end,
    case when me = row.user_a then row.consent_b else row.consent_a end;
end $$;
revoke all on function public.match_watch_state(uuid) from public, anon;
grant execute on function public.match_watch_state(uuid) to authenticated;
