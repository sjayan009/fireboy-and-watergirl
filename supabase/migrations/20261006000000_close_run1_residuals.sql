-- What the second fix check of the first security audit still found open on
-- main 3380271 (2026-10-05). Each section names its finding.
--
-- ## 1. Turning two-factor off let a parked session in (F1)
--
-- A password-only session parked at the code prompt is `aal1`, and
-- `assurance_satisfied` lets `aal1` through the moment the account has no
-- verified factor. The Settings button signs other devices out afterwards, but
-- from the client, and a direct call to GoTrue's unenroll does not. So the
-- database does it: when a verified factor row goes, every session of that
-- account that is not `aal2` goes with it.
--
-- `aal2` sessions stay. Unenrolling a verified factor needs one, so the caller's
-- own session survives; GoTrue deletes the factor BEFORE it downgrades sessions
-- to `aal1` (auth `UnenrollFactor`, checked against its source), so the
-- trigger sees them still at `aal2`. `redeem_recovery_code` deletes factors
-- from an `aal1` session -- the person who lost the authenticator -- so the
-- token's own session is spared by id. GoTrue's connection carries no JWT, so
-- there the exclusion matches nothing.
--
-- ## 2. A token with no session_id ended its own session too (F5)
--
-- `redeem_recovery_code` kept "every session but this one", and with no
-- `session_id` claim "this one" was nobody. Unreachable through Supabase,
-- whose tokens always carry the claim; refused now rather than reasoned about.
--
-- ## 3. Profiles made before the gate (F3)
--
-- `claim_username` refuses anonymous and unconfirmed users since
-- `20261005010000`; profiles they made before that stayed. Production holds
-- none (checked 2026-10-05), so this deletes nothing there.
--
-- ## 4. Ranked rows stuck in the queue (D1)
--
-- A queued attempt for an engine no verifier runs any more held its replay
-- bytes forever. After a day queued, or a day with a dead lease, it is ended
-- as unranked and its replay released, and the existing day-old clean-up
-- deletes it later.
--
-- ## 5. Count-then-insert (D4)
--
-- Every per-account ceiling counted rows and then inserted. The caller's own
-- calls were serialized by their budget row, but the OTHER player's were not,
-- so two friends of one account could each squeeze a row past its cap at the
-- same moment. Each writer now takes an advisory lock on both accounts, lower
-- id first, so every writer that counts rows of an account waits its turn.
--
-- ## 6. The verifier's queue query (D6)
--
-- `claim_replay` counted each candidate pair's busy rows with a correlated
-- subquery, once per candidate. It is one grouped pass now, joined, and the
-- queue has a partial index.

-- ---- 1 ------------------------------------------------------------------

create or replace function play_private.end_unassured_sessions()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status::text = 'verified' then
    delete from auth.sessions s
     where s.user_id = old.user_id
       and s.aal::text is distinct from 'aal2'
       and s.id is distinct from nullif(auth.jwt() ->> 'session_id', '')::uuid;
  end if;
  return old;
end $$;
revoke all on function play_private.end_unassured_sessions()
  from public, anon, authenticated, fbwg_verifier;

drop trigger if exists end_unassured_sessions on auth.mfa_factors;
create trigger end_unassured_sessions
  after delete on auth.mfa_factors
  for each row execute function play_private.end_unassured_sessions();

-- ---- 2 ------------------------------------------------------------------

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
  -- See (2): without it, "everybody else" below would be everybody.
  if mine is null then
    raise exception 'this token names no session' using errcode = '42501';
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

-- ---- 3 ------------------------------------------------------------------

delete from public.profiles p
 using auth.users u
 where u.id = p.id
   and (coalesce(u.is_anonymous, false) or u.email_confirmed_at is null);

-- ---- 5, the lock --------------------------------------------------------

/**
 * Serialize every capped writer that touches either account. Lower id first,
 * always, so two writers locking the same pair cannot deadlock.
 */
create or replace function play_private.lock_accounts(x uuid, y uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('play-account:' || least(x, y)::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('play-account:' || greatest(x, y)::text, 0));
end $$;
revoke all on function play_private.lock_accounts(uuid, uuid)
  from public, anon, authenticated, fbwg_verifier;

-- ---- 4 ------------------------------------------------------------------

create index if not exists ranked_attempts_queue
  on play_private.ranked_attempts (queued_at)
  where state in ('queued', 'verifying');

create or replace function play_private.prune_ranked()
returns void language sql security definer set search_path = '' as $$
  update play_private.ranked_attempts
     set state = 'not_ranked', reason = 'Partner acknowledgement expired', replay = null
   where id in (select a.id from play_private.ranked_attempts a
                 where a.state = 'waiting' and a.created_at < now() - interval '12 hours'
                 order by a.created_at limit 50 for update skip locked);
  -- See (4).
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
$$;
revoke all on function play_private.prune_ranked()
  from public, anon, authenticated, fbwg_verifier;

-- ---- 5, the writers -----------------------------------------------------

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
  if not exists(select 1 from play_private.match_sharing where id = p_match)
     and (select count(*) from play_private.match_sharing
           where me in (user_a, user_b) and expires_at > now()) >= 8 then
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
  if not exists(select 1 from play_private.ranked_attempts where user_a = least(me,their_id) and user_b = greatest(me,their_id) and connection = p_connection and run = p_run)
     and (select count(*) from play_private.ranked_attempts
           where me in (user_a, user_b) and state = 'waiting') >= 200 then
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
  -- The pair is read unlocked to know which accounts to lock, then the row is
  -- locked after them: the same order as every other writer.
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
  if row.replay is null and p_replay is not null
     and (select count(*) from play_private.ranked_attempts
           where auth.uid() in (user_a, user_b)
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

-- ---- 6 ------------------------------------------------------------------

-- ponytail: still one window over the whole eligible queue per claim; the
-- queue is bounded by four per account, so a cursor table is not worth it
-- until there are thousands of ranked players.
create or replace function play_private.claim_replay(p_versions text[])
returns table(id uuid, lease uuid, engine text, mode text, level integer, replay text, digest text)
language plpgsql security definer set search_path = '' as $$
declare row play_private.ranked_attempts; candidate uuid;
begin
  update play_private.ranked_attempts set state = 'not_ranked', reason = 'Verification retry limit reached', replay = null
    where state = 'verifying' and leased_until < now() and tries >= 3;
  for candidate in
    with busy as (
      select b.user_a, b.user_b, count(*) as n
        from play_private.ranked_attempts b
       where b.state = 'verifying' and b.leased_until >= now()
       group by b.user_a, b.user_b)
    select q.id from (
      select a.id, a.queued_at,
             row_number() over (partition by a.user_a, a.user_b order by a.queued_at)
               + coalesce(busy.n, 0) as turn
        from play_private.ranked_attempts a
        left join busy on busy.user_a = a.user_a and busy.user_b = a.user_b
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
