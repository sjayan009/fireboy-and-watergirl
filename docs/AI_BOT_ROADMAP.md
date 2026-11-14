# AI partner bot: the complete roadmap

Everything needed to build, refine and run in production a bot that plays the
second character in Fireboy & Watergirl, so one person can play alone. The
bot lives in one place: **Local Play → Solo + AI** on the hosted site, the
card that already shows greyed as "With a robot buddy · soon" next to Two
Players (`app/src/ui/modecards.ts:239`). It never plays online. It builds
on [AI_BOT_FEASIBILITY.md](AI_BOT_FEASIBILITY.md). The learning path is
the SYNC Research Academy curriculum, 24 weeks in six modules (section 15).
The two-week sprint through its first three modules is in
[AI_BOT_TWO_WEEK_PLAN.md](AI_BOT_TWO_WEEK_PLAN.md).

**Restart, 2026-11-14.** The first environment (`bot/` and
`engine/src/bot/`) was deleted in commit `4d71ca5` so it can be rebuilt as
SYNC Module 03. The deleted code is still at `0a37180` for comparison, and
what it learned is kept here as requirements: section 2 for engine facts,
section 4 for the lessons, section 13 for the traps.

Contents:

1. [What "perfect" means](#1-what-perfect-means)
2. [The game as an RL problem](#2-the-game-as-an-rl-problem)
3. [Architecture](#3-architecture)
4. [Building the environment](#4-building-the-environment)
5. [The order of learning methods](#5-the-order-of-learning-methods)
6. [Being a good partner](#6-being-a-good-partner)
7. [Evaluation](#7-evaluation)
8. [Data](#8-data)
9. [Shipping](#9-shipping)
10. [Integrity](#10-integrity)
11. [Operations](#11-operations)
12. [Refining](#12-refining)
13. [Pitfalls specific to this repo](#13-pitfalls-specific-to-this-repo)
14. [Build order](#14-build-order)
15. [The learning curriculum: SYNC, Modules 01–06](#15-the-learning-curriculum-sync-modules-0106)

---

## 1. What "perfect" means

No bot is perfect with every possible human. "Perfect" has to be a bar you
can measure, and the bar rises each release. These are the acceptance
criteria. A release that misses one is not done.

| Area | Bar |
|---|---|
| Completion | All 32 levels, at least 99% completion over 100 seeded episodes, with **every** partner in the eval set: scripted, cloned humans, and held-out real human traces |
| Quality | The top medal from the game's own `TimeTable` on every level when paired with the strongest human proxy partner |
| Diamonds | 100% of the bot's own diamonds collected on every level |
| Partner safety | Zero partner deaths caused by the bot; body-blocking under 1% of frames |
| Human outcome | People finish more levels with the bot than when controlling both characters themselves, and choose to replay with it |
| Latency | Inference p95 under 5 ms on a low-end reference laptop; scripted fallback used on under 0.1% of decisions |
| Size | Model under 1 MB, loaded lazily, pinned by content hash |
| Correctness | No bot code in `engine/src/{game,flash,box2d}`; the CI determinism digests unchanged |
| Adaptation | When a held-out partner switches strategy mid-level, the bot's recovery time in frames is measured and reported per partner type, and does not get worse release to release |
| Regressions | No level gets measurably worse release to release (confidence intervals, not single runs) |

If the bot ever played online, two more bars would apply: zero desyncs with
replays of bot games verifying, and zero bot runs in leaderboard rankings,
proved by a test. Neither is planned (section 3, "Online play").

---

## 2. The game as an RL problem

Facts from the code, not estimates.

- **Timing.** The simulation steps at a fixed 26 Hz (`TIME_STEP = 1/26` in
  `engine/src/embed.ts:42`), about 38.5 ms per frame. In Local Play there is
  no `NetSession`: `GameView.tick` (`embed.ts:826-870`) uses the session only
  when `session && session.running`, and otherwise runs `step()` on an
  accumulator, up to five steps per animation frame when the browser stutters.
  `step()` (`embed.ts:816`) ticks the clock and the display tree. The bot
  decides once per `step()`, not once per animation frame.
- **The level's first frame.** The bot never sees a level fresh from its
  constructor, which is not a state play shows (levers at ±90°, every fan
  on). On the website the bot sends nothing for the level's first frame and
  starts deciding from the state after it, but the human's keys in that frame
  count, so `reset` takes them as `first` and runs that frame with them.
  Training should draw `first` from the partner, not leave it 0. The first
  env's whole-game check (section 4) tested exactly that rule; the rebuild
  needs the same check.
- **The key fields' timing.** The observation's six key fields are the bits
  the last frame ran with. `readState` takes them as an argument and never
  reads the level's `*_pressed` flags, because the browser's key handlers
  change those between frames. The runtime must capture the bits right after
  each `step()` and pass the same value to the encoder.
- **Actions.** Three bits per character: left = 1, right = 2, up = 4. Eight
  actions each, no down key. The level reads them as `l_pressed`,
  `r_pressed`, `u_pressed` (Fireboy, arrow keys) and the `2` variants
  (Watergirl, W/A/D), written by `Game.keyPressed` and `keyReleased`
  (`engine/src/game/game.ts:4737`, `:4894`). `packInput` in
  `engine/src/net/hash.ts` packs both characters into six bits per frame.
  Left and right together move the same as right alone (the force code is
  `if (r_pressed) … else if (l_pressed)`), so six actions per character
  lose nothing: idle, left, right, up, left+up, right+up. That is the action
  set SYNC Week 11 asks for.
- **One physics step per frame.** The website steps a frame as
  `tickClock(); advanceTree(game); enterFrameTree(game)` with the keys
  already written by the key handlers (`embed.ts:816-821`); `GameHost` does
  the same with `applyInput(lv, bits)` first (`net/gamehost.ts:56-60`). The
  env's frame is `tickClock(); applyInput(lv, bits); advanceTree(lv);
  enterFrameTree(lv)`. The level registers
  `Update` as its ENTER_FRAME listener, so `enterFrameTree` already runs it.
  `LevelHost.step` (`net/levelhost.ts:34-45`) and `snapbench.ts` then call
  `lv.Update()` again: two physics steps and two `timecount` ticks per frame.
  The curriculum's Week 9–10 starting point is `LevelHost`, so trace it, but
  step the env the way `embed.ts` does. Changing `LevelHost` itself moves the
  netcode tests, so it stays as it is.
- **Input delay.** Local Play has no input lead and no input delay. The bot's
  only lag is its own decision time: about 0 frames on the main thread, about
  1 in a Web Worker, plus stutter, when several steps run in one animation
  frame on the same bits. So the env takes the input delay per reset, and
  training draws it from 0–2 frames per episode, replacing the fixed
  four-frame delay the env started with (the online input lead). Only the
  bot's three bits wait out the delay; the partner's apply in the frame they
  are sent, as a human's keys do (`reset`'s `side` says which is the bot's).
- **Time in the observation.** The global clock (`getClock()`,
  `game.ts:166`) counts frames since the `GameView` was built
  (`resetClock()` at `embed.ts:230`), so on the live site it includes time on
  the title and the map. The observation uses the level's own `timecount`
  instead: frames since the level started (reset at `game.ts:546`, counted at
  `:1982`), and what drives the fan strength cycle
  `detSin(this.timecount / 10)` (`game.ts:2041`). The global clock is one
  module variable shared by every level in the process, and a snapshot does
  not reach it: `LevelHost.save` stores it beside the snapshot
  (`levelhost.ts:60-63`). An env process that holds several levels must
  `setClock` before stepping each one and read it back after.
- **World.** Each level is a 29 × 39 tile grid plus 316 entity placements in
  `extracted/entities/*.json`: levers, pushers, platforms, wind, pulleys,
  boxes and doors. Water kills Fireboy, lava kills Watergirl, green goo kills
  both. The tile codes are in `extracted/LEVEL_FORMAT.md`.
- **Determinism.** The simulation is a pure function of (mode, level, input
  log), checked across V8, SpiderMonkey and JavaScriptCore. That is what makes
  snapshot resets and seeded evaluation reproducible. In Local Play there is
  no peer and no input log, so the policy itself does not need to be
  deterministic: WebGPU floating-point drift between devices changes only the
  bot's own choices.
- **Speed.** A step costs 0.0135 ms (about 2,800× real time per core).
  Rebuilding a level costs 20 ms; restoring a snapshot costs 4 ms. Reset by
  restoring a snapshot, then replay forward.
- **Snapshots restore in place.** `Snapshot.restore` writes old values back
  into the same objects (`net/snapshot.ts`, "Restoring in place"); it never
  builds a second world. A copy of a snapshot is not an independent game, so
  counterfactual branches (SYNC Week 19) save, probe and restore one world,
  or run in separate processes. Set `SoundBus.replaying = true` while a
  branch runs so it stays silent, as rollback does (`levelhost.ts:37-38`).
- **Grades.** The game's own `TimeTable` defines the medal thresholds, so
  "played well" has an objective answer the original authors defined.
- **Replays.** The session produces
  `{version, engine, mode, num, frames, inputs, commands}` for every online
  game (`engine/src/net/session.ts`). That is a ready-made dataset format for
  human play. Local Play has no session and records no replay.

---

## 3. Architecture

### Training side

- Node processes hold many environment copies; a Python process holds the
  learner.
- Observations travel in batches over a binary socket, modelled on
  `engine/src/net/protocol.ts`.
- **Measure the cost of that hop before optimizing anything else.**
  Serialization is where naive designs lose most of their speed.
- Do not port the physics to Python or JAX. The Box2D port is certified for
  determinism across three engines; you cannot cheaply recreate that.

### Runtime side (Local Play → Solo + AI)

```
┌──────────────────── browser ────────────────────┐
│  GameView.tick ── step() on its accumulator     │
│       │            (no NetSession)              │
│       ▼                                         │
│  live level ── observation ──▶ policy ──────────┼──▶ Web Worker (optional)
│       ▲                          │              │      ├─ observation encoder
│       │                          ▼              │      ├─ ONNX Runtime Web
│  human keys ─▶ Game.keyPressed   3 bits for the │      │   (WebGPU, WASM fallback)
│  (own character)   │             bot character  │      └─ policy → 3 bits
│                    ▼             │              │
│        lv.l/r/u_pressed[2] ◀─────┘              │
└─────────────────────────────────────────────────┘
```

- Each frame the bot reads the live level (or its worker is sent the
  observation), decides three bits for its character, and writes them to the
  level's `*_pressed` flags the same way `Game.keyPressed` does.
- On the main thread the decision applies to the frame it was made for. In a
  worker it lands about one frame later. Either way, train with the 0–2 frame
  delay from section 2.

### The rule about where code lives

- **Never put bot code in `engine/src/{game,flash,box2d}`.** `ENGINE_VERSION`
  hashes those folders plus `net/gamehost.ts`, `net/hash.ts`,
  `net/protocol.ts` and `verified.ts` (`engine/scripts/version.mjs:7-8`), so
  leave those four files alone too; changing any of them moves the CI
  determinism digests and splits online players across builds.
  The rebuilt env server goes outside them, in `engine/src/bot/` as before.

### Open items

Not decided or not built yet:

- **Bot-helped progress in the player's save.** `Recuent()` (`game.ts:4779`)
  writes medals and best times into `The_cookie` stats and times and unlocks
  the adjacent nodes, and solo progress syncs to the account through
  `sync_solo_progress` (`app/src/solosave.ts:98`). Decide whether to mark or
  separate bot-assisted progress.
- **The bot character's keys.** The human's keys write the same flags as the
  bot (`Game.keyPressed` and `keyReleased`), so in Solo + AI the bot
  character's keys (W/A/D or the arrows) must be ignored, or the human
  overwrites the bot.
- **A TypeScript observation encoder.** The rebuilt env's encoder and BFS
  fields will be Python. The browser needs a TypeScript copy and a parity test
  that both produce identical observations for the same state, gated by
  `SCHEMA_VERSION`.
- **Which character the bot plays.** The rebuilt env's `reset` takes `side`
  and `encode` ends the vector with it, as the first env did. The runtime
  must pass the side the player picked.
- **Pause, retry and blur.** Any key while `level.pause` is true clears all
  six flags (`game.ts:4768`), and death and win set `pause` too, so the bot
  stops deciding while paused, not only when `ended` is. Every new level,
  including R on the game-over board, clears the bot's delay queue and any
  recurrent memory. The window `blur` handler releases all six keys
  (`embed.ts:360`), so the bot re-sends its bits on the next frame. The level
  constructor resets the flags (`game.ts:555`), so nothing held carries
  across a level start.

### Online play (not planned)

The earlier plan put the bot in online games as a `BotTransport` behind the
five-method `Transport` interface (`engine/src/net/transport.ts`), sending its
bits through the session's input path with a four-frame input lead. None of
that is planned. If it ever is, bot input must go through the session and
never set `lv.l_pressed2` directly, and the two online bars in section 1
apply.

---

## 4. Building the environment

- **Reset.** Restore a snapshot from a cache: level start, or a sampled
  curriculum state. Never reconstruct the level.
- **Observation.**
  - A one-hot tile tensor `C × 29 × 39`: solid, four slope channels, water,
    lava, goo, collectibles, doors, and rasterized moving entities.
  - Two BFS distance-to-door fields, one per character, normalized. These turn
    a sparse-reward problem into a shaped one.
  - A vector: both characters' position and velocity, grounded and alive
    flags, lever and pusher states, door states, elapsed time from the
    level's `timecount` (section 2) clipped at 150 s because Local Play has
    no time limit, the keys both characters ran with last frame (so the bot
    sees what its partner is pressing), and which character the bot plays.
  - Give the observation a **schema version** number and ship it with every
    model.
- **Actions.** Repeat each action for 2–4 frames and sweep that as a
  hyperparameter. Apply the input delay given at reset on top, drawn from
  0–2 frames per episode.
- **Reward.**

  ```
  + Δ(BFS potential to own door)        dense shaping, the main signal
  + 1.0   own diamond collected
  + 10.0  own character at own door
  + 25.0  both doors reached
  + bonus scaled against TimeTable      the game's medal thresholds
  - 10.0  death (water / lava / goo)
  - 0.001 per step                      time pressure
  ```

  Reward-shaping bugs are the most common RL failure. Watch replays of what
  the agent actually does, not just the curves.
- **Termination.** Death, a win (the env's `won` field, not `complete`, which
  comes 34 frames later), or a time limit. Mark the time
  limit as *truncation*, not termination, or your value estimates are biased.
- **Invariant tests, pinned in CI next to the determinism digests.**
  - Same seed and actions give the same digest.
  - A restore gives the same state as a rebuild.
  - The observation is unchanged by a snapshot round-trip.
  - The delay given at reset is applied exactly.
  - For 800 random frames on every level, the env equals the whole `Game`
    (through `GameHost`) in hash, state and grid, before and after a restore.
    In the first env this one test caught most of the others.

### Lessons the first env paid for

Each of these cost a debugging session in the first env. The commit named
after each one has the code and the full reasoning. Build the check before
you need it.

1. **End episodes on the win, not on `complete`.** The win animation (the
   game's "ender" clip) starts 34 frames before the game reports complete
   (`c8da76b`).
2. **Use the game's own judgements.** Deaths, game over, medals and buttons
   come from the game's own `GameOver`, `Recuent`, `TimeTable` and button
   rules, never a reimplementation (`d831c11`, `0a37180`).
3. **Seesaw bases are invisible to the grid.** The seesaw stands on a static
   triangle outside the tile grid, so a tile BFS walks through it
   (adventure 10, speed 5). Mark cells inside any static solid shape that
   isn't the ground, a door or a diamond as walls (`09ce376`).
4. **"Grounded" is a frame late.** `allowjump` is set at the top of `Update`,
   so after a step it describes the previous frame. Read grounded from the
   contact lists the next jump check reads (`9fc6fcb`).
5. **Snapshot before the first frame.** Every reset restores it and runs that
   frame with the partner's `first` keys only (`0a37180`).
6. **Record the keys the frame ran with,** captured right after `step()`,
   never read back from the `*_pressed` flags (`0a37180`).
7. **Delay only the bot.** Only its three bits wait out the delay
   (`740b3da`).
8. **Clip time.** Local Play has no time limit, so the time feature is clipped
   at 150 s and a time limit is truncation (`740b3da`).
9. **Handshake first.** The first message carries the schema version,
   `ENGINE_VERSION` and the field names; the client refuses any mismatch, even
   at the same record size (`58a8f07`).
10. **Cap the level cache.** A level plus its snapshot is about 7.5 MB; 32
    levels in each of 18 envs filled Node's heap. Keep a small LRU per env
    (the first env used 4) (`09ce376`).

---

## 5. The order of learning methods

Each step is the baseline the next must beat.

1. **Scripted bot.** BFS to its own door, jump when blocked, avoid the pool
   that kills it. Playable on day one, and the floor every learned policy has
   to clear.
2. **Behaviour cloning** from recorded human play. Cheap, and it plays the way
   people play.
3. **PPO for one character** with a scripted or cloned partner.
4. **MAPPO self-play.** Both characters learn, with a shared critic.
5. **Training against many partners.** A population of past checkpoints,
   varied seeds and reward weights, cloned human partners, and the bad
   partners real players are: one who stands still and one who mashes keys
   at random. This is Fictitious Co-Play, the main defence against a bot that
   only works with itself.
6. **A recurrent policy (GRU or LSTM)** so the bot infers what *this* partner
   intends from their recent moves.
7. **Search at runtime (optional).** MCTS from snapshot restores in the worker,
   guided by the policy. Restore once, then simulate input prefixes forward:
   about 56 depth-50 rollouts per frame budget.
8. **LLM subgoal planner (optional).** About once a second, never inside the
   26 Hz loop, for the lever levels. It reads the entity JSON and the tile
   grid and emits subgoals that the RL controller carries out. The LLM never
   plays the game, and the README should say so.

SYNC Modules 04–05 add the research layer on top. Each is an ingredient the
Module 06 ablations remove one at a time, so each must be switchable:

9. **A partner-style estimator.** A Bayesian or count-based belief over which
   style the human is playing (cautious, impatient, button-first, door-first),
   updated from their recent moves. It is the explicit, inspectable cousin of
   the recurrent policy in step 6.
10. **Skills.** Navigate, hold a button, wait, cross a gap, retreat, reach the
    door, each with a start condition, a timeout and a failure check. A slow
    chooser picks skills; the fast policy runs them.
11. **A typed level graph.** Entities (player, button, lever, door, platform,
    hazard, region, goal) and edges (opens, requires, threatens,
    reachable_after), built from `extracted/entities/*.json` and the tile
    codes in `extracted/LEVEL_FORMAT.md`. An edge such as "this lever moves
    that platform" can be confirmed exactly: restore, toggle, step, compare.
12. **Counterfactual lookahead.** Restore once, try a few candidate bot
    actions against likely partner responses sampled from the estimator, and
    compare progress and risk (section 2, "Snapshots restore in place").
13. **Signaling and asking.** Move early toward the button the bot intends to
    take, and, when the estimator is unsure, ask through the UI at an explicit
    interruption cost.

Other-Play assumes the two players are interchangeable. Fireboy and Watergirl
are not, because their hazards differ, so rely on partner diversity instead
of symmetry tricks.

Sparse reward has three mitigations, in order of preference: the BFS
potential field, a curriculum that starts further back along a known-good
trajectory, and Go-Explore-style resets to states from successful runs, which
`Snapshot.restore()` makes trivial.

### Optional experiment: weights written by an LLM

[Sparks of Weight-Space Programming](https://rikiyat.github.io/blog/weight-space-programming/)
(Takehi, Teoh, Zhang and Khattab, MIT CSAIL, November 2026) reports a frontier
LLM reading and writing network weights directly, with no gradients. Two of
its results line up with problems this bot will have:

- **Fixing a policy stuck in a local minimum.** A PPO car policy in Kinetix
  never learned to back up before a ramp. Given the weights, the scene and
  one failed episode, the LLM edited 3.5% of the weights in one reply, and the
  car succeeded in all 1,024 episodes. The edit added a small path that
  handles the opening move and then switches off. Lever levels have the same
  shape: the right first move earns nothing until much later.
- **Writing a policy from scratch.** Its zero-shot MinAtar networks beat PPO
  trained for 100M steps in all three games. Against PPO at 500M steps they
  won Breakout, a game with a formula for the answer, and lost Seaquest and
  Asterix.

Why it stays off the main path:

- The method's advantage is needing no rollouts. Here rollouts are almost
  free (section 2), so it competes with PPO where PPO is strongest.
- The post compares against PPO from scratch, not against distilling a
  hand-written program into the network. That is behaviour cloning from the
  scripted bot (steps 1 and 2 above), and it needs no LLM.
- In the post's own results, edits removed something blocking an ability the
  model already had, but could not add a missing one. It will not teach
  coordination.
- One model (GPT-6 Astra), one blog post, no released code. Other models are
  untested.

Two experiments, both after single-character PPO exists (build order step 3):

1. **Debugging a stalled level.** When PPO settles into a local minimum on a
   lever level, give an LLM the policy weights, the level's entity JSON and a
   failed replay. Ask it to explain the failure, then make the smallest edit
   that fixes it. Score the edited model on the offline suite like any other.
   When the edit fails, the explanation is still a diagnosis to check against
   the failure causes in section 12.
2. **Warm starts.** On two or three levels, start PPO from random weights,
   from a clone of the scripted bot, and from LLM-written weights of the same
   architecture. Compare the steps each needs to beat the scripted baseline,
   over several seeds with confidence intervals (section 7). Expect the clone
   to win. A physics platformer with two characters is still a new test of
   the method, and a write-up fits Module 06.

The post put up to 171,664 weights into the prompt as text. Above that, it
gave the LLM a Python sandbox over the weight tensors, as it did for its
1.5M-weight Go network. In both experiments the LLM stays out of the 26 Hz
loop (section 13), and an edited model passes the same eval and CI gate as a
trained one.

---

## 6. Being a good partner

This is the hard part and the real research problem.

- **Lever problems.** Neither character is rewarded for holding a lever, so
  independent learners never find that cooperation. Attack it with curricula
  that start right at the lever moment, the subgoal planner, and shaped reward
  for helping the partner make progress.
- **Predictability.** People coordinate with partners they can predict.
  Prefer consistent routes over clever ones. Consider showing the bot's
  intent in the UI, for example a faint arrow toward its next subgoal.
- **Adaptivity.** Wait when the human hesitates; go when they commit.
  Measure it: switch a scripted partner's strategy midway through a level and
  count the frames until the bot is useful again, plus its wrong-role actions
  in between (SYNC Week 16).
- **Legibility is not predictability.** Predictable means the bot behaves
  consistently; legible means its moves make its intent obvious early. Test
  them as separate conditions.
- **Asking.** Asking the human costs their attention. Ask only when the
  partner estimate is uncertain, and count interruptions as a cost in the
  evaluation.
- **Staying out of the way.** Penalize body-blocking, and never stand on a
  button the human needs released.
- **Difficulty.** Sampling temperature, deliberate reaction delay, or separate
  "casual" checkpoints. People who are carried through quit.

---

## 7. Evaluation

The part that makes every other claim credible.

- **Offline suite.** All 32 levels, at least 100 seeded episodes each.
  Report completion, grade, diamonds, deaths by cause, time, and how often
  the bot blocked its partner.
- **Partner set.** Scripted, cloned humans, held-out real human traces, an
  idle partner and a key-masher. Real traces are **split by player, not by
  episode**, so no player leaks between training and test. No level can be
  won with an idle partner or a masher, so with them measure the bot's own
  deaths and blocking, not completion: it should reach its door and wait.
- **Statistics.** IQM with bootstrap confidence intervals
  ([rliable](https://github.com/google-research/rliable)), several training
  seeds, no cherry-picking.
- **Held-out partner types.** Split scripted partner styles into training and
  test sets as strictly as human players, and show that no test style tuned
  the final model. Report results per partner type, never only the mean.
- **Preregister.** Write hypotheses H1–H3 and what would falsify each before
  collecting data, and freeze the env protocol, tasks and metrics before the
  final runs.
- **Ablations.** Remove the partner estimator, the level graph, the lookahead
  and the signaling one at a time (section 5, steps 9–13). An ingredient that
  changes nothing when removed is not part of the result.
- **Regression gate in CI.** A new model ships only if it beats the deployed
  one on the suite and no level gets meaningfully worse. The repo already
  gates deploys on `dist/version.txt`; do the same for the policy.
- **Live, with consent.** Completion in Solo + AI versus the same people
  controlling both characters in Two Players, quit rate, replay rate. For research use, get
  Georgia Tech IRB approval first.

---

## 8. Data

Your unfair advantage: a live deployment with real players.

- The app already records a replay of every online game (section 2). That
  is a dataset of human play. Local games, Solo + AI included, record none.
- **Consent first.** Update the privacy policy, add an opt-in for training
  use, and enforce opt-outs at the database layer with RLS, the same way the
  leaderboard opt-out works.
- Version your datasets, and record which dataset produced which model.
- Fix the engine version in each dataset. A replay only replays on the engine
  version that recorded it.

---

## 9. Shipping

- **Smaller model.** Distill into a small conv net plus a small MLP, ideally
  a few hundred KB.
- **Export.** ONNX, then int8 quantization. Check that the quantized policy
  scores the same on the eval suite.
- **Runtime.** WebGPU first, WASM fallback for devices without it. Load lazily
  when Solo + AI starts, cache it, pin it by content hash.
- **Encoder.** The TypeScript observation encoder must pass the parity test
  against the Python encoder for the model's `SCHEMA_VERSION` (section 3,
  open items).
- **Latency.** There is no input lead to hide a decision behind: a frame is
  38.5 ms, and a decision made on the main thread runs inside it. Aim for
  under 5 ms p95 so slow devices stay safe. Measure on a low-end laptop, not
  an RTX 4060. If a decision is late, use the scripted bot for that frame;
  never stall.
- **Versioning.** Every model declares its observation schema version, its
  action-repeat setting, the input delays it was trained on and the engine
  versions it supports. The client refuses an incompatible model.
- **Rollout.** Feature flag, staged rollout, kill switch, one-click rollback
  to the previous model.

---

## 10. Integrity

- Local games never reach the leaderboard. `public.leaderboard()`
  (`supabase/migrations/0011_leaderboard.sql`), the function the board calls
  (`app/src/ui/leaderboard.ts:133`), reads only `pair_progress`, which holds
  two-player online results. So no leaderboard flag is needed for Solo + AI.
- Bot-helped games still write medals, best times and unlocks into the
  player's own save, and that syncs to their account. Whether to mark or
  separate that progress is an open item (section 3).
- If the bot ever played online, a bot flag on the replay and the database
  rows would have to exist before the first bot run is recorded, since
  retrofitting means guessing which rows were assisted.

---

## 11. Operations

- **Telemetry.** Inference p50 and p95, fallback rate, model load failures,
  per-level completion and abandonment with the bot. Read
  [FREE_TIER_BUDGET.md](../FREE_TIER_BUDGET.md) before adding events.
- **Dashboards and alerts** on the regression signals.
- **Improvement loop.** New consented replays → failure taxonomy → targeted
  curriculum → retrain → CI gate → staged release.
- **Drift.** New players bring new strategies. Re-run the human-partner eval
  on a schedule.
- **Experiment tracking.** MLflow or W&B with a model registry, so "which
  policy is live" always has an answer.

---

## 12. Refining

- Sort failures by cause: stuck, death type, blocking, lever deadlock,
  timeout.
- Each cause gets a targeted fix: curriculum start states, a reward term,
  more data, or a planner subgoal.
- Change one thing at a time and gate every change on the eval suite.
- Track grades, not just completions. A medal-level bot is the visible
  quality bar.

---

## 13. Pitfalls specific to this repo

- Building the env on `LevelHost.step`, which runs two physics steps per
  frame (section 2).
- Running several levels in one process without saving and restoring the
  module-global clock.
- Treating a copied snapshot as a second world.
- Training with one fixed input delay instead of 0–2 frames drawn per
  episode.
- Using the global clock in the observation instead of the level's
  `timecount`.
- Editing `engine/src/{game,flash,box2d}`, which changes `ENGINE_VERSION`.
- Letting the human's keys for the bot's character through, so they
  overwrite the bot's bits.
- A TypeScript encoder that drifts from the Python one without the parity
  test catching it.
- Splitting human data by episode instead of by player.
- Benchmarking latency on your own GPU.
- Recording replays without consent.
- Putting an LLM in the per-frame action path.
- Building a server or Kubernetes cluster to *serve* the bot. It runs in the
  browser; a serving cluster adds cost and latency to a static app.
- Following SYNC Week 18 into Databricks Genie Ontology. It is an enterprise
  data product, not an RL method; the level graph comes from the game's own
  entity JSON.
- Claiming a result from one video, from self-play alone, or from Level 1
  alone.

---

## 14. Build order

Ship something at every step. The steps follow the six SYNC milestones
(section 15).

1. **Milestones 1–2: RL you understand.** A gridworld and CartPole, with
   Q-learning, DQN and PPO compared over seeds. Outside the game, on
   `ai-rl-research`.
2. **Milestone 3: the rebuilt env and the scripted bot in Local Play →
   Solo + AI.** The env with its invariant tests and whole-game check, then
   the scripted bot people can already play with. Every later claim depends
   on these.
3. **Single-character PPO and a cloned-from-humans bot.** The bot visibly
   improves on the scripted baseline.
4. **The save decision, data opt-in, the TypeScript encoder with its parity
   test, ONNX/WebGPU runtime with fallback.** First real public release.
5. **Milestone 4: a partner you haven't met.** MAPPO, the partner
   population with held-out types, the recurrent policy, and the adaptation
   benchmark.
6. **Milestone 5: partner-aware planning.** Skills, the level graph,
   counterfactual lookahead, signaling (section 5, steps 9–13). Runtime search
   and the LLM planner for lever levels sit here too.
7. **Milestone 6: research and operations.** The harness with scripted
   fallback, the human study, the ablations and the paper; then telemetry,
   the CI gate and retraining, so the bot keeps improving on a schedule.

---

## 15. The learning curriculum: SYNC, Modules 01–06

The curriculum is the SYNC Research Academy: 24 weeks in six modules of
four, about 168 core hours. At 7 hours a week that is about 24 weeks; at 12,
about 14. Every week runs the same four moves: **understand** the mechanism
well enough to explain it without notes, **implement** small code you can
inspect, **experiment** against controlled baselines, and **prove** it with a
program, an output and a written explanation.

It is still T-shaped. The deep area is **multi-agent RL and human–AI
coordination** (Modules 04–05). Each module ends with a milestone in this
repo that proves it, and each module lists what to watch for here, because
the curriculum was written without seeing the code. The depth stages that
SYNC leaves out (LLMs, GPU programming, distributed training) follow the six
modules.

Two habits for every module: watch videos at 1.5–2× and pause to code along,
and write what you learned in your own words each night.

### Module 01 · Foundations (weeks 1–4)

From zero RL vocabulary to a working tabular agent.

| Week | Build | Read and watch |
|---|---|---|
| 1 · The agent–environment loop | A 5×5 gridworld with `reset(seed)` and `step(action)` returning observation, reward, terminated, truncated, info; a random and a shortest-path policy over 100 episodes each | [Spinning Up, RL intro](https://spinningup.openai.com/en/latest/spinningup/rl_intro.html); [Gymnasium, custom env](https://gymnasium.farama.org/main/introduction/create_custom_env/); [Hugging Face Deep RL course](https://huggingface.co/learn/deep-rl-course/en/unit0/introduction) |
| 2 · Math you actually need | `math_sanity.py`: a stable softmax, a numeric gradient checked against your hand derivative, an expected return by hand; finish `ML-Research/ml_from_scratch.py` | [3Blue1Brown, Essence of Linear Algebra](https://www.3blue1brown.com/topics/linear-algebra) and [Calculus](https://www.3blue1brown.com/topics/calculus); [Khan Academy probability](https://www.khanacademy.org/math/statistics-probability). For depth: [Strang, MIT 18.06](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/), [Stat 110](https://projects.iq.harvard.edu/stat110), [StatQuest](https://www.youtube.com/@statquest) |
| 3 · Value functions and Bellman thinking | Tabular Q-learning with ε-greedy on the gridworld; γ = 0 against γ = 0.99 | [Hugging Face, Q-learning unit](https://huggingface.co/learn/deep-rl-course/en/unit2/introduction); [Sutton & Barto](http://incompleteideas.net/book/the-book-2nd.html) chapters 3 and 6; [David Silver's lectures](https://www.davidsilver.uk/teaching/) 1–3 |
| 4 · A clean RL experiment | Separate training and evaluation seeds; random, rule-based and Q-learning over 5 seeds; median, mean and spread; one command reproduces the table | [Spinning Up, becoming an RL researcher](https://spinningup.openai.com/en/latest/spinningup/spinningup.html) |

In this repo:

- Keep this code on `ai-rl-research` beside your ML notes, never in
  `engine/`, so it cannot touch `ENGINE_VERSION` or CI.
- At 26 frames a second a 60-second level is about 1,560 steps, and
  0.99^1,560 is below 1e-6. That is why the Fireboy env repeats each action
  for several frames.
- Start the results log you'll keep all 24 weeks: commit, seed, command,
  number.

**Proves it (Milestone 1):** a Q-learning gridworld with a reproducible
training graph, and an evaluation table a stranger can rerun.

### Module 02 · Deep reinforcement learning (weeks 5–8)

From PyTorch tensors to a PPO controller you understand from the inside.

| Week | Build | Read and watch |
|---|---|---|
| 5 · Neural networks with PyTorch | A two-layer MLP with training and validation loss; gradient checks with no NaNs; an observation → logits → action sampler | [PyTorch, learn the basics](https://docs.pytorch.org/tutorials/beginner/basics/intro.html); [Karpathy, Neural Networks: Zero to Hero](https://karpathy.ai/zero-to-hero.html), micrograd first. For depth: [Understanding Deep Learning](https://udlbook.github.io/udlbook/), [CS231n ConvNets notes](https://cs231n.github.io/convolutional-networks/) |
| 6 · Deep Q-Networks | Replay buffer, online and target networks, DQN on CartPole; a run without the target network to watch it go unstable | [PyTorch DQN tutorial](https://docs.pytorch.org/tutorials/intermediate/reinforcement_q_learning.html); [CleanRL](https://docs.cleanrl.dev/) |
| 7 · Policy gradients and actor–critic | REINFORCE on CartPole, then with a value baseline; variance across seeds | [Spinning Up](https://spinningup.openai.com/) part 3; [Berkeley CS285](https://rail.eecs.berkeley.edu/deeprlcourse/) policy-gradient lecture; David Silver lecture 7; [Mutual Information](https://www.youtube.com/@Mutual_Information) RL series |
| 8 · PPO from both sides | Stable-Baselines3 PPO as a reference; CleanRL `ppo.py` annotated; DQN against PPO over 5 seeds; an exported policy that runs without the training libraries | [Spinning Up, PPO](https://spinningup.openai.com/en/latest/algorithms/ppo.html); [Stable-Baselines3 PPO](https://stable-baselines3.readthedocs.io/en/master/modules/ppo.html); [The 37 Implementation Details of PPO](https://iclr-blog-track.github.io/2022/03/25/ppo-implementation-details/) and Costa Huang's walkthrough; [Hugging Face PPO unit](https://huggingface.co/learn/deep-rl-course/en/unit8/introduction) |

In this repo:

- Make the sampler a 6-way categorical, one per character (section 2,
  "Actions"), so it carries over unchanged.
- Week 8's export is the browser path in miniature: the shipped bot runs in
  the page and cannot need PyTorch. Note the file size against the 1 MB bar
  in section 1.
- Week 6's target-network ablation is the pattern for Module 06: change one
  thing, keep the seeds, report the spread.

**Proves it (Milestone 2):** DQN and PPO compared on CartPole over several
seeds, and a saved policy. Derive the policy gradient theorem on paper
without looking it up.

### Module 03 · Game → learning environment (weeks 9–12)

Turn the deterministic TypeScript game into a testbed you can trust. This is
where the deleted env gets rebuilt.

| Week | Build | Read and watch |
|---|---|---|
| 9 · Read your own engine | Trace `LevelHost.start`, `step` and `hash`, and `applyInput`; run the determinism and replay tests; a 100-step trace of level 1; `engine_map.md` | `engine/src/net/levelhost.ts`, `hash.ts`, `snapshot.ts`, `engine/src/embed.ts` (`tick`, `step`); [TypeScript for JS programmers](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes.html) |
| 10 · A trusted environment API | A Node facade with `reset(mode, level, seed)` and `step(joint_bits)`; a JSON-lines bridge to Python; tests for resets, termination, truncation, invalid actions and 100 identical traces | [Gymnasium, custom env](https://gymnasium.farama.org/main/introduction/create_custom_env/); [From Python to NumPy](https://www.labri.fr/perso/nrougier/from-python-to-numpy/) |
| 11 · Reward design and safe actions | `reward_spec.md`: completion, failure, step cost, then measured shaping; the 6 actions; tests for deaths and wins; a reward-hacking checklist with 3 adversarial traces | Ng, Harada & Russell 1999, "Policy invariance under reward transformations" (potential-based shaping); [Go-Explore](https://arxiv.org/abs/1901.10995) for sparse reward |
| 12 · A scripted co-op partner | A finite-state bot (navigate, wait, press, go to the door) on one chosen puzzle; 20 logged episodes and the three most common failures; the same bot in Local Play → Solo + AI | Section 3 of this roadmap; `app/src/ui/modecards.ts:239` |

In this repo:

- **Step the way `embed.ts` does, not the way `LevelHost` does.**
  `LevelHost.step` runs two physics steps per frame (section 2).
- Save and restore the module-global clock with each snapshot (section 2,
  "Time in the observation").
- Rebuild the invariant tests and the whole-game check first, and work
  through the ten lessons in section 4 as you go. The first env's code is at
  `0a37180` if you want to compare after writing your own.
- Local Play has no NetSession: the bot writes its `*_pressed` flags in
  `embed.ts` with a 0–2 frame delay, and the human's keys for its character
  must not get through (section 3).

**Proves it (Milestone 3):** the rebuilt headless env with its invariant
tests, and a scripted bot that completes one cooperation puzzle consistently,
playable in Solo + AI. Not "all 32 levels" because level 1 works.

### Module 04 · Multi-agent intelligence (weeks 13–16, the depth area)

Train teamwork, and measure whether it works with partners it has never met.

| Week | Build | Read and watch |
|---|---|---|
| 13 · Two agents change everything | A toy two-character button-and-door grid with shared reward and simultaneous actions; independent learners against fixed scripted teammates; one coordination failure written up | [PettingZoo Parallel API](https://pettingzoo.farama.org/main/api/parallel/); [Hugging Face MARL intro](https://huggingface.co/learn/deep-rl-course/en/unit7/introduction); [Albrecht, Christianos & Schäfer, Multi-Agent RL](https://www.marl-book.com/) Part I |
| 14 · Centralized training, decentralized control | Independent PPO, then a centralized critic, on the toy game and then one Fireboy level with the scripted partner; an IPPO-vs-MAPPO table | [MAPPO](https://arxiv.org/abs/2103.01955). **Read this one**; [TorchRL multi-agent PPO](https://docs.pytorch.org/rl/stable/tutorials/multiagent_ppo.html) |
| 15 · Population training and ad-hoc teamwork | Cautious, impatient, random, button-first and door-first scripted partners, plus an idle one and a key-masher; a training/held-out split; population against self-play-only; a behaviour-cloned partner from your own play | [Overcooked-AI](https://arxiv.org/abs/1910.05789) and [its benchmark](https://github.com/HumanCompatibleAI/overcooked_ai). **Read this one**; [Fictitious Co-Play](https://arxiv.org/abs/2110.08176); [Other-Play](https://arxiv.org/abs/2003.02979); [PBT](https://arxiv.org/abs/1711.09846); [OvercookedV2](https://arxiv.org/abs/2503.17821); behaviour cloning and [DAgger](https://arxiv.org/abs/1011.0686) in CS285 |
| 16 · Partner identity and adaptation | Partners that switch convention mid-episode; recovery frames, wrong-role actions, failures; a Bayesian or count-based style estimator; fixed, diverse and estimator-augmented agents compared | [Stanford CS229](https://cs229.stanford.edu/) notes on generalization; StatQuest on k-means for clustering recorded play into styles; Jakob Foerster's talks on zero-shot coordination |

In this repo:

- Use the Parallel API: both characters' bits apply in the same frame.
- Fireboy and Watergirl are not interchangeable (water kills Fireboy, lava
  kills Watergirl, green goo kills both), so Other-Play's symmetry does not
  fit; rely on partner diversity.
- The deployed bot sees only what the page can compute each frame: the
  level, both characters and the six bits the last frame ran with. Anything
  more in the critic stays training-only.
- Count recovery in frames and convert at 26 per second. Determinism lets you
  replay the same partner switch against every agent.

**Proves it (Milestone 4):** an unfamiliar-partner benchmark with held-out
partner types and recovery metrics, reported per type.

### Module 05 · Human-centered frontier (weeks 17–20)

Add goals, causal structure, partner uncertainty and intentional signaling
(section 5, steps 9–13).

| Week | Build | Read and watch |
|---|---|---|
| 17 · Hierarchical decisions and skills | Skills (navigate, hold button, wait, cross gap, retreat, reach door) with start conditions, timeouts and failure checks; flat actions against skill selection on a long puzzle | Sutton, Precup & Singh 1999 on the options framework; CS285 on hierarchical RL; [SayCan](https://arxiv.org/abs/2204.01691) and [Voyager](https://arxiv.org/abs/2305.16291) for slow planners over fast skills |
| 18 · Level graphs and causal dependencies | `ontology.schema.json` and two hand-annotated levels with validation rules; a graph-guided planner against a coordinate-only one | `extracted/entities/*.json` and `extracted/LEVEL_FORMAT.md` |
| 19 · Counterfactuals with exact physics | Isolated branches from one snapshot; 3 candidate bot actions against sampled partner responses; a test that the live episode's hash never changes after a probe | `engine/src/net/snapshot.ts`; MCTS, [AlphaZero](https://arxiv.org/abs/1712.01815), [MuZero](https://arxiv.org/abs/1911.08265), [Surag Nair's AlphaZero tutorial](https://suragnair.github.io/posts/alphazero.html) |
| 20 · Theory of mind, legibility and asking | Logged beliefs over partner roles; early role signaling; an ask-when-unsure option with an interruption cost; hypotheses H1–H3 with what would falsify them | Dragan, Lee & Srinivasa 2013 on legibility and predictability; [Overcooked-AI](https://github.com/HumanCompatibleAI/overcooked_ai) |

In this repo:

- A frame is 38.5 ms. Anything slower than a few milliseconds runs off the
  frame loop and hands its answer to the fast policy later; the policy never
  waits.
- Skip Databricks Genie Ontology (section 13). Confirm graph edges by
  intervention: restore, toggle, step, compare.
- One live world per process: probe and restore the same objects, restore
  the clock, and set `SoundBus.replaying` during probes (section 2).
- Restores dominate the lookahead budget (4 ms against 0.0135 ms a step), so
  restore once and run many short input prefixes.

**Proves it (Milestone 5):** a partner-aware prototype where you can switch
each ingredient off, a trace where the partner model changes a bot decision
for a defensible reason, and a preregistration draft.

### Module 06 · Research and publication (weeks 21–24)

Engineer a robust system, design experiments and make claims you can defend.

| Week | Build | Read and watch |
|---|---|---|
| 21 · A harness that stays out of the way | Per-frame inference apart from the slow planner; timeouts, confidence thresholds and scripted fallback; structured logs of observations, actions, beliefs, plans and hashes; three forced failures with safe recovery | `engine/src/embed.ts`; the repo's own `docs/DEEP_DIVE` as examples of decision records |
| 22 · Human study design and consent | 2–3 primary outcomes and hypotheses written first; matched tasks and randomized order; a consent notice; pilot sessions; an analysis plan | CITI human-subjects training and the Georgia Tech IRB site; Chip Huyen, *Designing Machine Learning Systems*, on data and evaluation |
| 23 · Ablations and honest science | Frozen protocol; rule-based, PPO/MAPPO, diverse-partner and proposed-method baselines; the four ablations; negative results, compute and every exclusion written down | [Statistical Precipice](https://arxiv.org/abs/2108.13264), [rliable](https://github.com/google-research/rliable) and Rishabh Agarwal's NeurIPS 2021 talk |
| 24 · A research artifact people can inspect | The paper; a reproducibility README with pinned versions; an honest A/B demo with action and belief traces; model cards and evaluation scripts | [Keshav, How to Read a Paper](http://ccr.sigcomm.org/online/files/p83-keshavA.pdf), read as a writer this time |

In this repo:

- Run inference in a Web Worker with the scripted bot as the per-frame
  fallback; never stall the game. Re-send the bot's bits after a window blur.
- Get Georgia Tech IRB approval before recording anyone's play for research.
  Store replays under a study ID, and split human data by player.
- Record `ENGINE_VERSION` with every result: a replay only replays on the
  engine that recorded it.
- Ship code, models and numbers. The original SWF and decompiled ActionScript
  stay local-only and belong to Oslo Albet, and the MIT license does not
  cover the game's art.

**Proves it (Milestone 6):** the SYNC research package (a runnable
prototype, the benchmark suite, figures and a paper draft) that another
researcher reproduces from a clean checkout.

### Research skills (ongoing, start now)

| Habit | Resource |
|---|---|
| Read papers | [Keshav, How to Read a Paper](http://ccr.sigcomm.org/online/files/p83-keshavA.pdf); one paper a week. When you'd rather watch: the explainer video, then the paper's method section and figures |
| Reproduce a paper | End to end, to learn how much is never written down. First one: your PPO matching CleanRL's published CartPole curve (Module 02) |
| Write in public | One blog post per milestone, built from your nightly notes |

**Proves it:** submit the Module 06 result to a workshop, for example at
NeurIPS, ICML or AAMAS, after qualified review.

### After SYNC: optional depth

SYNC builds and studies the bot. These three areas make it faster, bigger
and smarter at planning, and the roadmap's optional steps (the LLM planner,
the replay coach, distributed training) need them. Take them after
Milestone 6, or one at a time between modules when a build step needs one.

#### Depth A · LLMs (2–3 months)

| Topic | Read | Watch |
|---|---|---|
| Build one | [nanoGPT](https://github.com/karpathy/nanoGPT); [Stanford CS336](https://stanford-cs336.github.io/) | Karpathy: *Let's build GPT*, *Let's reproduce GPT-2*, *Let's build the GPT Tokenizer*, *Deep Dive into LLMs*; CS336 2025 lectures on YouTube |
| Core papers | [Attention](https://arxiv.org/abs/1706.03762), [scaling laws](https://arxiv.org/abs/2001.08361), [LoRA](https://arxiv.org/abs/2106.09685), [QLoRA](https://arxiv.org/abs/2305.14314) | [Umar Jamil](https://www.youtube.com/@umarjamilai) on Transformers, LoRA and quantization |
| Post-training | RLHF, [DPO](https://arxiv.org/abs/2305.18290), GRPO from [DeepSeekMath](https://arxiv.org/abs/2402.03300); [TRL](https://huggingface.co/docs/trl) `SFTTrainer`, `DPOTrainer`, `GRPOTrainer` | Umar Jamil on RLHF and DPO; CS336 alignment lectures |

**Proves it:** the once-a-second subgoal planner on lever levels, plus a small model fine-tuned on (level, plan) pairs.

#### Depth B · Inference and GPU programming (2–4 months)

| Topic | Read | Watch |
|---|---|---|
| Serving | [vLLM / PagedAttention](https://arxiv.org/abs/2309.06180); [vLLM quickstart](https://docs.vllm.ai/en/latest/getting_started/quickstart.html) (run it in WSL2); continuous batching; [speculative decoding](https://arxiv.org/abs/2211.17192); [GPTQ](https://arxiv.org/abs/2210.17323); [AWQ](https://arxiv.org/abs/2306.00978) | The vLLM team's Ray Summit talk; CS336 inference lecture |
| Attention kernels | FlashAttention [1](https://arxiv.org/abs/2205.14135), [2](https://arxiv.org/abs/2307.08691), [3](https://arxiv.org/abs/2407.08608) | Umar Jamil, *Flash Attention derived and coded from first principles with Triton* |
| CUDA | Hwu, Kirk & El Hajj, *Programming Massively Parallel Processors* (threads, memory, tiling first) | [GPU MODE](https://www.youtube.com/@GPUMODE) PMPP reading-group lectures; freeCodeCamp CUDA course (Elliot Arledge) |
| Triton | [Official tutorials](https://triton-lang.org/main/getting-started/tutorials/index.html) 01–03 | [GPU MODE lectures](https://github.com/gpu-mode/lectures), including the Triton practitioner lecture |
| Profiling | [Nsight Systems](https://docs.nvidia.com/nsight-systems/UserGuide/index.html) and Nsight Compute | NVIDIA's Nsight intro videos; GPU MODE lecture 1 |
| In the browser | [PyTorch ONNX export](https://pytorch.org/tutorials/beginner/onnx/export_simple_model_to_onnx_tutorial.html); [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) on WebGPU | — |

**Proves it:** a Triton observation-encoder kernel, the vLLM replay coach with measured throughput, and the bot inside the latency budget.

#### Depth C · Distributed systems and MLOps (2–3 months)

| Topic | Read | Watch |
|---|---|---|
| Distributed training | PyTorch [DDP](https://pytorch.org/tutorials/intermediate/ddp_tutorial.html) and [FSDP](https://pytorch.org/tutorials/intermediate/FSDP_tutorial.html); [How to Scale Your Model](https://jax-ml.github.io/scaling-book/) | The PyTorch channel's DDP series |
| Distributed RL | [IMPALA](https://arxiv.org/abs/1802.01561), [SEED RL](https://arxiv.org/abs/1910.06591), [Sample Factory](https://github.com/alex-petrenko/sample-factory), [PufferLib](https://github.com/PufferAI/PufferLib) | — |
| Ray, then Kubernetes | [Ray Core](https://docs.ray.io/en/latest/ray-core/walkthrough.html); [KubeRay](https://docs.ray.io/en/latest/cluster/kubernetes/getting-started.html) once you're on more than one machine | Anyscale's Ray talks; [TechWorld with Nana](https://www.youtube.com/@TechWorldwithNana) Docker and Kubernetes crash courses |
| JAX | [JAX quickstart](https://docs.jax.dev/en/latest/quickstart.html). Learn it; don't port the physics | Aleksa Gordić's JAX series |
| ML systems | Chip Huyen, *Designing Machine Learning Systems*; [MLflow](https://mlflow.org/docs/latest/getting-started/); model registry; drift monitoring | [DataTalksClub MLOps Zoomcamp](https://github.com/DataTalksClub/mlops-zoomcamp) |

**Proves it:** one GPU learner fed by spot rollout workers, resuming from checkpoints, and a CI gate that ships a policy only if it beats the deployed one.

---

*Not checked while writing:* some video titles and links may have moved or
been renamed. Where a specific video wasn't certain, the table says what to
search for instead.
