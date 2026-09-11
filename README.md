# Fireboy & Watergirl: The Forest Temple

The 2009 Flash game, recovered from its compiled SWF and rebuilt so two people
anywhere can play it together and pick up where they left off.

There was no source code. Everything here — 32 levels, the art, the audio, the
menus, the physics — was reconstructed from one 2 MB binary, which is committed
because it is the only thing the rest was derived from.

```bash
npm install
npm run dev        # http://localhost:5174
npm test           # the fast tier: engine, build, secret scan
npm run test:all   # everything, including the soak and three browsers
```

`npm install` is the whole toolchain. Python is still what turned the SWF into
the assets in the first place (`tools/`), but nothing in a normal build or
deploy needs it.

## What it is

| | |
|---|---|
| `engine/` | the simulation, the renderer and the netcode. No network, no accounts, runs in Node |
| `app/` | a static single-page app: sign-up, friends, and the game |
| `supabase/` | migrations and the tests that prove row level security |
| `tools/` | the Python that turned the SWF into everything else |
| `web/` | the engine's own harness, with readouts and debug hooks |
| `docs/` | [the architecture](docs/ARCHITECTURE.MD), and the release and hosting notes |

## The two things that shaped it

**The simulation is a pure function of `(mode, level, input log)`,** verified
across V8, SpiderMonkey and JavaScriptCore. That is what makes the netcode
possible: two peers exchange three bits each per frame and nothing else, ever.

**Netplay is rollback, not lockstep.** Your own character answers on the very
next frame — measured at one frame against lockstep's five — because the peer's
input is predicted and corrected by re-simulating. It is affordable here for a
specific reason: a frame re-simulates in about 0.04 ms and a snapshot of the
entire world costs about 5 ms, so rewinding further is always cheaper than
having saved the exact frame.

A pair on a direct peer connection never touches a server while playing. A pair
whose NAT refuses one relays through their own Realtime channel, which costs a
hop of latency and needs no TURN server.

## Accounts

Sign-up needs a confirmed email address, and two-factor is optional. Google
sign-in satisfies verification without requiring an outbound email provider.
`claim_username` creates the profile after verification; invite codes have been
removed. An account with no profile cannot be
found, befriended, or reach a row of anybody else's data: migration `0013` makes
that true by requiring a profile in every policy and every function, where it
had previously been an argument about what a profile is used for. It was not
true before that — `profiles` was readable by any signed-in account, which was
the id an attacker needed.

**The gate is on the DATA, not on the download.** The bundle and the extracted
art are static files on a CDN and anybody who has the URL can fetch them; the
`X-Robots-Tag` header affects indexing and not access. Two-factor is likewise
enforced in the database rather than only on the screen that asks for the code —
a session that has not answered its own factor is refused by every policy — but
neither of those restricts who can download the game. If that matters, it has to
be a deployment-level control (Vercel's protection, or an authenticated asset
route), and there is not one today.

Two-factor has ten single-use recovery codes, minted and hashed in the database
and shown exactly once. This paragraph used to say the opposite -- that they
were deliberately not worth a new security-sensitive surface, because everyone
here could reach whoever holds the secret key. `0012_recovery_codes` decided
otherwise, on the grounds that "ask the person with the secret key" is a fine
answer for a handful of friends and a bad one at three in the morning.

One thing they cannot do, and both the screen and the migration say so:
redeeming a code turns two-factor **off** rather than letting one session past
it. Supabase models the second factor as an assurance level and a session
reaches `aal2` only by answering a challenge, so "let me in just this once" is
not something the platform can express. Recovery means unenrolling and setting
it up again.

Somebody who has lost both the authenticator and the codes still needs whoever
holds the secret key, and that person runs:

```bash
npm run unenrol -- --user someone
```

An account can delete itself from Settings. `delete_me()` is a security-definer
function rather than an admin call, because the admin API needs the secret key
and this deployment is static with nowhere to keep one; everything else -- the
profile, the friendships, the progress each pair earned -- is already a cascade.

## Testing

Two tiers, because a suite people stop waiting for stops being run.

```bash
npm test           # fast: no browser, no credentials, a few minutes
npm run test:all   # everything below
npm run db:test    # policies, races, fuzz, private channels
npm run app:test   # accounts and two-account play, in real browsers
```

| | |
|---|---|
| simulation | all 32 levels pinned by digest, snapshot round-trips on every one, a soak of 640,000 frames -- about seven hours of play, run twice and compared |
| netcode | 192 combinations of latency, jitter, loss, mode and input pattern; damaged, duplicated and stale packets |
| rendering | a perceptual signature per level, so a mask that stops clipping -- or an encoder swap that changes the picture -- is caught |
| database | row level security from a third account, races run in parallel, ordering fuzz |
| the app | the emailed links, the username rules, two-factor, Google, and two people playing |

What is **not** tested here: that email actually arrives, and real NAT traversal
between two physical networks. Both need something this machine does not have.

`npm run test:deployed` is the other tier, and it runs itself: the build stamps
`dist/version.txt` with the commit, and the `deployed` workflow waits for that
commit to be the one answering on the live origin before asserting against it.
Waiting for anything softer means passing against the previous release when a
build fails, which is a green check for a deployment that never happened.

## Deploying

The selected zero-cost destination is **Cloudflare Workers Static Assets Free**:
[fireboy-and-watergirl.sjayan009.workers.dev](https://fireboy-and-watergirl.sjayan009.workers.dev).
Run `npm run build`, then upload only repository-root `dist/` using the
static-file uploader or `npx wrangler@4.131.1 deploy` with `wrangler.json`.
The build generates security/cache headers and refuses more than 20,000 files,
assets over 25 MiB, Worker scripts, resource bindings or build hooks. Pages Free
can also serve this artifact. See [the deployment runbook](docs/free-hosting.md).
Only `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` reach the browser — the
secret key and the database password stay in `.env.local`, which is gitignored
and must remain so.

The Supabase **redirect allow-list** must include the deployed origin. Google
OAuth is the default zero-mail-provider path. Existing public password signup/reset
uses Brevo SMTP, verified on Free with 300 emails/day and no saved payment method
on 11 September 2026. Recheck the plan before changing providers; the built-in
Supabase sender is testing-only. Email confirmation remains required.

CI needs five repository secrets: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `SUPABASE_DB_PASSWORD` and `SUPABASE_PROJECT_REF`. The
first two are what the browser gets anyway; the last three are why `full` can
reach the database tier and `deployed` can sign an account in rather than
stopping after the headers. The secret key stored there should be one minted
for CI and used nowhere else, so that revoking it costs nobody their afternoon.

`ICE_SERVERS` is optional and accepts **STUN only**. The build rejects TURN URLs
and credentials. Unset, a pair gets two public STUN servers and the ones whose
NAT refuses to be discovered relay over their own private Realtime channel.

Read [FREE_TIER_BUDGET.md](FREE_TIER_BUDGET.md) before deploying. Quota exhaustion
must restrict service, never trigger a paid upgrade. Private-repository Actions
jobs default to disabled; set `FBWG_ZERO_DOLLAR_ACTIONS=1` only after verifying
the account's $0 stop-spend budget. Local tests do not need hosted CI. The
optional verifier may be unavailable while ordinary play and progress continue;
never accept unverified leaderboard scores to work around that.

The [before/after benchmark table](BENCHMARKS.md) records browser frame/render
times, real visual position updates, input latency proxies, CPU/heap and relay
traffic. The authoritative simulation remains 26 Hz; renderer-only snapshots
present motion at the display callback rate. Local visual extrapolation is
bounded and adds no simulation-tick input delay. Run `npm run bench:render`
and `npm run test:network-conditions` to reproduce the measurements/tests.

## A note on the art

This ships art extracted from a commercial game, and the deployment is now
open: anybody who confirms an email address can play. The invite gate that used
to stand in front of that is gone by choice, not by accident.

It never limited exposure as much as it looked like it did. It decided who could
have an ACCOUNT, never who could fetch a file, and the bundle, the sprites and
the audio were always public static objects to anyone who knew the URL. Removing
it changes how many people are likely to arrive, not what is reachable. The
deployment still asks not to be indexed, which is a request to crawlers rather
than a control.

Production source maps are off, so the source is no longer served alongside
them. Restricting the assets themselves needs a deployment-level control that
does not exist here yet. Worth settling before this goes anywhere more public
than it already is.
