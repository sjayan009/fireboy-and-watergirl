-- Whether this account can be signed into with a password.
--
-- Sounds like something the client already knows, and it very nearly is. A
-- session carries `user.identities`, and an account that signed up with an
-- address has an `email` identity there while one that arrived through Google
-- has only `google`. That was the first answer, and it is wrong in one specific
-- way that matters:
--
--   **Setting a password on a Google account does not create an email
--   identity.** Supabase writes the hash and leaves the identity list alone.
--
-- So a Google player who sets a password still looks passwordless forever. The
-- settings row goes on saying "Set a password / Not set" and goes on telling
-- them "this account has no password", both of which have become false, while
-- the password itself works perfectly well. The lie is only in the label, but
-- it is a lie the client has no way to stop telling: nothing in the session, in
-- `app_metadata.providers`, or anywhere else the browser can reach reflects the
-- password having been set.
--
-- `auth.users.encrypted_password` does, and the browser cannot read the `auth`
-- schema. Hence a definer function, the same shape as `delete_me` and
-- `recovery_codes_left` above it.
--
-- ## The column really is null, and that was measured
--
-- Worth writing down because it is easy to check the wrong way. Creating a user
-- through the admin API WITHOUT a password yields a 60-character bcrypt hash --
-- GoTrue makes one up -- so probing that way suggests the column is never null
-- and this function cannot work. An account that arrives through the real OAuth
-- flow is different: `encrypted_password` is genuinely null until something
-- sets one. The admin endpoint is the unrepresentative path, not the OAuth one.
--
-- ## Additive, so it survives the release before it
--
-- Nothing but a new function. The currently deployed client never calls it, and
-- the client that does treats a failure as "assume there IS a password" -- the
-- direction that shows the change form with its current-password proof rather
-- than one that sets a password without asking for anything.

create or replace function public.has_password()
returns boolean
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select u.encrypted_password is not null and u.encrypted_password <> ''
    from auth.users u
   where u.id = auth.uid();
$$;

-- No row, no answer. Deliberately null rather than false: false would mean "you
-- have no password, here is a form that sets one without proving anything",
-- which is the wrong way for this question to fail. The client reads null as
-- unknown and errs the other way.

revoke all on function public.has_password() from public;
grant execute on function public.has_password() to authenticated;
