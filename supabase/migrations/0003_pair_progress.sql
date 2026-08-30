-- Progress, which belongs to the PAIR and not to either player.
--
-- The shape is deliberately the one `Game.as` already keeps in its
-- SharedObject -- stats[32], times[32], timesString[32] -- one row per map
-- node instead of three parallel arrays. That is what lets a Supabase-backed
-- store satisfy the existing SaveStore interface in engine/src/game/save.ts
-- without a single line of the ported game changing.

create table if not exists public.pair_progress (
  user_a        uuid not null,
  user_b        uuid not null,
  -- 1..32, the level map's own numbering (Game.as `cur_node`).
  node          smallint not null check (node between 1 and 32),
  -- Game.as stats[]: -1 locked, 0 unlocked and unplayed, 1..3 medals.
  medal         smallint not null default -1 check (medal between -1 and 3),
  best_time_s   integer check (best_time_s is null or best_time_s >= 0),
  best_time_str text,
  updated_at    timestamptz not null default now(),

  primary key (user_a, user_b, node),
  foreign key (user_a, user_b)
    references public.friendships (user_a, user_b) on delete cascade
);

alter table public.pair_progress enable row level security;

-- Every verb, members only. A pair's progress is nobody else's business, and
-- there is no read-only public view of it to leak one.
drop policy if exists progress_read on public.pair_progress;
create policy progress_read on public.pair_progress
  for select to authenticated using (public.is_member(user_a, user_b));

drop policy if exists progress_insert on public.pair_progress;
create policy progress_insert on public.pair_progress
  for insert to authenticated with check (public.is_member(user_a, user_b));

drop policy if exists progress_update on public.pair_progress;
create policy progress_update on public.pair_progress
  for update to authenticated
  using (public.is_member(user_a, user_b))
  with check (public.is_member(user_a, user_b));

drop policy if exists progress_delete on public.pair_progress;
create policy progress_delete on public.pair_progress
  for delete to authenticated using (public.is_member(user_a, user_b));

/**
 * Record a finished level.
 *
 * Both peers compute the identical result -- that is what determinism buys --
 * so both would write the same row. Rather than pick a winner, the write is
 * made idempotent and monotonic: a medal never goes down, and a time is only
 * replaced by a faster one. Two peers racing to save now converge on the same
 * row whichever order they arrive in.
 */
create or replace function public.record_progress(
  their_id uuid, p_node smallint, p_medal smallint,
  p_time_s integer, p_time_str text
) returns public.pair_progress
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  lo uuid := least(auth.uid(), their_id);
  hi uuid := greatest(auth.uid(), their_id);
  row public.pair_progress;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (select 1 from public.friendships f
                  where f.user_a = lo and f.user_b = hi
                    and f.status = 'accepted') then
    raise exception 'you are not playing with that person' using errcode = '42501';
  end if;

  insert into public.pair_progress as pp
    (user_a, user_b, node, medal, best_time_s, best_time_str)
  values (lo, hi, p_node, p_medal, p_time_s, p_time_str)
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
  returning * into row;
  return row;
end;
$$;

revoke all on function public.record_progress(uuid, smallint, smallint, integer, text)
  from public;
grant execute on function public.record_progress(uuid, smallint, smallint, integer, text)
  to authenticated;

/**
 * Unlock the nodes a finished level opens.
 *
 * The adjacency graph lives in Game.as and is replayed here so that "what
 * finishing node 7 opens" has one answer, not one per client. Called after
 * record_progress.
 */
create or replace function public.unlock_neighbours(
  their_id uuid, p_node smallint, neighbours smallint[]
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lo uuid := least(auth.uid(), their_id);
  hi uuid := greatest(auth.uid(), their_id);
  n smallint;
  opened integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not exists (select 1 from public.friendships f
                  where f.user_a = lo and f.user_b = hi
                    and f.status = 'accepted') then
    raise exception 'you are not playing with that person' using errcode = '42501';
  end if;

  foreach n in array neighbours loop
    insert into public.pair_progress (user_a, user_b, node, medal)
    values (lo, hi, n, 0)
    on conflict (user_a, user_b, node) do nothing;
    opened := opened + 1;
  end loop;
  return opened;
end;
$$;

revoke all on function public.unlock_neighbours(uuid, smallint, smallint[]) from public;
grant execute on function public.unlock_neighbours(uuid, smallint, smallint[])
  to authenticated;
