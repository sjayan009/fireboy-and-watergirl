-- Your own progress, kept where your account is rather than where you sat.
--
-- Playing alone -- including two people on one keyboard -- wrote to
-- `localStorage` under the key `FBCookie`, which is the shape the 2009 game's
-- SharedObject had and was carried straight across in the port. One key, no
-- account anywhere in it.
--
-- So progress belonged to a BROWSER. Sign out, sign in as somebody else on the
-- same machine, and the new account opened with the previous person's map
-- unlocked and their times on it. That is how it was found: a brand-new account
-- on a shared laptop showing medals it had never earned. Clearing site data
-- threw it away; a second device never had it; and `delete_me` could not reach
-- it, so "delete my account" left a stranger's progress sitting in the browser
-- afterwards.
--
-- The pair half never had this problem, because a result two people earn
-- together has always been a row in `pair_progress` keyed to both of them. This
-- is the same idea with one name on it.
--
-- ## Monotonic, like its neighbour
--
-- The merge is `sync_progress`'s, deliberately: a better medal wins, a faster
-- time wins, and a node nobody has finished is left alone. That matters more
-- here than it looks. The local save is still written first and is still the
-- thing the game reads mid-level, so the server sees whatever the browser had
-- -- including a browser that was offline for a week, or one that has an older
-- copy than the phone. Taking the best of both is the only merge that cannot
-- lose a result, and it makes the order the devices sync in stop mattering.
--
-- It also means the old browser-wide `FBCookie` is not thrown away. Whoever
-- signs in first on that machine hands its contents to the server once, and it
-- is merged rather than trusted -- see `soloProgress` in the client.

create table if not exists public.solo_progress (
  user_id       uuid     not null references auth.users (id) on delete cascade,
  node          smallint not null check (node between 1 and 32),
  medal         smallint not null check (medal between 0 and 3),
  best_time_s   integer  check (best_time_s is null or best_time_s > 0),
  best_time_str text,
  updated_at    timestamptz not null default now(),
  primary key (user_id, node)
);

alter table public.solo_progress enable row level security;

-- Readable by its owner and nobody else. There is no "member" here as there is
-- for a pair: solo progress is one person's, and even a friend has no business
-- reading it -- what friends compare is the leaderboard, which is built from
-- `pair_progress`.
drop policy if exists solo_read on public.solo_progress;
create policy solo_read on public.solo_progress
  for select to authenticated using (user_id = auth.uid());

-- And no write policies at all, the same shape as `progress_sync_budget` and
-- `invite_codes`. Every write goes through the definer function below, which is
-- what enforces the monotonic merge -- a direct `update` could set a medal
-- backwards or plant a time no timer produces.

/**
 * Merge a browser's solo progress into the account's, and hand back the answer.
 *
 * Returns the WHOLE of the account's progress rather than a count of what
 * changed, which is where it differs from `sync_progress`. The caller is not
 * reporting a result to a partner who will read it later; it is asking "what do
 * I actually have?" and needs the merged answer to put on screen and into the
 * local save. One round trip instead of a write followed by a read.
 *
 * `p_times_str` is not in the signature at all. `0016` learned that lesson for
 * the pair function and kept the argument only because a released client was
 * still sending it; nothing has ever called this one, so it starts without it
 * and the label is derived by `time_label` as it should be.
 */
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

  -- The same budget table as the pair writes, keyed to this account three
  -- times over. `(me, me, me)` cannot collide with a pair row, because a pair
  -- row's `user_a` and `user_b` are two different people.
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
    -- A locked node is the absence of progress, not progress of -1. Sending one
    -- must never close a node this account has already opened.
    continue when a_medal is null or a_medal < 0;
    if a_medal > 3 then
      raise exception 'no such medal' using errcode = '22023';
    end if;

    secs := nullif(p_times[n], 0);
    if not public.plausible_time(secs) then
      raise exception 'no timer produces that' using errcode = '22023';
    end if;
    -- Reached and not finished carries no time.
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
