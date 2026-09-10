-- `is_member`, the last one, for the same reason as the other five.
--
-- `20260912010000` took PUBLIC's default EXECUTE off five functions and missed
-- this one, which carries the identical ACL:
--
--     is_member(a uuid, b uuid)
--       {=X/postgres,postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- The leading `=X/postgres` -- grantee empty, meaning PUBLIC -- is what keeps
-- `has_function_privilege('anon', ...)` true after the named revoke in
-- `20260912000000`. Both halves are needed; see that migration's header.
--
-- Nothing changes for a signed-in player. `friendships_read` and
-- `progress_read` both call this and both are `to authenticated`, which keeps
-- its own grant below.
--
-- After this, `has_function_privilege('anon', ...)` is false for every function
-- in `public`, and `app/test/accounts.mjs` asserts exactly that -- as a set, not
-- as a list of names, so a function added tomorrow with the wrong grant fails
-- the test rather than waiting to be noticed.

revoke execute on function public.is_member(uuid, uuid) from public;
grant  execute on function public.is_member(uuid, uuid) to authenticated;
