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

## Deploying

Static, on Vercel: `npm run build`, output `app/dist`, no server in the request
path. Only `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` reach the browser — the
secret key and the database password stay in `.env.local`, which is gitignored
and must remain so.

Two things live in the Supabase dashboard and cannot be set from here: the
**redirect allow-list** must include the deployed origin, and **custom SMTP**
must be configured, because the built-in sender is a few messages an hour and is
documented as being for testing.

## A note on the art

This ships art extracted from a commercial game. The repository is private, the
app is invite-gated, and the deployment asks not to be indexed. Worth revisiting
before it goes anywhere public.
