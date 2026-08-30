-- Progress for the whole map, written in one statement.
--
-- 0003 gave the pair a row per node and `record_progress` to write one of them,
-- plus `unlock_neighbours` to open the nodes a finished level leads to. That
-- second function was a mistake, and this replaces both.
--
-- The problem with it was not that it did not work. It was that the map's
-- adjacency graph -- which node opens which -- already exists, in `Game.as`,
-- and `unlock_neighbours` needed a second copy of that knowledge to live in the
-- client's call site. Two copies of a graph is one more than can be kept
-- honest.
--
-- `Recuent` already computes the entire `stats[32]` / `times[32]` /
-- `timesString[32]` picture, unlocks included, and both peers compute it
-- identically -- that is what determinism buys. So the client sends the whole
-- picture and the database merges it monotonically. There is one copy of the
-- graph in the project, in the ported game, where the original put it.

/**
 * Merge a pair's whole map into what is already stored.
 *
 * Monotonic, in both senses: a medal never goes down, and a time is only
 * replaced by a faster one. That is what makes it safe for BOTH peers to write
 * -- they compute the same result, so whoever arrives second changes nothing,
 * and two peers racing converge whichever order they land in. No writer has to
 * be elected, and neither has to trust the other.
 *
 * `stats` uses `Game.as`'s own numbering: -1 locked, 0 unlocked and unplayed,
 * 1..3 medals.
 */
create or replace function public.sync_progress(
  their_id uuid,
  p_stats smallint[],
  p_times integer[],
  p_times_str text[]
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  lo uuid := least(auth.uid(), their_id);
  hi uuid := greatest(auth.uid(), their_id);
  n integer;
  medal smallint;
  secs integer;
  label text;
  changed integer;
  touched integer := 0;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (select 1 from public.friendships f
                  where f.user_a = lo and f.user_b = hi
                    and f.status = 'accepted') then
    raise exception 'you are not playing with that person' using errcode = '42501';
  end if;
  if array_length(p_stats, 1) is distinct from 32 then
    raise exception 'the map has 32 nodes' using errcode = '22023';
  end if;

  for n in 1..32 loop
    medal := p_stats[n];
    -- A locked node is the absence of progress, not progress of -1. Sending
    -- one must never be able to lock a node the pair has already opened.
    continue when medal is null or medal < 0;

    secs := nullif(p_times[n], 0);
    label := nullif(p_times_str[n], '');

    insert into public.pair_progress as pp
      (user_a, user_b, node, medal, best_time_s, best_time_str)
    values (lo, hi, n::smallint, medal, secs, label)
    on conflict (user_a, user_b, node) do update
      set medal = greatest(pp.medal, excluded.medal),
          best_time_s = case
            when excluded.best_time_s is null then pp.best_time_s
            when pp.best_time_s is null then excluded.best_time_s
            else least(pp.best_time_s, excluded.best_time_s)
          end,
          best_time_str = case
            when excluded.best_time_s is not null
             and (pp.best_time_s is null or excluded.best_time_s < pp.best_time_s)
            then excluded.best_time_str else pp.best_time_str
          end,
          updated_at = now()
      where pp.medal < excluded.medal
         or (excluded.best_time_s is not null
             and (pp.best_time_s is null or excluded.best_time_s < pp.best_time_s));

    -- Counted from what the statement actually did, not from what was offered:
    -- the WHERE above skips a node whose stored result is already as good.
    get diagnostics changed = row_count;
    touched := touched + changed;
  end loop;

  return touched;
end;
$$;

revoke all on function public.sync_progress(uuid, smallint[], integer[], text[])
  from public;
grant execute on function public.sync_progress(uuid, smallint[], integer[], text[])
  to authenticated;

-- `unlock_neighbours` asked the client to re-state a graph the game already
-- holds. `sync_progress` sends the result instead of the rule, so it goes.
drop function if exists public.unlock_neighbours(uuid, smallint, smallint[]);
