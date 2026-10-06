-- What the second security audit (run-2, main 8bdd147, 2026-10-05) found.
-- Each section names its finding.
--
-- ## 1. The recovery functions took a signed-out session's word for it
--
-- `assurance_satisfied` stopped trusting a token whose session row is gone
-- (20261005010000), but `generate_recovery_codes` and `redeem_recovery_code`
-- never called it. A token kept after "sign out everywhere" could still mint
-- codes, spend one, take the factor off and end the owner's new sessions for
-- as long as the token lived. Both now require the session to exist, and a
-- session past its `not_after` time-box no longer counts as existing.
--
-- ## 2. A friend could spend somebody else's ceilings
--
-- The per-account ceilings (8 live matches, 200 waiting attempts, 8 parked
-- replays) counted every row naming the account, including rows a friend made
-- alone. One friend could fill them and lock the account out of sharing and
-- ranking with everybody else. They now count only what the account itself
-- did: the match rows it created, the attempts it registered, the replays it
-- uploaded. `match_watch_state` is metered and no longer revives a row past
-- its creator's ceiling.
--
-- ## 3. A block did not reach the spectator door
--
-- `may_watch` let a friend of EITHER player watch, so somebody blocked by one
-- player still watched them through a friendship with the other. A block
-- between the watcher and either player now refuses, and because the revoke
-- trigger asks `may_watch`, blocking also rotates the feed the blocked person
-- was on.
--
-- ## 4. One friend could put the other on the board
--
-- `sync_progress` needs only an accepted friendship, so either member could
-- write the pair's times alone, and `leaderboard` listed them under both names.
-- Each side's own best is now kept, and the board shows the SLOWER of the two:
-- a time both players reported. Rows that exist already are grandfathered.
--
-- ## 5. The pair's channel was a fact about the two of them
--
-- `pair:<lo>:<hi>` could not be withdrawn: Realtime keeps a join's
-- authorization, so an ex-friend's open tab stayed subscribed. The topic is now
-- `pair:<channel>`, a column of the friendship row replaced on every change of
-- status. Clients read it from the row, which only the two members can see.
--
-- ## 6. Two profile columns nothing uses were writable without limit
--
-- `display_name` and `avatar_url` were left writable by 20261005030000 with no
-- length or shape check, and every friend reads them. Nothing in the product
-- writes them, so they are no longer writable.
--
-- ## 7. Verified attempts were kept forever
--
-- Only the best verified result per pair and level is ever shown. Others
-- older than a day are deleted with their attempt.
--
-- ## 8. Tables that RLS alone was guarding
--
-- The budget and recovery tables relied on RLS with no policy. They now also
-- hold no grants for anon or authenticated, like `username_claim_budget`.

-- ---- 1 ------------------------------------------------------------------

create or replace function public.assurance_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select case
    when auth.uid() is null then false
    when coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then false
    when not exists (
      select 1 from auth.sessions s
       where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
         and s.user_id = auth.uid()
         and (s.not_after is null or s.not_after > now())
    ) then false
    when coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then true
    else not public.has_verified_factor()
  end
$$;
revoke all on function public.assurance_satisfied() from public, anon;
grant execute on function public.assurance_satisfied() to authenticated;

create or replace function public.generate_recovery_codes()
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp, extensions
as $$
declare
  me uuid := auth.uid();
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  out text[] := '{}';
  raw bytea;
  code text;
  i integer;
  j integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'answer your authenticator before making recovery codes'
      using errcode = '42501';
  end if;
  if not public.has_verified_factor() then
    raise exception 'turn two-factor on first' using errcode = '42501';
  end if;
  -- See (1). With an aal2 claim and a factor, this is "the session is live".
  if not public.assurance_satisfied() then
    raise exception 'this session has ended' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('recovery:' || me::text, 0));

  delete from public.mfa_recovery_codes
   where user_id = me and used_at is null;

  for i in 1..10 loop
    code := '';
    raw := extensions.gen_random_bytes(10);
    for j in 1..10 loop
      code := code || substr(alphabet, 1 + (get_byte(raw, j - 1) & 31), 1);
      if j = 5 then code := code || '-'; end if;
    end loop;
    insert into public.mfa_recovery_codes (user_id, code_hash)
    values (me, extensions.crypt(code, extensions.gen_salt('bf')));
    out := out || code;
  end loop;

  return out;
end;
$$;
revoke all on function public.generate_recovery_codes() from public, anon;
grant execute on function public.generate_recovery_codes() to authenticated;

create or replace function public.redeem_recovery_code(code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp, extensions
as $$
declare
  me uuid := auth.uid();
  mine uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  hit text;
  recent integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if mine is null then
    raise exception 'this token names no session' using errcode = '42501';
  end if;
  -- See (1). Callable at aal1 on purpose, so this asks only that the session
  -- is live, not that it is assured.
  if not exists (select 1 from auth.sessions s
                  where s.id = mine and s.user_id = me
                    and (s.not_after is null or s.not_after > now())) then
    raise exception 'this session has ended' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('recovery:' || me::text, 0));

  delete from public.mfa_recovery_attempts a
   where a.user_id = me and a.tried_at <= now() - interval '15 minutes';

  select count(*) into recent
    from public.mfa_recovery_attempts a
   where a.user_id = me and not a.ok
     and a.tried_at > now() - interval '15 minutes';
  if recent >= 5 then
    raise exception 'too many attempts; wait fifteen minutes'
      using errcode = '42501';
  end if;

  select c.code_hash into hit
    from public.mfa_recovery_codes c
   where c.user_id = me
     and c.used_at is null
     and c.code_hash = extensions.crypt(code, c.code_hash)
   limit 1;

  insert into public.mfa_recovery_attempts (user_id, ok)
  values (me, hit is not null);

  if hit is null then
    return false;
  end if;

  update public.mfa_recovery_codes
     set used_at = now()
   where user_id = me and code_hash = hit;

  delete from auth.mfa_factors where user_id = me;
  delete from public.mfa_recovery_codes where user_id = me and used_at is null;
  delete from public.mfa_recovery_attempts where user_id = me;

  delete from auth.sessions where user_id = me and id <> mine;

  return true;
end;
$$;
revoke all on function public.redeem_recovery_code(text) from public, anon;
grant execute on function public.redeem_recovery_code(text) to authenticated;

-- ---- 2 ------------------------------------------------------------------

alter table play_private.match_sharing add column if not exists created_by uuid;
alter table play_private.ranked_attempts add column if not exists replay_by uuid;

create or replace function public.match_consent(p_match uuid, their_id uuid, p_on boolean)
returns table(topic text, shared boolean, mine boolean, theirs boolean)
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); row play_private.match_sharing; changed boolean;
begin
  perform public.assert_allowed();
  perform play_private.spend('sharing',30);
  if p_match is null or their_id is null or p_on is null or not exists(select 1 from public.friendships where user_a = least(me,their_id) and user_b = greatest(me,their_id) and status = 'accepted') then raise exception 'Pair unavailable' using errcode = '42501'; end if;
  perform play_private.lock_accounts(me, their_id);
  delete from play_private.match_sharing
   where id in (select s.id from play_private.match_sharing s
                 where s.expires_at < now() - interval '1 hour'
                 order by s.expires_at limit 50 for update skip locked);
  -- See (2): only the rows this account made.
  if not exists(select 1 from play_private.match_sharing where id = p_match)
     and (select count(*) from play_private.match_sharing
           where created_by = me and expires_at > now()) >= 8 then
    raise exception 'Please retry later' using errcode = '53400';
  end if;
  insert into play_private.match_sharing(id,user_a,user_b,created_by) values(p_match,least(me,their_id),greatest(me,their_id),me) on conflict(id) do nothing;
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

create or replace function public.match_watch_state(p_match uuid)
returns table(topic text, shared boolean, mine boolean, theirs boolean)
language plpgsql security definer set search_path = '' as $$
declare row play_private.match_sharing; me uuid := auth.uid();
begin
  perform public.assert_allowed();
  -- The client asks every five seconds; twelve a minute is the normal rate.
  perform play_private.spend('watch_state', 60);
  select * into row from play_private.match_sharing where id = p_match and me in(user_a,user_b);
  if row.id is null then return; end if;
  if not exists(select 1 from public.friendships where user_a = row.user_a and user_b = row.user_b and status = 'accepted') then return; end if;
  -- See (2): reviving an expired row must not take its creator past eight.
  if row.expires_at <= now() and (select count(*) from play_private.match_sharing
       where created_by = row.created_by and expires_at > now()) >= 8 then return; end if;
  update play_private.match_sharing set expires_at = now() + interval '45 seconds' where id = row.id;
  return query select 'watch:' || row.id::text || ':' || row.feed::text, row.consent_a and row.consent_b,
    case when me = row.user_a then row.consent_a else row.consent_b end,
    case when me = row.user_a then row.consent_b else row.consent_a end;
end $$;
revoke all on function public.match_watch_state(uuid) from public, anon;
grant execute on function public.match_watch_state(uuid) to authenticated;

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
  perform play_private.lock_accounts(me, their_id);
  perform play_private.prune_ranked();
  -- See (2): only the attempts this account registered.
  if not exists(select 1 from play_private.ranked_attempts where user_a = least(me,their_id) and user_b = greatest(me,their_id) and connection = p_connection and run = p_run)
     and (select count(*) from play_private.ranked_attempts
           where state = 'waiting'
             and ((me = user_a and registered_a) or (me = user_b and registered_b))) >= 200 then
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

create or replace function public.submit_ranked_replay(p_attempt uuid, p_digest text, p_replay text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare row play_private.ranked_attempts; mine text;
begin
  perform public.assert_allowed();
  perform play_private.spend('submit', 30);
  select * into row from play_private.ranked_attempts where id = p_attempt and auth.uid() in(user_a,user_b);
  if row.id is null then raise exception 'Attempt unavailable' using errcode = '42501'; end if;
  perform play_private.lock_accounts(row.user_a, row.user_b);
  perform play_private.prune_ranked();
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
  -- See (2): only the replays this account uploaded.
  if row.replay is null and p_replay is not null
     and (select count(*) from play_private.ranked_attempts
           where replay_by = auth.uid()
             and state = 'waiting' and replay is not null) >= 8 then
    raise exception 'Please retry later' using errcode = '53400';
  end if;
  update play_private.ranked_attempts set
    digest_a = case when auth.uid() = user_a then p_digest else digest_a end,
    digest_b = case when auth.uid() = user_b then p_digest else digest_b end,
    replay_by = case when replay is null and p_replay is not null then auth.uid() else replay_by end,
    replay = coalesce(replay, p_replay)
  where id = row.id returning * into row;
  if row.digest_a is not null and row.digest_b is not null and row.digest_a <> row.digest_b then
    update play_private.ranked_attempts set state = 'not_ranked', reason = 'Players acknowledged different replays', replay = null where id = row.id;
    return 'not_ranked';
  end if;
  if row.registered_a and row.registered_b and row.digest_a = row.digest_b and row.replay is not null then
    if (select count(*) from play_private.ranked_attempts
         where auth.uid() in (user_a, user_b) and state in ('queued','verifying')) >= 4 then
      return 'waiting';
    end if;
    update play_private.ranked_attempts set state = 'queued', queued_at = now() where id = row.id;
    return 'queued';
  end if;
  return 'waiting';
end $$;

revoke all on function public.register_ranked_attempt(uuid,uuid,integer,text,integer,text), public.submit_ranked_replay(uuid,text,text) from public, anon;
grant execute on function public.register_ranked_attempt(uuid,uuid,integer,text,integer,text), public.submit_ranked_replay(uuid,text,text) to authenticated;

-- ---- 3 ------------------------------------------------------------------

create or replace function play_private.may_watch(watcher uuid, a uuid, b uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select watcher in (a, b) or (
    exists(
      select 1 from public.friendships f
       where f.status = 'accepted' and watcher in (f.user_a, f.user_b)
         and (a in (f.user_a, f.user_b) or b in (f.user_a, f.user_b)))
    and not exists(
      select 1 from public.friendships f
       where f.status = 'blocked' and watcher in (f.user_a, f.user_b)
         and (a in (f.user_a, f.user_b) or b in (f.user_a, f.user_b))))
$$;
revoke all on function play_private.may_watch(uuid, uuid, uuid)
  from public, anon, authenticated, fbwg_verifier;

-- `revoke_pair_sharing` (20261005020000) needs no change: it already asks
-- `may_watch` when an accepted friendship ends, which includes a block.

-- ---- 4 ------------------------------------------------------------------

alter table public.pair_progress add column if not exists best_a_s integer;
alter table public.pair_progress add column if not exists best_b_s integer;
alter table public.pair_progress drop constraint if exists side_times_plausible;
alter table public.pair_progress add constraint side_times_plausible check (
  (best_a_s is null or best_a_s between 3 and 5999) and
  (best_b_s is null or best_b_s between 3 and 5999));
-- Grandfathered: what is on the board today stays on it.
update public.pair_progress set best_a_s = best_time_s, best_b_s = best_time_s
 where best_time_s is not null and best_a_s is null and best_b_s is null;

create or replace function public.sync_progress(
  their_id uuid,
  p_stats smallint[],
  p_times integer[],
  p_times_str text[]
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  lo uuid := least(auth.uid(), their_id);
  hi uuid := greatest(auth.uid(), their_id);
  n integer;
  medal smallint;
  secs integer;
  label text;
  changed integer;
  touched integer := 0;
  spent integer;
begin
  perform public.assert_allowed();
  if not exists (select 1 from public.friendships f
                  where f.user_a = lo and f.user_b = hi
                    and f.status = 'accepted') then
    raise exception 'you are not playing with that person' using errcode = '42501';
  end if;
  if array_length(p_stats, 1) is distinct from 32
     or array_length(p_times, 1) is distinct from 32 then
    raise exception 'the map has 32 nodes' using errcode = '22023';
  end if;

  insert into public.progress_sync_budget as b (user_id, user_a, user_b, calls)
  values (me, lo, hi, 1)
  on conflict (user_id, user_a, user_b) do update
    set calls = case when b.window_start < now() - interval '1 minute'
                     then 1 else b.calls + 1 end,
        window_start = case when b.window_start < now() - interval '1 minute'
                            then now() else b.window_start end
  returning b.calls into spent;
  if spent > 40 then
    raise exception 'too many progress writes; slow down' using errcode = '53400';
  end if;

  for n in 1..32 loop
    medal := p_stats[n];
    continue when medal is null or medal < 0;
    if medal > 3 then
      raise exception 'no such medal' using errcode = '22023';
    end if;

    secs := nullif(p_times[n], 0);
    if not public.plausible_time(secs) then
      raise exception 'no timer produces that' using errcode = '22023';
    end if;
    if medal = 0 then secs := null; end if;
    label := public.time_label(secs);

    insert into public.pair_progress as pp
      (user_a, user_b, node, medal, best_time_s, best_time_str, best_a_s, best_b_s)
    values (lo, hi, n::smallint, medal, secs, label,
            case when me = lo then secs end, case when me = hi then secs end)
    on conflict (user_a, user_b, node) do update
      set medal = greatest(pp.medal, excluded.medal),
          best_time_s = case
            when excluded.best_time_s is null then pp.best_time_s
            when pp.best_time_s is null then excluded.best_time_s
            else least(pp.best_time_s, excluded.best_time_s)
          end,
          best_time_str = case
            when excluded.best_time_s is not null
             and (pp.best_time_s is null or excluded.best_time_s < pp.best_time_s)
            then excluded.best_time_str else pp.best_time_str
          end,
          updated_at = now()
      where pp.medal < excluded.medal
         or (excluded.best_time_s is not null
             and (pp.best_time_s is null or excluded.best_time_s < pp.best_time_s));

    get diagnostics changed = row_count;
    touched := touched + changed;

    -- See (4). The pair's best is what the game unlocks from; each side's own
    -- best is what the board is allowed to believe. Not counted in `touched`,
    -- which still says how many of the pair's results improved.
    if secs is not null then
      update public.pair_progress pp
         set best_a_s = case when me = lo then least(coalesce(pp.best_a_s, secs), secs) else pp.best_a_s end,
             best_b_s = case when me = hi then least(coalesce(pp.best_b_s, secs), secs) else pp.best_b_s end
       where pp.user_a = lo and pp.user_b = hi and pp.node = n
         and secs < coalesce(case when me = lo then pp.best_a_s else pp.best_b_s end, 6000);
    end if;
  end loop;
  return touched;
end;
$$;
revoke all on function public.sync_progress(uuid, smallint[], integer[], text[]) from public, anon;
grant execute on function public.sync_progress(uuid, smallint[], integer[], text[]) to authenticated;

create or replace function public.leaderboard(p_node smallint, p_limit integer
                                              default 20)
returns table (
  rank        integer,
  a_username  text,
  b_username  text,
  medal       smallint,
  best_time_s integer,
  best_time_str text,
  is_mine     boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with listed as (
    select pp.*, greatest(pp.best_a_s, pp.best_b_s) as agreed
      from public.pair_progress pp
     where pp.node = p_node and pp.medal > 0
       and pp.best_a_s is not null and pp.best_b_s is not null
  )
  select
    (row_number() over (order by l.agreed asc, l.updated_at asc))::integer,
    pa.username,
    pb.username,
    l.medal,
    l.agreed,
    public.time_label(l.agreed),
    auth.uid() in (l.user_a, l.user_b)
  from listed l
  join public.profiles pa on pa.id = l.user_a
  join public.profiles pb on pb.id = l.user_b
  where public.caller_allowed()
    and not pa.hide_from_leaderboard
    and not pb.hide_from_leaderboard
  order by l.agreed asc, l.updated_at asc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
$$;
revoke all on function public.leaderboard(smallint, integer) from public, anon;
grant execute on function public.leaderboard(smallint, integer) to authenticated;

create or replace function public.leaderboard_standing(their_id uuid)
returns table (node smallint, rank integer, entries integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with listed as (
    select pp.node, pp.user_a, pp.user_b,
           greatest(pp.best_a_s, pp.best_b_s) as agreed, pp.updated_at
      from public.pair_progress pp
      join public.profiles pa on pa.id = pp.user_a
      join public.profiles pb on pb.id = pp.user_b
     where pp.medal > 0 and pp.best_a_s is not null and pp.best_b_s is not null
       and not pa.hide_from_leaderboard and not pb.hide_from_leaderboard
  ),
  ranked as (
    select node, user_a, user_b,
           (row_number() over (partition by node
                               order by agreed asc, updated_at asc))::integer as r,
           (count(*) over (partition by node))::integer as n
      from listed
  )
  select node, r, n
    from ranked
   where public.caller_allowed()
     and user_a = least(auth.uid(), their_id)
     and user_b = greatest(auth.uid(), their_id)
   order by node
$$;
revoke all on function public.leaderboard_standing(uuid) from public, anon;
grant execute on function public.leaderboard_standing(uuid) to authenticated;

-- ---- 5 ------------------------------------------------------------------

alter table public.friendships
  add column if not exists channel uuid not null default gen_random_uuid();

create or replace function play_private.rotate_pair_channel() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    new.channel := gen_random_uuid();
  end if;
  return new;
end $$;
revoke all on function play_private.rotate_pair_channel()
  from public, anon, authenticated, fbwg_verifier;

drop trigger if exists rotate_pair_channel on public.friendships;
create trigger rotate_pair_channel
  before update on public.friendships
  for each row execute function play_private.rotate_pair_channel();

-- Invoker rights, as before: the row is read through `friendships_read`.
create or replace function public.can_use_pair_topic(topic text)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public.caller_allowed() and exists (
    select 1
      from public.friendships f
     where f.status = 'accepted'
       and auth.uid() in (f.user_a, f.user_b)
       and topic = 'pair:' || f.channel::text
  )
$$;
revoke all on function public.can_use_pair_topic(text) from public, anon;
grant execute on function public.can_use_pair_topic(text) to authenticated;

-- ---- 6 ------------------------------------------------------------------

revoke update (display_name, avatar_url) on public.profiles from authenticated;

-- ---- 7 ------------------------------------------------------------------

create or replace function play_private.prune_ranked()
returns void language sql security definer set search_path = '' as $$
  update play_private.ranked_attempts
     set state = 'not_ranked', reason = 'Partner acknowledgement expired', replay = null
   where id in (select a.id from play_private.ranked_attempts a
                 where a.state = 'waiting' and a.created_at < now() - interval '12 hours'
                 order by a.created_at limit 50 for update skip locked);
  update play_private.ranked_attempts
     set state = 'not_ranked', reason = 'Verification did not finish', replay = null
   where id in (select a.id from play_private.ranked_attempts a
                 where a.state in ('queued', 'verifying')
                   and a.queued_at < now() - interval '1 day'
                   and (a.state = 'queued' or a.leased_until < now())
                 order by a.queued_at limit 50 for update skip locked);
  delete from play_private.ranked_attempts
   where id in (select a.id from play_private.ranked_attempts a
                 where a.state = 'not_ranked' and a.created_at < now() - interval '1 day'
                 order by a.created_at limit 50 for update skip locked);
  -- See (7). The same ordering `verified_leaderboard` picks its best by.
  delete from play_private.ranked_attempts
   where id in (select r.attempt from (
                  select v.attempt, v.verified_at,
                         row_number() over (partition by v.user_a, v.user_b, v.node
                                            order by v.seconds, v.medal desc, v.verified_at) as place
                    from play_private.verified_results v) r
                 where r.place > 1 and r.verified_at < now() - interval '1 day'
                 limit 50);
$$;
revoke all on function play_private.prune_ranked()
  from public, anon, authenticated, fbwg_verifier;

-- ---- 8 ------------------------------------------------------------------

revoke all on public.progress_sync_budget, public.friend_request_budget,
              public.mfa_recovery_codes, public.mfa_recovery_attempts
  from anon, authenticated;
