-- Two things an account could not do to itself: block somebody, and leave.
--
-- `block()` has existed in the client since friends.ts was written and has been
-- reachable from nothing, which was just as well -- it set `status = 'blocked'`
-- through the ordinary update policy, and that policy lets either member of a
-- pair set any status they like. A block the blocked person can lift is not a
-- block, so the state needs an owner and the policy needs to say so.
--
-- Leaving is the other half. Supabase can delete a user from the admin API and
-- the admin API needs the secret key, which is exactly the thing that must never
-- reach a browser -- and this deployment is static, with no server of its own to
-- hold one. A security-definer function is the answer the rest of this schema
-- already uses: `claim_username` and `sync_progress` are both one statement the
-- caller could not have written for themselves, and this is a third.

-- ---------------------------------------------------------------- blocking

alter table public.friendships
  add column if not exists blocked_by uuid
    references auth.users (id) on delete cascade;

-- A block belongs to whoever cast it, and nothing else may claim one.
alter table public.friendships
  drop constraint if exists blocked_by_is_a_member;
alter table public.friendships
  add constraint blocked_by_is_a_member check (
    (status = 'blocked' and blocked_by in (user_a, user_b))
    or (status <> 'blocked' and blocked_by is null)
  );

/**
 * A row blocked by the OTHER person is not yours to change.
 *
 * Without this the whole feature is decoration: the blocked party could PATCH
 * the status back to 'accepted' from the browser, because the old policy asked
 * only whether they were one of the two people in the row.
 */
drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships
  for update to authenticated
  using (
    public.is_member(user_a, user_b)
    and (status <> 'blocked' or blocked_by = auth.uid())
  )
  with check (
    public.is_member(user_a, user_b)
    and (status <> 'blocked' or blocked_by = auth.uid())
  );

/**
 * Nor is it theirs to delete.
 *
 * Deleting is how you get out of a friendship, and if the blocked party could
 * do it they would simply delete the block and ask again -- which is the same
 * feature not existing, with extra steps.
 */
drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete to authenticated
  using (
    public.is_member(user_a, user_b)
    and (status <> 'blocked' or blocked_by = auth.uid())
  );

/** Block a friend. Only a friendship can be blocked; a request is refused. */
create or replace function public.block_friend(their_id uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  row public.friendships;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  update public.friendships
     set status = 'blocked', blocked_by = me, updated_at = now()
   where user_a = least(me, their_id)
     and user_b = greatest(me, their_id)
     -- Already blocked by them is not yours to take over.
     and (status <> 'blocked' or blocked_by = me)
  returning * into row;
  if row is null then
    raise exception 'no friendship to block' using errcode = 'P0002';
  end if;
  return row;
end;
$$;

revoke all on function public.block_friend(uuid) from public;
grant execute on function public.block_friend(uuid) to authenticated;

/** Lift a block you cast. Somebody else's is not yours to lift. */
create or replace function public.unblock_friend(their_id uuid)
returns public.friendships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  row public.friendships;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  update public.friendships
     set status = 'accepted', blocked_by = null, updated_at = now()
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

revoke all on function public.unblock_friend(uuid) from public;
grant execute on function public.unblock_friend(uuid) to authenticated;

/**
 * Asking again does not get you past a block.
 *
 * `request_friend` upserts, so without this a blocked person could send a fresh
 * request and the `on conflict` would quietly reopen the row they were shut out
 * of. The block is stated as "no such user" rather than "you are blocked",
 * because telling somebody they have been blocked is information the person who
 * blocked them did not choose to share.
 */
create or replace function public.request_friend(their_username text)
returns public.friendships
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  them uuid;
  lo uuid; hi uuid;
  existing public.friendships;
  row public.friendships;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select id into them from public.profiles
    where lower(username) = lower(their_username);
  if them is null then
    raise exception 'no such user' using errcode = 'P0002';
  end if;
  if them = me then
    raise exception 'you cannot befriend yourself' using errcode = '22023';
  end if;

  lo := least(me, them);
  hi := greatest(me, them);

  select * into existing from public.friendships
    where user_a = lo and user_b = hi;
  if existing.status = 'blocked' then
    raise exception 'no such user' using errcode = 'P0002';
  end if;

  insert into public.friendships (user_a, user_b, status, requested_by)
  values (lo, hi, 'pending', me)
  on conflict (user_a, user_b) do update
    -- they asked first, and now so have we: that is a yes
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

revoke all on function public.request_friend(text) from public;
grant execute on function public.request_friend(text) to authenticated;

-- ----------------------------------------------------------------- leaving

/**
 * Delete the calling account, and everything that hangs off it.
 *
 * One statement, because everything else is already a cascade: `profiles`,
 * `friendships` through all three of its user columns, `pair_progress` through
 * the friendship, and the invite redemptions. Nothing here has to know that
 * list, which is the point -- a delete that enumerated the tables would be a
 * list to keep in step with the schema forever.
 *
 * `security definer` so it runs as the owner: `auth.users` is not a table an
 * authenticated role may delete from, and it must not become one. The function
 * can only ever delete `auth.uid()`, so the privilege it borrows is spent on
 * the one row the caller already controls.
 */
create or replace function public.delete_me()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  delete from auth.users where id = me;
end;
$$;

revoke all on function public.delete_me() from public;
grant execute on function public.delete_me() to authenticated;
