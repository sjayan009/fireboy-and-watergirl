-- `auth.uid()` once per statement, not once per row.
--
-- `solo_read` was written the obvious way -- `using (user_id = auth.uid())` --
-- and it is the only policy in this schema that still is. `profiles`,
-- `pair_progress` and `friendships` all wrap the call in a scalar subquery, and
-- this one was missed because it is a one-liner and looked like it had nothing
-- in it to get wrong.
--
-- The difference is where the planner is allowed to evaluate the call.
-- `auth.uid()` is STABLE, which permits one evaluation per statement but does
-- not compel it: written bare in a policy it becomes part of the per-row filter
-- expression and is called again for every row the scan touches. Wrapped as
-- `(select auth.uid())` it is an InitPlan -- evaluated once, then a constant,
-- which the planner can push into an index scan on the `(user_id, node)`
-- primary key instead of filtering rows it has already read.
--
-- Today the table holds four rows and none of this is measurable. It is worth
-- doing now because the table grows as accounts times thirty-two and nothing
-- about the policy improves on its own: at five hundred accounts that is
-- sixteen thousand rows and sixteen thousand calls to settle one person's
-- SELECT. The Supabase performance advisor reports it as `auth_rls_initplan`.
--
-- Semantics are unchanged. Same rows, same people, same verb -- this is the
-- same predicate with the evaluation moved, and the drop and create are one
-- transaction, so no read sees a moment without a policy.

drop policy if exists solo_read on public.solo_progress;
create policy solo_read on public.solo_progress
  for select to authenticated using (user_id = (select auth.uid()));

-- The same instruction, where the advisor does not look.
--
-- `friendships_read` calls two functions bare. `caller_allowed()` takes no
-- arguments and is STABLE, so it is the identical fix: one call for the
-- statement rather than one per row.
--
-- `is_member(user_a, user_b)` is NOT the identical fix and is deliberately left
-- alone. It takes the row's own columns, so its answer differs from row to row
-- and there is nothing to hoist -- wrapping it in a subquery would not make it
-- cheaper, it would make it wrong.
--
-- The advisor flags neither, because it matches on `auth.<function>()` by name
-- and this is a function of ours that happens to call one. The cost is real but
-- small: nobody has many friendship rows, which is why this rides along with
-- the migration above rather than being one of its own.

drop policy if exists friendships_read on public.friendships;
create policy friendships_read on public.friendships
  for select to authenticated
  using (public.is_member(user_a, user_b) and (select public.caller_allowed()));
