-- The monotonic merge stops being optional.
--
-- 0003 gave `pair_progress` four policies that all asked one question --
-- `is_member(user_a, user_b)` -- and 0006 built `sync_progress` on top of them
-- with an invariant the policies never expressed: a medal never goes down and a
-- time is only replaced by a faster one. The RPC was the careful path and the
-- table was the way round it. Either member could PATCH a medal down, DELETE the
-- pair's history, or write a row for a friendship that was still `pending` or
-- had been `blocked` -- membership was the only test, and membership survives
-- both of those states.
--
-- So the verbs go and the function stays. Reading is narrowed to the state the
-- pair is actually in: `accepted`. A blocked pair's progress is preserved --
-- 0009 chose that deliberately, because blocking somebody you have played
-- thirty levels with should not throw them away -- and is simply not visible to
-- either of them until the block is lifted.
--
-- `record_progress` goes with them. 0006 said synchronization replaced it and
-- then left it granted: one row at a time, no monotonic guard on the whole map,
-- and a `p_time_str` the caller chose. It was the shortest path to a forged
-- leaderboard entry and had no remaining caller.
--
-- ## What the leaderboard can and cannot be told
--
-- The board ranks by `best_time_s` and prints `best_time_str`, and both arrived
-- as whatever the client said. `sync_progress` checked that `stats` had 32
-- entries and nothing else -- not the other two arrays' shapes, not the medal
-- range, not whether a time was physically possible, not whether the label bore
-- any relation to the number beside it. A pair could take the top of every
-- level with `p_time_s: 0` and a label reading whatever they liked.
--
-- This does not make results trustworthy. Nothing short of authoritative
-- simulation or a verified replay can, and that is a larger piece of work than
-- an authorization fix. What it does is take away the free-text and the
-- impossible: dimensions are checked, medals are checked, times must be inside
-- the range a running timer can produce, the label is DERIVED from the number
-- rather than accepted alongside it, and a caller cannot hammer the endpoint.
-- The remaining forgery is "a plausible time you did not earn", which is the
-- honest residue of a client-authoritative design and is now the only one.

-- ---------------------------------------------------------------- the verbs

drop policy if exists progress_insert on public.pair_progress;
drop policy if exists progress_update on public.pair_progress;
drop policy if exists progress_delete on public.pair_progress;

revoke insert, update, delete on public.pair_progress from authenticated;
revoke insert, update, delete on public.pair_progress from anon;

drop policy if exists progress_read on public.pair_progress;
create policy progress_read on public.pair_progress
  for select to authenticated
  using (
    public.caller_allowed()
    and exists (
      select 1 from public.friendships f
       where f.user_a = pair_progress.user_a
         and f.user_b = pair_progress.user_b
         and f.status = 'accepted'
         and auth.uid() in (f.user_a, f.user_b)
    )
  );

-- Superseded by `sync_progress` in 0006 and left callable, which made it the
-- cheapest way to write an arbitrary row.
drop function if exists public.record_progress(uuid, smallint, smallint, integer, text);

-- ------------------------------------------------------------- what is real

/**
 * The shortest and longest a finished level can take, in seconds.
 *
 * The timer is `MM:SS` with two digits of minutes, so 99:59 is the largest
 * value it can display and anything above it did not come from a running game.
 * The floor is the other end of the same argument: the fastest gold threshold
 * in `TimeTable` is twenty seconds, and three is far enough below every real
 * result to reject only claims that were never played.
 */
create or replace function public.plausible_time(secs integer)
returns boolean
language sql
immutable
as $$ select secs is null or (secs >= 3 and secs <= 5999) $$;

/** The label the game itself writes: two digits of minutes, two of seconds. */
create or replace function public.time_label(secs integer)
returns text
language sql
immutable
as $$
  select case when secs is null then null else
    lpad((secs / 60)::text, 2, '0') || ':' || lpad((secs % 60)::text, 2, '0')
  end
$$;

-- Values no timer could have produced, and labels that were never checked
-- against the number beside them. Nulling the time rather than deleting the row
-- keeps the medal, which is the part that says a level was finished at all.
update public.pair_progress
   set best_time_s = null, best_time_str = null
 where best_time_s is not null and not public.plausible_time(best_time_s);

update public.pair_progress
   set best_time_str = public.time_label(best_time_s)
 where best_time_s is not null
   and best_time_str is distinct from public.time_label(best_time_s);

-- Spelled out rather than calling `plausible_time`, because a check constraint
-- is stored as an expression and a function it calls can be replaced afterwards
-- without the constraint being re-checked. The two must agree; the comment on
-- `plausible_time` is where the reasoning lives.
alter table public.pair_progress drop constraint if exists best_time_plausible;
alter table public.pair_progress
  add constraint best_time_plausible
  check (best_time_s is null or (best_time_s >= 3 and best_time_s <= 5999));

-- --------------------------------------------------------------- the budget

/**
 * One row per player per pair, holding a counter and the minute it belongs to.
 *
 * A pair playing normally syncs at most every second and a half and only when
 * something changed, so forty in a minute is far more than a game produces and
 * far less than a script can use.
 */
create table if not exists public.progress_sync_budget (
  user_id      uuid not null references auth.users (id) on delete cascade,
  user_a       uuid not null,
  user_b       uuid not null,
  window_start timestamptz not null default now(),
  calls        integer not null default 0,
  primary key (user_id, user_a, user_b)
);

alter table public.progress_sync_budget enable row level security;
-- No policies. Like `invite_codes` and `mfa_recovery_codes`, there is no query
-- a signed-in account should be able to run against it.

-- ------------------------------------------------------------ the one write

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
  spent integer;
begin
  perform public.assert_allowed();
  if not exists (select 1 from public.friendships f
                  where f.user_a = lo and f.user_b = hi
                    and f.status = 'accepted') then
    raise exception 'you are not playing with that person' using errcode = '42501';
  end if;
  -- All three arrays, not just the first. The other two were read at indexes
  -- the first one's length promised and nothing checked they were there.
  if array_length(p_stats, 1) is distinct from 32
     or array_length(p_times, 1) is distinct from 32 then
    raise exception 'the map has 32 nodes' using errcode = '22023';
  end if;

  -- The budget, before any work is done on the caller's behalf.
  insert into public.progress_sync_budget as b (user_id, user_a, user_b, calls)
  values (me, lo, hi, 1)
  on conflict (user_id, user_a, user_b) do update
    set calls = case when b.window_start < now() - interval '1 minute'
                     then 1 else b.calls + 1 end,
        window_start = case when b.window_start < now() - interval '1 minute'
                            then now() else b.window_start end
  returning b.calls into spent;
  if spent > 40 then
    raise exception 'too many progress writes; slow down' using errcode = '53400';
  end if;

  for n in 1..32 loop
    medal := p_stats[n];
    -- A locked node is the absence of progress, not progress of -1. Sending
    -- one must never be able to lock a node the pair has already opened.
    continue when medal is null or medal < 0;
    if medal > 3 then
      raise exception 'no such medal' using errcode = '22023';
    end if;

    secs := nullif(p_times[n], 0);
    if not public.plausible_time(secs) then
      raise exception 'no timer produces that' using errcode = '22023';
    end if;
    -- A node that has been reached and not finished has no time. Accepting one
    -- would put an unplayed level on the board.
    if medal = 0 then secs := null; end if;
    -- Derived, never accepted. `p_times_str` is still in the signature so the
    -- release before this one keeps working; its contents are ignored.
    label := public.time_label(secs);

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
