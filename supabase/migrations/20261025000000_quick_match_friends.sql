-- Quick Match finds friends too, last.
--
-- Two friends online at once who both pressed Quick Match used to be skipped
-- past each other: the matcher took strangers only. Quick Match is still
-- mainly for meeting someone new, so a friend is only chosen when no stranger
-- who fits is waiting -- `order by` puts every stranger first.
--
-- Friends already have everything a match row would give them (the accepted
-- row opens the topic and the shared save), so pairing them writes no
-- friendship row at all: the queue hands both sides the topic they already
-- share, and `quick_match_end` / `quick_match_touch` already leave an accepted
-- row alone. `friend` tells the client not to offer "Add as a friend".

drop function public.quick_match_find(text);

create function public.quick_match_find(p_role text)
returns table(partner uuid, username text, topic text, fireboy uuid, host uuid, friend boolean)
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
       and f.status in ('matched', 'accepted');
    if pair.user_a is null then return; end if;
    return query select mine.partner, p.username, 'pair:' || pair.channel::text, mine.fireboy, mine.host,
                        pair.status = 'accepted'
      from public.profiles p where p.id = mine.partner;
    return;
  end if;

  -- Strangers (no row, or a match that ended) first, then friends. Never a
  -- pending request, a block, or a match already running.
  select q.* into them from play_private.quick_queue q
    left join public.friendships f
      on f.user_a = least(me, q.user_id) and f.user_b = greatest(me, q.user_id)
   where q.user_id <> me and q.partner is null and q.seen_at > now() - interval '10 seconds'
     and (q.role = 'either' or p_role = 'either' or q.role <> p_role)
     and (f.status is null or f.status in ('ended', 'accepted'))
     and exists (select 1 from public.profiles p where p.id = q.user_id)
   order by f.status is not distinct from 'accepted', q.joined_at
   limit 1
   for update of q skip locked;

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

  select * into pair from public.friendships f
   where f.user_a = least(me, them.user_id) and f.user_b = greatest(me, them.user_id)
     and f.status = 'accepted';
  if pair.user_a is null then
    insert into public.friendships as f (user_a, user_b, status, requested_by, match_until)
    values (least(me, them.user_id), greatest(me, them.user_id), 'matched',
            least(me, them.user_id), now() + interval '2 minutes')
    on conflict (user_a, user_b) do update
      set status = 'matched', match_until = excluded.match_until, match_request = null, updated_at = now()
      where f.status = 'ended'
    returning * into pair;
    if pair.user_a is null then return; end if;
  end if;

  update play_private.quick_queue q set partner = me, fireboy = fb, host = me, seen_at = now()
   where q.user_id = them.user_id;
  delete from play_private.quick_queue q where q.user_id = me;
  return query select them.user_id, p.username, 'pair:' || pair.channel::text, fb, me,
                      pair.status = 'accepted'
    from public.profiles p where p.id = them.user_id;
end $$;

revoke all on function public.quick_match_find(text) from public, anon;
grant execute on function public.quick_match_find(text) to authenticated;
