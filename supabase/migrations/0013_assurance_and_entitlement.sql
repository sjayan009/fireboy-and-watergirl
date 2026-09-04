-- Two rules the database only ever assumed, now stated once and enforced.
--
-- ## The second factor was a screen, not a boundary
--
-- `auth.ts` asks Supabase for the session's assurance level and holds the app
-- at the `locked` stage until a factor is answered. Every policy and every
-- security-definer function below it authorized on `auth.uid()` alone -- so the
-- factor guarded the SPA and nothing else. A password-only session is a
-- perfectly good `aal1` JWT, and PostgREST, the RPCs and Realtime all accepted
-- it: the whole account, including `delete_me`, was reachable by skipping the
-- one screen that asked for the code.
--
-- Supabase says this in as many words -- adding MFA to the interface does not
-- improve security unless the protected resources check the assurance level
-- themselves. `assurance_satisfied()` is that check, in one place:
--
--   * a session that has answered a factor (`aal2`) always passes;
--   * a session at `aal1` passes only if the account has NO verified factor.
--
-- So somebody who has not opted in is unaffected, and somebody who has cannot
-- be reached around the challenge. Recovery is the single deliberate exception
-- and stays at `aal1`: see `redeem_recovery_code`, which is the way back in for
-- exactly the person who cannot reach `aal2`.
--
-- ## An account with no profile was never as inert as 0004 claimed
--
-- 0004 argued that an unredeemed sign-up "cannot be found by anybody, cannot be
-- befriended, and therefore cannot reach a single row of anyone else's data".
-- The first clause was true and the conclusion was not: `profiles_read` was
-- `using (true)`, so a no-profile account could list every user id in the
-- project, and from there use the table policies directly.
--
-- `has_profile()` makes the invite gate mean what 0004 said it meant. Redeeming
-- an invite is now the thing that turns an auth user into a caller the rest of
-- the schema will answer, rather than merely the thing that gives them a name.
--
-- Neither rule is new behaviour for the shipped client -- it holds a `locked`
-- session at the code prompt and a `nameless` one at the username form -- so
-- the release before this one keeps working against it.

-- ---------------------------------------------------------------- the rules

/**
 * Does this account have a second factor it has actually finished setting up?
 *
 * `security definer` because `auth.mfa_factors` is not readable by the
 * `authenticated` role and must not become so. It answers one boolean about
 * the caller's own account and reveals nothing else.
 */
create or replace function public.has_verified_factor()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1 from auth.mfa_factors f
     where f.user_id = auth.uid() and f.status = 'verified'
  )
$$;

revoke all on function public.has_verified_factor() from public;
grant execute on function public.has_verified_factor() to authenticated;

/**
 * Has this session presented everything the account is configured to require?
 *
 * The `aal` claim is the session's, not the account's -- Supabase issues `aal1`
 * on a password sign-in and raises it to `aal2` only when a factor challenge is
 * answered. A missing claim is read as `aal1`, which is the safe direction: a
 * token that does not say it is strong is not treated as strong.
 */
create or replace function public.assurance_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select case
    when auth.uid() is null then false
    when coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then true
    else not public.has_verified_factor()
  end
$$;

revoke all on function public.assurance_satisfied() from public;
grant execute on function public.assurance_satisfied() to authenticated;

/**
 * Has this account been through the invite gate?
 *
 * `security definer`, and that is load-bearing rather than incidental: this is
 * called from `profiles`' own select policy, and an invoker-rights function
 * reading `profiles` from inside a `profiles` policy would recurse.
 */
create or replace function public.has_profile()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid())
$$;

revoke all on function public.has_profile() from public;
grant execute on function public.has_profile() to authenticated;

/** Both halves, for the many places that want both. */
create or replace function public.caller_allowed()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public.assurance_satisfied() and public.has_profile()
$$;

revoke all on function public.caller_allowed() from public;
grant execute on function public.caller_allowed() to authenticated;

/**
 * The same rules as an exception rather than a boolean, for the definer
 * functions -- where a policy's silent "no rows" would be a worse answer than
 * a message saying which gate was closed.
 */
create or replace function public.assert_assured()
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not public.assurance_satisfied() then
    raise exception 'this account needs its second factor for that'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_assured() from public;
grant execute on function public.assert_assured() to authenticated;

create or replace function public.assert_allowed()
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  perform public.assert_assured();
  if not public.has_profile() then
    raise exception 'claim a username first' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.assert_allowed() from public;
grant execute on function public.assert_allowed() to authenticated;

-- ------------------------------------------------------------- the policies

-- The directory is still readable by everybody who is IN -- you cannot add a
-- friend you cannot find -- and no longer by an account that has not redeemed
-- an invite or answered its own second factor.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated using (public.caller_allowed());

drop policy if exists profiles_write_own on public.profiles;
create policy profiles_write_own on public.profiles
  for update to authenticated
  using (id = auth.uid() and public.assurance_satisfied())
  with check (id = auth.uid() and public.assurance_satisfied());

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
  for delete to authenticated
  using (id = auth.uid() and public.assurance_satisfied());

drop policy if exists friendships_read on public.friendships;
create policy friendships_read on public.friendships
  for select to authenticated
  using (public.is_member(user_a, user_b) and public.caller_allowed());

-- Unchanged in substance from 0009 -- a block is not the blocked party's to
-- lift, and deleting is how you leave -- with the two gates added.
drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete to authenticated
  using (
    public.is_member(user_a, user_b)
    and public.caller_allowed()
    and (status <> 'blocked' or blocked_by = auth.uid())
  );

-- ------------------------------------------------------- the Realtime topics
--
-- Both topics are gated by row level security over `realtime.messages`, which
-- calls these. Adding the rule here rather than to the policies keeps 0005's
-- and 0010's reasoning about invoker versus definer rights intact.

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
       and topic = 'pair:' || f.user_a::text || ':' || f.user_b::text
  )
$$;

revoke all on function public.can_use_pair_topic(text) from public;
grant execute on function public.can_use_pair_topic(text) to authenticated;

create or replace function public.can_watch_pair_topic(topic text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.caller_allowed() and exists (
    select 1
      from public.friendships theirs
     where theirs.status = 'accepted'
       and topic = 'watch:' || theirs.user_a::text || ':' || theirs.user_b::text
       and exists (
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

create or replace function public.can_feed_watch_topic(topic text)
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
       and topic = 'watch:' || f.user_a::text || ':' || f.user_b::text
  )
$$;

revoke all on function public.can_feed_watch_topic(text) from public;
grant execute on function public.can_feed_watch_topic(text) to authenticated;

-- ----------------------------------------------------------- the functions
--
-- Bodies unchanged apart from the guard at the top, which replaces each
-- function's own "not signed in" check with the same three questions asked in
-- one place.

create or replace function public.request_friend(their_username text)
returns public.friendships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  them uuid;
  lo uuid; hi uuid;
  existing public.friendships;
  row public.friendships;
begin
  perform public.assert_allowed();
  select id into them from public.profiles
    where lower(username) = lower(their_username);
  if them is null then
    raise exception 'no such user' using errcode = 'P0002';
  end if;
  if them = me then
    raise exception 'you cannot befriend yourself' using errcode = '22023';
  end if;

  lo := least(me, them);
  hi := greatest(me, them);

  select * into existing from public.friendships
    where user_a = lo and user_b = hi;
  if existing.status = 'blocked' then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  insert into public.friendships (user_a, user_b, status, requested_by)
  values (lo, hi, 'pending', me)
  on conflict (user_a, user_b) do update
    -- they asked first, and now so have we: that is a yes
    set status = case
          when public.friendships.status = 'pending'
           and public.friendships.requested_by <> me then 'accepted'
          else public.friendships.status
        end,
        updated_at = now()
  returning * into row;
  return row;
end;
$$;

revoke all on function public.request_friend(text) from public;
grant execute on function public.request_friend(text) to authenticated;

create or replace function public.accept_friend(their_id uuid)
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
     set status = 'accepted', updated_at = now()
   where user_a = least(me, their_id)
     and user_b = greatest(me, their_id)
     and status = 'pending'
     -- you cannot accept your own request
     and requested_by <> me
  returning * into row;
  if row is null then
    raise exception 'no pending request from that user' using errcode = 'P0002';
  end if;
  return row;
end;
$$;

revoke all on function public.accept_friend(uuid) from public;
grant execute on function public.accept_friend(uuid) to authenticated;

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
     -- Already blocked by them is not yours to take over.
     and (status <> 'blocked' or blocked_by = me)
  returning * into row;
  if row is null then
    raise exception 'no friendship to block' using errcode = 'P0002';
  end if;
  return row;
end;
$$;

revoke all on function public.block_friend(uuid) from public;
grant execute on function public.block_friend(uuid) to authenticated;

create or replace function public.unblock_friend(their_id uuid)
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
     set status = 'accepted', blocked_by = null, updated_at = now()
   where user_a = least(me, their_id)
     and user_b = greatest(me, their_id)
     and status = 'blocked'
     and blocked_by = me
  returning * into row;
  if row is null then
    raise exception 'that is not your block to lift' using errcode = 'P0002';
  end if;
  return row;
end;
$$;

revoke all on function public.unblock_friend(uuid) from public;
grant execute on function public.unblock_friend(uuid) to authenticated;

/**
 * Delete the calling account, and everything that hangs off it.
 *
 * The most destructive thing an account can do to itself, and until now the
 * one most obviously reachable around the second factor: a stolen password was
 * enough. `assert_assured` rather than `assert_allowed`, because an account
 * that never claimed a username must still be able to leave.
 */
create or replace function public.delete_me()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
begin
  perform public.assert_assured();
  delete from auth.users where id = me;
end;
$$;

revoke all on function public.delete_me() from public;
grant execute on function public.delete_me() to authenticated;

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
  select
    (row_number() over (order by pp.best_time_s asc, pp.updated_at asc))::integer,
    pa.username,
    pb.username,
    pp.medal,
    pp.best_time_s,
    pp.best_time_str,
    auth.uid() in (pp.user_a, pp.user_b)
  from public.pair_progress pp
  join public.profiles pa on pa.id = pp.user_a
  join public.profiles pb on pb.id = pp.user_b
  where public.caller_allowed()
    and pp.node = p_node
    and pp.medal > 0
    and pp.best_time_s is not null
    and not pa.hide_from_leaderboard
    and not pb.hide_from_leaderboard
  order by pp.best_time_s asc, pp.updated_at asc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
$$;

revoke all on function public.leaderboard(smallint, integer) from public;
grant execute on function public.leaderboard(smallint, integer) to authenticated;

create or replace function public.leaderboard_standing(their_id uuid)
returns table (node smallint, rank integer, entries integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with listed as (
    select pp.node, pp.user_a, pp.user_b, pp.best_time_s, pp.updated_at
      from public.pair_progress pp
      join public.profiles pa on pa.id = pp.user_a
      join public.profiles pb on pb.id = pp.user_b
     where pp.medal > 0 and pp.best_time_s is not null
       and not pa.hide_from_leaderboard and not pb.hide_from_leaderboard
  ),
  ranked as (
    select node, user_a, user_b,
           (row_number() over (partition by node
                               order by best_time_s asc, updated_at asc))::integer as r,
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

revoke all on function public.leaderboard_standing(uuid) from public;
grant execute on function public.leaderboard_standing(uuid) to authenticated;

/**
 * How many recovery codes are left.
 *
 * Deliberately NOT gated on `aal2`. The unlock screen shows this to somebody
 * who is standing at the code prompt precisely because they cannot reach
 * `aal2`, and the answer -- a count of the caller's own codes -- is of no use
 * to anybody who is not them.
 */
create or replace function public.recovery_codes_left()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer from public.mfa_recovery_codes
   where user_id = auth.uid() and used_at is null
$$;

revoke all on function public.recovery_codes_left() from public;
grant execute on function public.recovery_codes_left() to authenticated;
