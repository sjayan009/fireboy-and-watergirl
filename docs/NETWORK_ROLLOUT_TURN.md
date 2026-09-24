# TURN rollout: broker, runtime ICE and selected-path diagnostics

The game continues sending deterministic input packets over its unordered,
unreliable WebRTC data channel. ICE may select a direct or Cloudflare TURN
candidate. TURN does not become an application transport or gameplay server.
Supabase Auth verifies credential requests; Realtime retains presence,
invitations, signaling and the emergency gameplay path.

## PR 1 / phases A–C

| Files | Change |
| --- | --- |
| `supabase/functions/turn-credentials/index.ts`, `handler.ts` | Authenticated, server-only credential issuance |
| `supabase/functions/tsconfig.json`, `runtime.d.ts` | Local strict typecheck/editor bridge for Deno imports |
| `app/src/net/turn.ts`, `turn-loader.ts`, `app/src/lobby.ts` | Runtime invocation, validation, memory cache and STUN fallback |
| `app/scripts/free-config.mjs`, `secret-scan.mjs`, `check.mjs` | Static STUN-only policy plus source/public/output secret scanning |
| `engine/src/net/transport.ts`, `webrtc.ts`, `connect.ts` | Optional selected ICE diagnostics and test-only relay-policy plumbing |
| `test/free-config.mjs`, `test/turn-credentials.mjs` | Static policy, broker/cache tests and secret-injection mutation fixtures |
| `engine/test/ice-diagnostics.mjs`, `engine/test/webrtc.mjs`, `test/turn-live.mjs` | Selected-pair privacy tests and live forced-TURN acceptance harness |

The official credential endpoint is
`POST https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers`,
using the TURN key's API token as bearer authorization and `{ "ttl": 14400 }`.
The provider returns `iceServers`; the broker adds `expiresAt` in Unix
milliseconds measured **before** issuance, so network time cannot lengthen
the advertised lifetime. The response contains only those two fields and
uses `Cache-Control: no-store`. [Cloudflare credential API](https://developers.cloudflare.com/realtime/turn/generate-credentials/)

The function requires a syntactically valid bearer header and calls
`supabase.auth.getUser(token)` against Supabase Auth. Invalid, missing or
anonymous users receive 401 before Cloudflare is contacted. The browser's
publishable key alone cannot obtain credentials. Authentication failures,
missing configuration and upstream failures produce generic responses;
tokens, credential bodies and upstream error bodies are never logged.
[Supabase getUser validation](https://supabase.com/docs/reference/javascript/auth-getuser)

No Edge Function CORS helper or reusable server rate-limit primitive existed
in this repository. The function supports POST/OPTIONS and Supabase client
headers. Set `TURN_ALLOWED_ORIGINS` to comma-separated exact origins for
production and authorized previews. When unset, CORS permits all origins,
but bearer authentication remains mandatory. Non-browser requests without
Origin still require authentication. [Supabase CORS](https://supabase.com/docs/guides/functions/cors)

Abuse resistance allows eight attempts per authenticated user per ten minutes
in each warm isolate, with at most 4096 resident user entries. Failed issuance
also consumes the budget. This is **not a distributed limit, usage limit or
billing cap**; isolate rotation and multiple accounts can bypass its scope.
Existing SQL budgets are specific to friendship/progress RPCs and were not
repurposed. Higher usage needs a shared issuance/usage budget and account
abuse controls before broader rollout.

The runtime loader deduplicates concurrent requests, rejects malformed or
overlong responses, refreshes five minutes before expiration and retries
failures after 30 seconds. Each invocation times out after four seconds;
failure returns the existing public STUN list. Credentials stay in memory,
are copied on return and clear on account changes/sign-out. Fresh connection
attempts refresh them; automatic refresh of an already-open connection beyond
four hours is a follow-up. No deterministic snapshot or replay format changes.

`Transport.rtc` exposes only selected candidate type (`host`, `srflx`,
`prflx`, `relay`), protocol, optional TURN relay protocol, and RTT seconds.
The existing `rttMs` remains milliseconds. A nominated pair is used only when
the browser lacks `transport.selectedCandidatePairId`; arbitrary successful
candidate probes are excluded. No addresses, ports, SDP or credentials are
included. `iceTransportPolicy` defaults to `all`; production never forces
relay. The development lobby accepts `?forceTurn=1` for diagnosis.

## Cost and operational boundary

Verified September 12, 2026: Cloudflare publishes **1,000 GB free per month**
shared across TURN and Realtime SFU, then **$0.05/GB** of egress. TURN overhead
counts. This game uses no SFU. That allowance supports the $0 target at modest
usage; it is not a guarantee of no bill at unlimited usage.
[Monthly allowance](https://developers.cloudflare.com/realtime/),
[pricing](https://developers.cloudflare.com/realtime/sfu/pricing/),
[TURN traffic accounting](https://developers.cloudflare.com/realtime/turn/faq/)

Before enabling production, configure the available Cloudflare usage/billing
notification for the account and assign an operator to review TURN analytics
well before the free allowance is exhausted (for example, an internal 800 GB
threshold). Confirm the account's actual notification controls in its
dashboard; this patch does not configure an alert or impose a spend cap.
If a notification cannot be configured, record a manual usage-review owner
and cadence before rollout. Supabase's existing free quotas also still apply.

## Deployment commands and secret locations

Nothing was deployed during implementation. The local machine has no Supabase
CLI or Deno runtime. Commands/flags below were verified against the official
[CLI deployment](https://supabase.com/docs/reference/cli/supabase-functions-deploy)
and [secret management](https://supabase.com/docs/reference/cli/supabase-secrets-set)
references. Check installed CLI help before using them.

Create a Cloudflare TURN key in the Realtime dashboard and place the following
values in a private, ignored operator env file **outside the web/public tree**:

```dotenv
CLOUDFLARE_TURN_KEY_ID=<turn-key-id>
CLOUDFLARE_TURN_API_TOKEN=<turn-key-api-token>
TURN_ALLOWED_ORIGINS=https://<production-host>,https://<approved-preview-host>
```

The two Cloudflare values belong only in Supabase Edge Function secrets.
Never put them in Vite variables, `define()`, `__ICE_SERVERS__`, client
declarations, public files or browser storage. The function uses platform
`SUPABASE_URL` and `SUPABASE_ANON_KEY` only to validate the user; it does not
need a service-role key or database password.

From the repository root, with an installed Supabase CLI:

```powershell
supabase --help
supabase functions deploy --help
supabase secrets set --help
supabase login
supabase secrets set --project-ref <project-ref> --env-file <private-env-file>
supabase functions deploy turn-credentials --project-ref <project-ref> --use-api --no-verify-jwt
```

`--use-api` bundles remotely without Docker. `--no-verify-jwt` disables the
gateway's legacy JWT check; this function itself **always** validates the
caller's token via `getUser`, supporting the project's actual signing scheme.
Never deploy a version that omits that validation. Test the function's 401
behavior immediately after deployment. The CLI may require `supabase init`
to create local configuration on a new installation; if so, review generated
configuration without changing existing migrations or production settings.

Build and validate the client before deploying its normal static artifact:

```powershell
node test/free-config.mjs
node test/turn-credentials.mjs
node node_modules/typescript/bin/tsc -p supabase/functions/tsconfig.json --noEmit
npm run build
node engine/test/ice-diagnostics.mjs
npm run check
node engine/test/webrtc.mjs
```

The scanner examines client source, public assets, Vite configuration and
production text assets. It preserves the original Supabase detectors, rejects
Cloudflare master variable names/server issuance endpoints, and checks exact
master values provided by local or CI environment (including accidental
`VITE_` prefixes). Test fixtures inject a fake master value into source,
public SVG, bundled JS and Vite config and assert detection without printing
the value. Unknown obfuscated secrets cannot be recognized universally.

For live acceptance, set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and
`FBWG_TURN_USER_TOKEN` in a private operator shell. The last value is a current
signed-in test user's access token, **not** a Supabase API key or Cloudflare
master token. Do not paste tokens into logs or source files. Then run:

```powershell
npx playwright install chromium
node test/turn-live.mjs
```

The harness first checks missing/forged-token rejection, then issues bounded
credentials and runs the existing real browser pair-session test with relay
policy forced. It checks gameplay convergence/hashes and both selected
candidate types. Only short-lived credentials reach the child browser test;
diagnostics omit secrets and addresses. Missing configuration exits 2;
missing browsers in either mode fail rather than producing a false pass.
This fixture's rendezvous is local BroadcastChannel; production Supabase
signaling/fallback still needs the app's separate live acceptance test.

## Evidence, risks and rollback

Local broker/runtime/security tests and strict function typecheck passed.
The live harness was invoked without configured credentials and reported
**not run**. No forced-Cloudflare-TURN session or cloud deployment is claimed.
Record the real result and percentile measurements before production
acceptance; local mocked policy tests are not substitutes for this cell.
The rollout's combined benchmark report owns before/after measurements.

Main risks are four-second cold-start fallback, browser/OS firewall reachability,
credentials expiring on sessions longer than four hours, per-isolate throttle
limits, and usage beyond free quotas. Direct sessions retain the same data
channel options and simulation. Rollback the lobby's runtime loader integration
to the existing static STUN fallback, or disable issuance by unsetting the
Cloudflare token. Cached/issued credentials remain usable until expiry;
an emergency revocation must happen through Cloudflare. Removing issuance
alone does not revoke credentials already issued.

## Production gate

- [ ] Cloudflare TURN key created; master token stored only in Supabase secrets
- [ ] Approved origin list and usage/billing alert configured
- [ ] Function deployed; missing/forged/anonymous callers rejected
- [ ] Authenticated invocation returns only short-lived ICE servers and expiry
- [ ] Production source/public/bundle secret scan passes
- [ ] Direct ICE and forced TURN full-session tests pass; candidate type visible
- [ ] Production Supabase signaling and emergency relay pair verified
- [ ] TURN and direct queue/RTT/jitter percentiles recorded
- [ ] Deterministic/network and save/replay checks pass
- [ ] Usage owner and rollback/revocation steps assigned
