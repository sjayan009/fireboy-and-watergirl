# AI partner bot: the two-week plan

A sprint through the first three modules of the SYNC curriculum
([roadmap](AI_BOT_ROADMAP.md) section 15) in 14 days. You learn each topic on
the day you build with it. Week 1 ends with PPO you understand from the
inside, on problems small enough to debug. Week 2 rebuilds the Fireboy
environment and ends with a scripted bot people can play with in the
browser, under Local Play → Solo + AI. The bot never plays online.

Two weeks will not give SYNC's twelve weeks of depth. What they give you:
every Module 01–03 deliverable built once, Milestones 1–3 shipped, and a
scripted-bot baseline on all 32 levels that every learned bot after it has to
beat. Modules 04–06 follow at SYNC's own pace.

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

Every day ends with the SYNC proof: a program you can rerun, an output (a
plot, a table, a trace) and a written explanation in your notes.

**One rule if you fall behind:** cut from the optional items, never from the
evaluation, the invariant tests or the playable bot.

---

## Week 1 · From a gridworld to PPO you understand

Modules 01 and 02. All of it lives on `ai-rl-research`, beside your ML
notes, not in the game.

### Day 1 · The loop and the math (SYNC weeks 1–2)

- **Learn:**
  - [Spinning Up, RL intro](https://spinningup.openai.com/en/latest/spinningup/rl_intro.html); draw the observation → action → environment → reward loop.
  - [3Blue1Brown, Linear Algebra](https://www.3blue1brown.com/topics/linear-algebra) (about 2 h at 1.5×) and [Calculus](https://www.3blue1brown.com/topics/calculus).
  - [Gymnasium, custom environment](https://gymnasium.farama.org/main/introduction/create_custom_env/).
- **Build:**
  - `research/01_gridworld`: a 5×5 board, `reset(seed)` and `step(action)` returning observation, reward, terminated, truncated, info.
  - A random policy and a shortest-path policy, 100 episodes each; mean return and success rate plotted.
  - `math_sanity.py`: a stable log-sum-exp softmax, a numeric gradient checked against your hand derivative, and the expected reward of a two-action policy, as five assertions.
- **Night:** [Keshav, How to Read a Paper](http://ccr.sigcomm.org/online/files/p83-keshavA.pdf); Bayes' rule with a cautious-partner and bold-partner example in your notes.
- **Done when:** `random_vs_scripted.png` exists, the five assertions pass, and you can define observation, policy, reward, episode, return and discount without notes.

### Day 2 · Values and Bellman (SYNC week 3)

- **Learn:**
  - [Hugging Face, Q-learning unit](https://huggingface.co/learn/deep-rl-course/en/unit2/introduction).
  - [Sutton & Barto](http://incompleteideas.net/book/the-book-2nd.html) chapters 3 and 6.
- **Build:**
  - A 3-state chain MDP worked by hand with γ = 0.9.
  - Tabular Q-learning with ε-greedy on the gridworld, reward logged every 100 episodes.
  - γ = 0 against γ = 0.99, with the behaviour explained in your own words.
  - Optional: SARSA, and how on-policy updates differ.
- **Night:** [David Silver's lectures](https://www.davidsilver.uk/teaching/) 1–3.
- **Done when:** you can write the Q-learning update from memory and explain every term, and the reward curve is an average over many episodes, not one lucky run.

### Day 3 · A clean experiment (SYNC week 4)

- **Learn:**
  - [Spinning Up, becoming an RL researcher](https://spinningup.openai.com/en/latest/spinningup/spinningup.html).
  - [Statistical Precipice](https://arxiv.org/abs/2108.13264), first pass.
- **Build:**
  - The gridworld as a proper Gymnasium env.
  - Training seeds apart from evaluation seeds, evaluation settings frozen.
  - Random, rule-based and Q-learning over 5 seeds: median, mean, spread, episodes to goal.
  - A methods-and-limitations page, pinned package versions, and the results log you'll keep from here on (commit, seed, command, number).
  - Optional: a bootstrap confidence interval.
- **Night:** write up Milestone 1.
- **Done when:** one command reproduces the evaluation table from a fresh clone (Milestone 1).

### Day 4 · Neural networks (SYNC week 5)

- **Learn:**
  - [PyTorch, learn the basics](https://docs.pytorch.org/tutorials/beginner/basics/intro.html): tensors, autograd, modules, optimizers, save and load.
  - [Karpathy, Zero to Hero](https://karpathy.ai/zero-to-hero.html): micrograd.
- **Build:**
  - Finish `ML-Research/ml_from_scratch.py`, the two-layer network in raw NumPy.
  - The same network in PyTorch on a small classification task, with training and validation loss, and overfitting found on purpose.
  - A gradient check that asserts no NaNs after backprop.
  - An observation → logits → action sampler over 6 actions, the size Fireboy will need.
- **Night:** 3Blue1Brown's Neural Networks series.
- **Done when:** you train, save and reload a model and get the same outputs, and can explain forward pass, loss, backward pass and optimizer step.

### Day 5 · DQN and policy gradients (SYNC weeks 6–7)

- **Learn:**
  - [PyTorch DQN tutorial](https://docs.pytorch.org/tutorials/intermediate/reinforcement_q_learning.html); draw its data flow.
  - [Spinning Up](https://spinningup.openai.com/) part 3; [CS285](https://rail.eecs.berkeley.edu/deeprlcourse/) policy-gradient lecture.
- **Build:**
  - DQN on CartPole: replay buffer, online and target networks, three seeds.
  - The same run without the target network, to watch it go unstable.
  - REINFORCE on CartPole, then with a value baseline; variance across seeds.
  - Optional: Double DQN.
- **Night:** David Silver lecture 7; [Mutual Information](https://www.youtube.com/@Mutual_Information) RL series.
- **Done when:** `target_network_ablation.png` and `baseline_vs_no_baseline.png` exist over three seeds, and you can say why a baseline reduces variance.

### Day 6 · PPO from both sides (SYNC week 8)

- **Learn:**
  - [Spinning Up, PPO](https://spinningup.openai.com/en/latest/algorithms/ppo.html).
  - [CleanRL `ppo.py`](https://docs.cleanrl.dev/) beside [The 37 Implementation Details of PPO](https://iclr-blog-track.github.io/2022/03/25/ppo-implementation-details/) and Costa Huang's walkthrough video.
- **Build:**
  - [Stable-Baselines3 PPO](https://stable-baselines3.readthedocs.io/en/master/modules/ppo.html) on CartPole as the known-good reference.
  - CleanRL's training loop annotated line by line, then your own single-file PPO matching its published curve.
  - DQN against PPO over at least 5 seeds with the same evaluation.
  - A trained policy exported and run without the training libraries; note its size.
  - Optional: the clipped objective as a unit-tested function.
- **Night:** [Hugging Face PPO unit](https://huggingface.co/learn/deep-rl-course/en/unit8/introduction).
- **Done when:** the DQN-vs-PPO table holds over 5 seeds and the exported policy runs on its own (Milestone 2).

### Day 7 · Consolidate

- **Build:**
  - Derive the policy gradient theorem on paper without looking it up.
  - Whiteboard the PPO loop and name three causes of unstable learning.
  - Clean up the Milestone 1 and 2 code so a stranger can run it.
- **Night:** your first blog post, from the week's notes.
- **Done when:** both milestones rerun from a clean clone, and the derivation is in your notes.

---

## Week 2 · From the engine to a bot you can play with

Module 03. The environment code goes in `engine/src/bot/` and `bot/` on
`ai-rl-bot`, as the first env's did, never in `engine/src/{game,flash,box2d}`.
Write it yourself first; compare with the first env at `0a37180` only after.

### Day 8 · Read the engine (SYNC week 9)

- **Learn:**
  - [TypeScript for JS programmers](https://www.typescriptlang.org/docs/handbook/typescript-in-5-minutes.html).
  - Roadmap section 2, then `engine/src/net/levelhost.ts`, `hash.ts`, `snapshot.ts` (the "Restoring in place" header) and `step` in `engine/src/embed.ts`.
- **Build:**
  - Trace `LevelHost.start`, `step` and `hash`, and `applyInput`'s six bits.
  - Run the engine's determinism and replay tests; record the commit.
  - A Node script that runs level 1 for 100 steps and prints both characters' positions.
  - Count world steps per frame in `LevelHost.step` against `embed.ts`: the first runs two, the second one (roadmap section 2).
  - `engine_map.md`: how the level, its physics, snapshots and input logs connect.
- **Night:** roadmap section 4's ten lessons, as a checklist for the next four days.
- **Done when:** you can explain why headless replay works and why a snapshot restores objects in place.

### Day 9 · The environment API (SYNC week 10, first half)

- **Learn:** [From Python to NumPy](https://www.labri.fr/perso/nrougier/from-python-to-numpy/) on vectorization.
- **Build:**
  - A Node facade over one level: `frame()` stepped the way `embed.ts` does, never `LevelHost.step`.
  - Snapshot before the level's first frame; reset by restoring it (never rebuilding), with the clock saved and restored beside it.
  - `reset(mode, level, seed, side, delay, first)` and `step(bits)` over a JSON-lines bridge; a handshake carrying the schema version, `ENGINE_VERSION` and field names, refused on mismatch.
  - The Python Gymnasium wrapper.
- **Night:** `contract.md`: every message, every field, and what the policy is not allowed to see.
- **Done when:** two identical fresh episodes give matching hashes, observations and rewards.

### Day 10 · Checks before features (SYNC week 10, second half)

- **Build:**
  - Invariant tests: same seed and actions give the same digest; restore equals rebuild; the observation survives a snapshot round-trip; the delay is applied exactly, to the bot's bits only.
  - The whole-game check: for 800 random frames on every level, the env equals the real `Game` in hash and state, before and after a restore.
  - A per-env level cache capped at a few levels; throughput measured end to end against the engine's raw speed.
  - Tests for termination, truncation, invalid actions and 100 identical traces.
  - Optional: one worker process per env.
- **Night:** Steve Brunton's or DeepMind x UCL RL lectures.
- **Done when:** a random agent runs 1,000 episodes and every invariant test passes.

### Day 11 · Observation, reward and actions (SYNC week 11)

- **Learn:** potential-based shaping (Ng, Harada & Russell 1999); [Go-Explore](https://arxiv.org/abs/1901.10995), first pass.
- **Build:**
  - The six actions per character: idle, left, right, up, left+up, right+up.
  - The observation: tile channels with seesaw bases marked as walls, BFS distance-to-door fields, both characters' state with grounded read from contacts, time clipped at 150 s, the six bits the last frame ran with, and the bot's side.
  - Episode ends on the win animation, deaths and game over from the game's own rules, time limits as truncation.
  - `reward_spec.md`: completion, failure and step cost first; BFS shaping added only after the baseline.
  - A reward-hacking checklist and three adversarial traces (camping on a button, running out the clock, suiciding early).
- **Night:** Sutton & Barto chapter 13.
- **Done when:** tests for deaths and wins pass on selected levels, and you can explain two ways a shaping term backfires.

### Day 12 · A scripted partner (SYNC week 12, first half)

- **Build:**
  - A finite-state bot: navigate to its door, wait, press a button, avoid the pool that kills it.
  - One chosen cooperation puzzle with an explicit start state and success condition.
  - 20 episodes logging both players' inputs, the bot's state, the outcome and the seed; the three most common failures written up.
  - The scripted bot over all 32 levels: per-level completion, deaths by cause and time. This is the baseline table.
- **Night:** [Overcooked-AI](https://arxiv.org/abs/1910.05789), Keshav first pass.
- **Done when:** the bot completes the chosen puzzle consistently without ML, and the 32-level baseline table exists.

### Day 13 · Solo + AI in the browser (SYNC week 12, second half)

- **Learn:** roadmap section 3, "Runtime side" and "Open items".
- **Build:**
  - The Solo + AI card (`app/src/ui/modecards.ts:239`) starts a local game with the scripted bot. Each `step()` it writes the bot character's `*_pressed` flags, as the keyboard does.
  - The human's keys for the bot's character never get through: map both key schemes to the human's character through `bits()` in `embed.ts`.
  - The bot stops while `level.pause` is true, resets on every new level, and re-sends its bits after a window blur.
  - The TypeScript copy of the encoder started, with the parity test against Python stubbed.
  - Optional: an "AI partner" status indicator.
- **Night:** write the Solo + AI section of your notes from what broke.
- **Done when:** you play level 1 in the browser under Local Play → Solo + AI with the scripted bot.

### Day 14 · Ship Milestone 3

- **Build:**
  - The env, its tests and the scripted bot cleaned up and committed; the env checks wired into `fast.yml`.
  - A README section: the env contract, the baseline table, and what the scripted bot fails at.
  - A 60-second video of Solo + AI; a blog post.
  - Plan Module 04: which levels need real coordination, from the baseline table.
- **Done when:** Milestone 3 is shipped, and you have a written list of the levels the scripted bot cannot finish. That list is where Module 04 starts.

---

## After the two weeks

Modules 04–06 at SYNC's own pace, about four weeks each: a partner the bot
has never met (Module 04), partner-aware planning (Module 05), and the study,
ablations and paper (Module 06). The roadmap's build order (section 14) says
what ships at each milestone. The depth stages in section 15 (LLMs, GPU
programming, distributed training) come after Milestone 6, or one at a time
when a build step needs one.
