-- Quick Match: two players who are not friends, paired by the server.
--
-- ## A match is a friendship row, on purpose
--
-- Everything two players share hangs off `friendships`: the private Realtime
-- topic (`pair:<channel>`), `pair_progress` (foreign-keyed to the row and
-- cascading with it), and the leaderboard, which reads `pair_progress`. A
-- second table would have meant a second copy of every one of those rules.
-- So a match is a row with two new states:
--
--   matched   a live match. The topic and the shared save work for as long as
--             `match_until` is in the future; the clients renew it every
--             45 seconds, so a closed tab lets go within two minutes.
--   ended     a match that finished. Nothing works for the two of them any
--             more -- no topic, no reading the save -- but the rows stay, so
--             their times stay on the board for as long as both are listed,
--             and a later match between the same two picks the save back up.
--
-- Watching stays a friends feature: every watch predicate asks for
-- `accepted`, and neither new state is.
--
-- ## Becoming friends keeps the save
--
-- `request_friend` during a match records who asked (`match_request`). When
-- the other one asks too the row becomes `accepted` WITHOUT rotating the
-- channel, so the game in progress keeps its topic and the two simply carry
-- on as friends. One request and the match ending turns into an ordinary
-- pending request, which the other can accept later.
--
-- ## Blocking a stranger
--
-- `block_friend` accepts a matched or ended row and remembers that it was one
-- (`match_block`), so lifting the block puts the pair back to `ended` and
-- never turns a stranger into a friend. A block also keeps the two from ever
-- being matched again: the matcher only pairs people with no row, or an ended
-- one.

-- ---- the two new states -------------------------------------------------

alter table public.friendships drop constraint friendships_status_check;
alter table public.friendships add constraint friendships_status_check
  check (status in ('pending', 'accepted', 'blocked', 'matched', 'ended'));
alter table public.friendships
  add column match_until timestamptz,
  add column match_request uuid references auth.users(id) on delete cascade,
  add column match_block boolean not null default false,
  add constraint match_request_is_a_member
    check (match_request is null or match_request in (user_a, user_b)),
  add constraint live_matches_expire
    check ((status = 'matched') = (match_until is not null));
create index friendships_live_matches on public.friendships(match_until) where status = 'matched';

-- Friends made mid-match keep the topic their game is running on. Every other
-- change of state still rotates it.
create or replace function play_private.rotate_pair_channel()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status
     and not (old.status = 'matched' and new.status = 'accepted') then
    new.channel := gen_random_uuid();
  end if;
  return new;
end $$;

/** The one definition of "these two may play together right now". */
create function public.is_live_pair(lo uuid, hi uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friendships f
                  where f.user_a = lo and f.user_b = hi
                    and (f.status = 'accepted' or (f.status = 'matched' and f.match_until > now())))
$$;
revoke all on function public.is_live_pair(uuid, uuid) from public, anon;
grant execute on function public.is_live_pair(uuid, uuid) to authenticated;

-- ---- where the rows are read ---------------------------------------------

create or replace function public.can_use_pair_topic(topic text)
returns boolean language sql stable set search_path = 'public', 'pg_temp' as $$
  select public.caller_allowed() and exists (
    select 1
      from public.friendships f
     where (f.status = 'accepted' or (f.status = 'matched' and f.match_until > now()))
       and auth.uid() in (f.user_a, f.user_b)
       and topic = 'pair:' || f.channel::text
  )
$$;

alter policy progress_read on public.pair_progress using (
  (select public.caller_allowed())
  and (select auth.uid()) in (pair_progress.user_a, pair_progress.user_b)
  and public.is_live_pair(pair_progress.user_a, pair_progress.user_b));

-- A stranger's name is readable while you are matched with them, as it is on
-- screen anyway; an ended match is not a reason to keep reading it.
alter policy profiles_read on public.profiles using (
  (select public.caller_allowed()) and ((id = (select auth.uid())) or exists (
    select 1 from public.friendships f
     where ((f.user_a = (select auth.uid()) and f.user_b = profiles.id)
         or (f.user_b = (select auth.uid()) and f.user_a = profiles.id))
       and f.status <> 'ended'
       and not (f.status = 'blocked' and f.blocked_by is distinct from (select auth.uid())))));

-- Matches are not friends, so the list does not show them. A stranger you
-- blocked does appear, under Blocked, which is where it is lifted from.
create or replace function public.list_friends()
returns table(id uuid, username text, status text, "theirMove" boolean, "ourMove" boolean, "blockedByMe" boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, f.status::text,
    f.status = 'pending' and f.requested_by = auth.uid(),
    f.status = 'pending' and f.requested_by <> auth.uid(),
    f.status = 'blocked' and f.blocked_by = auth.uid()
  from public.friendships f join public.profiles p
    on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
  where public.caller_allowed() and auth.uid() in(f.user_a, f.user_b)
    and f.status not in ('matched', 'ended')
    and not (f.status = 'blocked' and f.blocked_by <> auth.uid())
  order by p.username
$$;

create or replace function public.sync_progress(their_id uuid, p_stats smallint[], p_times integer[], p_times_str text[])
returns integer language plpgsql security definer set search_path = 'public', 'pg_temp' as $$
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
  if not public.is_live_pair(lo, hi) then
    raise exception 'you are not playing with that person' using errcode = '42501';
  end if;
  if array_length(p_stats, 1) is distinct from 32
     or array_length(p_times, 1) is distinct from 32 then
    raise exception 'the map has 32 nodes' using errcode = '22023';
  end if;

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
    continue when medal is null or medal < 0;
    if medal > 3 then
      raise exception 'no such medal' using errcode = '22023';
    end if;

    secs := nullif(p_times[n], 0);
    if not public.plausible_time(secs) then
      raise exception 'no timer produces that' using errcode = '22023';
    end if;
    if medal = 0 then secs := null; end if;
    label := public.time_label(secs);

    insert into public.pair_progress as pp
      (user_a, user_b, node, medal, best_time_s, best_time_str, best_a_s, best_b_s)
    values (lo, hi, n::smallint, medal, secs, label,
            case when me = lo then secs end, case when me = hi then secs end)
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

    get diagnostics changed = row_count;
    touched := touched + changed;

    if secs is not null then
      update public.pair_progress pp
         set best_a_s = case when me = lo then least(coalesce(pp.best_a_s, secs), secs) else pp.best_a_s end,
             best_b_s = case when me = hi then least(coalesce(pp.best_b_s, secs), secs) else pp.best_b_s end
       where pp.user_a = lo and pp.user_b = hi and pp.node = n
         and secs < coalesce(case when me = lo then pp.best_a_s else pp.best_b_s end, 6000);
    end if;
  end loop;
  return touched;
end;
$$;

-- ---- the queue -------------------------------------------------------------

create table play_private.quick_queue (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('fireboy', 'watergirl', 'either')),
  joined_at timestamptz not null default now(),
  seen_at timestamptz not null default now(),
  -- Set by whoever found this player; read once by this player's next poll.
  partner uuid references auth.users(id) on delete cascade,
  fireboy uuid, host uuid
);
alter table play_private.quick_queue enable row level security;
revoke all on play_private.quick_queue from public, anon, authenticated, fbwg_verifier;

-- ---- the friendship transitions that meet a match --------------------------

/** Live matches nobody renewed: ended, or a pending request if one was made. */
create function play_private.expire_quick_matches() returns void
language sql security definer set search_path = '' as $$
  update public.friendships
     set status = case when match_request is null then 'ended' else 'pending' end,
         requested_by = coalesce(match_request, requested_by),
         match_request = null, match_until = null, updated_at = now()
   where status = 'matched' and match_until <= now();
  delete from play_private.quick_queue
   where seen_at < now() - case when partner is null then interval '15 seconds' else interval '2 minutes' end;
$$;

create function play_private.end_quick_match(me uuid, them uuid) returns void
language sql security definer set search_path = '' as $$
  update public.friendships
     set status = case when match_request is null then 'ended' else 'pending' end,
         requested_by = coalesce(match_request, requested_by),
         match_request = null, match_until = null, updated_at = now()
   where user_a = least(me, them) and user_b = greatest(me, them) and status = 'matched';
$$;

create or replace function public.request_friend(their_username text)
returns public.friendships language plpgsql security definer set search_path = 'public', 'pg_temp' as $$
declare
  me uuid := auth.uid();
  them uuid;
  lo uuid; hi uuid;
  existing public.friendships;
  row public.friendships;
  spent integer;
  waited interval;
begin
  perform public.assert_allowed();

  insert into public.friend_request_budget as b (user_id, calls)
  values (me, 1)
  on conflict (user_id) do update
    set calls = case when b.window_start < now() - interval '1 hour'
                     then 1 else b.calls + 1 end,
        window_start = case when b.window_start < now() - interval '1 hour'
                            then now() else b.window_start end
  returning b.calls, now() - b.window_start into spent, waited;

  if spent > 5 then
    raise exception 'too many friend requests; try again in % minutes',
      greatest(1, ceil(extract(epoch from (interval '1 hour' - waited)) / 60))
      using errcode = '53400';
  end if;

  select id into them from public.profiles
    where lower(username) = lower(their_username);
  if them is null then
    return null;
  end if;
  if them = me then
    raise exception 'you cannot befriend yourself' using errcode = '22023';
  end if;

  lo := least(me, them);
  hi := greatest(me, them);

  perform play_private.expire_quick_matches();
  select * into existing from public.friendships
    where user_a = lo and user_b = hi;
  if existing.status = 'blocked' then
    return null;
  end if;

  -- Mid-match: both asking is a friendship, and the game keeps its topic.
  if existing.status = 'matched' then
    update public.friendships
       set status = case when match_request is not null and match_request <> me then 'accepted' else 'matched' end,
           match_until = case when match_request is not null and match_request <> me then null else match_until end,
           requested_by = case when match_request is not null and match_request <> me then match_request else requested_by end,
           match_request = case when match_request is not null and match_request <> me then null else me end,
           updated_at = now()
     where user_a = lo and user_b = hi
    returning * into row;
    return row;
  end if;

  -- After a match: an ordinary request, from the save the two already have.
  if existing.status = 'ended' then
    update public.friendships set status = 'pending', requested_by = me, updated_at = now()
     where user_a = lo and user_b = hi
    returning * into row;
    return row;
  end if;

  insert into public.friendships (user_a, user_b, status, requested_by)
  values (lo, hi, 'pending', me)
  on conflict (user_a, user_b) do update
    set status = case
          when public.friendships.status = 'pending'
           and public.friendships.requested_by <> me then 'accepted'
          else public.friendships.status
        end,
        updated_at = now()
  returning * into row;
  return row;
end;
$$;

create or replace function public.block_friend(their_id uuid)
returns public.friendships language plpgsql security definer set search_path = 'public', 'pg_temp' as $$
declare
  me uuid := auth.uid();
  row public.friendships;
begin
  perform public.assert_allowed();
  update public.friendships
     set status = 'blocked', blocked_by = me, updated_at = now(),
         match_block = status in ('matched', 'ended') or (status = 'blocked' and match_block),
         match_until = null, match_request = null
   where user_a = least(me, their_id)
     and user_b = greatest(me, their_id)
     -- A friendship, a match, or a block of mine already. Never a request:
     -- blocking one used to be the first half of forging an acceptance.
     and (status in ('accepted', 'matched', 'ended') or (status = 'blocked' and blocked_by = me))
  returning * into row;
  if row is null then
    raise exception 'no friendship to block' using errcode = 'P0002';
  end if;
  return row;
end;
$$;

create or replace function public.unblock_friend(their_id uuid)
returns public.friendships language plpgsql security definer set search_path = 'public', 'pg_temp' as $$
declare
  me uuid := auth.uid();
  row public.friendships;
begin
  perform public.assert_allowed();
  perform play_private.spend_hourly('unblock', 3);
  -- A stranger goes back to being a stranger, never a friend.
  update public.friendships
     set status = case when match_block then 'ended' else 'accepted' end,
         blocked_by = null, match_block = false, updated_at = now()
   where user_a = least(me, their_id)
     and user_b = greatest(me, their_id)
     and status = 'blocked'
     and blocked_by = me
  returning * into row;
  if row is null then
    raise exception 'that is not your block to lift' using errcode = 'P0002';
  end if;
  return row;
end;
$$;

/*
 * Find a partner, or wait for one.
 *
 * Polled by the client every two seconds while it searches. Each call either
 * returns the match -- found now, or found earlier by the other player -- or
 * leaves the caller in the queue, freshened.
 */
create function public.quick_match_find(p_role text)
returns table(partner uuid, username text, topic text, fireboy uuid, host uuid)
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  mine play_private.quick_queue;
  them play_private.quick_queue;
  fb uuid;
  pair public.friendships;
begin
  perform public.assert_allowed();
  perform play_private.spend('quickmatch', 60);
  if p_role is null or p_role not in ('fireboy', 'watergirl', 'either') then
    raise exception 'no such role' using errcode = '22023';
  end if;
  -- ponytail: one lock for the whole queue; bucket by role if it ever gets busy.
  perform pg_advisory_xact_lock(728401554);
  perform play_private.expire_quick_matches();

  -- Somebody already found us.
  select * into mine from play_private.quick_queue q where q.user_id = me;
  if mine.partner is not null then
    delete from play_private.quick_queue q where q.user_id = me;
    select * into pair from public.friendships f
     where f.user_a = least(me, mine.partner) and f.user_b = greatest(me, mine.partner)
       and f.status = 'matched';
    if pair.user_a is null then return; end if;
    return query select mine.partner, p.username, 'pair:' || pair.channel::text, mine.fireboy, mine.host
      from public.profiles p where p.id = mine.partner;
    return;
  end if;

  select q.* into them from play_private.quick_queue q
   where q.user_id <> me and q.partner is null and q.seen_at > now() - interval '10 seconds'
     and (q.role = 'either' or p_role = 'either' or q.role <> p_role)
     -- Strangers only, and never two people one of whom blocked the other.
     and not exists (select 1 from public.friendships f
                      where f.user_a = least(me, q.user_id) and f.user_b = greatest(me, q.user_id)
                        and f.status <> 'ended')
     and exists (select 1 from public.profiles p where p.id = q.user_id)
   order by q.joined_at
   limit 1
   for update skip locked;

  if them.user_id is null then
    insert into play_private.quick_queue as q (user_id, role) values (me, p_role)
      on conflict (user_id) do update set role = excluded.role, seen_at = now();
    return;
  end if;

  fb := case
    when p_role = 'fireboy' then me
    when p_role = 'watergirl' then them.user_id
    when them.role = 'fireboy' then them.user_id
    when them.role = 'watergirl' then me
    when random() < 0.5 then me else them.user_id end;

  insert into public.friendships as f (user_a, user_b, status, requested_by, match_until)
  values (least(me, them.user_id), greatest(me, them.user_id), 'matched',
          least(me, them.user_id), now() + interval '2 minutes')
  on conflict (user_a, user_b) do update
    set status = 'matched', match_until = excluded.match_until, match_request = null, updated_at = now()
    where f.status = 'ended'
  returning * into pair;
  if pair.user_a is null then return; end if;

  update play_private.quick_queue q set partner = me, fireboy = fb, host = me, seen_at = now()
   where q.user_id = them.user_id;
  delete from play_private.quick_queue q where q.user_id = me;
  return query select them.user_id, p.username, 'pair:' || pair.channel::text, fb, me
    from public.profiles p where p.id = them.user_id;
end $$;

/** Stop searching. A match found in the same instant is ended, not left waiting. */
create function public.quick_match_leave() returns void
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); mine play_private.quick_queue;
begin
  perform public.assert_allowed();
  perform pg_advisory_xact_lock(728401554);
  delete from play_private.quick_queue q where q.user_id = me returning * into mine;
  if mine.partner is not null then perform play_private.end_quick_match(me, mine.partner); end if;
end $$;

/** Keep a live match alive. False once it has ended, for either reason. */
create function public.quick_match_touch(their_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); n integer;
begin
  perform public.assert_allowed();
  perform play_private.spend('quicktouch', 10);
  update public.friendships set match_until = now() + interval '2 minutes'
   where user_a = least(me, their_id) and user_b = greatest(me, their_id)
     and status = 'matched' and match_until > now();
  get diagnostics n = row_count;
  return n > 0 or exists (select 1 from public.friendships f
    where f.user_a = least(me, their_id) and f.user_b = greatest(me, their_id) and f.status = 'accepted');
end $$;

create function public.quick_match_end(their_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_allowed();
  perform play_private.spend('quickend', 20);
  perform play_private.end_quick_match(auth.uid(), their_id);
end $$;

revoke all on function play_private.expire_quick_matches(), play_private.end_quick_match(uuid, uuid)
  from public, anon, authenticated, fbwg_verifier;
revoke all on function public.quick_match_find(text), public.quick_match_leave(),
  public.quick_match_touch(uuid), public.quick_match_end(uuid) from public, anon;
grant execute on function public.quick_match_find(text), public.quick_match_leave(),
  public.quick_match_touch(uuid), public.quick_match_end(uuid) to authenticated;
