# AI partner bot: the complete roadmap

Everything needed to build, refine and run in production a bot that plays the
second character in Fireboy & Watergirl, so one person can play alone. It
builds on [AI_BOT_FEASIBILITY.md](AI_BOT_FEASIBILITY.md). The day-by-day
schedule is in [AI_BOT_TWO_WEEK_PLAN.md](AI_BOT_TWO_WEEK_PLAN.md).

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
| Correctness | Zero desyncs; replays of bot games verify; the CI determinism digests unchanged |
| Integrity | Zero bot runs in leaderboard rankings, proved by a test |
| Regressions | No level gets measurably worse release to release (confidence intervals, not single runs) |

---

## 2. The game as an RL problem

Facts from the code, not estimates.

- **Timing.** The simulation steps at a fixed 26 Hz (`TIME_STEP = 1/26` in
  `engine/src/embed.ts`), about 38.5 ms per frame.
- **Actions.** Three bits per character: left = 1, right = 2, up = 4. Eight
  actions each, no down key. `packInput` in `engine/src/net/hash.ts` packs both
  characters into six bits per frame.
- **Input lead.** `session.setLocalInput` keeps three bits, and each frame's
  input is decided once, several frames ahead, and never revised.
  IMPLEMENTATION_RESULTS_17.md puts that lead at four frames, about 154 ms. The
  bot chooses frame t+4's input while looking at frame t. **Train with that
  four-frame action delay built in**, or the policy that worked in training
  fails live.
- **World.** Each level is a 29 × 39 tile grid plus 316 entity placements in
  `extracted/entities/*.json`: levers, pushers, platforms, wind, pulleys,
  boxes and doors. Water kills Fireboy, lava kills Watergirl, green goo kills
  both. The tile codes are in `extracted/LEVEL_FORMAT.md`.
- **Determinism.** The simulation is a pure function of (mode, level, input
  log), checked across V8, SpiderMonkey and JavaScriptCore. Only the bits
  enter the log, so the policy itself does not need to be deterministic.
  WebGPU floating-point drift between devices cannot desync a game or break
  replay verification.
- **Speed.** A step costs 0.0135 ms (about 2,800× real time per core).
  Rebuilding a level costs 20 ms; restoring a snapshot costs 4 ms. Reset by
  restoring a snapshot, then replay forward.
- **Grades.** The game's own `TimeTable` defines the medal thresholds, so
  "played well" has an objective answer the original authors defined.
- **Replays.** The session already produces
  `{version, engine, mode, num, frames, inputs, commands}` for every game
  (`engine/src/net/session.ts`). That is a ready-made dataset format.

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

### Runtime side

```
┌──────────── browser ─────────────┐
│  GameView ── NetSession(slot 0)  │
│                   │              │
│              Transport           │
│                   │              │
│            BotTransport ─────────┼──▶ Web Worker
│                                  │      ├─ its own engine copy
└──────────────────────────────────┘      ├─ observation encoder
                                          ├─ ONNX Runtime Web (WebGPU, WASM fallback)
                                          └─ policy → 3 bits
```

- `BotTransport` implements the five-method `Transport` interface in
  `engine/src/net/transport.ts`. To the game the bot is just a peer, so
  rollback, pause, retry, results, watch mode and replays all keep working.

### Two rules about where code lives

- **Never put bot code in `engine/src/{game,flash,box2d}`.** `ENGINE_VERSION`
  hashes those folders, and peers on different builds refuse to pair.
- **Bot input only ever enters through the session's input path**, never by
  setting `lv.l_pressed2` directly. Going around the session corrupts the
  input log, the desync check and the replay verifier the leaderboard trusts.

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
    flags, lever and pusher states, door states, elapsed time.
  - Give the observation a **schema version** number and ship it with every
    model.
- **Actions.** Repeat each action for 2–4 frames and sweep that as a
  hyperparameter. Apply the four-frame input delay on top.
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
- **Termination.** Death, both doors reached, or a time limit. Mark the time
  limit as *truncation*, not termination, or your value estimates are biased.
- **Invariant tests, pinned in CI next to the determinism digests.**
  - Same seed and actions give the same digest.
  - A restore gives the same state as a rebuild.
  - The observation is unchanged by a snapshot round-trip.
  - The four-frame delay is applied exactly.

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
   varied seeds and reward weights, and cloned human partners. This is
   Fictitious Co-Play, the main defence against a bot that only works with
   itself.
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
- **Partner set.** Scripted, cloned humans, and held-out real human traces,
  **split by player, not by episode**, so no player leaks between training
  and test.
- **Statistics.** IQM with bootstrap confidence intervals
  ([rliable](https://github.com/google-research/rliable)), several training
  seeds, no cherry-picking.
- **Regression gate in CI.** A new model ships only if it beats the deployed
  one on the suite and no level gets meaningfully worse. The repo already
  gates deploys on `dist/version.txt`; do the same for the policy.
- **Online, with consent.** Completion with the bot versus the same people
  controlling both characters, quit rate, replay rate. For research use, get
  Georgia Tech IRB approval first.

---

## 8. Data

Your unfair advantage: a live deployment with real players.

- The app already records replays (section 2). That is a dataset of human
  play.
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
  when solo-with-bot starts, cache it, pin it by content hash.
- **Latency.** The four-frame lead gives about 154 ms to decide. Aim for
  under 5 ms p95 so slow devices stay safe. Measure on a low-end laptop, not
  an RTX 4060. If a decision is late, use the scripted bot for that frame;
  never stall.
- **Versioning.** Every model declares its observation schema version, its
  action-repeat setting and the engine versions it supports. The client
  refuses an incompatible model.
- **Rollout.** Feature flag, staged rollout, kill switch, one-click rollback
  to the previous model.

---

## 10. Integrity

- Add a bot flag to the replay format and the database rows, and exclude
  flagged runs in `verified_leaderboard()` at the data layer. **Decide this
  before the first bot run is recorded**; retrofitting means guessing which
  historical rows were assisted.
- The replay verifier proves a run is *valid*, not that a *human* played it.
  Anyone can already script inputs on the client, and a public bot makes that
  easier. The flag keeps honest use honest. Proving a human played would need
  server-side anti-cheat, so do not claim it.

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

- Training without the four-frame action delay.
- Editing `engine/src/{game,flash,box2d}`, which changes `ENGINE_VERSION`.
- Injecting input outside the session.
- Shipping before the leaderboard flag exists.
- Splitting human data by episode instead of by player.
- Benchmarking latency on your own GPU.
- Recording replays without consent.
- Putting an LLM in the per-frame action path.
- Building a server or Kubernetes cluster to *serve* the bot. It runs in the
  browser; a serving cluster adds cost and latency to a static app.

---

## 14. Build order

Ship something at every step.

1. **Scripted bot behind `BotTransport`.** People can already play solo.
2. **Environment, eval suite and invariant tests.** Every later claim
   depends on these.
3. **Cloned-from-humans bot and single-character PPO.** The bot visibly
   improves.
4. **Bot flag, data opt-in, ONNX/WebGPU runtime with fallback.** First real
   public release.
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
| TypeScript and Node | [TypeScript for JS programmers](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes.html), then read `engine/src/net/session.ts`, `snapshot.ts`, `transport.ts` |

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
