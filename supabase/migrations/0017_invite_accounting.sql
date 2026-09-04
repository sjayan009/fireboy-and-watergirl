-- One account, one use of one code.
--
-- 0004's comment made a claim about `claim_username` that was true of one
-- statement inside it and not of the function around it:
--
--     One statement decides it. `uses < max_uses` inside the UPDATE means two
--     people racing for the last use of a code cannot both pass.
--
-- That is correct, and it is about two DIFFERENT people. The race that actually
-- happened is one person's client sending the same call several times -- a
-- double-click, a retry, a flaky connection -- where every request passes the
-- `select exists (... from profiles)` check before any of them has inserted the
-- profile, and each then increments the counter. Eight parallel calls consumed
-- three uses of a code and created one profile; a second run consumed two. The
-- redemption row is keyed `(code, user_id)` and deduplicated itself, so the
-- ledger said one redemption and the counter said three.
--
-- Three changes, each closing a different half of it:
--
--   * an advisory lock on the CALLER, so their own concurrent attempts queue
--     rather than interleave, and the second one sees the profile the first
--     one made;
--   * the counter is incremented only when a redemption row was actually
--     inserted, so an idempotent retry costs nothing even if it gets that far;
--   * the code row is locked before it is read, so two people racing for the
--     last use serialize on it rather than both reading `uses < max_uses`.
--
-- And the business rule finally exists as a constraint: one redemption per
-- account. Nothing in the schema said an account could not spend two codes.

-- Any account that managed to redeem twice keeps its first redemption. There
-- should be none; the index is what makes that permanent rather than lucky.
delete from public.invite_redemptions r
 where exists (
   select 1 from public.invite_redemptions e
    where e.user_id = r.user_id
      and (e.created_at, e.code) < (r.created_at, r.code)
 );

create unique index if not exists invite_redemptions_one_per_user
  on public.invite_redemptions (user_id);

/**
 * Claim a username, redeeming an invite code in the same statement.
 *
 * Unchanged from 0007 in what it decides. What changed is that the deciding is
 * now serialized against the caller's own concurrent attempts, and that the
 * session has to satisfy the account's second factor before any of it runs --
 * renaming is a change to the public identity of an account and belongs behind
 * the same gate as everything else. `assert_assured` rather than
 * `assert_allowed`, because this is the function that GIVES you a profile.
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
    if invite_code is null then
      raise exception 'an invite code is required' using errcode = '42501';
    end if;

    -- Locked before it is read: two people racing for the last use of a code
    -- serialize here, and the second one reads the counter the first one wrote.
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
