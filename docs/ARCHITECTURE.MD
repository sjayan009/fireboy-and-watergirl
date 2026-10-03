# Architecture

How *Fireboy & Watergirl: The Forest Temple* — a 2009 Flash game with no
surviving source — became a deterministic TypeScript engine, a rollback netcode,
a static single-page app, a Postgres database that enforces its own rules, and an
isolated worker that decides whether a score is real.

This document is the map. It says what each part is, why it has the shape it
has, and where the seams are. The runbooks live elsewhere and are linked from
each section: [`README.md`](../README.md) for the project as a whole,
[`app/README.md`](../app/README.md), [`supabase/README.md`](../supabase/README.md),
[`engine/PORT.md`](../engine/PORT.md), [`worker/README.md`](../worker/README.md),
[`docs/free-hosting.md`](free-hosting.md) and
[`docs/production-play-release.md`](production-play-release.md).

**Contents**

1. [System context](#1-system-context)
2. [Provenance: from one binary to a repository](#2-provenance-from-one-binary-to-a-repository)
3. [The engine](#3-the-engine)
4. [Determinism, and what it buys](#4-determinism-and-what-it-buys)
5. [Netcode](#5-netcode)
6. [The application](#6-the-application)
7. [Data model and the database as the boundary](#7-data-model-and-the-database-as-the-boundary)
8. [Progress: two peers, one row](#8-progress-two-peers-one-row)
9. [Ranked play and the verifier](#9-ranked-play-and-the-verifier)
10. [Spectating](#10-spectating)
11. [Assets and the build pipeline](#11-assets-and-the-build-pipeline)
12. [Deployment and CI](#12-deployment-and-ci)
13. [Testing architecture](#13-testing-architecture)
14. [Security model](#14-security-model)
15. [Known limits and open gates](#15-known-limits-and-open-gates)
16. [Appendix: file map, numbers, glossary](#16-appendix-file-map-numbers-glossary)

---

## 1. System context

Five things run, and only two of them are always on. The browser holds the
simulation; Supabase holds identity, relationships and progress; the CDN holds
static bytes; a worker somewhere else re-executes replays; and the pair's own
peer connection carries the game itself and touches none of the above.

```mermaid
flowchart TB
    subgraph Client["Browser — one per player"]
        APP["App shell<br/>routing, auth, lobby, UI"]
        ENG["Engine<br/>Box2D + Flash shim + game"]
        IDB[("IndexedDB<br/>progress outbox<br/>ranked outbox")]
        APP --- ENG
        APP --- IDB
    end

    subgraph Peer["Browser — the other player"]
        APP2["App shell"]
        ENG2["Engine"]
        APP2 --- ENG2
    end

    CDN["Static origin (Cloudflare Workers)<br/>bundle + 27 MB of extracted art"]
    subgraph SB["Supabase project"]
        AUTH["Auth<br/>email + optional TOTP"]
        PG[("Postgres<br/>public + play_private<br/>row level security")]
        RT["Realtime<br/>private channels"]
    end
    WK["Replay verifier<br/>Node worker threads in Docker<br/>on a free VM"]

    Client -->|"HTTPS, one round trip"| CDN
    Peer --> CDN
    Client -->|"PostgREST + JWT"| PG
    Client --> AUTH
    Client <-->|"presence, invites, signalling"| RT
    Peer <--> RT
    ENG <==>|"WebRTC data channel — 3 bits per player per frame"| ENG2
    ENG -.->|"or relayed through the pair topic when NAT refuses"| RT
    WK -->|"scoped LOGIN role, inherits fbwg_verifier only"| PG
```

Three properties fall out of that picture and explain most of the decisions
below:

* **No server in the request path.** Every page is a file. There is no
  server-rendered route, no middleware, no serverless function. A project whose
  entire point is latency cannot afford a region hop in front of a login form.
* **The database is the boundary, not the UI.** Auth runs in the browser
  against Supabase; what a signed-in account may *do* is decided by row level
  security and `security definer` functions in Postgres, and proved through the
  real API from a third account.
* **The game itself is peer to peer.** A pair on a direct connection exchanges
  about 700 bytes a second with each other and nothing with anybody. The pairs
  whose NAT refuses a direct connection relay through the Realtime channel they
  already had, which is why there is no TURN server anywhere in this design.

---

## 2. Provenance: from one binary to a repository

There was no source code. `Fireboy & Watergirl - The Forest Temple.swf` — 2 MB,
committed at the repository root — is the only input everything else was derived
from, which is why it stays in version control.

```mermaid
flowchart LR
    SWF["Forest Temple.swf<br/>2 MB, AVM2 bytecode + library"]

    subgraph Readers["tools/ — Python, run once, not in any build"]
        ABC["swfabc.py<br/>constant pool, classes, method bodies"]
        DIS["disasm.py<br/>AVM2 operand shapes"]
        LV["extract_levels.py<br/>walks method 782's if/else chain"]
        PSL["parse_source_levels.py<br/>independent path via JPEXS source"]
        SYM["extract_symbols.py<br/>frame counts + named children"]
        BTN["extract_buttons.py<br/>DefineButton2 up/hit states"]
        TXT["extract_text.py<br/>35 DefineEditText fields"]
        EXP["export_assets.py<br/>JPEXS sprite:png + sprite:svg"]
    end

    subgraph Generators["tools/ — emit TypeScript"]
        A2T["as3_to_ts.py<br/>Box2DFlash 2.0.2 → box2d.ts"]
        GS["gen_symbols.py<br/>→ flash/symbols.ts"]
        GG["gen_game.py<br/>level.as + ContactListener.as → game/game.ts"]
    end

    OUT["extracted/<br/>levels, entities, symbols.json,<br/>assets/ (sprites, sounds, text, buttons, fonts)"]
    TS["engine/src/<br/>generated + hand-written TypeScript"]

    SWF --> ABC --> DIS
    SWF --> EXP
    ABC --> LV --> OUT
    LV -. "cross-checked against" .-> PSL --> OUT
    ABC --> SYM --> OUT
    ABC --> BTN --> OUT
    ABC --> TXT --> OUT
    EXP --> OUT
    OUT --> GS --> TS
    ABC --> A2T --> TS
    ABC --> GG --> TS
```

Two things about this pipeline are load-bearing.

**The level grids were recovered twice, by different routes.**
`extract_levels.py` walks raw AVM2 bytecode — tracking the most recent
mode/level guard and running a tiny stack machine over `pushbyte`/`dup`/
`constructprop Array`. `parse_source_levels.py` walks JPEXS-decompiled
`level.as` with a brace-tracking scanner. Two independent derivations that agree
is the only available substitute for a source of truth.

**Generated files are never hand-edited.** `box2d.ts` (10,924 lines),
`flash/symbols.ts` (3,646 lines) and `game/game.ts` (4,979 lines) are outputs.
The reason is not tidiness: it keeps the port on the exact physics build the
original shipped — Box2DFlash 2.0.2, whose solver behaves differently from any
modern Box2D — and makes the whole port reviewable as a diff when a generator
changes. AS3 *is* ECMAScript, so the translation is close to a syntactic
rewrite; [`engine/PORT.md`](../engine/PORT.md) enumerates the handful of places
where it is not, each of which is a silent-wrong-answer bug rather than a
compile error.

Python is not needed to build, run, test or deploy anything. `npm install` is
the whole toolchain; `tools/` is how the repository came to exist.

---

## 3. The engine

`engine/` is the simulation, the renderer and the netcode. It has no network
client, no account, no storage of its own, and it runs in Node — which is what
makes the headless tests, the soak and the replay verifier possible at all.

```mermaid
flowchart TB
    subgraph L4["Hosts — drive a session"]
        GH["net/gamehost.ts<br/>the real Game: menus, pause tray, results board"]
        LH["net/levelhost.ts<br/>a bare level, for tests and replays"]
    end
    subgraph L3["Netcode"]
        SESS["net/session.ts<br/>rollback + lockstep, 1207 lines"]
        SNAP["net/snapshot.ts<br/>reflective capture/restore"]
        PROTO["net/protocol.ts<br/>2 packet kinds, epochs"]
        TRANS["net/transport.ts<br/>send / onMessage / onClosed / rttMs"]
        CONN["net/connect.ts — webrtc, else relay"]
        BC["net/broadcast.ts"]
        RTC["net/webrtc.ts"]
    end
    subgraph L2["Game"]
        GAME["game/game.ts — GENERATED<br/>level + ContactListener"]
        SAVE["game/save.ts — SaveStore interface"]
        SIN["game/shellinput.ts — keyboard/menu intent"]
        HL["game/headless.ts"]
    end
    subgraph L1["Platform shims"]
        FLASH["flash/flash.ts<br/>display list, ENTER_FRAME, SoundBus"]
        SYMS["flash/symbols.ts — GENERATED<br/>107 library symbols"]
        BOX["box2d/box2d.ts — GENERATED<br/>Box2DFlash 2.0.2"]
        TRIG["box2d/dettrig.ts<br/>deterministic sin/cos/atan2"]
        RNG["net/rng.ts — seeded scenery"]
    end
    subgraph L0["Presentation — outside the simulation"]
        SPR["render/sprites.ts"]
        FILT["render/filters.ts"]
        FONT["render/fonts.ts"]
        DBG["render/debugdraw.ts"]
        AUD["audio/player.ts"]
        EMB["embed.ts — GameView, 640x480"]
    end

    L4 --> SESS
    SESS --> SNAP
    SESS --> PROTO
    SESS --> TRANS
    CONN --> TRANS
    BC --> TRANS
    RTC --> TRANS
    L4 --> GAME
    GAME --> FLASH
    GAME --> BOX
    BOX --> TRIG
    GAME --> RNG
    GAME --> SAVE
    FLASH --> SYMS
    EMB --> SPR
    EMB --> AUD
    SPR --> FLASH
```

The important line in that picture is the one between L1–L2 and L0. **Rendering
and audio read the scene graph; they never write it.** The simulation is
complete without them, which is why a headless Node process and a browser reach
the same world — and why the renderer can be swapped, the debug draw turned on,
or the whole thing run at a thousand frames a second in a soak test.

`SoundBus` is the seam for audio: the game queues sounds into it during a frame,
and the host decides whether to play them. That decision is what stops rollback
sounding like a machine gun (§5).

### The Flash shim

`flash/flash.ts` (631 lines, hand-written) is the smallest Flash display API the
game actually uses: a display list with `addChild`/`getChildByName`, playheads
and `currentFrame`, `ENTER_FRAME` dispatch through `enterFrameTree`, mouse
events, and the sound bus. It matters that playheads are real: `level.as` reads
the exit door's `currentFrame` to decide whether a level is complete, so the
frame counts recovered from the SWF by `extract_symbols.py` are simulation
state, not decoration.

---

## 4. Determinism, and what it buys

**The simulation is a pure function of `(mode, level, input log)`** — verified
across V8, SpiderMonkey and JavaScriptCore, which agree on digest `aba863c1`
after 600 frames.

Everything downstream is bought with that one property:

| Property | What it enables |
|---|---|
| Same inputs → same world | Netcode exchanges 3 bits per player per frame and never state |
| Replaying is cheap and exact | Rollback: rewind, re-simulate, correct before anyone sees it |
| A third party can re-derive a result | The replay verifier, and therefore a leaderboard that means something |
| A watcher fed the input log arrives at the same world | Spectating costs the players nothing to compute |
| A digest pins a level | 32 level digests in CI catch a physics change nobody intended |

Four hazards get explicit machinery, because each is a silent divergence rather
than an error:

* **Trigonometry.** `box2d/dettrig.ts` replaces `Math.sin`/`cos`/`atan2`, whose
  results are implementation-defined in the last bits. `trigcheck.ts` measures
  the port against `Math.*` so the substitution is a known quantity.
* **Scenery randomness.** `level.as` calls `Math.random()` ten times per level —
  fireflies, which of `GroundBox1..4` draws each tile, decor rotation. None of it
  reaches physics, so it never showed in the state digest, and it is exactly why
  two peers would look at visibly different levels and reasonably conclude they
  had desynced. `net/rng.ts` seeds an LCG from `(mode, level)`. Every operation
  is a 32-bit integer op plus one divide by 2^32 — an earlier LCG used
  `s * 1103515245`, exceeded 2^53, and silently produced different numbers per
  host.
* **Float comparison.** `net/hash.ts` hashes the *exact IEEE-754 bits* of every
  value, walking bodies in Box2D world-list order (creation order, identical on
  both peers). Rounding before hashing would hide the one-ulp drift that is the
  entire quarry.
* **Effects outside the simulation.** Sound and save writes must happen on a
  frame's *first* run only. `step` is told whether it is replaying.

---

## 5. Netcode

Two modes live in `net/session.ts`. Lockstep is still in the box and still
tested; rollback is what plays.

### Why rollback, with numbers

Lockstep runs a frame only when both players' input for it is known, so a peer
decides its input for frame `F + delay` and sends it ahead — no stalls, but a
constant ~115 ms between pressing a key and seeing your own character move at
26 Hz and delay 3. Rollback applies your input to the very next frame and
*guesses* the peer's as "whatever they were doing last", which in a platformer
where keys are held for many frames is right almost every time.

It is affordable here for a measured reason:

| | cost |
|---|---|
| One frame of physics, re-simulated | **~0.04 ms** |
| One full snapshot | **~4.7 ms** |
| Frame budget at 26 fps | **38.5 ms** |

A snapshot is a hundred times dearer than a re-simulated frame. That inverts the
textbook design: instead of a ring of per-frame snapshots, there is **one**
snapshot, taken at a frame both players' real input has settled, and every
correction rewinds to it and re-simulates forward. It is refreshed only once it
has fallen `snapLag` frames behind the settled frontier — one capture per eight
frames rather than eight, and **1.4 MB of memory instead of 17 MB**.

```mermaid
sequenceDiagram
    autonumber
    participant U as Local player
    participant S as NetSession
    participant W as World
    participant P as Peer

    U->>S: press right (frame 100)
    S->>W: step(100) with my real input + peer's PREDICTED input
    Note over S,W: shown immediately — zero input delay
    S-->>P: input packet {epoch, frame 100, last 16 frames of bits}
    P-->>S: input packet {epoch, frame 98, ...}
    alt prediction for frame 98 was right
        S->>S: advance confirmed frontier, nothing to redo
    else prediction was wrong
        S->>W: restore the single snapshot (frame <= 98)
        loop each frame from the snapshot to now
            S->>W: step(f) replaying = true
            Note right of W: sound suppressed,<br/>save writes suppressed
        end
        S->>W: step(now) replaying = false
    end
    S->>S: every N frames, hash the world and exchange the digest
```

Solo play runs through this same session with a `NullTransport`. Single-player
and netplay are one code path, so a bug in either shows up in both.

### The snapshot

`net/snapshot.ts` is a generic reflective walk, not a hand-written Box2D
serialiser — because the state that matters is not only Box2D's. Display-tree
playheads gate level completion, the contact listener counts diamonds, and the
level's own flags decide whether anyone has died. A walk reaches all of it
without being told about any of it.

It **restores in place**: hard references to the same object instances, field
values written back into them, never a rebuilt graph. That is what keeps
`game.m_level`, the renderer's per-node caches and every Box2D cross-reference
valid across a restore; it is also why objects created since the snapshot vanish
correctly (nothing references them once the arrays are rewritten) and objects
destroyed since it come back (the snapshot was still holding them).

The storage layout was the difference between 11.3 ms and 4.7 ms per capture. A
census found 26,000 objects but only ~107,000 fields — the cost was ~105 ns of
per-field overhead, not the state. `Object.keys()` allocating 26,000 arrays a
frame became `for...in` into a cached list; a `Map.get` per object-valued field
became a non-enumerable generation stamp; one mixed `any[]` became typed arrays
with booleans, `null` and `undefined` encoded as payload-free tags. Functions and
anything in `FOREIGN` — images, audio nodes, promises, DOM — are opaque
references, never walked.

### The wire format

Two packet kinds, both tiny. A player's whole input is **three bits** — left,
right, up — so an input packet carrying a 16-frame window fits in 34 bytes and a
session costs about 700 bytes a second *including* the redundancy.

```mermaid
flowchart LR
    subgraph IP["InputPacket — Kind.Input"]
        direction TB
        I1["slot (0/1)"]
        I2["epoch — which build of the level"]
        I3["frame — absolute, from level start"]
        I4["bits[] — newest first, up to HISTORY=16"]
    end
    subgraph CP["CommandPacket — Kind.Command"]
        direction TB
        C1["Start (mode, level)"]
        C2["Pause"]
        C3["Retry"]
        C4["Quit"]
    end
```

That redundancy is the whole reliability strategy: **there are no
acknowledgements, no retransmission and no ordering.** A transport may lose,
duplicate and reorder freely; the next packet heals the gap. Which is why the
WebRTC data channel is deliberately configured **unreliable and unordered** —
SCTP retransmission would hold newer input behind older input that no longer
matters, and head-of-line blocking is the one thing this cannot afford.

**The epoch** exists because retry rebuilds the level and restarts the frame
count at zero. Without a generation number, a peer that has just retried files
still-in-flight packets for frames 195–201 of the level it left as frames
195–201 of the level it just started, and plays them seconds later as real
input. The symptom is a desync that appears only after a retry on a link with
any latency at all.

### Choosing a transport

```mermaid
stateDiagram-v2
    [*] --> Rendezvous
    Rendezvous: Pair channel (Realtime) or BroadcastChannel
    Rendezvous --> Offering: inviter offers, only after invitee says it is listening
    Offering --> Direct: ICE succeeds
    Offering --> Relay: ICE fails or times out
    Direct: RTCDataChannel — unreliable, unordered, ~0 server cost
    Relay: the rendezvous channel itself carries the game
    Direct --> Relay: link closes (onClosed)
    Direct --> [*]
    Relay --> [*]
```

Three `Transport` implementations satisfy one interface — `BroadcastChannel`
between two tabs, `RTCDataChannel` between two people, Supabase Realtime for the
10–20% whose NAT refuses. The session behaves identically on all three; the only
thing that changes is latency, which it measures rather than assumes.

`onClosed` is on the interface for a specific reason: silence means "nothing
arrived", and a session correctly treats that as the peer being slow, because
for a lost packet it is. A link that has actually gone never breaks that silence
— so without an explicit close signal, a dead connection and a laggy one are the
same event forever.

**Relay batching.** `FLUSH_MS = 230` in `app/src/net/realtime.ts`: leading edge,
then batched. One packet per frame per peer is ~52 messages a second, which
spends the free tier's ~2 million monthly Realtime messages in about ten hours
of play. Batching costs almost nothing because every packet already repeats
sixteen frames and rollback absorbs the later arrival by predicting. Commands
and signalling bypass the batch — they unblock the next action and must not wait
behind input.

---

## 6. The application

`app/` is a static single-page app with no UI framework: six forms and a canvas,
about 12 kB on top of the engine.

### Five gates

`auth.ts` resolves every session to one of five stages, plus a sixth that is not
a gate at all.

```mermaid
stateDiagram-v2
    [*] --> out
    out --> unverified: sign up
    unverified --> nameless: email link followed
    out --> locked: sign in, TOTP enrolled
    locked --> nameless: code answered
    locked --> out: recovery code — turns 2FA OFF
    nameless --> in: claim_username redeems an invite code
    out --> in: sign in, profile exists
    in --> out: sign out / delete_me
    unavailable: could not find out which gate they are at
    out --> unavailable: lookup failed
    locked --> unavailable: assurance lookup failed
    nameless --> unavailable: profile query failed
    unavailable --> out: retry
```

`unavailable` is a stage because every failure used to be reported as a benign
answer. A failed assurance lookup returned `false` — "no second factor is owed" —
so a Supabase incident would let an enrolled account past the code prompt. A
failed profile query returned `null` — "no profile" — so the same incident sent
an established player to the username form asking for an invite code they no
longer had. Both are the wrong direction to fail in and both were
indistinguishable from the truth.

**Every one of these gates is also enforced in Postgres.** The router decides
what to *draw*; `has_profile()`, `assurance_satisfied()` and `caller_allowed()`
decide what is *allowed*. Bypassing the SPA reaches nothing.

Routing is hash-based (`#/play`, `#/settings`) precisely because the app is
static: a deep link to `/settings` would need a rewrite rule and a serverless hop
to answer, and a deep link to `#/settings` needs neither. Each route declares the
stages that may see it; anything else is redirected to that stage's home.

### Module map

```mermaid
flowchart TB
    MAIN["main.ts — resolve auth, then route"]
    ROUTER["router.ts — stage-gated hash routes"]
    AUTH["auth.ts — 5 stages + unavailable"]
    SUPA["supabase.ts — the one client, publishable key only"]

    subgraph Screens
        ACC["screens/accounts.ts"]
        PLAY["screens/play.ts — 1433 lines, the controller"]
        FR["screens/friends.ts"]
        SET["screens/settings.ts"]
        WATCH["screens/watch.ts"]
    end
    subgraph State
        PC["playstate.ts — PlayController"]
        LEASE["matchlease.ts — Web Locks"]
        PS["pairsave.ts + outbox.ts — IndexedDB"]
        RANK["ranking.ts — ranked attempts"]
        SHARE["sharing.ts — MatchSharing consent"]
    end
    subgraph Net
        LOBBY["lobby.ts — one channel per friend"]
        PAIRCH["net/pairchannel.ts — pair:lo:hi"]
        RTT["net/realtime.ts — Transport over Realtime"]
        SCOPE["net/scope.ts — per-attempt scoping, bounded decode"]
        WCH["net/watchchannel.ts — watch:match:feed"]
        MIRROR["net/watch.ts — WatchMirror"]
    end
    SHELL["ui/playshell.ts — viewport + drawer"]
    ENGINE["@engine/embed.ts — GameView"]

    MAIN --> AUTH --> SUPA
    MAIN --> ROUTER --> Screens
    PLAY --> SHELL
    PLAY --> ENGINE
    PLAY --> PC
    PLAY --> LEASE
    PLAY --> PS
    PLAY --> RANK
    PLAY --> SHARE
    PLAY --> LOBBY --> PAIRCH
    PAIRCH --> RTT --> SCOPE
    PLAY --> MIRROR --> WCH
    WATCH --> WCH
```

### The lobby handshake

The lobby holds one open Realtime channel per accepted friend — you cannot be
told a friend came online by a server you are not listening to.

```mermaid
sequenceDiagram
    autonumber
    participant A as Inviter
    participant CH as pair:lo:hi (Realtime, private)
    participant B as Invitee

    A->>CH: presence: in_lobby
    B->>CH: presence: in_lobby
    A->>CH: invite {session id, mode+level, who is Fireboy}
    CH->>B: invite
    B->>CH: accept
    Note over B: only now starts listening for a peer connection
    CH->>A: accept
    A->>CH: SDP offer (SIGNAL)
    CH->>B: SDP offer
    B->>CH: SDP answer + ICE
    CH->>A: SDP answer + ICE
    alt data channel opens
        A-->>B: direct RTCDataChannel
    else no direct connection
        Note over A,B: keep relaying over CH — one extra hop, no TURN
    end
    B->>CH: ready (its NetSession exists)
    CH->>A: ready
    A->>B: Command.Start (mode, level) — re-sent a dozen times
    Note over A,B: both simulations begin on the same frame
```

Step 3 was learned the hard way: an earlier version offered as soon as the
invitation was sent, while the invitee was still looking at a banner. The offer
arrived at a channel nobody was listening on, was dropped, and eight seconds
later every pair on the same local network "fell back" to the relay. A direct
connection cannot be negotiated with somebody who has not agreed to negotiate.

Step 4 is the same care applied to `Start` — the one message that decides which
frame both simulations begin on.

One channel carries four jobs — presence, invites, signalling, relay — because
opening a second channel on the same topic would double the connection count for
nothing. Presence announcements are throttled to `PRESENCE_MS = 8000`: Supabase
allows five presence calls per channel per thirty seconds and the sixth does not
get dropped, it takes the channel down with
`ClientPresenceRateLimitReached`.

### Attempt lifecycle and tab ownership

`PlayController` owns asynchronous attempts through an `AbortController`, so a
superseded operation can never commit:

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> configuring: pick friend, level, roles
    configuring --> inviting: send invite
    idle --> accepting: invitation arrives
    inviting --> connecting: accepted
    accepting --> connecting: sent accept
    connecting --> playing: session ready + Start
    playing --> between_levels: level ends
    between_levels --> playing: next node chosen by the inviter
    playing --> reconnecting: transport closed
    reconnecting --> playing: link restored
    reconnecting --> ended: gave up
    playing --> ended: quit / sign out / taken over
    ended --> idle
```

`MatchLease` enforces **one active match per account per browser profile** with
Web Locks, named `fbwg.match.<owner>`, coordinated across tabs by a
`BroadcastChannel`. A second tab sees "Playing in another tab" and can take over;
the losing tab cancels its attempt and says why.

### The play shell

`ui/playshell.ts` is presentation only — **opening a panel never navigates and
never destroys the game instance**, which is what lets Settings or the friends
list be read mid-match. The canvas is a fixed 640×480 stage scaled by CSS; a
`ResizeObserver` keeps the 4:3 box fitted, and the engine neither knows nor cares
how big it is drawn.

Three controls point at the same drawer region and one tab strip switches
between panels inside it. The contract:

| Control | Behaviour |
|---|---|
| **Friends / Invitation** (toolbar) | Toggles its panel — which panel it stands for follows the badge |
| **Menu** (toolbar) | Toggles the game menu |
| **Saved / Saving… / Retry needed** (footer) | Toggles Progress, and flushes pending progress on *both* presses — when the label reads "Retry needed", the press *is* the retry |
| Tab strip: Friends / Match setup / Progress | Switches only; a tab that closed the thing it is a tab of would be a different control wearing the same clothes |

Pressing one toolbar control while a *different* panel is open switches rather
than closing — that is a different gesture and worth keeping. `aria-expanded`
describes the control it is on, so only the button whose panel is actually
showing claims it, and `close()` refuses to return focus into the subtree it has
just hidden (a hidden subtree is still `isConnected`; the canvas is the honest
fallback, being what the drawer was covering).

---

## 7. Data model and the database as the boundary

Two schemas. `public` is what the browser may call; `play_private` is revoked
from `public`, `anon` and `authenticated` outright and is reachable only through
`security definer` functions or by the scoped verifier role.

```mermaid
erDiagram
    PROFILES ||--o{ FRIENDSHIPS : "user_a / user_b"
    PROFILES ||--o{ INVITE_REDEMPTIONS : redeemed_by
    INVITE_CODES ||--o{ INVITE_REDEMPTIONS : code
    PROFILES ||--o{ MFA_RECOVERY_CODES : owner
    FRIENDSHIPS ||--o{ PAIR_PROGRESS : "the pair IS the friendship"
    PROFILES ||--o{ RANKED_ATTEMPTS : "user_a / user_b"
    RANKED_ATTEMPTS ||--o| VERIFIED_RESULTS : "attempt (1:0..1)"
    ENGINE_VERSIONS ||--o{ RANKED_ATTEMPTS : engine
    FRIENDSHIPS ||--o{ MATCH_SHARING : "one row per match, revoked on unfriend"

    PROFILES {
        uuid id PK
        text username UK
        bool hide_from_leaderboard
    }
    FRIENDSHIPS {
        uuid user_a PK "enforced user_a < user_b"
        uuid user_b PK
        text status "pending accepted blocked"
        uuid requested_by
        uuid blocked_by
    }
    PAIR_PROGRESS {
        uuid user_a PK
        uuid user_b PK
        smallint node PK
        smallint medal "1..3"
        int best_time_s
        text best_time_str
    }
    RANKED_ATTEMPTS {
        uuid id PK
        uuid connection "per peer connection"
        int run
        text mode
        int level
        text engine FK
        bool registered_a
        bool registered_b
        text digest_a
        text digest_b
        text replay "<= 1 MiB, cleared when finished"
        text state "waiting queued verifying verified not_ranked"
        uuid lease
        int tries
    }
    VERIFIED_RESULTS {
        uuid attempt PK
        smallint node
        smallint medal
        int seconds
        int frames
    }
    ENGINE_VERSIONS {
        text version PK
        bool accepting "seeded with NOTHING"
    }
    MATCH_SHARING {
        uuid id PK "the match id"
        uuid user_a "enforced user_a < user_b"
        uuid user_b
        bool consent_a
        bool consent_b
        uuid feed "rotated on every revocation"
        timestamptz expires_at
    }
```

Three modelling decisions worth stating plainly:

* **The accepted friendship *is* the co-op pair.** There is no `pairs` table,
  because a pair has nothing a friendship does not. `user_a < user_b` is enforced
  by a check constraint, so a pair cannot be stored twice, and every topic name
  derives from the same canonical ordering.
* **Progress belongs to the pair, not to either player** — which is what "jump
  back in where you left off, together" actually means. It hangs off the
  friendship by foreign key, so unfriending takes the shared progress with it.
* **Private things live in a private schema.** Ranked attempts, verified
  results, engine versions, rate-limit budgets and sharing consent are all in
  `play_private`, which has no grants to any application role.

### Writes go through functions, not tables

This is the part that turns comments into predicates:

| Table | Grants | Why |
|---|---|---|
| `profiles` | **no INSERT policy at all** | The only way a profile exists is `claim_username`, which validates the name's shape, its availability, and redeems an invite code **in one statement** — so two people racing for one name, or for a code's last use, resolve to exactly one winner |
| `friendships` | **no INSERT or UPDATE grant** (since `0015`) | The old policies read like the rules and were not: INSERT never required `status = 'pending'`, so `{self, victim, accepted}` was one POST away. Four transition functions are the only way a friendship changes |
| `pair_progress` | **no INSERT, UPDATE or DELETE grant** (since `0016`) | The monotonic merge lived in `sync_progress` and the table let either member walk around it |
| `invite_codes` | **no policies for any role** | A signed-in user can neither enumerate codes nor reset their use counts |
| everything in `play_private` | revoked from every application role | Reached only through definer functions, or by `fbwg_verifier` for three specific functions |

Two rules that used to be arguments, made into predicates by `0013`:

* **A second factor is a property of the SESSION, not of the screen.** Supabase
  issues an `aal1` token for a password sign-in whether or not a factor is
  enrolled. `assurance_satisfied()` passes `aal2` always, and `aal1` only for an
  account with no verified factor. `redeem_recovery_code` is the one deliberate
  exception, because the person using one cannot reach `aal2` by definition.
* **An account with no profile is inert.** `profiles_read` used to be
  `using (true)`, so an account that never redeemed an invite could list every
  user id in the project and forge itself into a friendship. `has_profile()` is
  that claim as a predicate, in every policy and every function.

Rate limiting is `play_private.spend(action, max)` — a per-owner, per-action
counter on a one-minute window, raising `53400` past the cap (60 registrations,
30 submissions).

### The two Realtime topics

```mermaid
flowchart LR
    subgraph T1["pair:lo:hi — private"]
        P1["presence"]
        P2["invites"]
        P3["SDP / ICE signalling"]
        P4["relayed game packets"]
    end
    subgraph T2["watch:match:feed — private"]
        W1["a copy of the input already crossing the link"]
    end
    RLS1["realtime.messages policy:<br/>exactly the two members of an ACCEPTED friendship"]
    RLS2["realtime.messages policy:<br/>friends of either player,<br/>only while BOTH consent,<br/>feed id rotates on revocation"]
    T1 --> RLS1
    T2 --> RLS2
```

Two topics and two policies, deliberately not one channel: the pair's own topic
carries their invitations and signalling and is readable by exactly the two of
them; the watch topic carries a copy of input and is readable by a wider
audience. There is no path from the second to the first.
`supabase/realtimetest.mjs` proves a third account is refused from one and a
fourth admitted to the other.

### Migration discipline

`migrate.mjs` connects straight to Postgres — no CLI, no Docker — records the
SHA-256 of every file it applies, and **fails hard if an applied migration's
digest changes**, printing both. It takes a Postgres advisory lock for the whole
run so two runners queue rather than racing. TLS verification is mandatory
against a pinned root (`supabase/certs/prod-ca-2021.crt`); there is no way to
turn it off.

The rule that shapes every migration:

> **A migration must survive the release before it.** `deployed` applies
> migrations *before* it waits for Workers, and Workers builds on push, so for a
> few seconds either release may be talking to either schema.

Add before you read; widen before you narrow; split anything that removes or
tightens across two releases. `supabase/deferred/` is where the second half
waits — the runner does not read it, and a file is "applied" by being moved into
`migrations/` once the release it was waiting for is verifiably live.
`20260906000000_watch_topic_contract.sql` is sitting there now: the narrowing of
the watch topic contract, gated on the promoted client (see §15).

---

## 8. Progress: two peers, one row

Both peers compute the identical result — that is what determinism buys — so
both will try to write it. Rather than electing a writer, the merge is made
**idempotent and monotonic**: a medal never goes down, a time is only replaced by
a faster one, and two peers racing converge on the same row whichever order they
arrive in.

Canonical solo data belongs to `solosave.ts`; the engine receives a separate
projection from `pairsave.ts`. Shared canonical results are merged only at
confirmed frontiers. Prediction/rollback can change the projection without
rewinding durable data or publishing an achievement. The Progress panel reads
canonical data, while solo cloud responses reach a live engine only at a safe
menu/release boundary. See [the implementation record](IMPLEMENTATION_RESULTS_17.md)
for the ownership, failure and lifecycle regression coverage.

```mermaid
sequenceDiagram
    autonumber
    participant G as Engine (Recuent)
    participant PS as pairsave.ts
    participant OB as IndexedDB "fbwg.progress"
    participant RPC as sync_progress()
    participant PP as pair_progress

    G->>PS: confirmed results — stats/times/timesString (32 each)
    PS->>PS: merge with canonical pair state
    PS->>OB: remember{owner, friendId, revision} (transactional)
    PS->>PS: settle delivery 1500 ms; two independent bounded lanes
    PS->>RPC: POST /rest/v1/rpc/sync_progress (token re-checked first)
    alt HTTP success
        RPC->>PP: monotonic merge — medal max, time min
        PS->>OB: acknowledge(revision) — deletes ONLY that revision
    else offline / error
        Note over PS,OB: the row stays and the save status offers the retry
        PS->>PS: drainOutbox() at the next authenticated moment
    end
```

Five details that are each a bug that happened:

* **The outbox is account-owned.** Every pending row carries `owner`, and
  `post()` re-reads the session immediately before the request — auth can change
  in another tab, and a result must never be written by whoever happens to be
  signed in when the retry fires. Ownerless legacy rows are quarantined, not
  replayed.
* **Acknowledgement is by revision.** A late acknowledgement for an older
  revision cannot delete a newer result; the browser test exercises exactly that
  against real IndexedDB.
* **Deletion requires a successful HTTP response**, not merely the absence of a
  thrown error.
* **The save status is a control.** "Saved" / "Saving…" / "Retry needed" is a
  button that flushes, so the retry is always one press away (§6).
* **Failures are scoped to a pair and revision.** Transient failures retry with
  bounded backoff; permanent refusals remain quarantined for explicit retry or
  export. Storage failure retains canonical results in memory and retries them
  even when the run stays paused or on results. A full quota is shown separately
  from a cloud-delivery error.

---

## 9. Ranked play and the verifier

Before this release, the leaderboard recorded whatever a client said it had
achieved: `public.leaderboard()` was a projection of `pair_progress`, which is
client-reported by construction. It still exists and is still granted, and it is
no longer what the board reads.

A score now has to survive four independent checks:

```mermaid
sequenceDiagram
    autonumber
    participant A as Player A
    participant B as Player B
    participant DB as play_private
    participant W as Verifier worker
    participant VR as verified_results

    Note over A,B: one attempt = (pair, connection, run) — unique
    A->>DB: register_ranked_attempt(peer, connection, run, mode, level, ENGINE_VERSION)
    B->>DB: register_ranked_attempt(same tuple)
    Note over DB: refuses unless the engine version is in engine_versions AND accepting
    DB-->>A: attempt id
    DB-->>B: attempt id
    A->>DB: submit_ranked_replay(attempt, sha256(canonical replay), replay)
    B->>DB: submit_ranked_replay(attempt, sha256(canonical replay))
    alt digests disagree
        DB->>DB: state = not_ranked, "Players acknowledged different replays", replay cleared
    else both registered and digests match
        DB->>DB: state = queued
    end
    W->>DB: claim_replay([versions this image can run]) — FOR UPDATE SKIP LOCKED
    DB-->>W: job + 30 s lease
    W->>W: fresh worker_thread: re-hash, re-parse, verifyReplay in an isolated realm
    Note over W: 60 s deadline, 256 MB old-gen heap,<br/>lease renewed every 10 s, max 3 tries
    W->>DB: finish_replay(id, lease, result)
    DB->>VR: insert medal, seconds, frames, node
    DB->>DB: state = verified, replay cleared
```

```mermaid
stateDiagram-v2
    [*] --> waiting: first registration
    waiting --> queued: both registered, digests agree, replay present
    waiting --> not_ranked: digests disagree
    waiting --> not_ranked: 12 hours elapsed — "Partner acknowledgement expired"
    queued --> verifying: worker claims a lease
    verifying --> verified: finish_replay with a result
    verifying --> not_ranked: replay refused
    verifying --> queued: lease expired, tries < 3
    verifying --> not_ranked: tries >= 3 — "Verification retry limit reached"
    verified --> [*]
    not_ranked --> [*]
```

What each layer actually guarantees:

| Layer | Guarantee |
|---|---|
| `register_ranked_attempt` | The two accounts are an accepted pair; the level exists in that mode; the engine build is one an operator has enabled; 60/min per account |
| `submit_ranked_replay` | Each player's digest is immutable once given; disagreement kills the attempt; replay ≤ 1 MiB; 12-hour expiry; 30/min |
| `replay-slot.mjs` | A fresh realm per job with **no database credentials and no shared engine globals**; re-hashes the payload against the claimed digest; refuses a replay whose engine/mode/level disagree with the attempt |
| `engine/src/verified.ts` | Reads the **actual result board**, never the personal-best save; refuses a completion whose clock text is unreadable (`Number("")` is 0 and `Number("--")` is NaN, and NaN passes every range check written as a comparison) |
| `verified_leaderboard()` | Best per pair per node; both players must not have opted out; **and the pair must still be accepted friends** |

**`ENGINE_VERSION` is derived, not declared.** `engine/scripts/version.mjs`
hashes every file under `game/`, `flash/` and `box2d/` plus `net/gamehost.ts`,
`net/hash.ts`, `net/protocol.ts` and `verified.ts` — path and content, normalised
line endings — into `temple-<32 hex>`. A replay therefore identifies the exact
build whose rules it was recorded under, and cannot be verified by a build that
would simulate it differently. `worker/versions.mjs` maps versions to engine
modules; a worker never claims a version absent from its map, and archived
modules must be added to an image *before* the old one is retired.

`play_private.engine_versions` is **deliberately seeded with nothing**, so ranked
registration refuses every engine until an operator enables one. Ordinary play,
progress and the historical leaderboard do not depend on it.

> **Operational consequence, and the answer to "where did the old runs go":**
> `verified_results` started empty at this migration and is only ever written by
> `finish_replay`. Nothing backfilled the pre-verification scores and nothing
> could — there are no replays to re-execute. The board's empty state says so:
> *"No verified results yet. Historical personal results are preserved in your
> progress."* `pair_progress` is intact, `sync_progress` still writes it, and the
> personal Best Times panel reads the game's own save data.

---

## 10. Spectating

Determinism makes a watcher nearly free: fed the two players' three bits per
frame, they arrive at the same world without either player computing anything
for it.

```mermaid
flowchart LR
    A["Inviter's transport<br/>(direct or relay)"] --> M["WatchMirror<br/>copies BOTH directions"]
    M -->|"batched, only while shared"| WC["watch:match:feed"]
    WC --> V1["Watcher 1 — MemorySave"]
    WC --> V2["Watcher 2 — MemorySave"]
    CONSENT["play_private.match_sharing<br/>consent_a AND consent_b"] -.->|"authorises the topic;<br/>feed id rotates on revocation"| WC
    UNFRIEND["unfriend / block"] -.->|"trigger revoke_pair_sharing"| CONSENT
```

* **Only the peer who sent the invitation mirrors.** Two mirrors would double the
  message count for packets a watcher already has — received input only ever
  fills gaps.
* **The mirror wraps the transport**, because a pair on a direct connection
  produces nothing a server could carry. It copies what this peer sends *and*
  what it receives, so one mirror carries both players.
* **Nothing is published until the pair turns watching on.** A game nobody has
  asked to share costs exactly zero messages.
* **A watcher who arrives mid-level waits for the next one.** Catching up would
  mean sending the whole input history to anybody who asks; starting from
  wherever the pair is now would simulate a world that never existed and call it
  their game.
* **Watching cannot touch the watcher's own save.** The view is handed a
  `MemorySave` that goes when the screen does.

The consent is server-side and the topic name carries a rotating feed id, so
"stop letting friends watch" is something a server enforces rather than a local
boolean. Before this release the topic was derived from the two user ids, which
meant anybody who could name the pair could name the topic. Until the deferred
narrowing is applied, both shapes are still accepted (§15).

---

## 11. Assets and the build pipeline

```mermaid
flowchart LR
    EX["extracted/ — 164 MB on disk<br/>the source of truth, committed"]
    RAW["extracted/assets/_raw/<br/>116 MB of JPEXS intermediates<br/>EXCLUDED from every build"]
    subgraph BUILD["npm run build"]
        E1["engine: version.mjs then tsc → engine/dist"]
        V1["vite build → dist/ at the REPO ROOT"]
        A1["app/scripts/assets.mjs"]
    end
    DIST["dist/<br/>~846 kB JS+CSS · 27.8 MB art and audio<br/>version.txt = the commit"]
    CHK["app/scripts/check.mjs"]

    EX --> A1
    RAW -. never .-> DIST
    E1 --> V1 --> DIST
    A1 -->|"PNG → WebP q80 effort 4"| DIST
    A1 -->|"decoded WAV → the ORIGINAL compressed stream"| DIST
    DIST --> CHK
```

Both asset transforms were measured rather than assumed:

* **Sprites: PNG → WebP, quality 80, effort 4** — 72–80% smaller on this art.
  Effort 6 cost *nineteen times* the encode time for 4% smaller files: 0.2 MB
  across the whole set against seventeen minutes of a two-core CI runner. Nobody
  takes that trade knowingly; it gets taken by leaving a default alone.
* **Audio: prefer the original compressed stream.** `sounds/` already holds what
  JPEXS pulled out of the SWF; `sounds_wav/` holds it decoded, and the player had
  been fetching those. Preferring the original takes the 17 sounds from 1.90 MB
  to 0.34 MB with no encoder involved. Two sounds came from FLV and keep their
  decoded WAV, because no browser plays FLV.

Source art/audio under `extracted/` retain their original format. The build also
generates `levels.json` there using an offline all-level dependency oracle;
runtime preparation reads it without constructing another physics world.
Critical common/level art forms the playable barrier and decorative work follows
in the background. Resource owners, priorities, cancellation and bounded cold
retention keep abandoned preparations from consuming unlimited work. A measured
character atlas prototype stays opt-in because it increases transfer and decoded
memory despite reducing request count.

**Cache identity.** The deployment serves `/extracted/assets/*` with
`max-age=31536000, immutable`, and the names under it are stable — `sprites.json`
is `sprites.json` in every release. Those two facts are incompatible unless the
URL changes when the assets do, so `app/scripts/release.mjs` derives
`?v=<digest>` from SHA-256 of every source asset's bytes, pipeline/encoder/layout
settings, native codec versions, generator source and atlas rollout mode. Same-size edits therefore
change release identity. Production sprite/dependency manifests agree on their
content identity and include atlas source rectangles/fallbacks when enabled.
`engine/src/asseturl.ts` joins paths onto the release-marked base.

**`check.mjs` is the gate before anything ships**, and asks three questions no
other test does: did a secret get into something the browser downloads; does
every asset the manifests name exist in the format they now claim; and has the
bundle quietly grown past its 860 kB budget (the 17-improvement release measured approximately 846 kB).

---

## 12. Deployment and CI

```mermaid
flowchart TB
    PUSH["git push"]
    subgraph GH["GitHub Actions"]
        FAST["fast — every push<br/>engine · verifier · build · check · lint"]
        FULL["full — Tue/Fri 04:23 UTC<br/>schema → engine / database / application"]
        DEP["deployed — after a release<br/>build+check → migrate → WAIT → test:deployed"]
        KA["keepalive — daily 06:40<br/>touch the database"]
        HOSTED["network-hosted — manual<br/>TURN + local hosted migration"]
        REMOTE["network-remote — manual<br/>runner + Browserbase migration"]
        PR["worker-image — on demand<br/>docker build"]
    end
    WORKERS["Workers Git integration — builds on main push<br/>npm run build, wrangler deploy --assets=./dist"]
    VERCEL["Vercel — branch Preview<br/>PathManager and test hooks only there"]
    LIVE["Static origin + CSP, X-Robots-Tag: noindex"]
    SUPA[("Supabase project")]
    VM["Free Linux VM — docker compose up worker"]

    PUSH --> FAST
    PUSH --> WORKERS --> LIVE
    PUSH -. branch preview .-> VERCEL
    PUSH --> DEP
    DEP -->|"npm run db:migrate"| SUPA
    DEP -->|"poll /version.txt until it is THIS commit"| LIVE
    FULL --> SUPA
    HOSTED --> SUPA
    REMOTE --> VERCEL
    REMOTE --> SUPA
    KA --> SUPA
    PR -.->|"image, installed by hand"| VM
    VM --> SUPA
```

The waiting is the interesting part. Workers Git integration builds on its own schedule and the
workflow starts on the same push, so the two race. `deployed` proves the release
*builds*, applies migrations, then **polls the live origin until `/version.txt`
is this commit** before asserting anything against it. Waiting for anything
softer means passing against the previous release when a build fails — a green
check for a deployment that never happened.

`full` and `deployed` share one concurrency group, and `migrate.mjs` takes a
Postgres advisory lock, so a manual run from a terminal is safe too.

**What reaches the browser:** `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, plus
optional `ICE_SERVERS`. `vite.config.ts` names those three explicitly rather than
relying on Vite's `VITE_` convention, so a mis-prefixed secret still cannot reach
the bundle. Forks and Dependabot get no secrets, so `FBWG_PLACEHOLDER_ENV=1`
substitutes obvious placeholders — only when something asks for them, so a real
deploy that has genuinely lost its configuration still fails rather than shipping
a bundle pointed at nowhere. Production source maps are off (`FBWG_SOURCEMAPS=1`
puts them back), because a shipped source map *is* the source.

**Response headers** come from `vercel.json`: a CSP with `default-src 'self'`
and `connect-src` limited to `'self'` plus `*.supabase.co` (and `wss:`),
`frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, a `Permissions-Policy` that turns camera,
microphone and geolocation off, and `X-Robots-Tag: noindex, nofollow`.

Five repository secrets: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`. The CI
secret key should be one minted for CI and used nowhere else, so revoking it
costs nobody their afternoon.

The worker is not deployed by any of this. It is a Docker image run by hand on a
free VM with a dedicated LOGIN role that inherits **only** `fbwg_verifier` — not
the service key, not an administrator login — with a small connection limit and
the same pinned CA. It exposes no inbound ports.

---

## 13. Testing architecture

Two tiers, because a suite people stop waiting for stops being run.

```mermaid
flowchart LR
    subgraph FASTT["npm test — no browser, no credentials"]
        T1["engine suite"]
        T2["test:servers — path containment"]
        T3["test:docs — names resolve"]
        T4["build + check + lint"]
    end
    subgraph ALL["npm run test:all"]
        T5["engine test:full — soak, goldens, cross-engine"]
        T6["db:test — RLS, MFA matrix, races, realtime"]
        T7["app:test — accounts, production, two people"]
    end
    subgraph MAN["manual / on demand"]
        T8["test:play — three browsers, four laptop sizes"]
        T9["test:verifier — replay determinism and rejection"]
        T10["test:play-db — needs a local Supabase-shaped Postgres"]
        T11["test:deployed — against the live origin"]
    end
```

| Layer | What is actually proved |
|---|---|
| Simulation | All 32 levels pinned by digest; snapshot round-trips on every one; a soak of 640,000 frames (~7 hours of play) run twice and compared |
| Cross-engine | V8, SpiderMonkey and JavaScriptCore agree on `aba863c1` after 600 frames |
| Netcode | 192 combinations of latency, jitter, loss, mode and input pattern; damaged, duplicated and stale packets; a hostile-peer suite |
| Rendering | A perceptual signature per level, so a clipping mask or an encoder swap that changes the picture is caught |
| Database | Policies from a third account, a no-profile caller, a forged accepted friendship, direct `pair_progress` verbs by a *member*, a leaderboard fed impossible times, the full `aal1`/`aal2` matrix, and races run in parallel |
| Servers | Every URL-to-file mapping, written onto a socket **by hand** — `fetch` normalises `\` to `/` before sending, so a test written with `fetch` proves that `fetch` normalises, not that the server is safe |
| App | Emailed links, the invite gate, two-factor, two people playing, IndexedDB revisions, tab takeover, drawer focus behaviour |
| Docs | Every migration filename named in an operational document resolves to a file that exists |

Not tested here, and the README says so: that email actually *arrives*, and real
NAT traversal between two physical networks.

---

## 14. Security model

```mermaid
flowchart TB
    subgraph Untrusted["Untrusted — anybody with the URL"]
        BUNDLE["the bundle, the art, the audio"]
    end
    subgraph Authenticated["Authenticated — a JWT"]
        REST["PostgREST tables + RPCs"]
        RTC2["Realtime private topics"]
    end
    subgraph Assured["Assured — profile + satisfied assurance"]
        DATA["anybody's rows, any friendship transition"]
    end
    subgraph Privileged["Never in a browser"]
        SEC["secret key · DB password · invite minting · unenrol"]
        VER["fbwg_verifier — 3 functions, nothing else"]
    end

    BUNDLE -->|"sign in"| Authenticated
    REST -->|"has_profile() AND assurance_satisfied()"| Assured
    RTC2 -->|"accepted friendship / consented feed"| Assured
    SEC -.->|".env.local, gitignored"| Privileged
    VER -.->|"scoped LOGIN role on a VM"| Privileged
```

The honest statement of the perimeter, repeated from the README because it is the
one thing most easily misread: **the gate is on the DATA, not on the download.**
The invite code decides who can have an *account*; the bundle and the extracted
art are static objects on a CDN and anybody who has the URL can fetch them.
`X-Robots-Tag` affects indexing, not access. Restricting the assets themselves
needs a deployment-level control that does not exist here yet.

Specific hardening worth knowing about:

* **Path containment is one module.** `safepath.mjs` owns URL-to-file mapping for
  `serve.mjs`, the Vite dev middleware and the test CDN stand-in. All three had
  the same hole: `..` filtered as a `/`-separated segment, then `path.join`,
  which on Windows honours `\` too — so `GET /..%5C.env.local` returned 200 and
  the file holding the secret key. `resolveUnder` refuses a backslash outright
  and decides containment with `path.relative`.
* **Per-attempt scoping.** `net/scope.ts` prefixes every byte with a connection
  identity, so delayed SDP or input from a superseded attempt is discarded before
  it is decoded; `boundedTransport` caps message and byte rate on a direct link
  before any decoding happens.
* **Isolation for untrusted execution.** A replay is attacker-controlled input.
  It runs in a fresh worker thread with an empty env, a 256 MB old-generation
  heap, a 60-second deadline and no database handle.
* **Logs carry identifiers and timings, never payloads, tokens or database
  URLs.**
* **Recovery codes turn 2FA off** rather than letting one session past it,
  because Supabase models the second factor as an assurance level and "let me in
  just this once" is not something the platform can express.

---

## 15. Known limits and open gates

Recorded here because an architecture document that lists only what works is a
sales brochure. [`docs/production-play-release.md`](production-play-release.md)
holds the full gate list and the evidence behind each claim.

| Limit | Status |
|---|---|
| Relay capacity | ~100 all-relay players is about 3.13 M Realtime events an hour — beyond both the Free rate and the monthly allowance. Not certified; see [free-hosting.md](free-hosting.md) |
| The deferred narrowing | `supabase/deferred/20260906000000_watch_topic_contract.sql` is unapplied. Until it runs, a feed is still reachable by naming two user ids rather than by holding a withdrawable consent |
| Ranked play | `engine_versions` is empty by design. Nothing is ranked until an operator installs a worker image and enables that exact build |
| End-to-end verification | Proved locally (two isolated executions of a Speed 3 fixture both derive medal 2, 8 s, 265 frames) — **not** through a deployed worker with two real browsers |
| Asset access control | None. Public static objects to anyone with the URL |
| Email delivery, real NAT traversal | Untestable from this machine |
| Watcher catch-up | Mid-level joiners wait for the next level, deliberately |
| Cam and mic | Would need the direct connection, so relayed pairs could not have them — the honest cost of not renting a TURN server |

---

## 16. Appendix: file map, numbers, glossary

### Where things live

| Path | What |
|---|---|
| `Fireboy & Watergirl - The Forest Temple.swf` | The only input. Everything else is derived from it |
| `tools/` | Python: readers, extractors and TypeScript generators. Not part of any build |
| `extracted/` | Levels, entities, symbols and assets recovered from the SWF. `assets/_raw/` is excluded from builds |
| `engine/src/box2d/`, `flash/symbols.ts`, `game/game.ts` | **Generated.** Change the generator, never the file |
| `engine/src/net/` | Session, snapshot, protocol, transports, hashing, seeded RNG |
| `engine/src/render/`, `audio/` | Presentation. Reads the scene graph, never writes it |
| `engine/src/verified.ts` | Replay rules. Hashed into `ENGINE_VERSION` |
| `app/src/` | Screens, auth, router, lobby, pair/watch channels, outboxes |
| `app/src/ui/playshell.ts` | Viewport, drawer and the toolbar contract |
| `supabase/migrations/` | 19 files, applied in order, digest-checked, never edited after the fact |
| `supabase/deferred/` | The contracting half of a two-release change |
| `worker/` | The replay verifier: `run.mjs`, `replay-slot.mjs`, `versions.mjs`, Dockerfile |
| `web/`, `serve.mjs` | The engine's own harness. Development and test only, loopback only |
| `dist/` | Build output, at the repository root, because that is where the deploy looks |

### Numbers this design rests on

| | |
|---|---|
| Levels | 32 — adventure 17, puzzle 9, speed 6 |
| Stage | 640 × 480, fixed, scaled by CSS |
| Tick | 26 fps — a 38.5 ms frame |
| Input | 3 bits per player per frame; `HISTORY = 16` frames repeated per packet |
| Session cost | ~700 bytes/second including redundancy; ~34 bytes per input packet |
| Re-simulate one frame | ~0.04 ms |
| Capture one snapshot | ~4.7 ms (was 11.3 ms before the storage rewrite) |
| Snapshots | One, refreshed every ~8 frames — 1.4 MB, not 17 MB |
| Relay batching | `FLUSH_MS = 230`, leading edge then batched |
| Presence | `PRESENCE_MS = 8000` — the sixth call in 30 s closes the channel |
| Bundle | ~846 kB JS+CSS against an 860 kB budget; ~27.4 MB of art and audio; see IMPLEMENTATION_RESULTS_17.md |
| Sprite frames / sounds / button parts | 1865 WebP frames · 17 sounds · 45 of 75 button parts |
| Leaderboard index (`0018`) | 0.10 ms index-only scan vs 39.8 ms sequential scan + sort, at 200k rows |
| Replay limits | ≤ 1 MiB, ≤ 200,000 frames, 12-hour attempt expiry, 3 verification tries |
| Rate limits | 60 registrations/min, 30 submissions/min, per account |

### Glossary

**attempt** — one `(pair, connection, run)` tuple; the unit a ranked score is
registered against.
**epoch** — the generation of a level build, carried on every packet so
post-retry packets from the previous build are ignored.
**feed** — the rotating id in a watch topic, changed on every revocation of
consent.
**frontier / confirmed frame** — the newest frame for which both players' real
input is known.
**node** — a position on the game's own level map; `stats[32]` is indexed by it.
**pair** — an accepted friendship. There is no other kind.
**slot** — 0 or 1; which character a player drives. Decided by the invite online,
by a coin toss between two tabs.
**stage** (auth) — one of `out`, `unverified`, `locked`, `nameless`, `in`, plus
`unavailable`.
**`ENGINE_VERSION`** — `temple-<32 hex>`, derived by hashing the files that
decide how a replay simulates.
