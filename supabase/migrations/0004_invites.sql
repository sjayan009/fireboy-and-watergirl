-- Invite codes, and the gate they hold shut.
--
-- The deployment ships art extracted from a 2009 commercial game, so it is not
-- open to the public. The gate is deliberately NOT at sign-up: sign-up is
-- Supabase Auth's, it happens in the browser, and anything the browser is asked
-- to check first is not a check at all.
--
-- It is here instead, on the one statement that makes an account into a person:
-- claiming a username. An account with no profile cannot be found by anybody,
-- cannot be befriended, and therefore cannot reach a single row of anyone
-- else's data -- so an unredeemed sign-up is inert, and the enforcement sits in
-- one security definer function rather than being spread across the client.

create table if not exists public.invite_codes (
  code       text primary key,
  note       text,
  max_uses   integer not null default 1 check (max_uses > 0),
  uses       integer not null default 0 check (uses >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),

  constraint code_shape check (code ~ '^[A-Za-z0-9-]{6,64}$')
);

alter table public.invite_codes enable row level security;

-- No policies whatsoever, for any role. Codes are minted with the secret key
-- from the command line and redeemed only inside claim_username, which runs as
-- definer. A signed-in user cannot read the table, so codes cannot be
-- enumerated, and cannot write it, so uses cannot be reset.

/** Who used which code. Useful when a code leaks and has to be traced. */
create table if not exists public.invite_redemptions (
  code       text not null references public.invite_codes (code) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (code, user_id)
);

alter table public.invite_redemptions enable row level security;
-- Same reasoning: nobody reads or writes this except the definer function.

/**
 * Claim a username, redeeming an invite code in the same statement.
 *
 * Replaces the one-argument version from 0001. The two halves have to be one
 * transaction: a code checked and then used in a second statement is a code two
 * people can pass at once, and a profile created before the code is checked is
 * a gate with a hole in it.
 *
 * A user who already has a profile may rename without a code -- they are
 * already through the gate, and asking again would mean a second code per
 * rename.
 */
create or replace function public.claim_username(
  new_username text, invite_code text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  row public.profiles;
  existing boolean;
  ok boolean;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if new_username !~ '^[A-Za-z0-9](_?[A-Za-z0-9]){2,19}$' then
    raise exception 'username must be 3-20 letters, digits or underscores'
      using errcode = '22023';
  end if;

  select exists (select 1 from public.profiles p where p.id = me) into existing;

  if not existing then
    if invite_code is null then
      raise exception 'an invite code is required' using errcode = '42501';
    end if;

    -- One statement decides it. `uses < max_uses` inside the UPDATE means two
    -- people racing for the last use of a code cannot both pass: the second
    -- update matches no row.
    update public.invite_codes c
       set uses = c.uses + 1
     where c.code = invite_code
       and c.uses < c.max_uses
       and (c.expires_at is null or c.expires_at > now())
    returning true into ok;

    if ok is not true then
      raise exception 'that invite code is not valid' using errcode = '42501';
    end if;

    insert into public.invite_redemptions (code, user_id) values (invite_code, me)
      on conflict do nothing;
  end if;

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

-- The one-argument version has to go, or it is a way around the gate.
drop function if exists public.claim_username(text);

revoke all on function public.claim_username(text, text) from public;
grant execute on function public.claim_username(text, text) to authenticated;
