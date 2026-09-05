# Backend

Postgres, auth and row level security for online co-op.

```bash
npm run db:migrate     # apply migrations, in order, once each
npm run db:test        # prove RLS, the assurance matrix and the load tests
```

Both read `.env.local` at the repo root, which is **gitignored and must stay
that way**: it holds the secret key, which bypasses RLS entirely, and the
database password. Only `SUPABASE_PUBLISHABLE_KEY` may ever reach a browser.

There is no Supabase CLI or Docker on this machine, so `migrate.mjs` connects
straight to Postgres and applies the files itself. The files are plain SQL, so
`supabase db push` would do the same thing if the CLI is installed later.

The connection **verifies the server's certificate**. Supabase does not use a
public CA for Postgres, so the root is pinned at `supabase/certs/prod-ca-2021.crt`
-- the certificate Supabase publishes for exactly this. It used to connect with
`rejectUnauthorized: false`, which is encryption with nothing authenticated:
anybody in the network path could have terminated the TLS, been handed the
database password, and answered the migrations. Point `SUPABASE_DB_CA` at a
different file for a self-hosted database or a rotated root; there is no way to
turn verification off.

## An applied migration is history

`migrate.mjs` records the SHA-256 of every file it applies and checks it on
every later run. Editing an applied migration -- fixing a typo in a policy,
tightening a predicate "just this once" -- is a hard failure with both digests
printed, because the alternative is a database and a repository that disagree
with nothing to say so. Put the change in a new file.

It also takes a PostgreSQL advisory lock for the whole run, so two runners
started together queue rather than both applying the same file. The `full` and
`deployed` workflows additionally share one GitHub concurrency group; the lock is
what makes a manual run from a terminal safe as well.

## A migration must survive the release before it

CI applies migrations — `full` before its tests, `deployed` after it has proved
the release BUILDS and before it waits for that build to be live. Until recently
nothing applied them at all, which is how a migration came to sit unapplied for
days: the only tests that could have noticed handed `claim_username` an invite
code, so they never asked the question the migration answered.

Applying them automatically buys that back and introduces one rule in its place.
**Vercel builds on push and the workflow starts on the same push, so the two
race.** `deployed` migrates before it waits, which is the best ordering
available, but it cannot stop a build finishing first — so for a few seconds
either release may be talking to either schema.

So a migration has to be compatible with the release **before** it as well as
the one it ships with: add before you read, widen before you narrow, and split
anything that removes or tightens across two releases. `0016` is the shape to
copy — it stopped USING `p_times_str` and kept it in the signature, so the
previous release's client goes on calling `sync_progress` with four arguments
and gets a correct answer.

### Where the second half waits

"Split across two releases" needs somewhere to put the half that must not run
yet, and `migrations/` is not it — a file there is applied by the next
`deployed` run, which is the same as never having split it. So the contracting
half goes in `supabase/deferred/`, which the runner does not read, and is
applied by being moved into `migrations/` once the release it was waiting for
is actually live. `supabase/deferred/README.md` has the procedure.

The watch topic is the worked example. `20260905002813` widened
`can_watch_pair_topic` and `can_feed_watch_topic` to accept the new
`watch:<match>:<feed>` alongside the derived `watch:<lo>:<hi>` the previous
release publishes to; `deferred/20260906000000_watch_topic_contract.sql` is the
narrowing, and until it runs a feed can still be reached by naming two user ids
rather than by holding a consent the players can withdraw.

## The schema

| | |
|---|---|
| `profiles` | the public half of a user: the unique name a friend types to find them |
| `friendships` | one row per relationship, `user_a < user_b` **enforced** so a pair cannot be stored twice |
| `pair_progress` | one row per map node per pair — the shape `Game.as` already keeps in its SharedObject |
| `invite_codes` / `invite_redemptions` | the gate, and who came through it |
| `mfa_recovery_codes` | ten bcrypt hashes per account, shown once |

Three decisions worth knowing:

- **The accepted friendship IS the co-op pair.** There is no separate `pairs`
  table, because a pair has nothing a friendship does not.
- **Progress belongs to the pair, not to either player**, which is what "jump
  back in where you left off, together" actually means. It hangs off the
  friendship by foreign key, so unfriending takes the shared progress with it.
- **`sync_progress` is idempotent and monotonic.** Both peers compute the
  identical result — that is what determinism buys — so both will write it.
  Rather than electing one writer, a medal never goes down and a time is only
  replaced by a faster one, so two peers racing converge on the same row
  whichever order they arrive in.

## Two rules that used to be arguments

Migration `0013` turned both of these from things the comments claimed into
predicates the database evaluates.

**A second factor is a property of the SESSION, not of the screen.** Supabase
issues an `aal1` token for a password sign-in whether or not a factor is
enrolled, and every policy here used to authorize on `auth.uid()` alone -- so
the code prompt in `auth.ts` guarded the SPA and nothing underneath it.
`assurance_satisfied()` is the rule now: `aal2` always passes, and `aal1` passes
only for an account with no verified factor. `redeem_recovery_code` is the one
deliberate exception, because the person using one cannot reach `aal2` by
definition.

**An account with no profile is inert.** `0004` said so and `profiles_read` was
`using (true)`, so an account that never redeemed an invite could list every
user id in the project and go on to forge itself into a friendship.
`has_profile()` is that claim as a predicate, in every policy and every
function.

## Writes go through functions, not tables

`claim_username`, `request_friend`, `accept_friend`, `block_friend`,
`unblock_friend`, `remove_friend`, `sync_progress`, `delete_me` and the two
recovery functions are `security definer`. That is not convenience: it is what
makes some things true by construction rather than by convention.

`profiles` has **no insert policy at all** — the only way a profile comes into
being is `claim_username`, which checks the name's shape and its availability in
the same statement, so two people racing for one name cannot both win.

`friendships` has **no insert or update grant** either, as of `0015`. It used to
have policies that read like the rules and were not: INSERT never required
`status = 'pending'`, so `{self, victim, accepted}` was a single POST away, and
UPDATE let either member set any status. The four transition functions are the
only way a friendship changes now.

`pair_progress` has **no insert, update or delete grant**, as of `0016`, for the
same reason: the monotonic merge lived in `sync_progress` and the table let
either member walk round it. Reads are limited to `accepted` pairs; a blocked
pair's history is kept and is nobody's to see until the block is lifted.

## The leaderboard index, measured

`0018` adds a partial index on `(node, best_time_s, updated_at)` for rows that
are actually rankable. The table's primary key is `(user_a, user_b, node)`,
which is right for what the GAME does with it — load one pair's whole map — and
useless for what the board does, which is one node across every pair in time
order.

Measured on a temporary copy of the table holding 200,000 rows, on the live
project's own planner:

| | top 20 for one node |
|---|---|
| with the index | **0.10 ms** — index-only scan, no sort |
| without it | **39.8 ms** — sequential scan, then a sort of 6,300 rows |

The ratio grows with the table rather than staying put: the scan is the whole
table, and the board is always twenty rows.

(This note lives here rather than in the migration because `0018` has been
applied, and an applied migration is history — see above. The measurement came
afterwards.)

## What `db:test` proves

Not pgTAP with `set role`. Real users are created through the admin API, signed
in for real JWTs, and talk to PostgREST exactly as the browser will — so the
tests cover policy, grant, function security and the anon-key surface together,
by the route an attacker would take. Each script creates and deletes its own
users, so they can run against the live project repeatedly.

| | |
|---|---|
| `rlstest.mjs` | the policies, including a no-profile caller, a forged accepted friendship, direct `pair_progress` verbs by a MEMBER, and a leaderboard fed impossible times |
| `mfatest.mjs` | a real TOTP factor, enrolled and answered, then every table verb and every RPC tried with the `aal1` token and again with the `aal2` one |
| `hardtest.mjs` | races: two people for one name, two for the last use of a code, sixteen requests from one person, and sixty out-of-order progress writes |
| `realtimetest.mjs` | the two topics, from a third account that is refused and a fourth that is admitted |
