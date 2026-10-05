-- A username changes through `claim_username` and nowhere else.
-- From the first security audit (2026-10-04).
--
-- `profiles_write_own` lets an account UPDATE any column of its own row, so
-- `PATCH /rest/v1/profiles?id=eq.<me> {"username": "..."}` renamed it too --
-- straight past `claim_username`'s shape check and its advisory lock, and
-- answering 409 for a name somebody else holds. That made it a second,
-- unmetered username-existence oracle beside the one
-- `20260913010000_charge_failed_requests` went to the trouble of charging for.
--
-- The client writes exactly one column through the table, and the settings
-- screen is the place it does it: `hide_from_leaderboard`. So the table grant
-- becomes those columns the account may reasonably own, and `username`,
-- `id`, and the timestamps are not among them. The policy is unchanged: it
-- still decides WHICH row; this decides which columns.
--
-- `claim_username` itself is the other half of the oracle. Metering it means
-- returning NULL for a taken name rather than raising, which the release
-- before this one does not understand, so that half waits in
-- `supabase/deferred/` -- see its README.
--
-- Compatible with the release before: it never sent anything but
-- `hide_from_leaderboard`.

revoke update on public.profiles from anon, authenticated;
grant update (display_name, avatar_url, hide_from_leaderboard)
  on public.profiles to authenticated;
