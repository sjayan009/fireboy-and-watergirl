-- An index shaped like the query, rather than like the table.
--
-- `pair_progress` is keyed `(user_a, user_b, node)`, which is exactly right for
-- what the game does with it: load one pair's whole map, write one pair's node.
-- The leaderboard asks the opposite question -- one node, every pair, in time
-- order -- and there was nothing for it to walk. `leaderboard` filtered by
-- `node` and sorted by `(best_time_s, updated_at)`; `leaderboard_standing`
-- ranked every eligible row in the table before picking one pair out of it.
-- Both had to scan and sort, and both get slower with the total number of rows
-- rather than with the size of the board they are drawing.
--
-- Partial, because the board's WHERE clause is a permanent property of the
-- board and not a parameter: only finished levels with a recorded time are ever
-- ranked, which today is a fraction of the rows and always will be -- every
-- node a pair merely unlocked is stored too.
--
-- The columns are in the order the query wants them: equality first, then the
-- sort, so a lookup for one node walks straight down the ranking without a sort
-- step. `user_a` and `user_b` ride along so the standing query can find its own
-- pair without going back to the heap.

create index if not exists pair_progress_board
  on public.pair_progress (node, best_time_s, updated_at)
  include (user_a, user_b)
  where medal > 0 and best_time_s is not null;

-- The profiles join in both functions is on the primary key, so it needs
-- nothing -- but the board also filters on the opt-out, and a project where
-- most people are listed wants to find the few who are not without reading
-- every row of the join's other side.
create index if not exists profiles_listed
  on public.profiles (id) where not hide_from_leaderboard;
