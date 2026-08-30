-- Invite codes are uppercase, and now the database says so.
--
-- `invite.mjs` mints them from an uppercase alphabet, and the sign-up form
-- uppercases whatever is typed -- which is the right convenience, because a
-- code is read aloud or copied out of a message and nobody should lose an
-- evening to having typed it in lower case.
--
-- But the two facts were only related by coincidence. Nothing stopped a code
-- being created in lower case, and one that was could never be redeemed: the
-- form would helpfully uppercase it into a code that does not exist, and tell
-- the person their perfectly valid code was invalid. Found by a test that
-- minted a lowercase code and could not use it.
--
-- Making it a constraint means the minting script and the form agree by rule
-- rather than by habit.

update public.invite_codes set code = upper(code) where code <> upper(code);

alter table public.invite_codes drop constraint if exists code_is_upper;
alter table public.invite_codes
  add constraint code_is_upper check (code = upper(code));
