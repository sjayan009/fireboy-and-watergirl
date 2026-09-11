# Free hosting decision — 11 September 2026

Use **Cloudflare Workers Static Assets Free for static files, Supabase Free for account/control
and persistence, and direct WebRTC for gameplay**. No trials, paid plans,
automatic upgrades, paid TURN, or usage that can generate overage are permitted.
When a free limit is reached, reduce availability; never purchase capacity.

[FREE_TIER_BUDGET.md](../FREE_TIER_BUDGET.md) contains current official limits,
daily/monthly calculations, actual audit observations, and remaining release
conditions. It supersedes earlier capacity estimates in this repository.

The connected Supabase organization was verified as `free` during this audit.
Its database was 13,233,299 bytes with zero accepting verifier versions, zero
ranked attempts, and no public tables without RLS. The existing linked Vercel
project is on a verified Hobby team. On the supplied Workers destination, the
Cloudflare dashboard shows **Free — $0 — Current plan**, and confirms that the
Worker has only static assets (no runtime variables, bindings or triggers).
Supabase uses Brevo SMTP; its authenticated account shows Free, 300 emails/day,
no saved payment methods and zero prepaid credits. Private GitHub hosted jobs
are disabled, and the published release's jobs were observed skipped.

## Static delivery

The user-selected destination is
`https://fireboy-and-watergirl.sjayan009.workers.dev`. Its account was verified
on Workers Free. Static asset requests/storage are free, with no Worker script
required. `wrangler.json` targets this existing account and service; the build
rejects runtime scripts, resource bindings, environments and build hooks.
[Static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

Build with `npm ci` and `npm run build`, then publish only repository-root
`dist/` through the service's **New deployment → folder** uploader, or run
`npx wrangler@4.131.1 deploy --dry-run` followed by
`npx wrangler@4.131.1 deploy` when Wrangler is authenticated. CLI deployment
uses `wrangler.json`; the browser uploader only accepts static assets and does
not read that local configuration. Always verify headers and missing-file 404s
after either method. Do not select an upgrade or add a script to serve files.

The build generates `_headers`, understood by Workers Static Assets and Pages,
and rejects output exceeding 20,000 files, 25 MiB/file, or containing a Pages
Function/Worker entry point. No object storage is required. Only the Supabase
URL and publishable key belong in the browser. The current Git build is linked
to `main`, with `npm run build` and a static `wrangler deploy --assets=./dist`
command. Local changes must reach the remote repository before Git builds use
them; a dashboard upload does not update Git.

Set `FBWG_URL` for deployed checks. Builds recognize `WORKERS_CI_COMMIT_SHA`,
then `CF_PAGES_COMMIT_SHA`, `VERCEL_GIT_COMMIT_SHA` and `GITHUB_SHA`; an untagged
local build says `local`. Validate local uploads against their asset hashes,
since that marker does not identify an uncommitted working tree.

Supabase's Site URL and redirect allow-list were corrected with user approval
to the Workers HTTPS origin and `https://fireboy-and-watergirl.sjayan009.workers.dev/`.
The app uses the origin root with optional intent query parameters.

The inspected final artifact contained 2,496 files. Recount every final
artifact. WebP/audio conversion already
exists. If assets grow, combine them and validate rendering before considering
additional infrastructure. Workers Free also permits 20,000 assets/version
and 25 MiB/asset. Pages Free remains a compatible alternative.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets),
[Pages limits](https://developers.cloudflare.com/pages/platform/limits/)

Workers Builds Free includes 3,000 build minutes/month, one concurrent build
and a 20-minute timeout. Three builds/day at the timeout use at most
`3 × 31 × 20 = 1,860` minutes/month; four use 2,480, above a 75% planning reserve.
Count branch builds, retries and all other account projects too. Local builds
and direct uploads consume **zero hosted build minutes**. Exhaustion must
delay new builds; serving the last static artifact requires no build minutes.
Do not confuse this with Pages' 500-build monthly quota.
[Workers Builds limits](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)

## Bounded relay capacity

The Supabase emergency relay remains available. At 230-ms batching a pair-hour
costs about 62,609 Realtime units; at 115 ms about 125,217, counting both send
and recipient. Reserving 25% of 2M monthly messages leaves 23.96 or 11.98
pair-hours/month before other traffic. Do not promise 100 all-relay players or
route unbounded DO failover into Supabase.
[Realtime accounting](https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages)

An optional Cloudflare Durable Object binary WebSocket relay is evaluated,
not deployed. Free offers 100k request units/day and 13k GB-s/day; incoming WS
messages use 20:1 metering. Immediate 26-Hz forwarding consumes 9,360 units per
pair-hour, before setup/probes/control. A 75% planning threshold permits less
than eight pair-hours/day after overhead. Authenticated global admission,
Hibernation, jointly measured region selection and tested failover are required.
A paid Workers account's included allowance does not qualify.
[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

If both relays lack capacity and P2P fails, show unavailable/retry status and
preserve progress. Financial safety does not mean infinite capacity or uptime.
The default build accepts STUN only; paid TURN cannot be added by quietly
changing the ICE environment variable.

## Verification, email and CI

The deterministic replay verifier stays in `worker/`. It can run on an existing
suitable machine with the scoped database credential; Docker Compose provisions
neither a machine nor a paid resource. Core play/progress do not require it.
Keep ranked engine acceptance off without a compatible verifier, bounded queue
and retention. Never replace verification with trusting client-submitted scores.

Oracle Always Free may optionally host coturn, a relay or the verifier. It is
home-region-only, can lack capacity and can reclaim idle instances. No Oracle
machine is required or provisioned. Only Always Free resources qualify; trial
credits and upgrading a tenancy are excluded.
[Oracle limits](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

Google OAuth is implemented as an email-free sign-in route; production initiation
redirects to Google. The audit did not complete a human Google sign-in round trip.
Existing email sign-up/reset uses verified Brevo Free, with a 300-email daily
allowance and no expiry or automatic paid capacity. Keep its account on Free,
without paid credits. Supabase's default sender is for testing and restricted
to team addresses. Keep confirmation/MFA checks.
[SMTP limits](https://supabase.com/docs/guides/auth/auth-smtp)

Hosted CI now runs for public repositories or when the owner has set
`FBWG_ZERO_DOLLAR_ACTIONS=1` after verifying account-level zero-dollar stop-spend
controls. Private CI otherwise remains disabled; checks can run locally.
The variable is an operator attestation, not an API-enforced billing setting.
[GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

The budget and [deployment record](DEPLOYMENT_STATUS.md) distinguish observed
account settings from remaining physical-device/WAN checks. No provider promises
an unchanged free offer forever. If terms change, disable or migrate the
integration while retaining the $0 constraint.
