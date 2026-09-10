-- Revoking from `anon` was half of it. Five functions did not move.
--
-- `20260912000000` revoked EXECUTE from `anon` on twelve functions and seven of
-- them went. These five did not:
--
--     pair_hi           {=X/postgres,postgres=X/...,authenticated=X/...}
--     pair_lo           {=X/postgres,...}
--     plausible_time    {=X/postgres,...}
--     time_label        {=X/postgres,...}
--     rls_auto_enable   {=X/postgres,...}
--
--     caller_allowed    {postgres=X/...,authenticated=X/...}      <- moved
--
-- The difference is the first entry. `=X/postgres` is a grant to PUBLIC -- the
-- grantee before the `=` is empty -- and `anon` is a member of PUBLIC, so
-- `has_function_privilege('anon', ...)` stays true no matter how many times the
-- named grant is revoked. `caller_allowed` moved because ITS original migration
-- had already said `revoke all ... from public`.
--
-- So the rule this repo needs is both halves, and it is not obvious from either
-- one failing:
--
--   * old functions carry PUBLIC's default EXECUTE  -> revoke from public
--   * new ones carry a NAMED grant to anon, from     -> revoke from anon
--     Supabase's default privileges
--
-- Revoking only from `public` leaves the new ones open, which is how
-- `has_password` shipped reachable. Revoking only from `anon` leaves the old
-- ones open, which is what happened here. The three-line block in
-- `20260909010000_has_password_anon` does both and remains the shape to copy.
--
-- None of these five leak anything -- `pair_lo`/`pair_hi` sort two uuids you
-- already have, `plausible_time` and `time_label` are pure arithmetic on a
-- number, and `rls_auto_enable` is an event trigger function that cannot be
-- meaningfully called at all. This is about the surface matching what the
-- project claims, so that the next function to arrive wrong is visible.

revoke execute on function public.pair_hi(uuid, uuid)     from public;
revoke execute on function public.pair_lo(uuid, uuid)     from public;
revoke execute on function public.plausible_time(integer) from public;
revoke execute on function public.time_label(integer)     from public;
revoke execute on function public.rls_auto_enable()       from public;

-- `authenticated` keeps every one of them: the policies and functions that call
-- these run as the signed-in caller, and taking them away there would break
-- `is_member`, the progress writes and the realtime checks in one go.
grant execute on function public.pair_hi(uuid, uuid)     to authenticated;
grant execute on function public.pair_lo(uuid, uuid)     to authenticated;
grant execute on function public.plausible_time(integer) to authenticated;
grant execute on function public.time_label(integer)     to authenticated;
