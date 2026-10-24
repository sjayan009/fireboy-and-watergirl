# AI partner bot: the two-week plan

A first pass through the whole [roadmap](AI_BOT_ROADMAP.md) in 14 days. You
learn each topic on the day you build with it. Week 1 ends with a learned
bot people can play with in the browser. Week 2 makes it a good partner and
production-ready.

Two weeks will not reach the "perfect" bar in roadmap section 1. That bar is
what the improvement loop works toward after these two weeks. What two weeks
gives you: every system built once, every stage of the curriculum touched,
and a measured gap between where the bot is and where it needs to be.

## Daily shape

| Time | What |
|---|---|
| 05:30–09:30 | **Learn.** Videos at 1.5–2×, or reading. Pause and code along |
| 09:30–17:30 | **Build.** This is where the learning sticks |
| 18:00–21:30 | **Night.** Papers or explainer videos, then 30 minutes writing what you learned in your own words |
| 7+ hours | **Sleep.** Memory consolidates while you sleep; skipping it throws the day away |

Read papers as a Keshav first pass: title, abstract, figures, conclusion,
about 10 minutes. Read the method section in full only for papers your build
copies (PPO's 37 details, MAPPO, Overcooked).

**One rule if you fall behind:** cut from the optional items, never from the
evaluation, the leaderboard flag or the playable bot.

---

## Week 1 · From nothing to a learned bot in the browser

### Day 1 · The environment

- **Learn:**
  - [3Blue1Brown, Linear Algebra](https://www.3blue1brown.com/topics/linear-algebra) (about 2 h at 1.5×).
  - Strang [18.06](https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/), only the eigenvalues and SVD lectures.
  - [3Blue1Brown, Calculus](https://www.3blue1brown.com/topics/calculus); Khan Academy multivariable calculus on gradients and the Jacobian.
- **Build:**
  - Node env server: many env copies, `Snapshot.restore` as reset, binary batched protocol modelled on `protocol.ts`.
  - NumPy observation encoder: one-hot `C × 29 × 39` tiles, two BFS distance-to-door fields, the state vector. Use [From Python to NumPy](https://www.labri.fr/perso/nrougier/from-python-to-numpy/) for vectorization.
  - Python [Gymnasium](https://gymnasium.farama.org/) wrapper with the four-frame action delay and action repeat.
  - Invariant tests: same seed and actions give the same digest; restore equals rebuild; observation survives a snapshot round-trip.
  - Measure the socket cost: steps per second end to end versus the engine's raw speed.
- **Night:** [Keshav, How to Read a Paper](http://ccr.sigcomm.org/online/files/p83-keshavA.pdf); [Stat 110](https://projects.iq.harvard.edu/stat110) on expectation, variance and Markov chains.
- **Done when:** a random agent runs 1,000 episodes and the invariant tests pass. (Stage 0–1 milestone.)

### Day 2 · Scripted bot, playable, and the leaderboard flag

- **Learn:**
  - [TypeScript for JS programmers](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes.html), then read `engine/src/net/transport.ts`, `session.ts` and `snapshot.ts` end to end.
  - [Ruder's gradient descent overview](https://www.ruder.io/optimizing-gradient-descent/); [Boyd](https://web.stanford.edu/~boyd/cvxbook/) §5.1.
- **Build:**
  - Scripted bot: BFS to its own door, jump when blocked, avoid the deadly pool. Run it in the env and record its per-level results; this is the baseline.
  - `BotTransport` in a Web Worker with its own engine copy, sending bits through the session's input path only. Keep it outside `engine/src/{game,flash,box2d}`.
  - **Leaderboard flag before any bot run is recorded:** bot flag on the replay and the database row, excluded in `verified_leaderboard()`, with an RLS test proving no bot run ranks. Run it against the local Supabase stack.
- **Night:** StatQuest probability videos; start your notes file.
- **Done when:** you play level 1 in the browser with the scripted bot, and the leaderboard test passes.

### Day 3 · Deep learning and behaviour cloning

- **Learn:**
  - [Karpathy, Zero to Hero](https://karpathy.ai/zero-to-hero.html): micrograd, then *Let's build GPT*.
  - [CS231n ConvNets notes](https://cs231n.github.io/convolutional-networks/); [UDL](https://udlbook.github.io/udlbook/) or [d2l.ai](https://d2l.ai/) chapters on backprop and convnets.
  - [CS229](https://cs229.stanford.edu/) notes on bias/variance and regularization; [Géron](https://github.com/ageron/handson-ml3) chapters 2–3 notebooks.
- **Build:**
  - Conv trunk over the tile tensor plus an MLP over the state vector, profiled with `torch.profiler`.
  - Record 30–60 minutes of your own play as slot 1. Train a behaviour-cloning policy on it.
  - k-means on input traces into partner styles (Stage 2 milestone).
- **Night:** 3Blue1Brown Neural Networks series, transformer chapters.
- **Done when:** the cloned bot plays level 1 in the env; you have a profiled model (Stage 3 milestone).

### Day 4 · PPO from scratch

- **Learn:**
  - [Spinning Up](https://spinningup.openai.com/) parts 1–3 and the PPO page.
  - [CleanRL `ppo.py`](https://github.com/vwxyzjn/cleanrl) beside [The 37 Implementation Details of PPO](https://iclr-blog-track.github.io/2022/03/25/ppo-implementation-details/) and Costa Huang's walkthrough video.
  - [Mutual Information](https://www.youtube.com/@Mutual_Information) RL series.
- **Build:**
  - Your own single-file PPO. CartPole first, matching CleanRL's published curve (your first reproduction, Stage 9).
  - Then level 1: one learned character with the scripted partner, shaped reward from roadmap section 4, four-frame delay on.
  - Read and run CleanRL's DQN, A2C and SAC files.
  - TensorBoard or W&B logging; AMP and `torch.compile` from the [PyTorch tutorials](https://pytorch.org/tutorials/).
- **Night:** [Sutton & Barto](http://incompleteideas.net/book/the-book-2nd.html) chapters 3, 6 and 13; [David Silver](https://www.davidsilver.uk/teaching/) lecture 7. Then derive the policy gradient theorem on paper (Stage 0 milestone).
- **Done when:** PPO beats the scripted baseline on level 1 across at least three seeds.

### Day 5 · Evaluation, tracking and scale

- **Learn:**
  - [CS285](https://rail.eecs.berkeley.edu/deeprlcourse/) policy-gradient and actor-critic lectures.
  - [Hugging Face Deep RL](https://huggingface.co/learn/deep-rl-course), Units 1 and 8.
  - [Statistical Precipice](https://arxiv.org/abs/2108.13264) and Rishabh Agarwal's NeurIPS 2021 talk.
- **Build:**
  - The eval suite: all 32 levels, 100+ seeded episodes each; completion, grade, diamonds, deaths by cause, time, blocking. IQM and bootstrap intervals with [rliable](https://github.com/google-research/rliable).
  - [MLflow](https://mlflow.org/docs/latest/getting-started/) tracking with a model registry.
  - Rollout Docker image extended from `worker/Dockerfile`.
  - Frame-skip sweep (2, 3, 4).
  - The CI regression gate script: a candidate ships only if it beats the incumbent with no level measurably worse.
- **Night:** Steve Brunton's RL series; DeepMind x UCL RL lectures.
- **Done when:** one command reproduces the 32-level eval table.

### Day 6 · Sparse reward, search and imitation

- **Learn:**
  - [Go-Explore](https://arxiv.org/abs/1901.10995) and Yannic Kilcher's explainer.
  - [AlphaZero](https://arxiv.org/abs/1712.01815), [MuZero](https://arxiv.org/abs/1911.08265), [Surag Nair's AlphaZero tutorial](https://suragnair.github.io/posts/alphazero.html).
  - CS285 imitation-learning lecture; [DAgger](https://arxiv.org/abs/1011.0686), [GAIL](https://arxiv.org/abs/1606.03476).
- **Build:**
  - Snapshot curriculum: start episodes further and further back along successful runs.
  - A Go-Explore cell archive on top of `Snapshot.restore` for levels PPO cannot finish.
  - DAgger on the cloned bot: you correct it where it goes wrong, then retrain.
  - Train PPO across more levels with the curriculum.
- **Night:** Pieter Abbeel's *Foundations of Deep RL*; David Silver on Lex Fridman #86.
- **Done when:** the eval table shows which levels PPO finishes and which need coordination (Stage 4 milestone, reported as it stands).

### Day 7 · Ship v1

- **Learn:**
  - [PyTorch ONNX export](https://pytorch.org/tutorials/beginner/onnx/export_simple_model_to_onnx_tutorial.html); [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/).
  - Umar Jamil on quantization.
- **Build:**
  - Distill to a small model, export to ONNX, quantize to int8, re-run the eval to confirm the scores hold.
  - WebGPU in the worker with WASM fallback; lazy load; pin by content hash.
  - Model manifest: observation schema version, action repeat, supported engine versions. The client refuses a mismatch.
  - Scripted fallback whenever a decision is late. Measure p95 on the slowest laptop you can find.
  - Feature flag and kill switch.
- **Night:** write the week-1 README section and your first blog post from the notes.
- **Done when:** you play several levels in the browser with the learned bot behind a flag, inside the latency budget.

---

## Week 2 · A good partner, ready for production

### Day 8 · Multi-agent RL

- **Learn:**
  - [MARL book](https://www.marl-book.com/): Part I, then centralized training.
  - **Read in full:** [MAPPO](https://arxiv.org/abs/2103.01955) and [Overcooked-AI](https://arxiv.org/abs/1910.05789).
- **Build:**
  - MAPPO with a shared critic, both characters learning, on a lever level.
  - Measure the coordination gap: the self-trained pair versus the bot paired with the scripted and cloned partners.
- **Night:** Jakob Foerster's talks on zero-shot coordination.
- **Done when:** you have a number for the coordination gap.

### Day 9 · Partner robustness

- **Learn:** [Other-Play](https://arxiv.org/abs/2003.02979) (and why its symmetry assumption doesn't fit Fireboy and Watergirl), [Fictitious Co-Play](https://arxiv.org/abs/2110.08176), [PBT](https://arxiv.org/abs/1711.09846), [OvercookedV2](https://arxiv.org/abs/2503.17821), [curriculum design for ZSC](https://arxiv.org/abs/2503.07275).
- **Build:**
  - A partner population: past checkpoints, varied seeds and reward weights, cloned humans.
  - Fictitious Co-Play training against that population.
  - A GRU policy so the bot reads its partner's recent moves.
  - Lever curriculum starting at the lever moment; reward for helping the partner progress.
  - Blocking penalty.
- **Night:** DeepMind's PBT blog post.
- **Done when:** the coordination gap shrinks on the held-out partners.

### Day 10 · Human data, done right

- **Learn:** Chip Huyen, *Designing Machine Learning Systems*, chapters on data and evaluation; the CITI human-subjects course and the Georgia Tech IRB website.
- **Build:**
  - Training-consent opt-in and privacy-policy update draft. Opt-outs enforced with RLS, tested.
  - A dataset pipeline from stored replays: pinned engine version, versioned datasets, split by player.
  - Human-proxy partners trained on consented traces; a held-out human partner set for evaluation.
  - Start the CITI course and the IRB application if this will be research.
- **Night:** Andrew Ng's CS229 lectures on generalization.
- **Done when:** the eval suite runs against held-out human partners (Stage 5 milestone at pilot scale).

### Day 11 · LLMs

- **Learn:**
  - [CS336](https://stanford-cs336.github.io/) lecture 1 and the assignment 1 handout; CS336 alignment lectures.
  - [Attention](https://arxiv.org/abs/1706.03762), [scaling laws](https://arxiv.org/abs/2001.08361), [LoRA](https://arxiv.org/abs/2106.09685), [QLoRA](https://arxiv.org/abs/2305.14314), [DPO](https://arxiv.org/abs/2305.18290), [DeepSeekMath / GRPO](https://arxiv.org/abs/2402.03300), with Umar Jamil's explainers.
  - Karpathy: *Let's reproduce GPT-2*, *Let's build the GPT Tokenizer*, *Deep Dive into LLMs*.
- **Build:**
  - The subgoal planner: reads entity JSON and the tile grid about once a second, emits subgoals the RL controller executes. Test on the lever levels.
  - LoRA fine-tune a roughly 0.5B model on (level, plan) pairs with [TRL](https://huggingface.co/docs/trl) `SFTTrainer`; try `DPOTrainer` or `GRPOTrainer` once.
- **Night:** [SayCan](https://arxiv.org/abs/2204.01691) and [Voyager](https://arxiv.org/abs/2305.16291) demo pages.
- **Done when:** the planner measurably raises completion on a lever level (Stage 6 milestone).

### Day 12 · Inference and GPU programming

- **Learn:**
  - [vLLM quickstart](https://docs.vllm.ai/en/latest/getting_started/quickstart.html) in WSL2; [PagedAttention](https://arxiv.org/abs/2309.06180); the vLLM team's Ray Summit talk.
  - FlashAttention [1](https://arxiv.org/abs/2205.14135), [2](https://arxiv.org/abs/2307.08691), [3](https://arxiv.org/abs/2407.08608); [GPTQ](https://arxiv.org/abs/2210.17323), [AWQ](https://arxiv.org/abs/2306.00978), [speculative decoding](https://arxiv.org/abs/2211.17192).
  - [Triton tutorials](https://triton-lang.org/main/getting-started/tutorials/index.html) 01–03; Umar Jamil's FlashAttention-in-Triton video; [GPU MODE](https://github.com/gpu-mode/lectures) lecture 1 and the PMPP lectures.
- **Build:**
  - The replay coach: batch inference over stored replays on vLLM with an AWQ 7B model; measure replays per second.
  - A Triton kernel for the observation encoder, benchmarked against NumPy and PyTorch; profile with [Nsight Systems](https://docs.nvidia.com/nsight-systems/UserGuide/index.html).
- **Night:** freeCodeCamp CUDA course, the chapters on memory and tiling.
- **Done when:** both have measured numbers (Stage 7 milestone).

### Day 13 · Distributed training and operations

- **Learn:**
  - PyTorch [DDP](https://pytorch.org/tutorials/intermediate/ddp_tutorial.html) and [FSDP](https://pytorch.org/tutorials/intermediate/FSDP_tutorial.html); [How to Scale Your Model](https://jax-ml.github.io/scaling-book/) parts 1–3; [JAX quickstart](https://docs.jax.dev/en/latest/quickstart.html).
  - [IMPALA](https://arxiv.org/abs/1802.01561), [SEED RL](https://arxiv.org/abs/1910.06591), [Sample Factory](https://github.com/alex-petrenko/sample-factory), [PufferLib](https://github.com/PufferAI/PufferLib).
  - [Ray Core](https://docs.ray.io/en/latest/ray-core/walkthrough.html); [KubeRay quickstart](https://docs.ray.io/en/latest/cluster/kubernetes/getting-started.html); TechWorld with Nana on Docker and Kubernetes; [MLOps Zoomcamp](https://github.com/DataTalksClub/mlops-zoomcamp) on monitoring.
- **Build:**
  - Ray rollout workers feeding one GPU learner; checkpoint and resume after a killed worker.
  - KubeRay on a local `kind` cluster, to learn it.
  - Telemetry within the free-tier budget: inference p50/p95, fallback rate, load failures, per-level completion and abandonment.
  - Staged rollout, kill switch, one-click rollback; the CI gate wired into the workflow.
- **Night:** Huyen's chapters on deployment and monitoring.
- **Done when:** training survives a killed worker, and a bad model can be rolled back in one step (Stage 8 milestone at single-machine scale).

### Day 14 · Release v2 and close the loop

- **Build:**
  - Optional: runtime MCTS from snapshot restores in the worker, guided by the policy, on the hardest levels.
  - Full eval against every row of the "perfect" bar. Write down which rows pass and which don't.
  - Staged release of v2 behind the flag.
  - README: the eval table, the coordination result, a demo link, and a plain statement that the LLM does not play the game.
  - A 60-second video; a blog post; a 4-page workshop outline around the coordination result (Stage 9).
- **Done when:** v2 is live behind a flag, and you have a written list of the bars it misses. That list is the next cycle's plan.

---

## After the two weeks

Repeat the improvement loop from roadmap section 11 until every row of the
"perfect" bar passes: consented replays → failure taxonomy → targeted fix →
retrain → CI gate → staged release. Deepen one curriculum stage per cycle,
starting with Stage 5.
