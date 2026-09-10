-- An invitation sent to an address, instead of a code read down a phone.
--
-- The gate has always been a string somebody types: minted with `npm run
-- invite`, handed over out of band, typed into the last screen before a profile
-- exists. That works for one friend and gets worse from there, and "Continue
-- with Google" made it worse still -- one click to sign in, then fourteen
-- characters copied by hand.
--
-- So the address becomes the invitation. You invite somebody, Supabase mails
-- them a link, they follow it and pick a name. There is no code in that story.
--
-- ## Why `invited_at` can be trusted as a credential
--
-- `auth.users.invited_at` is set by the admin API and by nothing else. No
-- session can write it: `updateUser` reaches email, password and user metadata,
-- and none of those are this column. So "was invited" is a fact about an
-- account that only the holder of the secret key can have caused, which is
-- exactly the property an invite code has and the reason one is asked for.
--
-- ## Widening, so it survives the release before it
--
-- Every path that worked before works unchanged: the deployed client always
-- sends a code, no account it can reach has `invited_at` set, and the code
-- machinery below is untouched. This only ADDS a way through, which is the
-- easy half of the rule in `supabase/README.md` and needs no deferred half.

create or replace function public.was_invited()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select u.invited_at is not null
    from auth.users u
   where u.id = auth.uid();
$$;

-- The three-line grant, not the two-line one. `20260909010000_has_password_anon`
-- has the full story: Supabase's default privileges now grant EXECUTE to `anon`
-- by name, and revoking from PUBLIC does not take a named grant away.
revoke all on function public.was_invited() from public;
revoke all on function public.was_invited() from anon;
grant execute on function public.was_invited() to authenticated;

/**
 * Claim a username, redeeming an invite code -- unless an invitation already
 * said yes.
 *
 * Unchanged from 0017 in everything it decides about codes: the assurance
 * check, the advisory lock against the caller's own retries, the row lock on
 * the code, the redemption-first accounting. What is new is one branch above
 * all of that, and one thing deliberately NOT done inside it.
 *
 * **An invited account writes no `invite_redemptions` row.** That table is the
 * ledger for CODES -- its `code` column is `not null` and references
 * `invite_codes`, and there is no code here to point at. Inventing a sentinel
 * row to make the ledger look uniform would put a fiction in the one table that
 * exists to be audited when a code leaks. The invitation's record is
 * `auth.users.invited_at`, which is where it happened. So an account with a
 * profile and no redemption is not a hole in the accounting; it is somebody who
 * was invited, and this comment is here so that is not read as a bug later.
 *
 * An invitation also OUTRANKS a code rather than being checked after one: an
 * invited caller who also types something into the field, correct or not, is
 * let through on the invitation and spends nothing. They were already welcome;
 * charging them a use of somebody else's code for saying so would be strange.
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
  invited boolean;
  invite public.invite_codes;
  redeemed integer;
begin
  perform public.assert_assured();
  if char_length(new_username) < 3 or char_length(new_username) > 20
     or new_username !~ '^[A-Za-z0-9](_?[A-Za-z0-9]){2,19}$' then
    raise exception 'username must be 3-20 letters, digits or underscores'
      using errcode = '22023';
  end if;

  -- Held until this transaction ends, so a second call from the same account
  -- waits here and then finds the profile the first one created rather than
  -- passing the same check and spending a second use.
  perform pg_advisory_xact_lock(hashtextextended(me::text, 0));

  select exists (select 1 from public.profiles p where p.id = me) into existing;

  if not existing then
    -- Read here rather than through `was_invited()`. This function is already
    -- definer and already inside the transaction holding the lock; going out
    -- through PostgREST to ask itself the same question would buy nothing.
    select (u.invited_at is not null) into invited
      from auth.users u where u.id = me;

    if not coalesce(invited, false) then
      if invite_code is null then
        raise exception 'an invite code is required' using errcode = '42501';
      end if;

      -- Locked before it is read: two people racing for the last use of a code
      -- serialize here, and the second one reads the counter the first wrote.
      select * into invite from public.invite_codes c
        where c.code = invite_code for update;

      if invite.code is null
         or invite.uses >= invite.max_uses
         or (invite.expires_at is not null and invite.expires_at <= now()) then
        raise exception 'that invite code is not valid' using errcode = '42501';
      end if;

      -- The redemption is what a use IS, so it is established first and the
      -- counter follows from it. A retry that gets this far conflicts, inserts
      -- nothing, and therefore costs nothing.
      insert into public.invite_redemptions (code, user_id)
      values (invite_code, me)
      on conflict do nothing;
      get diagnostics redeemed = row_count;

      if redeemed = 1 then
        update public.invite_codes c set uses = c.uses + 1
         where c.code = invite_code;
      end if;
    end if;
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
revoke all on function public.claim_username(text, text) from anon;
grant execute on function public.claim_username(text, text) to authenticated;
