-- Additive release: ordinary progress and historical scores remain intact.
create schema if not exists play_private;
revoke all on schema play_private from public, anon, authenticated;

create table play_private.engine_versions (
  version text primary key check (length(version) <= 80),
  accepting boolean not null default true,
  created_at timestamptz not null default now()
);
create table play_private.budgets (
  owner uuid references auth.users(id) on delete cascade,
  action text not null,
  opened timestamptz not null default now(), calls integer not null default 1,
  primary key(owner, action)
);
create function play_private.spend(action_name text, maximum integer) returns void
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into play_private.budgets as b(owner, action) values(auth.uid(), action_name)
  on conflict(owner, action) do update set
    calls = case when b.opened < now() - interval '1 minute' then 1 else b.calls + 1 end,
    opened = case when b.opened < now() - interval '1 minute' then now() else b.opened end
  returning calls into n;
  if n > maximum then raise exception 'Please retry later' using errcode = '53400'; end if;
end $$;

create function public.list_friends()
returns table(id uuid, username text, status text, "theirMove" boolean, "ourMove" boolean, "blockedByMe" boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, f.status::text,
    f.status = 'pending' and f.requested_by = auth.uid(),
    f.status = 'pending' and f.requested_by <> auth.uid(),
    f.status = 'blocked' and f.blocked_by = auth.uid()
  from public.friendships f join public.profiles p
    on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
  where public.caller_allowed() and auth.uid() in(f.user_a, f.user_b)
  order by p.username
$$;
revoke all on function public.list_friends() from public, anon;
grant execute on function public.list_friends() to authenticated;

create table play_private.ranked_attempts (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  connection uuid not null, run integer not null check(run between 1 and 100000),
  mode text not null check(mode in ('adventure','puzzle','speed')),
  level integer not null check(level between 1 and 17),
  engine text not null references play_private.engine_versions(version),
  registered_a boolean not null default false, registered_b boolean not null default false,
  digest_a text, digest_b text, replay text,
  state text not null default 'waiting' check(state in ('waiting','queued','verifying','verified','not_ranked')),
  reason text, created_at timestamptz not null default now(), queued_at timestamptz,
  lease uuid, leased_until timestamptz, tries integer not null default 0,
  check(user_a < user_b), check(replay is null or octet_length(replay) <= 1048576),
  unique(user_a, user_b, connection, run)
);
create index ranked_queue on play_private.ranked_attempts(queued_at) where state in ('queued','verifying');
create table play_private.verified_results (
  attempt uuid primary key references play_private.ranked_attempts(id) on delete cascade,
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  node smallint not null check(node between 1 and 32),
  medal smallint not null check(medal between 1 and 3),
  seconds integer not null check(seconds between 3 and 5999),
  frames integer not null check(frames between 1 and 200000),
  verified_at timestamptz not null default now()
);
create index verified_rank on play_private.verified_results(node, seconds, verified_at);

create function public.register_ranked_attempt(their_id uuid, p_connection uuid, p_run integer, p_mode text, p_level integer, p_engine text)
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
  insert into play_private.ranked_attempts(user_a,user_b,connection,run,mode,level,engine,registered_a,registered_b)
  values(least(me,their_id),greatest(me,their_id),p_connection,p_run,p_mode,p_level,p_engine,me < their_id,me > their_id)
  on conflict(user_a,user_b,connection,run) do nothing;
  select * into row from play_private.ranked_attempts where user_a = least(me,their_id) and user_b = greatest(me,their_id) and connection = p_connection and run = p_run for update;
  if row.mode <> p_mode or row.level <> p_level or row.engine <> p_engine then raise exception 'Attempt disagreement' using errcode = '22023'; end if;
  update play_private.ranked_attempts set registered_a = registered_a or me = user_a, registered_b = registered_b or me = user_b where id = row.id;
  return row.id;
end $$;

create function public.submit_ranked_replay(p_attempt uuid, p_digest text, p_replay text default null)
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

create function public.ranked_status(p_attempt uuid)
returns table(state text, reason text) language sql stable security definer set search_path = '' as $$
  select case when a.state = 'waiting' and a.created_at < now() - interval '12 hours' then 'not_ranked' else a.state end,
         case when a.state = 'waiting' and a.created_at < now() - interval '12 hours' then 'Partner acknowledgement expired' else a.reason end
  from play_private.ranked_attempts a where a.id = p_attempt and public.caller_allowed() and auth.uid() in (a.user_a,a.user_b)
$$;

-- This role cannot read auth, profiles, progress, arbitrary replays, or mutate tables.
do $$ begin if not exists(select 1 from pg_roles where rolname = 'fbwg_verifier') then create role fbwg_verifier nologin; end if; end $$;
grant usage on schema play_private to fbwg_verifier;

create function play_private.claim_replay(p_versions text[])
returns table(id uuid, lease uuid, engine text, mode text, level integer, replay text, digest text)
language plpgsql security definer set search_path = '' as $$
declare row play_private.ranked_attempts;
begin
  update play_private.ranked_attempts set state = 'not_ranked', reason = 'Verification retry limit reached', replay = null
    where state = 'verifying' and leased_until < now() and tries >= 3;
  select * into row from play_private.ranked_attempts a
   where a.engine = any(p_versions) and (a.state = 'queued' or (a.state = 'verifying' and a.leased_until < now()))
     and a.tries < 3 and a.registered_a and a.registered_b and a.digest_a = a.digest_b
   order by a.queued_at for update skip locked limit 1;
  if row.id is null then return; end if;
  update play_private.ranked_attempts a set state = 'verifying', lease = gen_random_uuid(), leased_until = now() + interval '30 seconds', tries = tries + 1
   where a.id = row.id returning * into row;
  return query select row.id,row.lease,row.engine,row.mode,row.level,row.replay,row.digest_a;
end $$;
create function play_private.renew_replay(p_id uuid, p_lease uuid) returns boolean
language sql security definer set search_path = '' as $$
  with renewed as (update play_private.ranked_attempts set leased_until = now() + interval '30 seconds'
    where id = p_id and lease = p_lease and state = 'verifying' and leased_until > now() returning id)
  select exists(select 1 from renewed)
$$;
create function play_private.finish_replay(p_id uuid, p_lease uuid, p_result jsonb, p_reason text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare row play_private.ranked_attempts;
begin
  select * into row from play_private.ranked_attempts where id = p_id and lease = p_lease and state = 'verifying' and leased_until > now() for update;
  if row.id is null then return false; end if;
  if p_result is not null then
    insert into play_private.verified_results(attempt,user_a,user_b,node,medal,seconds,frames)
    values(row.id,row.user_a,row.user_b,(p_result->>'node')::smallint,(p_result->>'medal')::smallint,(p_result->>'seconds')::integer,(p_result->>'frames')::integer)
    on conflict(attempt) do nothing;
  end if;
  update play_private.ranked_attempts set state = case when p_result is null then 'not_ranked' else 'verified' end,
    reason = left(p_reason,200), replay = null, leased_until = null where id = row.id;
  return true;
end $$;

create function public.verified_leaderboard(p_node smallint, p_limit integer default 20)
returns table(rank integer,a_username text,b_username text,medal smallint,best_time_s integer,best_time_str text,is_mine boolean)
language sql stable security definer set search_path = '' as $$
  with best as (
    select distinct on(v.user_a,v.user_b) v.* from play_private.verified_results v
    where v.node = p_node order by v.user_a,v.user_b,v.seconds,v.medal desc,v.verified_at
  )
  select (row_number() over(order by b.seconds,b.verified_at))::integer,pa.username,pb.username,b.medal,b.seconds,public.time_label(b.seconds),auth.uid() in(b.user_a,b.user_b)
  from best b join public.profiles pa on pa.id = b.user_a join public.profiles pb on pb.id = b.user_b
  join public.friendships f on f.user_a = b.user_a and f.user_b = b.user_b and f.status = 'accepted'
  where public.caller_allowed() and not pa.hide_from_leaderboard and not pb.hide_from_leaderboard
  order by b.seconds,b.verified_at limit greatest(1,least(coalesce(p_limit,20),100))
$$;

-- No implicit defaults: even the private schema has RLS and explicit function grants.
alter table play_private.engine_versions enable row level security;
alter table play_private.budgets enable row level security;
alter table play_private.ranked_attempts enable row level security;
alter table play_private.verified_results enable row level security;
revoke all on all tables in schema play_private from public, anon, authenticated, fbwg_verifier;
revoke all on all functions in schema play_private from public, anon, authenticated, fbwg_verifier;
grant execute on function play_private.claim_replay(text[]), play_private.renew_replay(uuid,uuid), play_private.finish_replay(uuid,uuid,jsonb,text) to fbwg_verifier;
revoke all on function public.register_ranked_attempt(uuid,uuid,integer,text,integer,text), public.submit_ranked_replay(uuid,text,text), public.ranked_status(uuid), public.verified_leaderboard(smallint,integer) from public, anon;
grant execute on function public.register_ranked_attempt(uuid,uuid,integer,text,integer,text), public.submit_ranked_replay(uuid,text,text), public.ranked_status(uuid), public.verified_leaderboard(smallint,integer) to authenticated;

create table play_private.match_sharing (
  id uuid primary key,
  user_a uuid not null references auth.users(id) on delete cascade,
  user_b uuid not null references auth.users(id) on delete cascade,
  consent_a boolean not null default false, consent_b boolean not null default false,
  feed uuid not null default gen_random_uuid(),
  expires_at timestamptz not null default now(),
  check(user_a < user_b)
);
alter table play_private.match_sharing enable row level security;
revoke all on play_private.match_sharing from public, anon, authenticated, fbwg_verifier;

create function public.match_consent(p_match uuid, their_id uuid, p_on boolean)
returns table(topic text, shared boolean, mine boolean, theirs boolean)
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); row play_private.match_sharing; changed boolean;
begin
  perform public.assert_allowed();
  perform play_private.spend('sharing',30);
  if p_match is null or their_id is null or p_on is null or not exists(select 1 from public.friendships where user_a = least(me,their_id) and user_b = greatest(me,their_id) and status = 'accepted') then raise exception 'Pair unavailable' using errcode = '42501'; end if;
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
create function public.match_watch_state(p_match uuid)
returns table(topic text, shared boolean, mine boolean, theirs boolean)
language plpgsql security definer set search_path = '' as $$
declare row play_private.match_sharing; me uuid := auth.uid();
begin
  perform public.assert_allowed();
  select * into row from play_private.match_sharing where id = p_match and me in(user_a,user_b);
  if row.id is null then return; end if;
  if not exists(select 1 from public.friendships where user_a = row.user_a and user_b = row.user_b and status = 'accepted') then return; end if;
  update play_private.match_sharing set expires_at = now() + interval '45 seconds' where id = row.id;
  return query select 'watch:' || row.id::text || ':' || row.feed::text, row.consent_a and row.consent_b,
    case when me = row.user_a then row.consent_a else row.consent_b end,
    case when me = row.user_a then row.consent_b else row.consent_a end;
end $$;
/*
 * Two topic shapes, on purpose, for exactly one release.
 *
 * The watch topic stops being derived from who the two players are and starts
 * being `watch:<match>:<feed>` -- an identifier the pair consents to and the
 * server rotates on every revocation. That is the whole point of the change:
 * a topic computed from two user ids cannot be withdrawn, because anybody who
 * can name the pair can name the topic.
 *
 * But `deployed` applies this file BEFORE it waits for Vercel, and Vercel
 * builds on the same push -- so for a few seconds, and for however long a
 * failed build takes to notice, the PREVIOUS release is talking to this
 * schema. That client publishes and subscribes to `watch:<lo>:<hi>`. Replacing
 * these two predicates outright would answer false for every topic it knows,
 * which is spectating broken for everybody watching at the moment of a deploy.
 *
 * So the legacy arm below is 0013's predicate, unchanged in substance, kept
 * alongside the new one. It widens nothing: a `watch:<uuid>:<uuid>` topic
 * still requires the same accepted friendship it always did, and the new arm
 * still requires consent from both players. See `supabase/README.md`.
 *
 * It is transitional and must not survive. `supabase/deferred/` holds the
 * contract migration that deletes it; move that file into `migrations/` in the
 * release AFTER the client that stops using the old shape is live.
 */
create or replace function public.can_watch_pair_topic(topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.caller_allowed() and (exists(
    select 1 from play_private.match_sharing m
    join public.friendships pair on pair.user_a = m.user_a and pair.user_b = m.user_b and pair.status = 'accepted'
    where m.consent_a and m.consent_b and m.expires_at > now() and topic = 'watch:' || m.id::text || ':' || m.feed::text
    and (auth.uid() in(m.user_a,m.user_b) or exists(select 1 from public.friendships f where f.status = 'accepted' and auth.uid() in(f.user_a,f.user_b) and (m.user_a in(f.user_a,f.user_b) or m.user_b in(f.user_a,f.user_b))))
  ) or exists(
    -- Transitional: the previous release's `watch:<lo>:<hi>`. Remove with the
    -- deferred contract migration.
    select 1 from public.friendships theirs
    where theirs.status = 'accepted'
      and topic = 'watch:' || theirs.user_a::text || ':' || theirs.user_b::text
      and exists(select 1 from public.friendships mine where mine.status = 'accepted'
        and auth.uid() in(mine.user_a,mine.user_b)
        and (theirs.user_a in(mine.user_a,mine.user_b) or theirs.user_b in(mine.user_a,mine.user_b)))
  ))
$$;
create or replace function public.can_feed_watch_topic(topic text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.caller_allowed() and (exists(
    select 1 from play_private.match_sharing m join public.friendships pair on pair.user_a = m.user_a and pair.user_b = m.user_b and pair.status = 'accepted'
    where auth.uid() in(m.user_a,m.user_b) and m.consent_a and m.consent_b and m.expires_at > now() and topic = 'watch:' || m.id::text || ':' || m.feed::text
  ) or exists(
    -- Transitional, as above. Definer rights do not widen this: the caller has
    -- to be one of the two people whose ids the topic is built from.
    select 1 from public.friendships f
    where f.status = 'accepted' and auth.uid() in(f.user_a,f.user_b)
      and topic = 'watch:' || f.user_a::text || ':' || f.user_b::text
  ))
$$;
-- Viewer presence grants no broadcast authority. Realtime caches channel policies;
-- every revocation rotates the feed and clients also recheck current authorization.
drop policy if exists watch_presence_write on realtime.messages;
create policy watch_presence_write on realtime.messages for insert to authenticated
  with check(extension = 'presence' and public.can_watch_pair_topic(realtime.topic()));
revoke all on function public.match_consent(uuid,uuid,boolean),public.match_watch_state(uuid) from public,anon;
grant execute on function public.match_consent(uuid,uuid,boolean),public.match_watch_state(uuid) to authenticated;

create function play_private.revoke_pair_sharing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or new.status <> 'accepted' then
    update play_private.match_sharing set consent_a = false, consent_b = false, feed = gen_random_uuid(), expires_at = now()
    where user_a = old.user_a and user_b = old.user_b;
  end if;
  return old;
end $$;
revoke all on function play_private.revoke_pair_sharing() from public,anon,authenticated,fbwg_verifier;
create trigger revoke_pair_sharing after update or delete on public.friendships for each row execute function play_private.revoke_pair_sharing();

-- Effective production grants included anon independently of PUBLIC defaults.
-- These RPCs already authenticate their callers; remove the unnecessary API grant.
revoke execute on function
  public.accept_friend(uuid),
  public.assurance_satisfied(),
  public.block_friend(uuid),
  public.can_watch_pair_topic(text),
  public.claim_username(text, text),
  public.delete_me(),
  public.generate_recovery_codes(),
  public.has_profile(),
  public.has_verified_factor(),
  public.leaderboard(smallint, integer),
  public.leaderboard_standing(uuid),
  public.recovery_codes_left(),
  public.redeem_recovery_code(text),
  public.remove_friend(uuid),
  public.request_friend(text),
  public.sync_progress(uuid, smallint[], integer[], text[]),
  public.unblock_friend(uuid)
from public, anon;
grant execute on function
  public.accept_friend(uuid),
  public.assurance_satisfied(),
  public.block_friend(uuid),
  public.can_watch_pair_topic(text),
  public.claim_username(text, text),
  public.delete_me(),
  public.generate_recovery_codes(),
  public.has_profile(),
  public.has_verified_factor(),
  public.leaderboard(smallint, integer),
  public.leaderboard_standing(uuid),
  public.recovery_codes_left(),
  public.redeem_recovery_code(text),
  public.remove_friend(uuid),
  public.request_friend(text),
  public.sync_progress(uuid, smallint[], integer[], text[]),
  public.unblock_friend(uuid)
to authenticated;

alter function public.is_member(uuid,uuid) set search_path = '';
alter function public.pair_lo(uuid,uuid) set search_path = '';
alter function public.pair_hi(uuid,uuid) set search_path = '';
alter function public.plausible_time(integer) set search_path = '';
alter function public.time_label(integer) set search_path = '';

create index if not exists friendships_requester_idx on public.friendships(requested_by);
create index if not exists friendships_blocker_idx on public.friendships(blocked_by) where blocked_by is not null;

alter policy profiles_write_own on public.profiles
  using (id = (select auth.uid()) and (select public.assurance_satisfied()))
  with check (id = (select auth.uid()) and (select public.assurance_satisfied()));
alter policy profiles_delete_own on public.profiles
  using (id = (select auth.uid()) and (select public.assurance_satisfied()));
alter policy friendships_delete on public.friendships
  using ((select auth.uid()) in (user_a,user_b) and (select public.caller_allowed())
    and (status <> 'blocked' or blocked_by = (select auth.uid())));
alter policy progress_read on public.pair_progress using (
  (select public.caller_allowed()) and exists (
    select 1 from public.friendships f where f.user_a = pair_progress.user_a
      and f.user_b = pair_progress.user_b and f.status = 'accepted'
      and (select auth.uid()) in (f.user_a,f.user_b)));
