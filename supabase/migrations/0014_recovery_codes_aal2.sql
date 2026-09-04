-- Recovery codes, minted only by somebody who has already proved the factor.
--
-- 0012 checked that `auth.uid()` was not null and nothing else, which made the
-- whole feature a way around itself: a session holding only the password could
-- call `generate_recovery_codes`, get ten codes, hand one straight back to
-- `redeem_recovery_code`, and unenrol the factor it had never answered. The
-- second factor protected against nothing it was installed to protect against,
-- and the victim's own written-down codes were silently invalidated on the way
-- past -- so the theft was also destructive.
--
-- Issuing is the strongly-authenticated half of the ceremony and now says so:
-- `aal2` plus a verified factor. Redemption stays at `aal1`, which is the whole
-- point of it. The asymmetry is the design: you must be able to prove the
-- factor to MINT the way around it, and must not need to prove it to USE one.
--
-- ## And they are generated properly now
--
-- Every character came from `random()`, which PostgreSQL documents as a
-- deterministic PRNG that is "not suitable for cryptographic applications".
-- Hashing the output with bcrypt protects the stored form and can do nothing
-- about weak generation. `gen_random_bytes` is in the same pgcrypto extension
-- 0012 was already using for `crypt` and `gen_salt`; it was simply not reached
-- for.
--
-- The alphabet is 32 symbols, which is a power of two, so masking a byte with
-- 31 selects from it without modulo bias. Fifty bits per code, from the
-- operating system's entropy rather than from a seeded sequence.

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
  -- The session, not the account: a token that has not answered a challenge
  -- must not be able to mint the thing that replaces answering one.
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'answer your authenticator before making recovery codes'
      using errcode = '42501';
  end if;
  -- And the account, not just the session: codes exist to get past a factor,
  -- so an account without one has nothing to get past and no business holding
  -- ten passwords that turn off a feature it is not using.
  if not public.has_verified_factor() then
    raise exception 'turn two-factor on first' using errcode = '42501';
  end if;

  delete from public.mfa_recovery_codes
   where user_id = me and used_at is null;

  for i in 1..10 loop
    code := '';
    -- Ten characters from a 32-symbol alphabet is fifty bits, which is the
    -- reason this table needs no attempt counter: guessing one is not a thing
    -- that happens -- now that the fifty bits are real.
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

revoke all on function public.generate_recovery_codes() from public;
grant execute on function public.generate_recovery_codes() to authenticated;

/**
 * Spend a code, and take the second factor off.
 *
 * Unchanged from 0012, and deliberately so -- this is the one function that
 * must stay callable at `aal1`, because the person using it is the person who
 * cannot reach `aal2`. What changed is who could have created the code it is
 * being handed.
 *
 * The throttle is new and is the layered half of the answer: a code is fifty
 * bits, but an endpoint that will answer a guess as fast as it is asked is
 * still worth rate limiting. Five wrong answers in fifteen minutes and the
 * account stops being asked the question.
 */
create table if not exists public.mfa_recovery_attempts (
  user_id  uuid not null references auth.users (id) on delete cascade,
  tried_at timestamptz not null default now(),
  ok       boolean not null
);

create index if not exists mfa_recovery_attempts_recent
  on public.mfa_recovery_attempts (user_id, tried_at desc);

alter table public.mfa_recovery_attempts enable row level security;
-- No policies, for the same reason `mfa_recovery_codes` has none: there is no
-- query a signed-in account should be able to run against it.

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

  -- The factors go, and the remaining codes with them: they were the way past
  -- a second factor that no longer exists, and leaving them lying about would
  -- be leaving nine spare passwords on an account protected by one.
  delete from auth.mfa_factors where user_id = me;
  delete from public.mfa_recovery_codes where user_id = me and used_at is null;
  delete from public.mfa_recovery_attempts where user_id = me;

  return true;
end;
$$;

revoke all on function public.redeem_recovery_code(text) from public;
grant execute on function public.redeem_recovery_code(text) to authenticated;
