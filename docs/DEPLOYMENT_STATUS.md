# Workers deployment verification — 11 September 2026

**Published and production smoke checks passed** at
[fireboy-and-watergirl.sjayan009.workers.dev](https://fireboy-and-watergirl.sjayan009.workers.dev).
The tested code revision is `a80d07ef72f7e0be9d89c4bde320c34a810e10b3`.
Subsequent documentation-only revisions retain this implementation.

## Publication and account evidence

- Cloudflare Workers dashboard: **Free — $0 — Current plan**. The service is
  static assets only, with no runtime bindings, variables, triggers, Logpush
  or Tail Workers; no purchased domain; preview URLs disabled.
- Existing Git integration deployed `main` using `npm run build` and
  `wrangler deploy --assets=./dist`. Successful build
  `657cb4bc-cf32-4946-8b74-2b4377f2af6e` took **1 minute 18 seconds**.
  Live `version.txt` matched the full tested code revision.
- Supabase organization subscription is **Free**. Site URL is
  `https://fireboy-and-watergirl.sjayan009.workers.dev`; the redirect allow-list
  includes `https://fireboy-and-watergirl.sjayan009.workers.dev/`. The malformed
  entry without a scheme was removed; existing local/Vercel redirects retained.
- Supabase's SMTP host is `smtp-relay.brevo.com`. The authenticated Brevo account
  shows **Free, 300 emails/day**, no saved payment methods and zero prepaid email
  or SMS credits. No plan upgrade, paid credit or payment method was added.
- GitHub repository is private. CI was initially gated off; it was restored
  on 11 September after verifying the existing account-wide Actions $0 budget
  with Stop usage enabled. `FBWG_ZERO_DOLLAR_ACTIONS=1` is now configured, and
  all five workflows were dispatched. The account had used 573 of 2,000
  included minutes, with $0 billable usage. The earlier storage snapshot was
  2 caches totaling 86,199,572 bytes and zero artifacts.
- The existing linked Vercel project remains on a verified Hobby team. It is
  not required by the selected Workers deployment.

These are dated observations, not guarantees about future account changes or
provider terms. [FREE_TIER_BUDGET.md](../FREE_TIER_BUDGET.md) gives the financial
boundaries, daily/monthly workload calculations and capacity limitations.

## Production checks

`node app/test/deployed.mjs https://fireboy-and-watergirl.sjayan009.workers.dev`
passed with the expected commit supplied through `FBWG_COMMIT`:

- Root/hash routes return 200; unknown paths return 404; HTML revalidates.
- CSP permits the configured Supabase connection and denies framing;
  X-Frame-Options, nosniff, no-referrer, noindex and camera/microphone restrictions
  are present. Immutable art and bundle caching works. All nine previously
  failing security/cache assertions now pass.
- A disposable confirmed account signed in and reached the canvas. The menu
  rendered CDN WebP art, all 17 audio files were fetchable, and no CSP refusal,
  failed resource request or page error was observed. The test user was deleted.
  This smoke test renders the menu; it does not claim a completed multiplayer level.
- The production bundle contains no secret key or debug hook.
- A separate Google OAuth initiation request returned HTTP 302 to
  `accounts.google.com`. A human Google sign-in round trip was not performed.

## Artifact identity and local validation

[Bundle evidence](benchmarks/deployment.json) records nine live JS/CSS responses.
The tested engine bundle is **byte-identical** to production, SHA-256
`53f9a8b306ad68c97ba28502f96e9ca5c16effc3971c1a6b75c71c2591bfe1c1`.
CSS and the Supabase chunk also match exactly. Other app chunks match after
normalizing only generated chunk filenames and asset release query identifiers.
This is narrower than claiming an identical full artifact.

The inspected **local** `dist/` had 2,496 files, 27,839,015 bytes, largest
1,356,970 bytes. Its fingerprint was
`1df931ed0a8addd50a2435d70428976c805a86efc09e1c8023fa61566ed849b4`,
hashing sorted `UTF8(path + NUL + byteLength + NUL)` followed by each file's bytes.
It does not identify the separately built Cloudflare artifact. Build guards
recount assets and reject quota violations or runtime resources on each build.

Local validation passed production build, static/secret/manifest checks,
zero-cost configuration tests, documentation checks and Wrangler 4.131.1 dry-run
without bindings. [BENCHMARKS.md](../BENCHMARKS.md) records renderer improvements,
determinism/replay/browser tests and controlled network/failover measurements.

Physical input-to-photon, real high-refresh hardware, remote NAT combinations,
joint regional relay paths and provider quota refusal remain unmeasured in the
field. The optional Durable Object relay was evaluated, not enabled. Current
provider Free limits stop expenditure; project-wide graceful quota admission
is not claimed implemented for the existing Supabase emergency relay.
