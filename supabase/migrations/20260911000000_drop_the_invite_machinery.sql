-- The contracting half of `20260910000000_open_the_gate`.
--
-- NOT IN `migrations/`, and that is the point. `supabase/deferred/README.md`
-- has the procedure: the runner does not read this directory, and a file here
-- is applied by being MOVED into `migrations/` once the release it waits for is
-- actually live. Put it there too early and a client that still sends an invite
-- code meets a function that no longer takes one.
--
-- ## Move it when all of this is true
--
--   * a release without the gate has been live long enough that no browser is
--     still running the previous bundle -- an afternoon is plenty for a game
--     nobody keeps open for days;
--   * nothing has needed `invite_redemptions` in the meantime;
--   * you have decided you do not want the record of how the first eighteen
--     accounts arrived. THIS IS THE PART THAT IS NOT REVERSIBLE. The rest of
--     this file is schema; that table is history, and once it is dropped the
--     answer to "who did that code go to" is gone for good. Take a dump first
--     if there is any doubt.
--
-- Until then the tables sit there costing nothing, which is the correct price
-- for something you might want and cannot get back.

begin;

-- The argument goes last, because the function has to exist for the grants
-- above it to have anywhere to land.
drop function if exists public.claim_username(text, text);

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

revoke all on function public.claim_username(text) from public;
revoke all on function public.claim_username(text) from anon;
grant execute on function public.claim_username(text) to authenticated;

-- `was_invited` has no caller once the username screen stops asking.
drop function if exists public.was_invited();

-- Redemptions first: it references the codes.
drop table if exists public.invite_redemptions;
drop table if exists public.invite_codes;

commit;
