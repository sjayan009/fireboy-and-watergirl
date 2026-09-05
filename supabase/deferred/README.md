# Migrations that are written but must not run yet

`migrate.mjs` reads `supabase/migrations/` and nothing else, so a file here is
inert: it is applied by being **moved** into that directory, in a later release.

That is the whole mechanism. There is no flag, no ordering table and no "skip"
list, because the rule these files exist to serve is one about releases rather
than about SQL:

> A migration has to be compatible with the release **before** it as well as
> the one it ships with: add before you read, widen before you narrow, and
> split anything that removes or tightens across two releases.

— `supabase/README.md`

The second half of such a split has nowhere to live in `migrations/`. Put it
there and the very next `deployed` run applies it, which is the same thing as
not having split it at all. So it waits here, with its reason attached, until
the release it was waiting for is live.

## Moving one in

1. Confirm the client that stopped depending on the old behaviour is actually
   live -- `curl https://fireboy-and-watergirl-official.vercel.app/version.txt`
   against the commit that shipped it, not against what `main` says.
2. `git mv supabase/deferred/<file>.sql supabase/migrations/<file>.sql`
3. Delete the transitional code the file's header names, if it is somewhere a
   migration cannot reach it.
4. Push. `deployed` applies it like any other.

Renaming is not required and is a bad idea: the timestamp records when the
change was written, and the ledger only ever sees the name it lands under once.

## What is here

| File | Waiting for |
| --- | --- |
| `20260906000000_watch_topic_contract.sql` | The release that stops using `watch:<lo>:<hi>` to be live |
