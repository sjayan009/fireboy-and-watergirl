-- What a session is allowed to be, beyond carrying a valid signature.
-- From the first security audit (2026-10-04).
--
-- ## 1. Recovery left every other session alive
--
-- `redeem_recovery_code` deletes the account's factors and nothing else. Two
-- things followed from that.
--
-- Every outstanding `aal1` token for the account passed `assurance_satisfied`
-- the moment the factor rows were gone, because that function decides whether
-- `aal1` is enough from the ACCOUNT's current state -- so a session parked at
-- the code prompt somewhere else was promoted without anyone signing in again.
--
-- And a session that reached `aal2` earlier -- on the phone that was lost,
-- which is the usual reason anybody reaches for a recovery code -- kept its
-- refresh token. Recovering from a stolen device did not cut the device off.
--
-- So a redemption now ends every session but the one redeeming.
-- `auth.refresh_tokens` and `auth.mfa_amr_claims` hang off `auth.sessions` with
-- ON DELETE CASCADE (checked against the live project, not assumed), so
-- deleting the session row revokes its refresh tokens too.
--
-- ## 2. A deleted session's access token still worked until it expired
--
-- Deleting the row stops refreshes, but the access token already issued is a
-- signed JWT and nothing here ever asked whether its session still existed. So
-- `assurance_satisfied` now does: the token's `session_id` must name a live
-- row in `auth.sessions` belonging to the caller. That one primary-key lookup
-- is what makes sign-out-everywhere, the recovery above and Supabase's own
-- session time-boxes take effect at the database straight away, rather than up
-- to an hour later.
--
-- ## 3. Nothing in the database said "not anonymous" or "confirmed address"
--
-- `20260910000000_open_the_gate` made a confirmed address the whole price of
-- playing, and only the SPA checked it. Anonymous sign-ins are OFF on the live
-- project (its /auth/v1/settings says `anonymous_users: false`), so this is
-- defence in depth rather than a live hole -- but it is one dashboard toggle
-- from being one. An anonymous JWT is now refused by `assurance_satisfied`, and
-- `claim_username` -- the only way a profile comes into being, and so the
-- gate in front of every player surface -- requires a confirmed, non-anonymous
-- user.
--
-- ## 4. Codes minted under 0012 were never revoked
--
-- 0012 let an `aal1` session mint codes, from `random()`. 0014 fixed the
-- generator and left the rows it had already minted redeemable. Production
-- holds none (checked: zero unused codes older than 0014), so the delete below
-- removes nothing there; it is here so the statement is true of every
-- database these files are applied to, not only the one that was checked.
--
-- Compatible with the release before: none of this changes a signature or a
-- shape, and a live, non-anonymous, confirmed session sees no difference.

create or replace function public.assurance_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select case
    when auth.uid() is null then false
    -- A token that does not say it is anonymous is not; one that does is
    -- refused outright. See (3).
    when coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then false
    -- See (2). A missing claim reads as no session, which is the safe way to
    -- be wrong.
    when not exists (
      select 1 from auth.sessions s
       where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid
         and s.user_id = auth.uid()
    ) then false
    when coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' then true
    else not public.has_verified_factor()
  end
$$;

revoke all on function public.assurance_satisfied() from public, anon;
grant execute on function public.assurance_satisfied() to authenticated;

create or replace function public.redeem_recovery_code(code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp, extensions
as $$
declare
  me uuid := auth.uid();
  hit text;
  recent integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  -- One redemption per account at a time. The throttle below is a count and
  -- then an insert, and two requests racing between them used to get two
  -- guesses for the price of one.
  perform pg_advisory_xact_lock(hashtextextended('recovery:' || me::text, 0));

  -- The throttle only ever looks back fifteen minutes; anything older is
  -- dead weight that nothing else deleted.
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

  -- Everybody else signed in as this account goes too: see (1). Refresh
  -- tokens cascade with their session.
  delete from auth.sessions
   where user_id = me
     and id is distinct from nullif(auth.jwt() ->> 'session_id', '')::uuid;

  return true;
end;
$$;

revoke all on function public.redeem_recovery_code(text) from public, anon;
grant execute on function public.redeem_recovery_code(text) to authenticated;

create or replace function public.claim_username(new_username text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  row public.profiles;
begin
  perform public.assert_assured();
  -- See (3): the profile is the gate, so this is where the address is checked.
  if not exists (select 1 from auth.users u
                  where u.id = me
                    and u.email_confirmed_at is not null
                    and not coalesce(u.is_anonymous, false)) then
    raise exception 'confirm your email address first' using errcode = '42501';
  end if;
  if char_length(new_username) < 3 or char_length(new_username) > 20
     or new_username !~ '^[A-Za-z0-9](_?[A-Za-z0-9]){2,19}$' then
    raise exception 'username must be 3-20 letters, digits or underscores'
      using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(me::text, 0));
  insert into public.profiles as p (id, username)
  values (me, new_username)
  on conflict (id) do update
    set username = excluded.username, updated_at = now()
  returning * into row;
  return row;
exception
  when unique_violation then
    raise exception 'that username is taken' using errcode = '23505';
end;
$$;

revoke all on function public.claim_username(text) from public, anon;
grant execute on function public.claim_username(text) to authenticated;

-- (4). The cut-off is when 0014 was applied, read from the runner's ledger.
-- Without a ledger row -- the file applied by hand, or a renamed entry -- it
-- falls back to the moment 0014 reached production (2026-09-04 16:21:15 UTC),
-- rather than comparing against NULL and quietly deleting nothing.
do $$
declare
  cutoff timestamptz := '2026-09-04 16:21:15.400267+00';
begin
  if to_regclass('public.schema_migrations') is not null then
    select coalesce(max(m.applied_at), cutoff) into cutoff
      from public.schema_migrations m
     where m.name = '0014_recovery_codes_aal2.sql';
  end if;
  delete from public.mfa_recovery_codes c
   where c.used_at is null and c.created_at < cutoff;
end $$;
