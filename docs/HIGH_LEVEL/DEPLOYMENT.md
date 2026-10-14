# Deployment

Use **Cloudflare Workers Static Assets Free for static files, Supabase Free for account/control
and persistence, and direct WebRTC for gameplay**. No trials, paid plans,
automatic upgrades, or usage that can generate overage are permitted, with one
reviewed exception: Cloudflare Realtime TURN inside its published free
allowance (see [the TURN deep dive](../DEEP_DIVE/TURN.md)). When a free limit is
reached, reduce availability; never purchase capacity.

What the system is and how its pieces fit is in [OVERVIEW.md](OVERVIEW.md).

## Free-tier limits

These are the published plan limits this document relies on. Providers change
their offers; check the linked pages before relying on a number, and if terms
change, disable or migrate the integration while keeping the $0 constraint.

| Service | Published Free limit |
|---|---|
| Cloudflare Workers Static Assets | Static requests and storage free; 20,000 files per version, 25 MiB per file. [Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets) |
| Cloudflare Workers (scripts) | 100,000 requests/day; a Worker-routed request past the limit gets a 429. [Pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Cloudflare Workers Builds | 3,000 build minutes/month, one concurrent build, 20-minute timeout. [Limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/) |
| Cloudflare Pages (alternative) | 500 builds/month, 20,000 files/site, 25 MiB/file, unlimited static requests. [Limits](https://developers.cloudflare.com/pages/platform/limits/) |
| Cloudflare Realtime TURN | 1,000 GB/month shared with the SFU, then $0.05/GB egress, TURN overhead included. This game uses no SFU. [Allowance](https://developers.cloudflare.com/realtime/), [pricing](https://developers.cloudflare.com/realtime/sfu/pricing/) |
| Cloudflare Durable Objects (evaluated, not used) | 100,000 request units/day, 13,000 GB-s/day; incoming WebSocket messages metered 20:1. [Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Supabase Free | 500 MB database, 5 GB uncached egress, 50,000 MAU, 2M Realtime messages/month, 200 peak Realtime connections, 500,000 Edge Function invocations/month. Free restricts or pauses rather than billing overage. [Pricing](https://supabase.com/pricing), [cost control](https://supabase.com/docs/guides/platform/cost-control) |
| Supabase Realtime rates | 100 messages/s, 20 presence messages/s, 100 joins/s, 100 channels per connection; a broadcast counts once sent plus once per recipient. [Limits](https://supabase.com/docs/guides/realtime/limits), [accounting](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages) |
| Brevo Free (SMTP) | 300 emails/day, no carry-over, no expiry. [Free plan](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan) |
| GitHub Actions | Standard runners free for public repositories; private GitHub Free includes 2,000 minutes/month. [Billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| Oracle Always Free (optional) | 1,500 A1 OCPU-hours and 9,000 GB-hours/month, home region only; idle instances can be reclaimed. [Limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |

The rule at every one of these limits is the same: **never buy capacity;
reduce availability.** Plan against 75% of each budget. Past that, stop
optional work first (new spectators, optional uploads, ranked admissions) and
keep control capacity for players already connected. Alerts and throttles are
not spending caps, and a provider's free offer is not a promise of uptime.

## Static delivery

The destination is `https://fireboy-and-watergirl.sjayan009.workers.dev`, on
Workers Free. Static asset requests and storage are free. `wrangler.json`
targets this service with the static assets in `./dist` and one script,
`edge.mjs`, which runs only for a path that matches no file and answers it with
the 404 page. It never runs first: past the daily request limit a Worker-routed
request gets a 429, so routing `/` through it would let anybody with a loop take
the app offline until the next UTC day. As it is, exhausting the limit breaks
only 404 answers. The build rejects resource bindings other than `ASSETS`,
alternate environments and build hooks.

Build with `npm ci` and `npm run build`, then publish only repository-root
`dist/` through the service's **New deployment → folder** uploader, or run
`npx wrangler@4.131.1 deploy --dry-run` followed by
`npx wrangler@4.131.1 deploy` when Wrangler is authenticated. CLI deployment
uses `wrangler.json`; the browser uploader only accepts static assets and does
not read that local configuration. Always verify headers and missing-file 404s
after either method. Do not select an upgrade.

The build generates `_headers` (from `headers.json`), understood by Workers
Static Assets and Pages, and rejects output exceeding 20,000 files or 25 MiB per
file. No object storage is required. Only the Supabase URL and publishable key
belong in the browser. The Git build is linked to `main`, with `npm run build`
and a static `wrangler deploy --assets=./dist` command. Local changes must reach
the remote repository before Git builds use them; a dashboard upload does not
update Git.

Set `FBWG_URL` for deployed checks. Builds recognize `WORKERS_CI_COMMIT_SHA`,
then `CF_PAGES_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA` and `GITHUB_SHA`; an untagged
local build says `local`. Validate local uploads against their asset hashes,
since that marker does not identify an uncommitted working tree.

Supabase's Site URL and redirect allow-list must name the Workers HTTPS origin
and `https://fireboy-and-watergirl.sjayan009.workers.dev/`. The app uses the
origin root with optional intent query parameters.

Recount the files in every final artifact; the build guard reports count, bytes
and largest file and fails before deployment if a limit is exceeded. WebP/audio
conversion already exists. If assets grow, combine them and validate rendering
before considering additional infrastructure. Pages Free remains a compatible
alternative.

Three builds a day at the 20-minute timeout use at most
`3 × 31 × 20 = 1,860` minutes/month; four use 2,480, above a 75% planning reserve
of 2,250. Count branch builds, retries and all other account projects too. Local
builds and direct uploads consume **zero hosted build minutes**. Exhaustion must
delay new builds; serving the last static artifact requires no build minutes.
Do not confuse this with Pages' 500-build monthly quota.

## Bounded relay capacity

The Supabase emergency relay remains available. At 230-ms batching a pair-hour
costs about 62,609 Realtime units; at 115 ms about 125,217, counting both send
and recipient. Reserving 25% of 2M monthly messages leaves 23.96 or 11.98
pair-hours/month before other traffic. Do not promise 100 all-relay players or
route unbounded failover into Supabase. The immediate-edge publisher described
in [the netcode deep dive](../DEEP_DIVE/NETCODE.md) sends more messages per pair
than either batching interval, so its pair-hours per month are fewer still.

An optional Cloudflare Durable Object binary WebSocket relay was evaluated,
not deployed. Immediate 26-Hz forwarding consumes 9,360 request units per
pair-hour, before setup/probes/control. A 75% planning threshold permits less
than eight pair-hours/day after overhead. Authenticated global admission,
Hibernation, jointly measured region selection and tested failover are required.
A paid Workers account's included allowance does not qualify.

If every relay lacks capacity and P2P fails, show unavailable/retry status and
preserve progress. Financial safety does not mean infinite capacity or uptime.
Static `ICE_SERVERS` accepts public STUN only; TURN credentials come solely from
the authenticated broker, so paid TURN cannot be added by quietly changing the
ICE environment variable.

## Verification, email and CI

The deterministic replay verifier stays in `worker/`. It can run on an existing
suitable machine with the scoped database credential; Docker Compose provisions
neither a machine nor a paid resource. Core play/progress do not require it.
Keep ranked engine acceptance off without a compatible verifier, bounded queue
and retention. Never replace verification with trusting client-submitted scores.

Oracle Always Free may optionally host coturn, a relay or the verifier. It is
home-region-only, can lack capacity and can reclaim idle instances. No Oracle
machine is required. Only Always Free resources qualify; trial credits and
upgrading a tenancy are excluded.

Google OAuth is implemented as an email-free sign-in route; production initiation
redirects to Google. Email sign-up/reset uses Brevo Free, with a 300-email daily
allowance and no expiry or automatic paid capacity. Keep its account on Free,
without paid credits. Supabase's default sender is for testing and restricted
to team addresses. Keep confirmation/MFA checks.
[SMTP limits](https://supabase.com/docs/guides/auth/auth-smtp)

Hosted CI runs for public repositories, or for a private one when the owner has
set `FBWG_ZERO_DOLLAR_ACTIONS=1` after verifying account-level zero-dollar
stop-spend controls. Otherwise private CI stays disabled and checks run locally.
The variable is an operator attestation, not an API-enforced billing setting.

No provider promises an unchanged free offer forever. If terms change, disable
or migrate the integration while retaining the $0 constraint.
