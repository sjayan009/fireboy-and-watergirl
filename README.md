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

Sign-up needs an invite code, email verification is required, and two-factor is
optional. The gate is not on sign-up — it cannot be, that is Supabase Auth
running in a browser — but on `claim_username`, which redeems the code and
creates the profile in one statement. An account with no profile cannot be
found, befriended, or reach a row of anybody else's data.

```bash
npm run invite -- --uses 5 --days 30 --note "for the group chat"
npm run invite -- --list
```

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
| the app | the emailed links, the invite gate, two-factor, and two people playing |

What is **not** tested here: that email actually arrives, and real NAT traversal
between two physical networks. Both need something this machine does not have.

`npm run test:deployed` is the other tier, and it runs itself: the build stamps
`dist/version.txt` with the commit, and the `deployed` workflow waits for that
commit to be the one answering on the live origin before asserting against it.
Waiting for anything softer means passing against the previous release when a
build fails, which is a green check for a deployment that never happened.

## Deploying

Static, on Vercel: `npm run build`, output `dist/` at the repository root (the
default the deploy already looks in), no server in the request
path. Only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` reach the browser — the
secret key and the database password stay in `.env.local`, which is gitignored
and must remain so.

Two things live in the Supabase dashboard and cannot be set from here: the
**redirect allow-list** must include the deployed origin, and **custom SMTP**
must be configured, because the built-in sender is a few messages an hour and is
documented as being for testing. Both are done. The allow-list is proved on
every release -- `test:deployed` signs a real account in against the live
origin, which would fail without it. That an email *arrives* is still the one
thing nothing here can check.

CI needs five repository secrets: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `SUPABASE_DB_PASSWORD` and `SUPABASE_PROJECT_REF`. The
first two are what the browser gets anyway; the last three are why `full` can
reach the database tier and `deployed` can sign an account in rather than
stopping after the headers. The secret key stored there should be one minted
for CI and used nowhere else, so that revoking it costs nobody their afternoon.

`ICE_SERVERS` is optional: a JSON array of `RTCIceServer`, for adding TURN
without a release. Unset, a pair gets two public STUN servers and the ones whose
NAT refuses to be discovered relay over their own Realtime channel instead.

## A note on the art

This ships art extracted from a commercial game. The repository is private, the
app is invite-gated, and the deployment asks not to be indexed. Worth revisiting
before it goes anywhere public.
