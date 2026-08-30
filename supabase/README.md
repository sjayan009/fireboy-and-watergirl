# Backend

Postgres, auth and row level security for online co-op.

```bash
npm run db:migrate     # apply migrations, in order, once each
npm run db:test        # prove RLS against the real project
```

Both read `.env.local` at the repo root, which is **gitignored and must stay
that way**: it holds the secret key, which bypasses RLS entirely, and the
database password. Only `SUPABASE_PUBLISHABLE_KEY` may ever reach a browser.

There is no Supabase CLI or Docker on this machine, so `migrate.mjs` connects
straight to Postgres and applies the files itself. The files are plain SQL, so
`supabase db push` would do the same thing if the CLI is installed later.

## The schema

| | |
|---|---|
| `profiles` | the public half of a user: the unique name a friend types to find them |
| `friendships` | one row per relationship, `user_a < user_b` **enforced** so a pair cannot be stored twice |
| `pair_progress` | one row per map node per pair — the shape `Game.as` already keeps in its SharedObject |

Three decisions worth knowing:

- **The accepted friendship IS the co-op pair.** There is no separate `pairs`
  table, because a pair has nothing a friendship does not.
- **Progress belongs to the pair, not to either player**, which is what "jump
  back in where you left off, together" actually means. It hangs off the
  friendship by foreign key, so unfriending takes the shared progress with it.
- **`record_progress` is idempotent and monotonic.** Both peers compute the
  identical result — that is what determinism buys — so both will write it.
  Rather than electing one writer, a medal never goes down and a time is only
  replaced by a faster one, so two peers racing converge on the same row
  whichever order they arrive in.

## Writes go through functions, not tables

`claim_username`, `request_friend`, `accept_friend`, `record_progress` and
`unlock_neighbours` are `security definer`. That is not convenience: it is what
makes some things true by construction rather than by convention.

`profiles` has **no insert policy at all** — the only way a profile comes into
being is `claim_username`, which checks the name's shape and its availability in
the same statement, so two people racing for one name cannot both win.
`friendships` has an insert policy, but it requires `requested_by = auth.uid()`,
so a row claiming somebody else asked cannot be forged.

## What `db:test` proves

Not pgTAP with `set role`. Three real users are created through the admin API,
signed in for real JWTs, and talk to PostgREST exactly as the browser will —
so the test covers policy, grant, function security and the anon-key surface
together, by the route an attacker would take. It creates and deletes its own
users, so it can run against the live project repeatedly.

27 assertions, including: a third party cannot select, insert, update or delete
another pair's progress; cannot forge themselves into a friendship; cannot
rewrite someone's profile; cannot record progress for a pair they are not in;
and an anonymous caller sees nothing at all.
