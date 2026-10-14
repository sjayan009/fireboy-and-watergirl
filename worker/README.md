# Replay verifier

The worker claims durable jobs from `play_private`, runs each replay in a fresh
Node worker thread, and publishes only the result computed by the engine. It
has two execution slots, a 60-second execution deadline, bounded heaps and
30-second database leases renewed every 10 seconds. A crashed job gets at most
three executions. Logs contain attempt identifiers and timings, not replay
payloads, tokens or database URLs.

## Free VM setup

Use an existing Always Free Linux VM as described in
[the hosting comparison](../docs/HIGH_LEVEL/DEPLOYMENT.md). No paid cloud resource is
created by the repository. Supply `VERIFIER_DATABASE_URL` securely to Docker
Compose, then run:

```sh
docker compose -f worker/compose.yaml up -d --build
```

An administrator must first apply the reviewed migration and create a dedicated
LOGIN role that inherits **only** `fbwg_verifier`. Give it a unique generated
password and a small connection limit (the pool uses four). Use that login's
session-pooler connection string, not the application's service-role key or
the project's administrator login. TLS verification uses the checked-in
Supabase CA; a different provider requires its trusted CA via
`VERIFIER_CA_FILE`. Never disable certificate verification in deployment.

The development-only `VERIFIER_LOCAL_FIXTURE=1` allows an unencrypted connection
only to loopback hostnames. The Compose file does not enable this exception.

## Engine version rollout

`npm --prefix engine run build` derives `ENGINE_VERSION` from the deterministic
rules. Install the worker image before enabling that version in
`play_private.engine_versions`. The migration deliberately enables no version.
Read `engine/dist/version.js` from the exact built artifact and insert its value
through an administrator connection; never synthesize a different version in
the browser.

Before replacing an image, retain each engine module needed by pending jobs in
the image and register its path in `worker/versions.mjs`. Stop accepting new
attempts for an older version before retiring it, wait for its queue to drain,
then remove the module. A worker never claims a version absent from its map.
Do not verify old jobs with the newest engine merely to clear the queue.

## Checks and operations

```sh
node worker/test.mjs
node supabase/test/production-play.mjs
docker build -f worker/Dockerfile -t fbwg-verifier:local .
```

The database test is explicitly restricted to a local fixture and rolls back
its migrations and test data. It is not a command for the supplied live project.
The replay tests exercise real engine execution and rejection cases. The
committed Speed 3 fixture was recorded using movement inputs only, with no
physics or completion-state changes. Two fresh worker executions derive the
same successful result, and the local database test publishes that actual
leased outcome. Both real clients' independent acknowledgements, disagreement
handling, and publication through the deployed worker remain required.

Monitor oldest queued `queued_at`, expired leases, rejection reasons and
`verification_retry` events using an administrator/operations account. Worker
credentials intentionally cannot run arbitrary monitoring queries. Alert when
queue age exceeds 60 seconds or repeated retries exhaust a job. Keep ordinary
pair progress available during verification incidents.

Rollback the client and disable acceptance of its engine version first. Keep
the additive tables and worker until pending jobs are resolved; do not delete
personal progress or overwrite historical scores. An older client and a newer
client have different protocol builds and must reload to play together.
