-- A way back in when the authenticator is gone.
--
-- Until now the answer was `npm run unenrol`, which needs somebody holding the
-- secret key to be awake. That is a fine answer for a handful of friends and a
-- bad one at three in the morning, so: ten single-use codes, minted here,
-- hashed here, shown to the person exactly once.
--
-- One thing this cannot do, and the screens have to say so. Redeeming a code
-- turns two-factor OFF rather than letting one session past it: Supabase models
-- the second factor as an assurance level, and a session can only reach `aal2`
-- by answering a factor challenge. "Let me in this once" is not something the
-- platform can express, so recovery means unenrolling and setting it up again.

create table if not exists public.mfa_recovery_codes (
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- bcrypt, via pgcrypto. Never the code itself: a recovery code is a password
  -- that happens to be used once, and this table is a list of passwords.
  code_hash  text not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz,
  primary key (user_id, code_hash)
);

create index if not exists mfa_recovery_unused
  on public.mfa_recovery_codes (user_id) where used_at is null;

-- RLS on, and deliberately NO policies -- the same shape as `invite_codes`, for
-- the same reason. There is no query a signed-in account should be able to run
-- against this table: not reading its own hashes, which are of no use to it,
-- and certainly not counting or clearing anybody else's. The two functions
-- below are the entire surface.
alter table public.mfa_recovery_codes enable row level security;

/**
 * Mint ten codes, and hand them back once.
 *
 * Generated here rather than in the browser: a client-chosen recovery code is
 * a client-chosen password, and this one bypasses the second factor. The
 * alphabet is the invite codes' -- no O/0, no I/1/l -- because these get read
 * off a screen and typed somewhere else, possibly by somebody upset.
 *
 * Any unused codes from a previous set are dropped. Two live sets would mean a
 * code somebody wrote down a year ago still works, which is the opposite of
 * what regenerating is for.
 */
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
  code text;
  i integer;
  j integer;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  delete from public.mfa_recovery_codes
   where user_id = me and used_at is null;

  for i in 1..10 loop
    code := '';
    -- Ten characters from a 32-symbol alphabet is fifty bits, which is the
    -- reason this table needs no attempt counter: guessing one is not a thing
    -- that happens.
    for j in 1..10 loop
      code := code || substr(alphabet,
                             1 + floor(random() * length(alphabet))::int, 1);
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

/** How many are left, for a screen that wants to say so. */
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

/**
 * Spend a code, and take the second factor off.
 *
 * Callable at `aal1`, which is the whole point of it: the password was the
 * first factor and this is the second. A session that has already answered a
 * challenge has no need for it.
 *
 * The code is matched by re-hashing the candidate with the stored salt, so a
 * wrong one costs the same work as a right one and the comparison never sees
 * a plaintext it did not just compute.
 */
create or replace function public.redeem_recovery_code(code text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp, extensions
as $$
declare
  me uuid := auth.uid();
  hit text;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  select c.code_hash into hit
    from public.mfa_recovery_codes c
   where c.user_id = me
     and c.used_at is null
     and c.code_hash = extensions.crypt(code, c.code_hash)
   limit 1;

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

  return true;
end;
$$;

revoke all on function public.redeem_recovery_code(text) from public;
grant execute on function public.redeem_recovery_code(text) to authenticated;
