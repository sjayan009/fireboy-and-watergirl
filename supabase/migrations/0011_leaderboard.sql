-- The board, without opening the table it reads from.
--
-- `pair_progress` is members-only in every verb and stays that way. A
-- leaderboard is a projection of it -- a rank, two names, a time -- so it is a
-- SECURITY DEFINER function returning that projection, and nothing gains SELECT
-- on a row it could not already see. A policy loosened to "anyone may read any
-- pair's progress" would have given away the whole table to buy one column.

alter table public.profiles
  add column if not exists hide_from_leaderboard boolean not null default false;

/**
 * The best time on one level, across every pair.
 *
 * A pair is listed only if BOTH players are willing. A row belongs to two
 * people and there is no half of it to publish, so either of them opting out
 * takes the whole entry off -- which also means neither can put the other on
 * the board by themselves.
 *
 * Only finished levels: medal above zero and a time recorded. `stats` uses
 * Game.as's own numbering, where 0 means a node you have reached and not
 * completed, and ranking those would be ranking an absence.
 */
create or replace function public.leaderboard(p_node smallint, p_limit integer
                                              default 20)
returns table (
  rank        integer,
  a_username  text,
  b_username  text,
  medal       smallint,
  best_time_s integer,
  best_time_str text,
  is_mine     boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    (row_number() over (order by pp.best_time_s asc, pp.updated_at asc))::integer,
    pa.username,
    pb.username,
    pp.medal,
    pp.best_time_s,
    pp.best_time_str,
    auth.uid() in (pp.user_a, pp.user_b)
  from public.pair_progress pp
  join public.profiles pa on pa.id = pp.user_a
  join public.profiles pb on pb.id = pp.user_b
  where pp.node = p_node
    and pp.medal > 0
    and pp.best_time_s is not null
    and not pa.hide_from_leaderboard
    and not pb.hide_from_leaderboard
  order by pp.best_time_s asc, pp.updated_at asc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
$$;

revoke all on function public.leaderboard(smallint, integer) from public;
grant execute on function public.leaderboard(smallint, integer) to authenticated;

/**
 * Where a pair stands on every level at once, so the map can be annotated
 * without thirty-two round trips.
 *
 * Their own rank, and how many pairs are on the board for that level. Runs as
 * the caller's pair, so it says nothing about anybody else's position beyond
 * the count -- which is the number the board itself would show.
 */
create or replace function public.leaderboard_standing(their_id uuid)
returns table (node smallint, rank integer, entries integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with listed as (
    select pp.node, pp.user_a, pp.user_b, pp.best_time_s, pp.updated_at
      from public.pair_progress pp
      join public.profiles pa on pa.id = pp.user_a
      join public.profiles pb on pb.id = pp.user_b
     where pp.medal > 0 and pp.best_time_s is not null
       and not pa.hide_from_leaderboard and not pb.hide_from_leaderboard
  ),
  ranked as (
    select node, user_a, user_b,
           (row_number() over (partition by node
                               order by best_time_s asc, updated_at asc))::integer as r,
           (count(*) over (partition by node))::integer as n
      from listed
  )
  select node, r, n
    from ranked
   where user_a = least(auth.uid(), their_id)
     and user_b = greatest(auth.uid(), their_id)
   order by node
$$;

revoke all on function public.leaderboard_standing(uuid) from public;
grant execute on function public.leaderboard_standing(uuid) to authenticated;
