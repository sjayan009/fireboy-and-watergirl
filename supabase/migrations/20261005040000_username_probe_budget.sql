-- Ten username claims an hour, counted before the name is tried.
--
-- The contracting half of `20261005030000_rename_through_the_function`. It
-- waited in `supabase/deferred/` until the client whose `claimUsername` reads a
-- NULL answer as "that username is taken" was live (6553a3b, confirmed from the
-- deployed version.txt). Applied before that, the previous client would have
-- read NULL as success and published an empty profile for anybody who picked a
-- taken name during the deploy.
--
-- ## Why
--
-- `claim_username` answered "that username is taken" for a name somebody holds
-- and succeeded for one nobody does, then rolled back, so asking cost nothing
-- and left no trace. That is the same existence oracle `request_friend` was
-- metered to close (`20260913000000`, `20260913010000`), reachable through the
-- one function that was not. `20261005030000` closed the table route.
--
-- ## Why NULL rather than a raise
--
-- For the reason `20260913010000` gives at length: a raise rolls back the
-- transaction, and with it the attempt that was just charged. So a taken name
-- now commits the charge and returns NULL; `auth.ts` turns that back into the
-- same message as before.
--
-- Ten an hour, charged for every attempt at a name you do not already hold:
-- somebody choosing a name tries two or three, and a rename is rare. A
-- dictionary is not ten words.

create table if not exists public.username_claim_budget (
  user_id      uuid not null references auth.users (id) on delete cascade,
  window_start timestamptz not null default now(),
  calls        integer not null default 0,
  primary key (user_id)
);

alter table public.username_claim_budget enable row level security;
revoke all on public.username_claim_budget from public, anon, authenticated;
-- No policies, the same shape as `friend_request_budget`.

create or replace function public.claim_username(new_username text)
returns public.profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  row public.profiles;
  spent integer;
  waited interval;
begin
  perform public.assert_assured();
  if not exists (select 1 from auth.users u
                  where u.id = me
                    and u.email_confirmed_at is not null
                    and not coalesce(u.is_anonymous, false)) then
    raise exception 'confirm your email address first' using errcode = '42501';
  end if;
  if char_length(new_username) < 3 or char_length(new_username) > 20
     or new_username !~ '^[A-Za-z0-9](_?[A-Za-z0-9]){2,19}$' then
    raise exception 'username must be 3-20 letters, digits or underscores'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(me::text, 0));

  -- Asking again for the name you already hold answers nothing about anybody
  -- else, and is what a double click or a retry looks like -- so it is free.
  -- After the lock, so sixteen identical requests in flight charge once.
  select * into row from public.profiles p where p.id = me;
  if row.username = new_username then
    return row;
  end if;

  insert into public.username_claim_budget as b (user_id, calls)
  values (me, 1)
  on conflict (user_id) do update
    set calls = case when b.window_start < now() - interval '1 hour'
                     then 1 else b.calls + 1 end,
        window_start = case when b.window_start < now() - interval '1 hour'
                            then now() else b.window_start end
  returning b.calls, now() - b.window_start into spent, waited;

  if spent > 10 then
    raise exception 'too many username changes; try again in % minutes',
      greatest(1, ceil(extract(epoch from (interval '1 hour' - waited)) / 60))
      using errcode = '53400';
  end if;

  -- The name check and the write in one block, so a collision unwinds only the
  -- write and the charge above still commits. See the header.
  begin
    insert into public.profiles as p (id, username)
    values (me, new_username)
    on conflict (id) do update
      set username = excluded.username, updated_at = now()
    returning * into row;
  exception
    when unique_violation then
      return null;
  end;
  return row;
end;
$$;

revoke all on function public.claim_username(text) from public, anon;
grant execute on function public.claim_username(text) to authenticated;
