-- `sync_solo_progress` could not read back what it had just written.
--
-- `returns table (node smallint, medal smallint, ...)` does two things at once:
-- it names the result columns AND it declares a plpgsql variable for each of
-- them. So in the final `return query select sp.node, sp.medal ... from
-- solo_progress sp`, every one of those names is both a variable in scope and a
-- column of the table being selected from, and Postgres refuses to guess:
--
--   42702: column reference "node" is ambiguous
--   It could refer to either a PL/pgSQL variable or a table column.
--
-- Qualifying with `sp.` is not enough, because the conflict is raised on the
-- OUTPUT list's names rather than on the input reference. `#variable_conflict
-- use_column` settles it the way this function wants: where a name could be
-- either, it is the column.
--
-- Safe to state that broadly here because nothing else in the body collides --
-- the locals are `me`, `n`, `a_medal`, `secs`, `label` and `spent`, and not one
-- of them is a column of `solo_progress`. The rename of `medal` to `a_medal` in
-- the original was for exactly this reason and turns out to have been the right
-- instinct applied in only half the places it was needed.
--
-- Everything else is `20260910120000` unchanged.

create or replace function public.sync_solo_progress(
  p_stats smallint[],
  p_times integer[]
)
returns table (node smallint, medal smallint, best_time_s integer,
               best_time_str text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  me uuid := auth.uid();
  n integer;
  a_medal smallint;
  secs integer;
  label text;
  spent integer;
begin
  perform public.assert_allowed();
  if array_length(p_stats, 1) is distinct from 32
     or array_length(p_times, 1) is distinct from 32 then
    raise exception 'the map has 32 nodes' using errcode = '22023';
  end if;

  insert into public.progress_sync_budget as b (user_id, user_a, user_b, calls)
  values (me, me, me, 1)
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
    a_medal := p_stats[n];
    continue when a_medal is null or a_medal < 0;
    if a_medal > 3 then
      raise exception 'no such medal' using errcode = '22023';
    end if;

    secs := nullif(p_times[n], 0);
    if not public.plausible_time(secs) then
      raise exception 'no timer produces that' using errcode = '22023';
    end if;
    if a_medal = 0 then secs := null; end if;
    label := public.time_label(secs);

    insert into public.solo_progress as sp
      (user_id, node, medal, best_time_s, best_time_str)
    values (me, n::smallint, a_medal, secs, label)
    on conflict (user_id, node) do update
      set medal = greatest(sp.medal, excluded.medal),
          best_time_s = case
            when excluded.best_time_s is null then sp.best_time_s
            when sp.best_time_s is null then excluded.best_time_s
            else least(sp.best_time_s, excluded.best_time_s)
          end,
          best_time_str = case
            when excluded.best_time_s is not null
             and (sp.best_time_s is null or excluded.best_time_s < sp.best_time_s)
            then excluded.best_time_str else sp.best_time_str
          end,
          updated_at = now()
      where sp.medal < excluded.medal
         or (excluded.best_time_s is not null
             and (sp.best_time_s is null or excluded.best_time_s < sp.best_time_s));
  end loop;

  return query
    select sp.node, sp.medal, sp.best_time_s, sp.best_time_str
      from public.solo_progress sp
     where sp.user_id = me
     order by sp.node;
end;
$$;

revoke all on function public.sync_solo_progress(smallint[], integer[]) from public;
revoke all on function public.sync_solo_progress(smallint[], integer[]) from anon;
grant execute on function public.sync_solo_progress(smallint[], integer[])
  to authenticated;
