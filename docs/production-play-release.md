# Production play release status

Implementation is uncommitted in the shared workspace against main `72daeb2`.
Existing work was preserved. Nothing has been deployed, merged, or applied to
the supplied Supabase project, and no paid resources were provisioned.

## Implemented

- Viewport shell, 4:3 width-and-height sizing, compact toolbar, 320px drawer,
  colocated friend/setup controls, incoming invite badge, fullscreen, keyboard
  focus handling and removal of the canvas perimeter ring. Settings and friend
  panels preserve the game instance.
- Typed lifecycle states and cancellable attempts; deterministic simultaneous
  offer selection; acknowledged, deduplicated control delivery; connection
  identity scoping; current level/chooser restoration and tab ownership.
- Account-owned transactional IndexedDB progress, monotonic merge, revision
  acknowledgements, successful-HTTP-only deletion, visible save errors, legacy
  ownerless outbox quarantine and confirmed-frame result capture.
- Deferred engine loading, parallel manifests, shared resource requests,
  bounded decode concurrency, required art preparation and retry, conditional
  rendering and input suspension. Relay batching remains 230ms.
- Server-side match sharing consent and rotating authorization, confirmed
  spectator catch-up, authorized friend-list RPC, verified-only leaderboard,
  durable replay registration/acknowledgement/queue, and isolated Node verifier.

## Evidence obtained locally

| Check | Result |
| --- | --- |
| Engine suite, 32 level digests, snapshots, rollback and quick network matrix | Passed |
| Cross-engine determinism | Chromium, Firefox and WebKit: `aba863c1` after 600 frames |
| Usability fixtures | Passed 1024x600, 1280x720, 1366x768 and 1920x1080, all three browsers; 50 friends, setup, panels, focus, IndexedDB revisions and tab takeover |
| Two local players | Forced relay invite/accept, ready focus, panel lifetime, quit and new level passed |
| Local database transaction | All 19 migrations, account/pair authorization, anonymous RPC grants, replay acknowledgements, duplicate claims, expired leases, retry exhaustion, worker-only publication, consent and revocation passed |
| Worker | Docker image built; two isolated executions of an ordinary-input Speed 3 completion both derive medal 2, 8 seconds, 265 frames; the leased replay also passes through the local database publication path. Rejection, version, canonical ordering and size checks passed. |
| Production bundle | Build and asset/secret checks passed; 738kB JS+CSS under existing 800kB budget; all advertised WebP files exist |
| Lint/typechecking | Passed (existing warning-level explicit-any findings remain) |

Browser screenshots are generated under `.cache/play-evidence`. The fixture
pages are local development inputs, absent from the production bundle. A dev
server hot reload interrupted one pair test during editing; the subsequent
standalone run passed after source edits stopped.

## Database advisor findings

Read-only checks of `hkuhkzcnwircqcmxurxi` found anonymous EXECUTE permissions on
17 application security-definer RPCs, despite earlier migrations revoking
PUBLIC. The new migration explicitly revokes both grants and preserves
authenticated access. Existing function bodies also check caller authority;
this finding does not establish an authentication bypass.
[Advisor guidance](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)

Five SQL helpers had mutable search paths; the migration fixes them. Four
policies now evaluate stable caller checks once, and two friendship foreign
keys receive indexes. These query changes have not yet been benchmarked against
production-size data.
[Search paths](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable),
[RLS initialization](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan),
[Foreign-key indexes](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys)

RLS-without-policy notices on private invite, recovery and budget tables describe
intentional default denial; opening policies to silence them would be incorrect.
Authenticated security-definer access is intentional for the checked RPCs.
The platform's `rls_auto_enable` event-trigger helper is outside these migration
changes and needs administrator review. The unused historical leaderboard index
was retained. The recovery-attempt log's missing primary key is recorded for
schema review, not treated as a demonstrated performance regression.

Leaked-password protection is disabled in project Auth settings. Its availability
under the selected free plan and activation remain an operations check.
[Password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)

## Remaining release gates

1. Provision accessible free compute and resolve relay capacity. The current
   Supabase Free relay cannot meet 100 all-relay players. The alternative relay
   integration is not implemented; see [free hosting](free-hosting.md).
2. Confirm a real browser pair's independent replay acknowledgements and score
   publication through the deployed worker. The recorded ordinary-input fixture
   and local database path pass; they do not establish that deployed end-to-end flow.
3. Exercise real account switching, session expiry, repeated cancellation,
   simultaneous invitations, reconnect after handover, OS suspension, failed
   unload writes and denied storage against the deployed services.
4. Complete fullscreen/display-scaling checks and the existing full rendering
   baselines. Document a cold-load network/CPU profile and measure preparation
   and p95 interactions; no 3-second or 200ms claim is established yet.
5. Run the one-hour 50-game capacity test, including forced relay and five
   spectator groups. Measure sends **and deliveries**, resource drift, queue
   age, confirmed desyncs, acknowledged saves and 25% quota headroom.
6. Wire collected operational events into the chosen host's monitoring, verify
   production response headers, deploy the additive migration and worker,
   enable the exact supported engine version, then promote the client together.
7. Once the promoted client is live — checked against `/version.txt`, not
   against `main` — move `supabase/deferred/20260906000000_watch_topic_contract.sql`
   into `migrations/`. Until it runs, a spectator feed is still reachable by
   naming two user ids instead of by holding a withdrawable consent.

## Release compatibility

`deployed` applies migrations before it waits for Vercel, so the release before
this one is briefly talking to this schema. The migration therefore **widens**
`can_watch_pair_topic` and `can_feed_watch_topic` to accept both the new
`watch:<match>:<feed>` and the previous release's derived `watch:<lo>:<hi>`,
rather than replacing them — otherwise every deploy would break spectating for
whoever was watching at that moment, and would leave it broken for as long as a
failed build went unnoticed. The narrowing is gate 7 above. See
`supabase/README.md`.

Everything else the migration alters was checked against its live definition and
is unchanged in substance: `progress_read`, `profiles_write_own`,
`profiles_delete_own` and `friendships_delete` only wrap existing predicates in
`(select …)` for the initplan optimisation, and `is_member(a,b)` is
`auth.uid() in (a,b)`.

`play_private.engine_versions` is deliberately seeded with nothing, so ranked
registration refuses every engine until an operator enables one. Ordinary play,
progress and the historical leaderboard do not depend on it.

## Where these run

`test:verifier` runs in `fast`, on every push — it needs no browser and no
database, and it is what decides whether a score is real. `test:play` runs in
`full`'s app job, which already has three browsers installed. `test:play-db`
needs a Supabase-shaped local Postgres on port 55439 that nothing in this
repository provisions, so it stays a manual check; `play-release.yml` remains
the on-demand gate that also builds the worker image.

Keep the client unpromoted until these gates pass. The controller currently
owns asynchronous attempt state; more screen lifecycle code can be extracted
as the remaining race tests define its boundaries. Shared caches bound active
downloads but do not yet enforce a decoded-memory budget. Neither physics
parallelization nor a browser-worker rewrite has been introduced without
profiling evidence.
