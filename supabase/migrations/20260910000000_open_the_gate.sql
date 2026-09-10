-- The gate comes down. Anybody who confirms an address can play.
--
-- `0004_invites.sql` put a code on `claim_username` because the deployment
-- ships art extracted from a 2009 commercial game and was not meant to be
-- public. That is a decision about what this deployment is for, and it has been
-- made the other way: it is to be publicly playable. So the check goes.
--
-- What replaces it is the thing that was always underneath it -- a confirmed
-- email address. `assert_assured` still runs, the username rules are unchanged,
-- the advisory lock against a caller's own retries is unchanged, and the second
-- factor is still owed by any account that enrolled one. The only thing that
-- stopped being required is the code.
--
-- ## Widening, and therefore safe to ship on its own
--
-- Every call that worked yesterday works today. The deployed client sends a
-- code as its second argument and this still accepts one -- it is simply no
-- longer consulted. Nothing needs a deferred half, because nothing is being
-- taken away from a caller.
--
-- ## What is NOT dropped here, and why
--
-- `invite_codes`, `invite_redemptions` and `was_invited()` all survive this
-- migration untouched. Two reasons, and neither is sentiment:
--
--   * `invite_redemptions` is the record of how eighteen accounts actually got
--     in. Dropping it to tidy up would delete history to make a schema look
--     neater, and the schema is not the thing anybody will want later.
--   * Dropping a table IS the contracting half of a change, which this repo
--     splits across two releases on purpose. The half that removes them belongs
--     in `supabase/deferred/`, applied once a release without the gate has been
--     live and nothing has gone looking for them.
--
-- `invite.mjs` also still works. With no gate it mints codes nobody is asked
-- for, but `--email` remains a genuinely useful way to put somebody straight
-- into the game without them typing anything, so it stays.

/**
 * Claim a username.
 *
 * Unchanged from `20260909020000` except that the branch which demanded an
 * invite code, or an invitation in its place, is gone. `invite_code` is kept in
 * the signature and ignored: removing an argument would break the release
 * before this one on the day it deployed, and the repo's own rule is to widen
 * before narrowing. It can go in the same deferred pass that drops the tables.
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
begin
  perform public.assert_assured();
  if char_length(new_username) < 3 or char_length(new_username) > 20
     or new_username !~ '^[A-Za-z0-9](_?[A-Za-z0-9]){2,19}$' then
    raise exception 'username must be 3-20 letters, digits or underscores'
      using errcode = '22023';
  end if;

  -- Still held, and still for the reason 0017 gives: a caller's own concurrent
  -- attempts have to queue so the second finds the profile the first made
  -- rather than racing it. That was never about the code.
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

revoke all on function public.claim_username(text, text) from public;
revoke all on function public.claim_username(text, text) from anon;
grant execute on function public.claim_username(text, text) to authenticated;
