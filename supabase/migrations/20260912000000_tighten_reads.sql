-- Two things a signed-in stranger could do, and can no longer.
--
-- Both were fine when signing up meant holding an invite code. Neither is fine
-- now: `20260910000000_open_the_gate` made an account something anybody can
-- have in one form, so "any authenticated caller" and "anybody at all" became
-- the same set of people.
--
-- ## 1. Every profile was readable by every account
--
-- `profiles_read` was `using (caller_allowed())` -- have a profile, read them
-- all. Measured against the live database with a brand-new account:
--
--     profiles it can read: 6
--     -> door, uia77053, Jayan, anakinprogramming, uia63152, audnosy49711
--
-- Every username, every display name, every avatar, every `hide_from_leaderboard`
-- flag, and -- the part that matters most -- every user id. A spectator topic
-- derived from two ids stops being something an attacker has to work out and
-- becomes something they can list.
--
-- Nothing needed it. The client reads `profiles` in three places: its own row
-- (`id = auth.uid()`), the names of people it already has a friendship row with
-- (`.in("id", ids)`, and only as a fallback for a client older than
-- `list_friends()`), and `findByUsername`, which has no callers and is deleted
-- in this change. Adding a friend goes through `request_friend(their_username)`,
-- a definer function that resolves the name server-side and never needed the
-- policy at all.
--
-- So: your own row, plus anyone you share a `friendships` row with, in any
-- status. Pending covers the person who just asked, blocked covers the person
-- you need to keep naming in order to unblock them.
--
-- ## 2. `anon` could execute eleven functions
--
-- None were exploitable -- they read `auth.uid()`, which is null, and answer
-- false or nothing. It is still not what this repo says it does, and the reason
-- it happened is worth fixing rather than tidying: Supabase's default
-- privileges grant EXECUTE to `anon` BY NAME on new functions, and
-- `revoke ... from public` does not take a named grant away. Every function
-- written since that default changed has arrived reachable by anybody holding
-- the publishable key. `has_password` did, and needed
-- `20260909010000_has_password_anon` to undo it.
--
-- `app/test/accounts.mjs` now asserts the whole set, so the next one that
-- arrives wrong fails a test rather than sitting there.

-- ---- 1. profiles ----------------------------------------------------------

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated
  using (
    -- Unchanged: a caller with no profile, or one owing a second factor, still
    -- reads nothing at all. This is the gate `0013` put in front of everything.
    (select public.caller_allowed())
    and (
      id = (select auth.uid())
      or exists (
        select 1 from public.friendships f
         where (f.user_a = (select auth.uid()) and f.user_b = public.profiles.id)
            or (f.user_b = (select auth.uid()) and f.user_a = public.profiles.id)
      )
    )
  );

-- ---- 2. anon -------------------------------------------------------------

revoke execute on function public.assert_allowed()              from anon;
revoke execute on function public.assert_assured()              from anon;
revoke execute on function public.caller_allowed()              from anon;
revoke execute on function public.can_feed_watch_topic(text)    from anon;
revoke execute on function public.can_use_pair_topic(text)      from anon;
revoke execute on function public.can_watch_pair_topic(text)    from anon;
revoke execute on function public.is_member(uuid, uuid)         from anon;
revoke execute on function public.pair_hi(uuid, uuid)           from anon;
revoke execute on function public.pair_lo(uuid, uuid)           from anon;
revoke execute on function public.plausible_time(integer)       from anon;
revoke execute on function public.rls_auto_enable()             from anon;
revoke execute on function public.time_label(integer)           from anon;

-- The realtime policies call three of these, and they are `to authenticated`,
-- so nothing evaluates them as `anon` and nothing above changes what a signed-in
-- player can do. That is asserted rather than assumed: `realtimetest.mjs` opens
-- real channels and would fail if a policy could no longer be evaluated.
