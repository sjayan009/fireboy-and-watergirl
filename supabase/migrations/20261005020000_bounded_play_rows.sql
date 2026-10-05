-- Everything `20260905002813_production_play` lets a player create now has an
-- upper bound and a way out. From the first security audit (2026-10-04).
--
-- Each writer there is guarded by `play_private.spend`, which limits calls per
-- minute and resets every minute -- a rate, never a total. Nothing pruned what
-- the calls left behind, so a script holding one friendship (a second account
-- of its own will do) could grow shared tables for as long as it liked:
--
--   * `match_consent` inserts a `match_sharing` row per caller-chosen match id,
--     ~43,000 a day, and every watch-topic authorization by ANY user scanned the
--     whole table, because the topic is compared as a computed string the
--     primary key cannot serve.
--   * `register_ranked_attempt` inserts a `ranked_attempts` row per new
--     (connection, run), ~86,000 a day, none ever deleted.
--   * `submit_ranked_replay` stores up to 1 MiB on a row still waiting for the
--     partner, and nothing released it -- ~30 MiB a minute.
--   * `claim_replay` served one global FIFO, so one colluding pair's backlog
--     sat in front of everybody else's first attempt.
--
-- Ranked play is not reachable in production today (no `engine_versions` row
-- accepts), and `match_sharing` holds nine rows, all long expired. This lands
-- before either matters.
--
-- And one revocation that never happened:
--
--   * A watcher admitted because they were a friend of one player kept the
--     feed after that player unfriended or blocked them: `revoke_pair_sharing`
--     only rotated the pair's OWN matches, and the only recheck was a poll in
--     the watcher's own browser. Realtime caches a joined channel's policy, so
--     a modified client could go on reading. Feeds now rotate when either
--     player's friendship with anybody leaves 'accepted'.
--
-- Compatible with the release before: no signature changes, and the client
-- already handles every new refusal (53400) as "try again later".

-- ---- indexes the cascades and triggers were scanning without ------------

create index if not exists match_sharing_pair
  on play_private.match_sharing (user_a, user_b);
create index if not exists match_sharing_user_b
  on play_private.match_sharing (user_b);
create index if not exists ranked_attempts_user_b
  on play_private.ranked_attempts (user_b);
create index if not exists verified_results_user_a
  on play_private.verified_results (user_a);
create index if not exists verified_results_user_b
  on play_private.verified_results (user_b);
create index if not exists play_budgets_owner
  on play_private.budgets (owner);

-- ---- match sharing ------------------------------------------------------

/**
 * The match id a well-formed watch topic names, or NULL.
 *
 * So the watch predicates can find their row by primary key instead of
 * building `'watch:' || id || ':' || feed` for every row and comparing.
 * The full-string comparison stays as well; this only decides which row to
 * compare it against.
 */
create or replace function play_private.watch_topic_match(topic text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when topic ~ '^watch:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(topic, ':', 2)::uuid
  end
$$;
revoke all on function play_private.watch_topic_match(text)
  from public, anon, authenticated, fbwg_verifier;

create or replace function public.can_watch_pair_topic(topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.caller_allowed() and exists(
    select 1 from play_private.match_sharing m
    join public.friendships pair on pair.user_a = m.user_a and pair.user_b = m.user_b and pair.status = 'accepted'
    where m.id = play_private.watch_topic_match(topic)
    and m.consent_a and m.consent_b and m.expires_at > now() and topic = 'watch:' || m.id::text || ':' || m.feed::text
    and (auth.uid() in(m.user_a,m.user_b) or exists(select 1 from public.friendships f where f.status = 'accepted' and auth.uid() in(f.user_a,f.user_b) and (m.user_a in(f.user_a,f.user_b) or m.user_b in(f.user_a,f.user_b))))
  )
$$;

create or replace function public.can_feed_watch_topic(topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.caller_allowed() and exists(
    select 1 from play_private.match_sharing m join public.friendships pair on pair.user_a = m.user_a and pair.user_b = m.user_b and pair.status = 'accepted'
    where m.id = play_private.watch_topic_match(topic)
    and auth.uid() in(m.user_a,m.user_b) and m.consent_a and m.consent_b and m.expires_at > now() and topic = 'watch:' || m.id::text || ':' || m.feed::text
  )
$$;

/**
 * Unchanged in what it answers. Two additions at the top: rows this pair
 * left expired for over an hour are deleted, and a pair may hold at most
 * eight live matches at once.
 *
 * An hour rather than the 45-second window itself, because `match_watch_state`
 * brings an expired row back to life when a game that paused -- a tab in the
 * background -- starts polling again, and that should keep working. A real
 * pair has one live match; eight is generous.
 */
create or replace function public.match_consent(p_match uuid, their_id uuid, p_on boolean)
returns table(topic text, shared boolean, mine boolean, theirs boolean)
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); row play_private.match_sharing; changed boolean;
begin
  perform public.assert_allowed();
  perform play_private.spend('sharing',30);
  if p_match is null or their_id is null or p_on is null or not exists(select 1 from public.friendships where user_a = least(me,their_id) and user_b = greatest(me,their_id) and status = 'accepted') then raise exception 'Pair unavailable' using errcode = '42501'; end if;
  delete from play_private.match_sharing
   where user_a = least(me,their_id) and user_b = greatest(me,their_id)
     and expires_at < now() - interval '1 hour';
  if not exists(select 1 from play_private.match_sharing where id = p_match)
     and (select count(*) from play_private.match_sharing
           where user_a = least(me,their_id) and user_b = greatest(me,their_id)
             and expires_at > now()) >= 8 then
    raise exception 'Please retry later' using errcode = '53400';
  end if;
  insert into play_private.match_sharing(id,user_a,user_b) values(p_match,least(me,their_id),greatest(me,their_id)) on conflict(id) do nothing;
  select * into row from play_private.match_sharing where id = p_match and user_a = least(me,their_id) and user_b = greatest(me,their_id) for update;
  if row.id is null then raise exception 'Match unavailable' using errcode = '42501'; end if;
  changed := p_on is distinct from case when me = row.user_a then row.consent_a else row.consent_b end;
  update play_private.match_sharing set
    consent_a = case when me = user_a then p_on else consent_a end,
    consent_b = case when me = user_b then p_on else consent_b end,
    feed = case when changed then gen_random_uuid() else feed end,
    expires_at = now() + interval '45 seconds'
   where id = row.id returning * into row;
  return query select 'watch:' || row.id::text || ':' || row.feed::text, row.consent_a and row.consent_b,
    case when me = row.user_a then row.consent_a else row.consent_b end,
    case when me = row.user_a then row.consent_b else row.consent_a end;
end $$;
revoke all on function public.match_consent(uuid,uuid,boolean) from public, anon;
grant execute on function public.match_consent(uuid,uuid,boolean) to authenticated;

/**
 * A friendship leaving 'accepted' revokes two things now.
 *
 * Its own pair's matches, as before: consent off, new feed.
 *
 * And the LIVE matches either of the two plays with anybody else get a new
 * feed, consent untouched. A watcher was admitted because they were a friend
 * of one of the players; when that friendship ends, the topic they joined has
 * to stop existing, because Realtime will not re-ask the policy on its own.
 * The players' clients pick the new topic up on their next five-second poll of
 * `match_watch_state`; other watchers rejoin from the friends list.
 */
create or replace function play_private.revoke_pair_sharing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or new.status <> 'accepted' then
    update play_private.match_sharing set consent_a = false, consent_b = false, feed = gen_random_uuid(), expires_at = now()
    where user_a = old.user_a and user_b = old.user_b;
    if old.status = 'accepted' then
      update play_private.match_sharing set feed = gen_random_uuid()
       where expires_at > now()
         and not (user_a = old.user_a and user_b = old.user_b)
         and (user_a in (old.user_a, old.user_b) or user_b in (old.user_a, old.user_b));
    end if;
  end if;
  return old;
end $$;
revoke all on function play_private.revoke_pair_sharing() from public,anon,authenticated,fbwg_verifier;

-- ---- ranked attempts ----------------------------------------------------

/**
 * Tidy this pair's stale attempts. Called from both writers, so a pair that
 * keeps playing keeps its own history short and a pair that stops costs one
 * day's rows at most.
 *
 * After twelve hours a waiting attempt can no longer be ranked
 * (`submit_ranked_replay` and `ranked_status` already say so); its replay is
 * released then. After a day it, and any attempt that ended unranked, is
 * deleted. Verified attempts are kept: `verified_results` hangs off them.
 * The client treats an attempt it cannot find after twelve hours as unranked,
 * so a deleted row reads the same as the label it already had.
 */
create or replace function play_private.prune_ranked(p_a uuid, p_b uuid)
returns void language sql security definer set search_path = '' as $$
  update play_private.ranked_attempts
     set state = 'not_ranked', reason = 'Partner acknowledgement expired', replay = null
   where user_a = p_a and user_b = p_b and state = 'waiting'
     and created_at < now() - interval '12 hours';
  delete from play_private.ranked_attempts
   where user_a = p_a and user_b = p_b and state = 'not_ranked'
     and created_at < now() - interval '1 day';
$$;
revoke all on function play_private.prune_ranked(uuid,uuid)
  from public, anon, authenticated, fbwg_verifier;

/**
 * Unchanged, except that a pair may hold at most 200 attempts still waiting
 * for both players. An honest pair registers one per run and completes or
 * abandons it; two hundred open in twelve hours is a script.
 */
create or replace function public.register_ranked_attempt(their_id uuid, p_connection uuid, p_run integer, p_mode text, p_level integer, p_engine text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); row play_private.ranked_attempts;
begin
  perform public.assert_allowed();
  perform play_private.spend('register', 60);
  if their_id is null or their_id = me or p_connection is null or p_run is null or p_mode is null or p_level is null or
     not exists(select 1 from public.friendships where user_a = least(me,their_id) and user_b = greatest(me,their_id) and status = 'accepted') then
    raise exception 'Pair unavailable' using errcode = '42501';
  end if;
  if not exists(select 1 from play_private.engine_versions where version = p_engine and accepting) then
    raise exception 'This engine version is not accepting ranked attempts' using errcode = '22023';
  end if;
  if p_mode not in ('adventure','puzzle','speed') or p_level < 1 or p_level > (case p_mode when 'adventure' then 17 when 'puzzle' then 9 else 6 end) then
    raise exception 'Invalid level' using errcode = '22023';
  end if;
  perform play_private.prune_ranked(least(me,their_id), greatest(me,their_id));
  if not exists(select 1 from play_private.ranked_attempts where user_a = least(me,their_id) and user_b = greatest(me,their_id) and connection = p_connection and run = p_run)
     and (select count(*) from play_private.ranked_attempts
           where user_a = least(me,their_id) and user_b = greatest(me,their_id)
             and state = 'waiting') >= 200 then
    raise exception 'Please retry later' using errcode = '53400';
  end if;
  insert into play_private.ranked_attempts(user_a,user_b,connection,run,mode,level,engine,registered_a,registered_b)
  values(least(me,their_id),greatest(me,their_id),p_connection,p_run,p_mode,p_level,p_engine,me < their_id,me > their_id)
  on conflict(user_a,user_b,connection,run) do nothing;
  select * into row from play_private.ranked_attempts where user_a = least(me,their_id) and user_b = greatest(me,their_id) and connection = p_connection and run = p_run for update;
  if row.mode <> p_mode or row.level <> p_level or row.engine <> p_engine then raise exception 'Attempt disagreement' using errcode = '22023'; end if;
  update play_private.ranked_attempts set registered_a = registered_a or me = user_a, registered_b = registered_b or me = user_b where id = row.id;
  return row.id;
end $$;

/**
 * Unchanged, except that a pair may park replay bytes on at most eight
 * attempts that are still waiting for the other player. The honest case is
 * both players submitting within seconds of each other at the end of a run,
 * so a replay waits on one row, briefly. Eight MiB per pair is the ceiling on
 * bytes nobody has agreed to yet, instead of no ceiling.
 */
create or replace function public.submit_ranked_replay(p_attempt uuid, p_digest text, p_replay text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare row play_private.ranked_attempts; mine text;
begin
  perform public.assert_allowed();
  perform play_private.spend('submit', 30);
  select * into row from play_private.ranked_attempts where id = p_attempt and auth.uid() in(user_a,user_b) for update;
  if row.id is null or not exists(select 1 from public.friendships where user_a = row.user_a and user_b = row.user_b and status = 'accepted') then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or octet_length(p_replay) > 1048576 then raise exception 'Invalid replay submission' using errcode = '22023'; end if;
  mine := case when auth.uid() = row.user_a then row.digest_a else row.digest_b end;
  if mine is not null and mine <> p_digest then raise exception 'Replay acknowledgement is immutable' using errcode = '22023'; end if;
  if row.state in ('verified','not_ranked','verifying','queued') then return row.state; end if;
  if row.created_at < now() - interval '12 hours' then
    update play_private.ranked_attempts set state = 'not_ranked', reason = 'Submission expired', replay = null where id = row.id;
    return 'not_ranked';
  end if;
  perform play_private.prune_ranked(row.user_a, row.user_b);
  if row.replay is null and p_replay is not null
     and (select count(*) from play_private.ranked_attempts
           where user_a = row.user_a and user_b = row.user_b
             and state = 'waiting' and replay is not null) >= 8 then
    raise exception 'Please retry later' using errcode = '53400';
  end if;
  update play_private.ranked_attempts set
    digest_a = case when auth.uid() = user_a then p_digest else digest_a end,
    digest_b = case when auth.uid() = user_b then p_digest else digest_b end,
    replay = coalesce(replay, p_replay)
  where id = row.id returning * into row;
  if row.digest_a is not null and row.digest_b is not null and row.digest_a <> row.digest_b then
    update play_private.ranked_attempts set state = 'not_ranked', reason = 'Players acknowledged different replays', replay = null where id = row.id;
    return 'not_ranked';
  end if;
  if row.registered_a and row.registered_b and row.digest_a = row.digest_b and row.replay is not null then
    update play_private.ranked_attempts set state = 'queued', queued_at = now() where id = row.id;
    return 'queued';
  end if;
  return 'waiting';
end $$;

revoke all on function public.register_ranked_attempt(uuid,uuid,integer,text,integer,text), public.submit_ranked_replay(uuid,text,text) from public, anon;
grant execute on function public.register_ranked_attempt(uuid,uuid,integer,text,integer,text), public.submit_ranked_replay(uuid,text,text) to authenticated;

/**
 * Round-robin between pairs instead of one global FIFO.
 *
 * Each eligible attempt is ranked within its own pair by age, plus however
 * many of the pair's attempts a verifier is already working on, and the queue
 * is served by that rank first and age second: every pair's first job goes
 * before any pair's second. A pair that queues fifty attempts now delays only
 * itself. `FOR UPDATE` cannot share a statement with a window function, so the
 * order is computed first and the lock taken on each candidate in turn.
 */
create or replace function play_private.claim_replay(p_versions text[])
returns table(id uuid, lease uuid, engine text, mode text, level integer, replay text, digest text)
language plpgsql security definer set search_path = '' as $$
declare row play_private.ranked_attempts; candidate uuid;
begin
  update play_private.ranked_attempts set state = 'not_ranked', reason = 'Verification retry limit reached', replay = null
    where state = 'verifying' and leased_until < now() and tries >= 3;
  for candidate in
    select q.id from (
      select a.id, a.queued_at,
             row_number() over (partition by a.user_a, a.user_b order by a.queued_at)
               -- What the pair already has on a verifier counts as turns taken,
               -- or claiming its first job would make its second "first" again.
               + (select count(*) from play_private.ranked_attempts busy
                   where busy.user_a = a.user_a and busy.user_b = a.user_b
                     and busy.state = 'verifying' and busy.leased_until >= now()) as turn
        from play_private.ranked_attempts a
       where a.engine = any(p_versions) and (a.state = 'queued' or (a.state = 'verifying' and a.leased_until < now()))
         and a.tries < 3 and a.registered_a and a.registered_b and a.digest_a = a.digest_b
    ) q
    order by q.turn, q.queued_at
    limit 32
  loop
    select * into row from play_private.ranked_attempts a
     where a.id = candidate
       and (a.state = 'queued' or (a.state = 'verifying' and a.leased_until < now())) and a.tries < 3
     for update skip locked;
    exit when row.id is not null;
  end loop;
  if row.id is null then return; end if;
  update play_private.ranked_attempts a set state = 'verifying', lease = gen_random_uuid(), leased_until = now() + interval '30 seconds', tries = tries + 1
   where a.id = row.id returning * into row;
  return query select row.id,row.lease,row.engine,row.mode,row.level,row.replay,row.digest_a;
end $$;
revoke all on function play_private.claim_replay(text[]) from public, anon, authenticated;
grant execute on function play_private.claim_replay(text[]) to fbwg_verifier;
