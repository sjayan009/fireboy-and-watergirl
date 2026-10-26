-- What Supabase's performance advisor reported on 2026-10-18, fixed.
--
-- ## Unindexed foreign keys
--
-- Deleting an auth user (or retiring an engine version) cascades or checks
-- through these columns; without an index each check is a sequential scan
-- of the whole table.
--
-- ## Duplicate index
--
-- `ranked_queue` (production_play) and `ranked_attempts_queue`
-- (close_run1_residuals) are the same partial index on `queued_at`. Nothing
-- refers to either by name, so the older one stays.
--
-- ## Missing primary key
--
-- `mfa_recovery_attempts` is a log with no natural key: two attempts in one
-- transaction share `tried_at`. Every insert names its columns, so an
-- identity column is safe to add, and the table is small enough to rewrite.
--
-- ## Left alone
--
-- The seven "unused index" notices: on a project this size that means "not
-- hit yet", and several back ranked attempts, which are off.

create index if not exists quick_queue_partner
  on play_private.quick_queue (partner);

create index if not exists ranked_attempts_engine
  on play_private.ranked_attempts (engine);

create index if not exists friendships_match_request
  on public.friendships (match_request);

drop index if exists play_private.ranked_attempts_queue;

alter table public.mfa_recovery_attempts
  add column if not exists id bigint generated always as identity primary key;
