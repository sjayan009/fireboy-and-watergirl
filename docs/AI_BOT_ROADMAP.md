# AI partner bot: the complete roadmap

Everything needed to build, refine and run in production a bot that plays the
second character in Fireboy & Watergirl, so one person can play alone. The
bot lives in one place: **Local Play → Solo + AI** on the hosted site, the
card that already shows greyed as "With a robot buddy · soon" next to Two
Players (`app/src/ui/modecards.ts:239`). It never plays online. It builds
on [AI_BOT_FEASIBILITY.md](AI_BOT_FEASIBILITY.md). The day-by-day schedule
is in [AI_BOT_TWO_WEEK_PLAN.md](AI_BOT_TWO_WEEK_PLAN.md).

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
15. [The learning curriculum, Stages 0–9](#15-the-learning-curriculum-stages-09)

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
- **The level's first frame.** The env runs each level's first frame with no
  input before the bot sees it, because a level fresh from its constructor is
  not a state play shows (levers at ±90°, every fan on). So on the website the
  bot sends nothing for the level's first frame and starts deciding from the
  state after it; the human's keys in that one frame still count, a 1/26 s
  difference. `engine/src/bot/envlive.ts` checks the env against the whole
  game on exactly that rule.
- **Actions.** Three bits per character: left = 1, right = 2, up = 4. Eight
  actions each, no down key. The level reads them as `l_pressed`,
  `r_pressed`, `u_pressed` (Fireboy, arrow keys) and the `2` variants
  (Watergirl, W/A/D), written by `Game.keyPressed` and `keyReleased`
  (`engine/src/game/game.ts:4737`, `:4894`). `packInput` in
  `engine/src/net/hash.ts` packs both characters into six bits per frame.
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
  `detSin(this.timecount / 10)` (`game.ts:2041`).
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
  The env server already sits outside them, in `engine/src/bot/`.

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
- **A TypeScript observation encoder.** The encoder and the BFS fields exist
  only in Python (`bot/fbwg_env.py`). The browser needs a TypeScript copy and
  a parity test that both produce identical observations for the same state,
  gated by `SCHEMA_VERSION`.
- **Which character the bot plays.** Done in the env: `reset` takes `side`
  and `encode` ends the vector with it. The runtime must pass the side the
  player picked.

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
   the method, and a write-up fits Stage 9.

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
  against `bot/fbwg_env.py` for the model's `SCHEMA_VERSION` (section 3, open
  items).
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

---

## 14. Build order

Ship something at every step.

1. **Scripted bot in Local Play → Solo + AI.** People can already play solo.
2. **Environment, eval suite and invariant tests.** Every later claim
   depends on these.
3. **Cloned-from-humans bot and single-character PPO.** The bot visibly
   improves.
4. **The save decision, data opt-in, the TypeScript encoder with its parity
   test, ONNX/WebGPU runtime with fallback.** First real public release.
5. **MAPPO, partner diversity, recurrent policy.** It becomes a good partner.
6. **Runtime search and the LLM planner for lever levels.** It handles the
   hardest levels.
7. **The operations loop:** telemetry, CI gate, retraining. From here it keeps
   improving on a schedule.

---

## 15. The learning curriculum, Stages 0–9

T-shaped: broad enough to build the whole system, very deep in one area. For
this project the deep area is **multi-agent RL and human–AI coordination**.
Each stage ends with a milestone in this repo that proves it. Full time,
about 18–30 months for real depth; the two-week plan is the first pass.

Two habits for every stage: watch videos at 1.5–2× and pause to code along,
and write what you learned in your own words each night.

### Stage 0 · Math (4–6 weeks)

| Topic | Read | Watch |
|---|---|---|
| Linear algebra | [Strang, MIT 18.06](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/) | [3Blue1Brown, Essence of Linear Algebra](https://www.3blue1brown.com/topics/linear-algebra); Strang's 18.06 lectures, especially eigenvalues and SVD |
| Calculus | Multivariable: gradients, chain rule as Jacobians | [3Blue1Brown, Essence of Calculus](https://www.3blue1brown.com/topics/calculus); Khan Academy multivariable calculus on gradients and the Jacobian |
| Probability | [Blitzstein, Stat 110](https://projects.iq.harvard.edu/stat110): expectation, variance, Markov chains | Stat 110 lectures on YouTube; [StatQuest](https://www.youtube.com/@statquest) |
| Optimization | [Boyd, Convex Optimization](https://web.stanford.edu/~boyd/cvxbook/), §5.1 and selected chapters; [Ruder's gradient descent overview](https://www.ruder.io/optimizing-gradient-descent/) | Boyd's EE364A lectures 1–2 |

**Proves it:** derive the policy gradient theorem on paper without looking it up.

### Stage 1 · Programming foundations (2–3 weeks, overlaps Stage 0)

| Topic | Resource |
|---|---|
| Python | Fluent Python 3.11+, type hints, profiling with `cProfile` |
| NumPy | [Rougier, From Python to NumPy](https://www.labri.fr/perso/nrougier/from-python-to-numpy/), especially vectorization |
| TypeScript and Node | [TypeScript for JS programmers](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes.html), then read `engine/src/embed.ts` (`tick`, `step`), `engine/src/net/snapshot.ts` and `engine/src/bot/envserver.ts` |

Docs and code-along beat videos here.

**Proves it:** the env server, the observation encoder and the BFS distance fields.

### Stage 2 · Classical ML (3 weeks)

| Topic | Read | Watch |
|---|---|---|
| Theory | [Stanford CS229](https://cs229.stanford.edu/) notes: bias/variance, regularization, generalization | Andrew Ng's CS229 (Autumn 2018) on YouTube |
| Practice | [Géron, Hands-On Machine Learning](https://github.com/ageron/handson-ml3), Part I (chapters 2–3 notebooks in Colab) | StatQuest on k-means |

**Proves it:** cluster recorded human input traces into partner styles, and train a behaviour-cloning baseline.

### Stage 3 · Deep learning (6–8 weeks)

| Topic | Read | Watch |
|---|---|---|
| From scratch | — | [Karpathy, Neural Networks: Zero to Hero](https://karpathy.ai/zero-to-hero.html), micrograd to GPT. The best single resource here |
| Textbook | [Prince, Understanding Deep Learning](https://udlbook.github.io/udlbook/) or [d2l.ai](https://d2l.ai/) | 3Blue1Brown's Neural Networks series, including the transformer chapters |
| Convolutional nets | [CS231n ConvNets notes](https://cs231n.github.io/convolutional-networks/) | [CS231n](https://cs231n.stanford.edu/) lectures on YouTube |
| PyTorch internals | [PyTorch tutorials](https://pytorch.org/tutorials/): autograd, `torch.compile`, AMP, profiler | The PyTorch YouTube channel |

**Proves it:** a conv-net policy trunk over the `C × 29 × 39` tile tensor, profiled.

### Stage 4 · Reinforcement learning (8–12 weeks, the core)

| Topic | Read | Watch |
|---|---|---|
| Foundations | [Sutton & Barto](http://incompleteideas.net/book/the-book-2nd.html), cover to cover (chapters 3, 6, 13 first) | [David Silver's lectures](https://www.davidsilver.uk/teaching/) (lecture 7 on policy gradients); [Mutual Information](https://www.youtube.com/@Mutual_Information) RL series; [Steve Brunton](https://www.youtube.com/@Eigensteve) RL series; DeepMind x UCL RL lectures (Hado van Hasselt, 2021) |
| Deep RL | [Spinning Up](https://spinningup.openai.com/) parts 1–3 and the PPO page; [Hugging Face Deep RL course](https://huggingface.co/learn/deep-rl-course), Units 1 and 8 | [Berkeley CS285](https://rail.eecs.berkeley.edu/deeprlcourse/) with homework: imitation learning, policy gradients, actor-critic, planning; Pieter Abbeel's *Foundations of Deep RL* (6 lectures) |
| Implement it | [CleanRL](https://github.com/vwxyzjn/cleanrl) `ppo.py`; [The 37 Implementation Details of PPO](https://iclr-blog-track.github.io/2022/03/25/ppo-implementation-details/). Write DQN, A2C, PPO and SAC | Costa Huang's walkthrough video, linked from the 37-details post |
| Honest evaluation | [Statistical Precipice](https://arxiv.org/abs/2108.13264) and [rliable](https://github.com/google-research/rliable) | Rishabh Agarwal's NeurIPS 2021 talk |
| Search and planning | MCTS; [AlphaZero](https://arxiv.org/abs/1712.01815); [MuZero](https://arxiv.org/abs/1911.08265); [Surag Nair's AlphaZero tutorial](https://suragnair.github.io/posts/alphazero.html) | [Yannic Kilcher](https://www.youtube.com/@YannicKilcher) on MuZero; David Silver on the Lex Fridman Podcast #86 |
| Sparse reward | [Go-Explore](https://arxiv.org/abs/1901.10995) | Yannic Kilcher on Go-Explore |
| Imitation | Behaviour cloning, [DAgger](https://arxiv.org/abs/1011.0686), [GAIL](https://arxiv.org/abs/1606.03476) | CS285 imitation-learning lecture |

**Proves it:** a single-agent PPO bot that beats the scripted baseline on all 32 levels, with confidence intervals.

### Stage 5 · Multi-agent RL and coordination (3–6 months, the depth area)

| Topic | Read | Watch |
|---|---|---|
| Textbook | [Albrecht, Christianos & Schäfer, Multi-Agent RL](https://www.marl-book.com/) (2024): Part I, then centralized training | The book's site has slides |
| MAPPO | [The Surprising Effectiveness of PPO in Cooperative MARL](https://arxiv.org/abs/2103.01955). **Read this one** | — |
| Overcooked-AI | [Carroll et al. 2019](https://arxiv.org/abs/1910.05789): why self-trained bots fail with humans. **Read this one** | — |
| Zero-shot coordination | [Other-Play](https://arxiv.org/abs/2003.02979); [Fictitious Co-Play](https://arxiv.org/abs/2110.08176); [OvercookedV2](https://arxiv.org/abs/2503.17821); [curriculum design for ZSC](https://arxiv.org/abs/2503.07275) | Search YouTube for Jakob Foerster's talks on zero-shot coordination |
| Population-based training | [PBT](https://arxiv.org/abs/1711.09846) | DeepMind's PBT blog post |
| Human studies | Running user studies; CITI human-subjects training and Georgia Tech IRB approval before recording players for research | — |

**Proves it:** a measured result on how well the bot completes levels with held-out human partners. Publishable.

### Stage 6 · LLMs (2–3 months)

| Topic | Read | Watch |
|---|---|---|
| Build one | [nanoGPT](https://github.com/karpathy/nanoGPT); [Stanford CS336](https://stanford-cs336.github.io/) | Karpathy: *Let's build GPT*, *Let's reproduce GPT-2*, *Let's build the GPT Tokenizer*, *Deep Dive into LLMs*; CS336 2025 lectures on YouTube |
| Core papers | [Attention](https://arxiv.org/abs/1706.03762), [scaling laws](https://arxiv.org/abs/2001.08361), [LoRA](https://arxiv.org/abs/2106.09685), [QLoRA](https://arxiv.org/abs/2305.14314) | [Umar Jamil](https://www.youtube.com/@umarjamilai) on Transformers, LoRA and quantization |
| Post-training | RLHF, [DPO](https://arxiv.org/abs/2305.18290), GRPO from [DeepSeekMath](https://arxiv.org/abs/2402.03300); [TRL](https://huggingface.co/docs/trl) `SFTTrainer`, `DPOTrainer`, `GRPOTrainer` | Umar Jamil on RLHF and DPO; CS336 alignment lectures |
| LLMs as planners | [SayCan](https://arxiv.org/abs/2204.01691), [Voyager](https://arxiv.org/abs/2305.16291) | Demo videos at say-can.github.io and voyager.minedojo.org |

**Proves it:** the once-a-second subgoal planner on lever levels, plus a small model fine-tuned on (level, plan) pairs.

### Stage 7 · Inference and GPU programming (2–4 months)

| Topic | Read | Watch |
|---|---|---|
| Serving | [vLLM / PagedAttention](https://arxiv.org/abs/2309.06180); [vLLM quickstart](https://docs.vllm.ai/en/latest/getting_started/quickstart.html) (run it in WSL2); continuous batching; [speculative decoding](https://arxiv.org/abs/2211.17192); [GPTQ](https://arxiv.org/abs/2210.17323); [AWQ](https://arxiv.org/abs/2306.00978) | The vLLM team's Ray Summit talk; CS336 inference lecture |
| Attention kernels | FlashAttention [1](https://arxiv.org/abs/2205.14135), [2](https://arxiv.org/abs/2307.08691), [3](https://arxiv.org/abs/2407.08608) | Umar Jamil, *Flash Attention derived and coded from first principles with Triton* |
| CUDA | Hwu, Kirk & El Hajj, *Programming Massively Parallel Processors* (threads, memory, tiling first) | [GPU MODE](https://www.youtube.com/@GPUMODE) PMPP reading-group lectures; freeCodeCamp CUDA course (Elliot Arledge) |
| Triton | [Official tutorials](https://triton-lang.org/main/getting-started/tutorials/index.html) 01–03 | [GPU MODE lectures](https://github.com/gpu-mode/lectures), including the Triton practitioner lecture |
| Profiling | [Nsight Systems](https://docs.nvidia.com/nsight-systems/UserGuide/index.html) and Nsight Compute | NVIDIA's Nsight intro videos; GPU MODE lecture 1 |
| In the browser | [PyTorch ONNX export](https://pytorch.org/tutorials/beginner/onnx/export_simple_model_to_onnx_tutorial.html); [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) on WebGPU | — |

**Proves it:** a Triton observation-encoder kernel, the vLLM replay coach with measured throughput, and the bot inside the latency budget.

### Stage 8 · Distributed systems and MLOps (2–3 months)

| Topic | Read | Watch |
|---|---|---|
| Distributed training | PyTorch [DDP](https://pytorch.org/tutorials/intermediate/ddp_tutorial.html) and [FSDP](https://pytorch.org/tutorials/intermediate/FSDP_tutorial.html); [How to Scale Your Model](https://jax-ml.github.io/scaling-book/) | The PyTorch channel's DDP series |
| Distributed RL | [IMPALA](https://arxiv.org/abs/1802.01561), [SEED RL](https://arxiv.org/abs/1910.06591), [Sample Factory](https://github.com/alex-petrenko/sample-factory), [PufferLib](https://github.com/PufferAI/PufferLib) | — |
| Ray, then Kubernetes | [Ray Core](https://docs.ray.io/en/latest/ray-core/walkthrough.html); [KubeRay](https://docs.ray.io/en/latest/cluster/kubernetes/getting-started.html) once you're on more than one machine | Anyscale's Ray talks; [TechWorld with Nana](https://www.youtube.com/@TechWorldwithNana) Docker and Kubernetes crash courses |
| JAX | [JAX quickstart](https://docs.jax.dev/en/latest/quickstart.html). Learn it; don't port the physics | Aleksa Gordić's JAX series |
| ML systems | Chip Huyen, *Designing Machine Learning Systems*; [MLflow](https://mlflow.org/docs/latest/getting-started/); model registry; drift monitoring | [DataTalksClub MLOps Zoomcamp](https://github.com/DataTalksClub/mlops-zoomcamp) |

**Proves it:** one GPU learner fed by spot rollout workers, resuming from checkpoints, and a CI gate that ships a policy only if it beats the deployed one.

### Stage 9 · Research skills (ongoing, start now)

| Habit | Resource |
|---|---|
| Read papers | [Keshav, How to Read a Paper](http://ccr.sigcomm.org/online/files/p83-keshavA.pdf); one paper a week. When you'd rather watch: the explainer video, then the paper's method section and figures |
| Reproduce a paper | End to end, to learn how much is never written down. First one: your PPO matching CleanRL's published CartPole curve |
| Write in public | One blog post per milestone, built from your nightly notes |

**Proves it:** submit the Stage 5 result to a workshop, for example at NeurIPS, ICML or AAMAS.

---

*Not checked while writing:* some video titles and links may have moved or
been renamed. Where a specific video wasn't certain, the table says what to
search for instead.
