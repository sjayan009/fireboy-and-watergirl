-- Take `has_password` away from anon, which `20260909000000` did not manage.
--
-- That migration ended with the same two lines every definer function in this
-- directory ends with:
--
--   revoke all on function ... from public;
--   grant  execute on function ... to authenticated;
--
-- and for `delete_me`, `recovery_codes_left` and the rest that was enough. For
-- this one it was not, and the difference is age rather than anything in the
-- SQL. Supabase's default privileges on the `public` schema now grant EXECUTE
-- to `anon` and `authenticated` EXPLICITLY, and revoking from PUBLIC does not
-- touch a grant made to a named role. So a function created today arrives with
-- `anon=X` in its ACL and keeps it; the ones written before that default was in
-- place only ever had PUBLIC's, which the revoke did remove.
--
-- The proof is in the catalogue rather than in reasoning:
--
--   has_password        -> {...,anon=X/postgres,authenticated=X/postgres,...}
--   recovery_codes_left -> {...,authenticated=X/postgres,...}
--
-- Identical migrations, different ACLs.
--
-- ## This is posture, not a hole
--
-- Worth being accurate about. `has_password` reads `auth.users` for `auth.uid()`
-- and a signed-out caller has no uid, so anon got a row-less query and `null`
-- back -- no leak, and no way to ask about somebody else. What was wrong is
-- that a security definer function touching the `auth` schema was reachable by
-- anyone holding the publishable key, which is everyone. That is the thing this
-- repo does not do, and it should not stop being true because a platform
-- default changed underneath it.
--
-- **Any definer function added after this one needs the anon revoke too.**
-- Copy these three lines, not the two from an older file.

revoke all on function public.has_password() from public;
revoke all on function public.has_password() from anon;
grant execute on function public.has_password() to authenticated;
