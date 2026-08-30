-- A username is at most 20 characters, and now actually is.
--
-- 0001 said "3-20 characters" in a comment and enforced it with
--
--   ^[A-Za-z0-9](_?[A-Za-z0-9]){2,19}$
--
-- which is a rule about the SHAPE -- alphanumerics, single underscores between
-- them, never at either end -- and only incidentally about the length. Each of
-- the 19 repetitions can match two characters, so the pattern happily accepts
-- `twenty_one_chars_long` and, at the limit, a 39-character name. The sign-up
-- form's `maxlength` said 20 and the database did not, which is the wrong way
-- round: the form is a convenience and the constraint is the rule.
--
-- Found by a test that tried a list of awkward names and expected all of them
-- to be refused.

alter table public.profiles drop constraint if exists username_length;
alter table public.profiles
  add constraint username_length check (char_length(username) between 3 and 20);

/**
 * Claim a username, redeeming an invite code in the same statement.
 *
 * Unchanged from 0004 except for the length check, which is repeated here so
 * the caller gets the message they need rather than a constraint violation.
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
  if char_length(new_username) < 3 or char_length(new_username) > 20
     or new_username !~ '^[A-Za-z0-9](_?[A-Za-z0-9]){2,19}$' then
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

revoke all on function public.claim_username(text, text) from public;
grant execute on function public.claim_username(text, text) to authenticated;
