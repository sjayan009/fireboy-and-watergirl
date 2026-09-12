# Production free-tier budget

Account settings audited 11 September 2026; those observations and legacy relay numbers remain dated evidence. Updated 12 September 2026 for the authorized short-lived Cloudflare TURN rollout and immediate-edge emergency relay. Workload calculations are models unless explicitly tied to a benchmark artifact. See [network rollout](docs/NETWORK_ROLLOUT.md) and [TURN deployment/security gates](docs/NETWORK_ROLLOUT_TURN.md).

## Financial boundary and verified evidence

The target is **$0/month at current and modest usage**. The September 12 authorized rollout permits Cloudflare Realtime TURN's published free allowance and Supabase's credential broker; it supersedes the earlier blanket TURN exclusion. Cloudflare TURN has metered overage, so the earlier guarantee of no charges even when overloaded does **not** apply to this integration. Existing static hosting, Supabase and hosted-CI free-plan controls remain in place. No authoritative gameplay server, SFU, paid upgrade, required VM or paid storage is added. Capacity exhaustion must lead to reduced availability or rollback, not an automatic upgrade.

Unlimited players, retries or hostile requests have no finite worst-case traffic volume. Provider-enforced limits protect the services that have them; TURN's free allowance alone does not. Notifications, credential issuance throttles and browser-local usage counters are not spend caps. Assign usage review and rollback/revocation ownership before TURN rollout. This document cannot certify unknown account settings or guarantee a zero invoice.

Read-only Supabase connector checks against the repository's production project returned:

| Check | Observed result |
| --- | --- |
| Organization subscription | `free` |
| Project status / region | `ACTIVE_HEALTHY`, `us-west-2` |
| Database / version | 13,233,299 bytes; PostgreSQL 17.6 |
| Public tables without RLS | 0 |
| Accepting verifier engine versions | 0 |
| Ranked attempts / retained replay payload | 0 / 0 bytes |
| GitHub repository visibility | `private`, verified through repository metadata |
| Existing Vercel project | `fireboy-and-watergirl-official`, linked to this repository on a `hobby` team |
| Selected Cloudflare destination | `fireboy-and-watergirl.sjayan009.workers.dev`; dashboard Workers plan **Free, $0, Current plan** |
| Existing Worker deployment type | Dashboard confirms static assets only; runtime variables, Logpush, Tail Workers and triggers unavailable |
| Configured SMTP provider | Supabase SMTP host is `smtp-relay.brevo.com`; authenticated Brevo dashboard shows **Free, 300 emails/day** |
| Brevo purchasing state | No saved payment methods; zero prepaid email credits and zero SMS credits |
| Hosted CI | Restored with `FBWG_ZERO_DOLLAR_ACTIONS=1` after verifying the existing account-wide Actions **$0 budget, Stop usage: Yes** |
| GitHub included usage at restoration | GitHub Free; 573 / 2,000 minutes used; $0 billable Actions usage |
| GitHub retained storage | 2 caches, 86,199,572 bytes; 0 artifacts, 0 artifact bytes |

These are September 11 point-in-time observations, before TURN was authorized. Those existing dependencies were on verified Free plans; the authenticated SMTP provider account had no payment method or prepaid credits. Private hosted CI was enabled under GitHub's verified account-wide $0 Actions stop-usage budget. This evidence does not certify the new Cloudflare TURN account configuration or prevent its overage charges. Account-wide invoices, unrelated purchases and future administrator/provider changes are outside this evidence. See [dated deployment evidence](docs/DEPLOYMENT_STATUS.md).

Implemented repository safeguards: `app/scripts/pages.mjs` emits Cloudflare static security headers and rejects over-limit or non-static output. `static-hosting.mjs` restricts `wrangler.json` to this service's static assets, with no script, binding, alternate environment or build hook. `app/scripts/free-config.mjs` rejects static TURN/credentials; the runtime broker is the supported route for short-lived TURN. `check.mjs` scans client/public/output text for master references and configured secret values. Every hosted CI job is gated to public repositories or `FBWG_ZERO_DOLLAR_ACTIONS=1`, which may be set only after a zero-dollar account stop-spend budget is verified. The flag is an operator attestation, not a billing API check. Fast CI has a 20-minute deadline and keepalive a 2-minute deadline.

## Production dependency ledger

| Dependency | Boundary and zero-dollar rule |
| --- | --- |
| Cloudflare Workers Static Assets (selected) | Verified Workers Free; free `workers.dev` hostname, no runtime script/bindings, R2, Images, Stream or purchased domain. Static requests/storage are free and unlimited; Free permits 20,000 files/version and 25 MiB/file. No Worker invocation is needed even for 404s. [Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets) |
| Cloudflare Pages (compatible alternative) | Free `pages.dev` hostname; no Functions or paid resources. Free: 500 builds/month, 20,000 files/site, 25 MiB/file. Static requests are unlimited. At build exhaustion retain the last good deployment. [Limits](https://developers.cloudflare.com/pages/platform/limits/) |
| Existing Vercel hosting during migration | The linked project is on a verified Hobby team. Hobby is free, restricts use to personal/non-commercial projects, and blocks features at limits rather than charging usage overage. Do not upgrade it or add paid integrations. The user selected the existing Workers destination. [Hobby plan](https://vercel.com/docs/plans/hobby) |
| Supabase Free | Auth, Postgres, private friends/presence/signalling, persistence and bounded emergency relay. Free: 500 MB database, 5 GB uncached egress, 50,000 MAU, 2M Realtime messages/month, 200 peak connections. No paid add-ons, branching, compute upgrade, custom domain, phone MFA or log drains. Free may restrict service or pause after inactivity; it does not bill overages. [Pricing](https://supabase.com/pricing), [cost control](https://supabase.com/docs/guides/platform/cost-control) |
| Direct WebRTC | Existing unordered data channel with `maxRetransmits: 0`. Direct host/srflx gameplay avoids provider relay usage. Public STUN remains the only static ICE configuration. |
| Cloudflare Realtime TURN (authorized rollout) | Short-lived credentials minted by an authenticated Supabase Edge Function; master token stays server-side. 1,000 GB/month shared with SFU, then $0.05/GB egress including TURN overhead. No SFU is used here. Usage alerts and the local issuance throttle are not spend caps; live acceptance and account monitoring remain gates. [Allowance](https://developers.cloudflare.com/realtime/), [pricing](https://developers.cloudflare.com/realtime/sfu/pricing/), [accounting](https://developers.cloudflare.com/realtime/turn/faq/) |
| Google OAuth through Supabase | Already implemented; avoids an email-delivery prerequisite for this sign-in route. Verify provider configuration and redirects. Preserve assurance/profile checks and enrolled TOTP. |
| Email sign-up/reset | Existing Brevo SMTP; authenticated account verified Free, 300 emails/day, no saved payment method or prepaid credits. The published Free plan has no expiry. Keep it on Free; no paid credits, upgrades or recharge. Preserve confirmation/MFA and the OAuth alternative. Default Supabase SMTP is restricted to team addresses and is not the configured public sender. [Brevo Free limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan), [plans](https://help.brevo.com/hc/en-us/articles/208589409-About-Brevo-s-pricing-plans), [Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp) |
| Replay verifier | Preserve isolated Node worker and replay validation. Ordinary play/progress already tolerate unavailable ranking registration. Keep engine acceptance disabled without a compatible verifier and bounded queue. No VM is required to play. |
| Optional DO relay | Evaluated below, not deployed or enabled by this audit. Must run on Workers **Free**, using SQLite-backed objects, Hibernation and server-enforced admission. A free allowance on a paid account is insufficient. |
| Local toolchain | npm/Node/TypeScript/Vite/sharp/Playwright are not hosted production services. Use the committed lockfile. Local image builds avoid any required paid registry. Serving an existing static artifact does not require CI to run. |

The September 11 ledger listed Supabase Storage (1 GB) and Edge Functions (500,000 invocations/month) as unused. Storage remains unused and game assets stay on the static host. The new `turn-credentials` function consumes the Edge Function allowance: budget initial issuance, refreshes, retries and rejected calls. Its browser cache reduces normal issuance to roughly once per account per four hours of continuous use, but multiple tabs, restarts and abuse add invocations. The rollout adds managed TURN and the credential function, with no gameplay server.

## Asset inventory and delivery

The final built `dist/` inspected during this audit contained **2,496 files, 27,839,015 bytes**, largest **1,356,970 bytes**: 12.48% of the Pages file limit and 5.177% of the single-file limit. Recount the artifact after every build; these numbers are not a claim about a later build. Publish `dist/`, not the extraction/source tree.

This includes the added Cloudflare `_headers` file. Workers Static Assets and Pages both parse it. The build guard reports final count, bytes and largest file on each release and fails before deployment if a limit is exceeded.

WebP raster conversion, original compressed audio and exclusion of extraction intermediates already exist. Atlases can reduce fetch/decode work but are not necessary for today's file quota. Any atlas must preserve pivots, clipping, filter margins and sampling and pass render comparisons. Combine assets before adding storage. Every atlas must remain below 25 MiB.

At 100 completely cold full-artifact downloads/day, the pessimistic static transfer is **2.7839015 GB/day, 86.3009465 GB/31 days**. This is free static asset delivery, not Supabase egress or Worker invocations. Lazy loading and caches reduce it.

Workers Builds Free has **3,000 build minutes/month**, one concurrent build and a 20-minute timeout. At the full timeout, three builds/day consume at most **60 minutes/day, 1,860 minutes/31 days**; four/day consume **2,480 minutes/month**, above a 75% planning threshold of 2,250. Count non-production branches, retries and other account projects. Local builds/direct uploads use **0 hosted build minutes**. Retain the last good static deployment at exhaustion and never switch to the paid 6,000-minute-plus-overage plan. The service is Git-linked to `main`; the audited code was published through that integration in a 1-minute-18-second build. [Build limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)

Brevo's 300-email daily allowance permits at most **9,300 sends per 31 days**, with no unused allowance carried forward. A 75% planning threshold is **225/day, 6,975/31 days**, shared with any marketing or other transactional mail in the same account. Supabase's configured per-user interval is 60 seconds; its project auth rate limits also apply. Brevo documents queueing transactional mail above the daily allowance, with a 1,000-message queue limit; that is delayed delivery, not purchased capacity. Do not treat email availability as unlimited or add paid credits to clear a queue. No email was intentionally sent by the audit's confirmed disposable-account test. [Free-plan behavior](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)

## Exact traffic arithmetic

`H` means **pair-hours**: two people playing one hour produce one pair-hour. `N` is concurrent relayed pairs; `d` is batching interval in seconds. A model month has 31 days. RTT, jitter, loss and browser throttling change actual sends/stalls; do not assume a universal NAT-failure percentage.

The full engine input is `18 + 16 + 15 + 16 = 65` bytes, carrying 32 input-history frames plus timing/checksums:

```text
input packets/pair-second = 2 * 26 = 52
input packets/pair-hour   = 187,200
input payload/pair-hour   = 187,200 * 65 = 12,168,000 bytes
input payload/peer-second = 26 * 65 = 1,690 bytes
```

Both players therefore generate at most **3,380 input payload bytes/second**
at this full-packet size, approximately 3.3 kB/s. The regional direct benchmark
measured 3,330.15 bytes/s. For scale, 100 relayed pair-hours/day over 31 days
would carry **37.72 GB of input payload** before TURN/DTLS/SCTP/network
headers, control traffic and other account usage. Cloudflare's 1,000 GB
allowance leaves substantial room at modest input-only usage; this example
is not a measured bill, guaranteed session capacity or admission limit.
Measure actual TURN egress and retain headroom for abuse and protocol overhead.

Exclude commands, negotiation, lower-layer retransmissions and DTLS/SCTP/UDP/IP or TLS/TCP/WebSocket framing from that payload figure. Never call it NIC bandwidth. Supabase adds a connection prefix: with `L` prefix bytes, base64 length is `4 * ceil((65 + L) / 3)` ASCII bytes/input, plus JSON arrays/envelopes and Phoenix framing. Actual serialized messages and transport counters must be measured.

### Legacy Supabase emergency relay baseline (September 11)

A broadcast counts once sent plus once per receiving subscriber. With one recipient, that is **two units**. Inputs are batched at 230 ms normally and 115 ms hurried. [Accounting](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages)

```text
broadcasts/pair-hour      = 2 * 3,600 / d
Realtime units/pair-hour = 4 * 3,600 / d
Realtime units/second    = 4 * N / d
```

| Input-only quantity | 230 ms | 115 ms |
| --- | ---: | ---: |
| Broadcasts/pair-hour | 31,304.35 | 62,608.70 |
| Realtime units/pair-hour | 62,608.70 | 125,217.39 |
| Units/second/pair | 17.3913 | 34.7826 |
| Pair-hours/month at full 2M quota | 31.9444 | 15.9722 |
| Pair-hours/month at 1.5M, 25% reserve | 23.9583 | 11.9792 |
| Pair-hours/day at reserve, 31-day month | 0.77285 | 0.38642 |
| Whole pairs below 75 units/second | 4 | 2 |

For finite sessions round sends up and add leading-edge sends, commands, signalling and retries. Free also limits 100 messages/s, 20 presence messages/s, 100 joins/s and 100 channels/connection. [Limits](https://supabase.com/docs/guides/realtime/limits)

The audit's actual 20-second production-transport baseline, with seeded 80-ms RTT/10-ms jitter, measured **8.95 publishes/s and 9,839.4 JSON-payload bytes/s** for a pair on 230-ms batching. Repeating that exact observed rate would be 64,440 Realtime units and 35,421,840 sent JSON bytes per pair-hour. This includes a 74-byte session/attempt prefix before base64, but excludes Phoenix/TLS/IP. A 600-ms RTT/100-ms jitter/20%-loss cell measured 11.1 publishes/s at 230 ms and 19.6 at 115 ms because control retries add sends. These short controlled samples are not global WAN or provider-quota measurements; see [raw baseline](docs/benchmarks/network-before.json). They demonstrate why the input-only ceilings cannot be treated as admissions.

Presence is change-triggered and spaced 8 seconds **per pair channel**. Up to 50 channels means one client's simultaneous activity change can exceed the project presence rate. Rejoining announces again. The channel cap does not prove project-wide presence compliance. Multiple tabs consume actual connections. Reserve budget for the friends graph, startup bursts and reconnects.

### Immediate-edge emergency relay rollout (September 12)

Input transitions and epoch/reset boundaries now publish immediately. Unchanged
holds retain the newest history-bearing packet for an approximately 115 ms
heartbeat. The old 230/115 ms implementation remains available through the
documented rollback flag; its table above is historical comparison, not the
new path's quota estimate.

The matched regional cell (80 ms injected RTT, 10 ms jitter) measured:

| Publication policy | Pair publishes/s | Sent JSON payload bytes/s | Implied Realtime units/pair-hour at that observed rate |
| --- | ---: | ---: | ---: |
| Legacy 230 ms | 8.95 | 9,839.4 | 64,440 |
| Legacy 115 ms | 17.65 | 9,957.6 | 127,080 |
| Immediate edges / coalesced heartbeat | 21.65 | 4,236.3 | 155,880 |

The new policy reduces serialized bytes and input-edge batching delay while
increasing message count in this workload. At 21.65 publishes/s, a 1.5M-message
planning budget would cover only about **9.62 pair-hours/month**, before
presence, signaling, spectators and other traffic. Quota remains finite and
depends on actual input patterns. Prefer healthy WebRTC (direct or TURN);
keep Supabase gameplay as emergency fallback and stop publishing gameplay
there after RTC promotion. [Before](docs/benchmarks/network-rollout-before.json),
[after](docs/benchmarks/network-rollout-after.json),
[rollout analysis](docs/NETWORK_ROLLOUT.md)

Spectating adds traffic even for direct players: one sharing peer mirrors both input directions every 115 ms. With `V` recipients, units/watched pair-hour are `(1 + V) * 3,600 / 0.115`, before catch-up snapshots, presence and control. One viewer adds **62,608.70 units/hour**. Stop admitting new spectators before reducing player connectivity.

### Historical optional Durable Object binary relay analysis (not selected)

This September 11 alternative is retained for comparison. The September 12
rollout selects TURN inside WebRTC and the existing emergency Supabase path;
it adds no Durable Object relay.

DO Free: SQLite only; 100,000 request units/day, 13,000 GB-s/day, reset 00:00 UTC. Incoming application WS messages count 20:1; outgoing messages are unmetered for requests. An upgrade is a request. Eligible idle time is excluded from duration; active objects are metered at 0.128 GB. Free quota exhaustion fails operations, without overage billing. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

The front Worker separately allows 100k requests/day, 10 ms CPU/invocation. Count upgrades, authentication, probes and rejected requests; do not route static files through it. [Worker pricing](https://developers.cloudflare.com/workers/platform/pricing/)

For one object per pair, no upstream sockets/timers preventing hibernation and no per-input storage:

```text
DO request units = R + ceil((input WS messages + control WS messages) / 20)
R = upgrades + HTTP requests + RPC sessions + alarms, across every object
duration GB-s <= 0.128 * 3,600 * H = 460.8 * H (continuous-active bound)
```

Do not assume negligible active time at 52 incoming messages/s. Measure provider duration/handler occupancy before claiming Hibernation savings. Eligible idle time is free even before physical eviction. Use `ctx.acceptWebSocket`; ordinary `accept()` keeps connected objects active. Per-input storage is unnecessary. Free storage limits: 5M reads/day, 100k writes/day, 5 GB total. A persistent global admission ledger needs separate row accounting and retention.

| Input strategy | Units/pair-hour | Request ceiling pair-hours/day | Continuous-active duration ceiling |
| --- | ---: | ---: | ---: |
| Immediate 26 Hz binary | 9,360.00 | 10.6838 | 28.2118 |
| Binary batches, 115 ms | 3,130.43 | 31.9444 | 28.2118 |
| Binary batches, 230 ms | 1,565.22 | 63.8889 | 28.2118 |

These ceilings exclude overhead. Binary batching removes base64/JSON but still adds queue delay and reliable ordered TCP delivery. It does not replace the semantics of the direct unreliable/unordered data channel.

| Illustrative daily workload; each player plays 1 hour | Relayed pair-hours/day | Immediate DO input units/day | 31-day input units | Continuous GB-s/day | Supabase 230-ms units/31 days instead |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2 players, both relayed | 1 | 9,360 | 290,160 | 460.8 | 1,940,869.57 |
| 20 players, 10% relayed | 1 | 9,360 | 290,160 | 460.8 | 1,940,869.57 |
| 100 players, 10% relayed | 5 | 46,800 | 1,450,800 | 2,304 | 9,704,347.83 |
| 20 players, all relayed | 10 | 93,600 | 2,901,600 | 4,608 | 19,408,695.65 |
| 100 players, all relayed | 50 | 468,000 | 14,508,000 | 23,040 | 97,043,478.26 |

A 75k-unit planning threshold allows **less than eight immediate pair-hours/day after overhead**. Five relayed pair-hours use 46,800 input units and leave 28,200 within that threshold; eight use 74,880 and leave only 120. One pair relaying 24 hours requires 224,640 units/day and cannot remain on DO Free. A monthly total cannot pool daily allowances across busy/quiet days.

Regional probes also count. Two players, eight candidates, six echoes each: 16 upgrades + 96 incoming echoes = 20.8 units (round up to 21), before two gameplay upgrades, admission, retries and controls. Bound attempts/samples, cache results for the connection attempt, and probe only after direct P2P fails.

Both players should test the same candidate endpoints and share results over their authorized private pair channel. Proposed selection: minimize the worse player's p95 RTT, then sum of medians, then stable region order. This is an algorithm proposal, not measured optimal routing. `locationHint` is best-effort and only affects the first lookup; existing objects do not move. Fresh region-scoped match identities are needed after reselection. Hints include `enam`, `wnam`, `weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, `oc`; `sam`, `afr`, `me` currently map to nearby supported locations. [Placement](https://developers.cloudflare.com/durable-objects/reference/data-location/)

Survev's [regional binary echo tests](https://github.com/survev/survev/blob/master/client/src/pingTest.ts) use six samples and bounded retries; its [player renderer](https://github.com/survev/survev/blob/master/client/src/objects/player.ts) has separate visual interpolation fields. Its single-client minimum-RTT selector and server-authoritative architecture do not solve this game's joint routing or deterministic rollback.

**Decision:** a narrowly admitted optional DO fallback is financially plausible on confirmed Workers Free. It is not a production dependency. Before enabling it, test pair membership/assurance, globally reserved requests/duration, connection/rate/size caps, expiry, Hibernation recovery, quota rejection and two-peer failover. A shared server counter must cover every region/session; its own request/storage cost belongs in the budget.

## Exhaustion and persistence

At 75% of each relevant planning budget, stop optional uploads/new spectators and reserve control capacity. Prefer direct P2P, then healthy TURN-backed RTC. Review actual TURN egress well before the shared free allowance is exhausted; an alert does not stop traffic or revoke issued credentials. A future enabled DO relay would need separate admission controls and is not part of this rollout. Reuse packet bytes/epochs; transport replacement must not restart authoritative simulation. Bound reconnection attempts.

Supabase fallback is sustainable **only if its separate monthly and per-second budgets can absorb it**. Large TURN usage cannot simply be redirected into 2M Supabase messages/month. If RTC and the emergency path are unavailable, retain local progress and show retry status. Supabase Free restrictions protect its billing boundary; the new PathManager's health checks do not implement global quota-aware admission, and the TURN broker's per-isolate throttle does not enforce a financial cap.

Budget all Supabase egress: API/auth, Realtime and verifier replay downloads. A 3.75 GB/month planning threshold reserves 1.25 GB of the published 5 GB. Remaining gameplay budget is `3.75e9 - observed_non_gameplay_egress`, not that amount divided by raw 65-byte inputs. A maximum 1 MiB replay downloaded on three verifier attempts consumes 3 MiB. One thousand such jobs require **3,145,728,000 bytes**, before other API responses.

The verifier's two empty slots poll every two seconds: up to **86,400 empty claims/day, 2,678,400/31 days**, plus renewals/finishes. A 60-second job can renew six times; three attempts cap execution at 180 seconds/job. Preserve its dedicated `fbwg_verifier` login, verified TLS, isolated threads and resource caps. Do not move it to a paid request service labeled free.

A 1 MiB per-replay limit is not a global queue cap. A hypothetical 500,000,000-byte database ceiling minus the observed 13,233,299 bytes leaves 486,766,701 bytes: only **464 full-size replays** before metadata/indexes/MVCC/other growth. Finishing clears payloads but retains attempt/result rows; indefinite retention is unbounded. Keep engine acceptance disabled until queue admission, a compatible verifier and retention are available. At 75% database use stop optional ranked admissions. Do not erase historical results or ordinary progress merely to fit a calculation. Profiles/friendships/progress also require bounded user admission as storage grows. These operational thresholds do not imply that account settings or code already enforce them.

Read-only security advisors reported 10 RLS/no-policy notices for deliberately private/system tables and 28 signed-in SECURITY DEFINER notices for existing controlled APIs. Retain caller/ownership checks; blanket revocation would break the security model. Leaked-password protection is unavailable on Free; no paid upgrade was proposed to silence its warning. Existing RLS/MFA/friendship/replay tests remain gates. [Advisor guidance](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)

## CI, optional Oracle, and remaining certification

Standard GitHub runners are free for public repositories. This repository was verified **private**. Private GitHub Free includes 2,000 minutes/month, 500 MB artifact storage and 10 GB cache/repository. Nightly job timeouts total 130 minutes, or **4,030 minutes/31 days**, before push jobs/probes/retries. With the new 2-minute keepalive deadline, nightly plus daily keepalive are bounded at **4,092 minutes/31 days**; add at most 20 minutes per fast run, 25 per deployed run and 20 per manual play-release run. This cannot fit the private Free allowance in the worst case. The new job conditions disable private hosted CI without the explicit zero-dollar-budget attestation; run checks locally otherwise. Larger runners remain excluded. Keep cache within the included amount; do not upload large artifacts. No payment method blocks excess usage; unbounded usage with a payment method is unacceptable. [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

CI was initially gated off while the account budget was unverified. On 11 September 2026, the authenticated GitHub billing dashboard confirmed **GitHub Free**, **573 of 2,000 included minutes used**, **$0 billable usage**, and an existing account-wide **Actions budget of $0 with Stop usage: Yes**. No billing setting needed changing. The repository variable `FBWG_ZERO_DOLLAR_ACTIONS=1` was then set and all five workflows were dispatched. This restores push/PR, scheduled and manual checks; the provider budget blocks paid usage if included capacity runs out. Do not remove the stop-usage setting or raise the budget. The flag records this verification; it is not itself a spending cap. [GitHub budget enforcement](https://docs.github.com/en/billing/how-tos/set-up-budgets)

The earlier storage snapshot was 2 caches totaling 86,199,572 bytes and zero artifacts; it is not a claim about all future runs. The daily Supabase liveness workflow adds 31 small requests/month; it does not guarantee uptime or prevent policy changes. CI is not required to serve already-deployed files.

Oracle is **optional only**. Current Always Free: 1,500 A1 OCPU-hours and 9,000 GB-hours/month (2 OCPUs/12 GB), 200 GB block storage, 10 TB outbound/month, home region only. Fixed 2-OCPU/12-GB operation for 31 days uses **1,488 OCPU-hours, 8,928 GB-hours**. Only eligible resources on a non-upgraded Always Free tenancy qualify; no trial credits. Capacity can be unavailable; idle instances can be reclaimed. Optional coturn/relay/verifier loss must not block core play. No Oracle resource was created or made required. [Oracle limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

Cloudflare TURN's published free allowance is the explicitly authorized September 12 exception to the earlier blanket metered-TURN exclusion. Rented TURN, Cloud Run with billing, paid Render workers, paid-capable object storage, paid SMTP and purchased domains remain outside this rollout.

Before certifying a release, retain final asset inventory, actual benchmark artifacts, Supabase Free evidence, Cloudflare static-host Free evidence, TURN allowance/account configuration and usage-alert evidence, SMTP verification or use of existing OAuth, and GitHub zero-dollar controls if private hosted CI is used. Exercise forced TURN, emergency relay and failover on actual deployed origins. No source-only document can substitute for these account and deployment checks, and no blanket $0 guarantee is claimed for excess TURN usage.
