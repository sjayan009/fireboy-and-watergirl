# Weight-Space Programming (LLM-written/edited weights) in RL and Deep RL: applications, competing methods, verdicts

Scope note: the primary source is the 2 Nov 2026 MIT CSAIL blog post "Sparks of Weight-Space Programming" (Takehi, Teoh, Zhang, Khattab). Older papers below are background (2011–2025) unless marked 2026. Background papers marked "(background, from prior knowledge)" were not re-fetched this session; their arXiv IDs and headline claims are well known, but figures marked "unverified" should be checked before quoting.

## 0. What the post actually shows in RL (facts used throughout)

### Takeaway
There are four RL results: zero-shot MinAtar policies, a one-shot repair of a Kinetix PPO actor, a 9x9 Go policy built with up to 50 forward passes, and identifying a game from a policy's weights. Only MinAtar has been independently reproduced: Breakout and Asterix matched, Seaquest came in 46% lower. Costs are tiny (about $12 for 9 attempts), but the PPO baselines and the Go comparison are poorly specified.

### Cited Findings
- **MinAtar setup.** The network is a 600→32→32→6 tanh MLP. Astra started from all-zero weights and wrote them as text in one reply, with the game rules, source code and layout but "no data, loss, gradients, tools, or rollouts". Scoring used 1,000 episodes with sampled actions, sticky actions 0.1 and at most 10,000 steps. The PPO baseline is "the best of 3 to 10 seeds", and the post does not name the PPO implementation. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **MinAtar scores (PPO 100M / PPO 500M / Astra one-shot):** Breakout 15.8 / 25.3 / 517.4; Seaquest 5.6 / 88.9 / 53.1; Asterix 25.8 / 55.2 / 53.2. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **How the Breakout policy works.** Astra reasons out the program first: "the first layer computes where the ball lands, and the second moves the paddle there". — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **Independent reproduction (2026).** Three attempts per game with GPT-6 Astra at reasoning_effort=xhigh, same no-tools/one-turn protocol:
  - Breakout 470.8 ± 37.8, Asterix 58.2 ± 8.7, Seaquest 28.9 ± 7.5 (46% below the paper; all 3 attempts fell short).
  - DeepSeek V4.1-Flash scored 32.1 / 6.2 / 0.3 and V4-Pro 7.0 / 1.4 / 0.6. Random play scores 0.49 / 0.53 / 0.10.
  - Astra used 269,210 tokens over 9 attempts, about **$12.28**.
  - Score gaps came from survival, not from reward per step. Each added layer of ball-landing prediction multiplies survival by roughly 6–8x. Astra encoded decisions in saturated tanh regions, while the weaker models made sign and scaling errors.
  — [yzw-22/astra-weight-space-repro](https://github.com/yzw-22/astra-weight-space-repro)
- **Kinetix repair.** The official Kinetix actor is 679→128 ReLU → 5×128 tanh → 16, with 171,664 weights. Official PPO trained for 1B steps never succeeded in 256 episodes; the car stalls on the ramp. Astra received the weights, a scene description and one recorded episode, then edited 3.5% of the weights in one reply with no tools. Success went from 0% to 100% over 1,024 episodes. The fix is a small parallel path through a few units per layer: it reads the car's position and speed and switches off once the wheel passes the red strip. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **Go 9x9.**
  - Network: 243→512×6→82 ReLU, 1,480,274 weights, starting at zero. Built in a Python sandbox with no Go library; training, fitting and search were prohibited.
  - Forward-pass budget of 0–50. Each pass is up to 128 games against a practice opponent, or outputs on up to 256 positions.
  - Evaluation: 2,000 games against two small PPO nets (243→32→32→82; 20,000 iterations × 1,024 games).
  - With 0 passes it "wins more than half"; with 50 passes it beats the "equal-sized" PPO net. The post gives **no exact win rates**.
  - The opponent nets are far smaller than the "equal-sized" label implies (32-unit layers vs 1.48M weights).
  — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/) (the size inconsistency is visible in the post's own numbers)
- **Weight reading.** From the weights alone, Astra identified which of four games (Breakout, Pong, Pac-Man, Freeway) a 17,253-weight PPO MLP had been trained on. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **Costs and author limitations.** The post reports no token, dollar or wall-clock figures for the RL experiments. The authors call the results "very early" and say they are limited by context length. Their language-model experiment concluded that editing "could remove an obstacle that hid an ability, but it could not add an ability the model lacked." — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **Critique.** Only three small experiments (17K–172K weights) used the pure no-tools, raw-weight setting. The game network beats PPO-500M only in Breakout. The Qwen result used Python and up to 50 model runs. — [Honnibal critique via daily.dev](https://daily.dev/posts/the-astra-can-read-and-write-weights-to-improve-qwen-post-is-misleading-mxzmgeaeb) (original: https://honnibal.dev/blog/astra-read-write-misleading; author attribution unconfirmed)

### Inferences
- **MinAtar is the solid result.** The no-rollout claim is the strongest and best-replicated. Breakout's big win is a survival effect: an exact interception program does not die, and MinAtar Breakout has no score cap.
- **Kinetix and Go rest on one run each,** with no variance reported.
- **Weaker models fail.** The DeepSeek arms score near random, so this is a frontier-only capability as of Nov 2026.

### Gaps
- No seeds or variance for Kinetix or Go.
- No exact Go win rates.
- No cost figures from the authors.
- The PPO code and hyperparameters behind the MinAtar baselines are unknown.

## 1. Baseline strength: is the post's MinAtar PPO baseline weak?

### Takeaway
Partly. Breakout PPO (about 25) matches public PureJaxRL/gymnax numbers (about 28), so Breakout is an honest plateau that PPO hits regardless of budget. Asterix PPO-500M (55) is well above gymnax's 15. PPO at 100M steps scoring 5.6 on Seaquest is unusually low. The bigger issue is that **no strong value-based or tuned baselines** (DQN/Rainbow/PQN) are shown. A scripted interception policy would also likely hit hundreds in Breakout, which makes it the more relevant baseline.

### Cited Findings
- **gymnax PPO reference returns:** Breakout-MinAtar 28, Asterix-MinAtar 15, Freeway 58, SpaceInvaders 131. No Seaquest row. Training steps are not listed. — [gymnax README](https://github.com/RobertTLange/gymnax)
- **gymnax throughput** (A100, 2k envs, seconds per 1M steps): Breakout 0.19 (about 5.3M steps/s), Asterix 0.92 (about 1.1M steps/s). At that rate, PPO's 500M Breakout steps are minutes of simulation. — [gymnax README](https://github.com/RobertTLange/gymnax)
- **Pgx (based on PureJaxRL):** PPO "achieves sufficiently high scores in less than a minute" on MinAtar, except Seaquest, which takes more than 80 seconds for 20M frames. — [Pgx, Koyamada et al. 2023](https://arxiv.org/pdf/2303.17503)
- **Original MinAtar paper (background, 2019):**
  - Agents trained for 5M frames. The DQN is one conv layer (16 3×3) plus a 128-unit fully connected layer; AC(λ) was also tested.
  - Sticky actions 0.1. Breakout adds three new brick rows when cleared, and the episode ends when the ball is missed. Seaquest and Asterix get harder over time.
  - Final returns appear only in figures, not text.
  — [Young & Tian 2019](https://ar5iv.labs.arxiv.org/html/1903.03176)
- **Spectral normalisation paper normalizers** (search snippet only; definition of "max" not verified): Breakout max 122.88, Asterix max 78.90, Seaquest max 93.91. Random: 0.52 / 0.49 / 0.09. This suggests value-based agents in that paper reached about 120 in Breakout, 79 in Asterix and 94 in Seaquest. — [Gogianu et al. 2021](https://arxiv.org/pdf/2105.05246) (unverified; PDF text not extractable)
- **Post's own numbers.** PPO-500M scores 88.9 on Seaquest, above Astra's 53.1 and the reproduction's 28.9. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/); [repro](https://github.com/yzw-22/astra-weight-space-repro)

### Inferences
- **Breakout gap.** The 517 vs 25 gap mostly shows that PPO with a small MLP plateaus at a few walls in MinAtar Breakout. It does not show a weak implementation, since gymnax gets 28. A DQN-family agent at about 120 (unverified) would shrink the ratio from 20x to about 4x.
- **Seaquest and Asterix.** A tuned value-based agent would likely match or beat Astra, given normalizer maxima of about 79–94 vs Astra's 53.
- **Missing baseline.** The decisive comparison is a **hand-written Python interception heuristic** (or BC from it) on the same network. My expectation, which is untested, is that a Python program gets similar Breakout scores far more easily. The weight-space result is impressive as *compilation*, not as a better policy.
- **Fairness.** "Best of 3–10 seeds" is generous to PPO. "1 attempt" is generous to Astra (the reproduction shows ±38 to ±9 spread across attempts).

### Gaps
- I found no verified table of DQN/Rainbow/PQN final MinAtar returns. The Revisiting Rainbow (arXiv 2011.14826) and PQN papers have them in figures or appendices I could not extract.
- No published scripted-heuristic MinAtar scores were found.

## 2. Programmatic and LLM-written policies (Code as Policies, Voyager, Eureka, Text2Reward, PIRL/NDPS, LLM-GS): when is a neural policy actually needed?

### Takeaway
LLMs already write policies, rewards and skill libraries as **code**, and code is easier to write, read, test and debug than 30K–1.5M floats. Weight-space programming adds value only when the artifact must be a neural network:
- a warm start for gradient RL,
- differentiable fine-tuning,
- an existing NN deployment or verification pipeline,
- an edit to an *existing* learned net whose behaviour has no code equivalent (Kinetix).

Verdict: **unlikely** to replace code-as-policy for writing new policies; **plausible** as a "compile program → network" step.

### Cited Findings
- **LLM-GS (ICLR 2025).** The LLM writes Python, which is converted to a domain-specific language (DSL) and then refined by scheduled hill climbing. It significantly outperforms LEAPS, HPRL, CEBS and hill climbing on almost all Karel tasks. On DOORKEY the baselines fail, while LLM-GS converges in about 50K program evaluations (secondary summary). — [Liu et al. 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/dcf887f2bfe2776584e3bce80ed206ef-Abstract-Conference.html); [arXiv 2405.16450](https://arxiv.org/html/2405.16450v3)
- **Eureka (background, from prior knowledge).** The LLM writes reward code that PPO then optimises. It beat expert human rewards on 83% of 29 IsaacGym tasks, with a 52% average normalized improvement. — [Ma et al. 2023](https://arxiv.org/abs/2310.12931)
- **Text2Reward (background, from prior knowledge).** LLM-generated dense reward code matched or beat expert rewards on 13 of 17 manipulation tasks (unverified count). — [Xie et al. 2023](https://arxiv.org/abs/2309.11489)
- **Voyager (background, from prior knowledge).** A code skill library in Minecraft reported 3.3x more unique items and tech-tree milestones up to 15.3x faster than prior methods. — [Wang et al. 2023](https://arxiv.org/abs/2305.16291)
- **Code as Policies (background).** The LLM writes robot policy code that calls perception and control APIs. — [Liang et al. 2022](https://arxiv.org/abs/2209.07753)
- **PIRL/NDPS (background).** Training a neural policy, then searching for a program that imitates it, gives interpretable and verifiable policies (TORCS) at some performance cost. This is the reverse direction of weight-space programming (neural → program). — [Verma et al. 2018](https://arxiv.org/abs/1804.02477)
- **The post's method is itself program-first.** Astra reasons out a program and compiles it into weights. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **Reproduction finding.** Weaker LLMs fail mainly through arithmetic, sign and scale errors when hand-encoding weights. — [repro](https://github.com/yzw-22/astra-weight-space-repro)

### Inferences
**When a neural network is genuinely needed:**
- **(a) As an init for PPO or SAC fine-tuning** in the *same architecture* as the RL pipeline.
- **(b) Uniform deployment.** Accelerator inference, a fixed-shape policy server, batched JAX rollouts where a Python program cannot be vmapped, or on-device NPU or MCU runtimes that accept only tensors.
- **(c) Differentiability.** Model-based planning or gradient-based adversarial testing through the policy.
- **(d) Editing an existing learned net,** where no code version exists.

**Where a cheaper route exists:**
- For (a)–(c), the route is "LLM writes Python heuristic → behavior cloning (BC) or DAgger onto the network". It is well understood, needs no weight-level arithmetic, and works with any frontier or mid-tier LLM.
- Direct weight-writing only wins if (i) a program is hard to express as labelled data, or (ii) BC fails to reproduce rare-but-critical behaviour (for example, precise Breakout interception, where small BC errors compound), or (iii) no environment or simulator is available to generate BC states.
- Point (iii) is the honest niche. Note that in the post the LLM still had the game **source code**, so a simulator effectively existed.

**Interpretability.** Hand-written weights are structured (saturated tanh gates, a known program), so they may be more interpretable and verifiable than PPO weights. This is closer to PIRL's goals than to a black box.

### Gaps
- No study compares "LLM writes code → BC" with "LLM writes weights" on the same task. This is the key missing experiment.
- No data on whether LLM-written weights survive PPO fine-tuning.

## 3. Policy initialization, warm starts and distillation: would LLM-written weights beat BC from a scripted expert?

### Takeaway
The warm-start literature says a teacher policy helps a lot (reincarnating RL: students reach and beat a 400M-frame teacher within 10M frames). But naive fine-tuning of a pre-trained policy suffers from forgetting, plasticity loss and primacy bias. An LLM-written init is just another teacher. It would compete with BC, DAgger, kickstarting, jump-start RL (JSRL) and QDagger, and those methods do not care whether the teacher is code or a net.

Verdict: **likely useful as a teacher or init in sim-free or cold-start settings; unlikely to beat BC from a scripted expert when a simulator exists.** Its edge is that the weights *are* the init, with no data-collection step.

### Cited Findings
- **Reincarnating RL / QDagger (NeurIPS 2022).** The teacher is a DQN trained for 400M frames; students get 10M frames. Only QDagger surpassed teacher performance within 10M frames and beat the teacher in 75% of games. — [Google Research blog](https://research.google/blog/beyond-tabula-rasa-reincarnating-reinforcement-learning/); [Agarwal et al. 2022](https://arxiv.org/pdf/2206.01626)
- **Forgetting during fine-tuning (ICML 2024).** Fine-tuning a pre-trained policy suffers from forgetting of pre-trained capabilities (FPC): competence is lost on states early fine-tuning doesn't visit. The causes are a state coverage gap and an imperfect cloning gap. Knowledge-retention methods fix it; NetHack Human Monk rose from 5K to over 10K points. — [Wołczyk et al. 2024](https://arxiv.org/pdf/2402.02868)
- **Same pattern in transformers.** Most fine-tuning approaches degrade pre-training tasks in multi-task Decision Transformers. — [Schmied et al. 2023](https://arxiv.org/html/2306.14884v1)
- **Kinetix.** Fine-tuning a generalist agent significantly beats training from scratch, including on some environments where standard RL completely fails. — [Matthews et al. 2025](https://arxiv.org/abs/2410.23208)
- **Kickstarting (background, from prior knowledge).** Distillation loss from a teacher on DMLab-30 gave roughly an order-of-magnitude speedup over from-scratch training (exact figure unverified). — [Schmitt et al. 2018](https://arxiv.org/abs/1803.03835)
- **JSRL (background, from prior knowledge).** A guide policy rolls in for the first h steps, then an exploration policy takes over, with a curriculum that shrinks h. Any guide works (scripted, BC, offline RL), and it improved sample efficiency on D4RL and robotics tasks. — [Uchendu et al. 2023](https://arxiv.org/abs/2204.02372)
- **DAgger and policy distillation (background).** [Ross et al. 2011](https://arxiv.org/abs/1011.0686); [Rusu et al. 2015](https://arxiv.org/abs/1511.06295)
- **Primacy bias and plasticity (background, from prior knowledge).**
  - Agents overfit early experience; periodic resets help. — [Nikishin et al. 2022](https://arxiv.org/abs/2205.07802)
  - Networks lose plasticity in continual learning. — [Dohare et al., Nature 2024](https://www.nature.com/articles/s41586-024-07711-7); [Lyle et al. 2023](https://arxiv.org/abs/2303.01486)
  - Warm-started networks generalise worse than fresh ones. — [Ash & Adams 2020](https://arxiv.org/abs/1910.08475)
- **Saturated weights.** Astra's policies encode decisions in saturated tanh regions. — [repro](https://github.com/yzw-22/astra-weight-space-repro)

### Inferences
- **Saturation is a plasticity red flag.** Saturated tanh units have near-zero gradients. A hand-written net with large-magnitude, saturated weights is the kind of init most prone to plasticity loss and poor fine-tuning. PPO might be unable to improve it, or might destroy it. Mitigations: use it as a **teacher** (kickstarting/JSRL/QDagger) rather than as a raw init; shrink-and-perturb; or distil into a fresh net.
- **BC vs LLM weights as init.** BC from a scripted expert gives a smoother, gradient-friendly function in the standard parameterisation and needs only an LLM that writes Python. It should be preferred whenever states can be generated. LLM weights win when (a) no simulator or state distribution is available, (b) the behaviour is precise and rare, so BC compounding errors matter, or (c) the init must fit an exact pre-existing architecture plus an edit (see §4).
- **JSRL is the natural harness.** JSRL can consume an LLM-written guide directly, with no need for it to be a net. If the guide is a net, it can also share the actor's architecture.
- **Likelihood.** Moderately likely to appear in 2027 papers as "LLM-written init + PPO". Unlikely to become standard, because "LLM code + BC" is easier and model-agnostic.

### Gaps
- No experiment yet fine-tunes Astra-written weights with PPO.
- No measurement of plasticity or forgetting for hand-written inits.
- No comparison with BC from Astra's own program.

## 4. Policy repair and escaping local minima: where does a targeted LLM weight edit fit?

### Takeaway
The Kinetix 0% → 100% edit is the most novel RL result. Nothing standard does a one-shot, zero-rollout, localised patch of a trained actor. Competitors either need many environment steps (exploration bonuses, curricula, reward shaping, Go-Explore, retraining) or change architecture without changing behaviour (Net2Net, OpenAI Five "surgery"). The closest analogue is a hand-coded override or shield, which needs no weight edit at all.

Verdict: **likely the most promising RL niche**, especially "debug-and-patch a deployed policy for a known failure mode". The caveat is that the result is a single scene with a single run.

### Cited Findings
- **The Kinetix edit.** 3.5% of 171,664 weights changed; 1B-step PPO had a 0% success rate; one recorded episode was given; 100% success over 1,024 episodes. The mechanism is a small side path that handles the opening and then switches off. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **OpenAI Five surgery.** A set of tools for changing the environment, observations or architecture mid-training without restarting, "with minimal loss in performance". About one surgery every two weeks over a 10-month run. The final agent won 99.4% of more than 7,000 public games. Surgery preserves function across architecture changes; it does not add new behaviour. — [Berner et al. 2019](https://arxiv.org/pdf/1912.06680)
- **Net2Net (background).** Function-preserving widening and deepening of networks. — [Chen et al. 2015](https://arxiv.org/abs/1511.05641)
- **Exploration methods (background, from prior knowledge).** Go-Explore solved hard-exploration Atari games (Montezuma's Revenge, Pitfall) by returning to promising states and then exploring, at a cost of billions of frames. RND adds a curiosity bonus. Both need large amounts of environment interaction. — [Ecoffet et al., Nature 2021](https://arxiv.org/abs/2004.12919); [Burda et al. 2018](https://arxiv.org/abs/1810.12894)
- **Shielding (background).** A runtime monitor overrides unsafe actions using a formal spec. It needs no change to the policy, but the spec must be written. — [Alshiekh et al. 2018](https://arxiv.org/abs/1708.08611)
- **Kinetix itself.** Generalist pretraining plus fine-tuning solves some environments that from-scratch RL "completely fails at". This is a gradient-based alternative for escaping the ramp minimum. — [Matthews et al. 2025](https://arxiv.org/abs/2410.23208)

### Inferences
- **What the edit does.** It amounts to "LLM writes a JSRL-style opening guide and fuses it into the actor with a gating unit". The same behaviour could likely be had by (a) a code override for the first k steps (a trivial shield-style patch), or (b) JSRL with a scripted guide plus some fine-tuning. The weight edit's advantages: a single artifact, no runtime branching, zero rollouts, and the rest of the policy left untouched (100% success suggests no regression on this scene, but **regression on other scenes was not measured**).
- **Good uses:**
  - Patching a fielded robot or game-AI policy for a reported failure without retraining.
  - Hot-fixing sim-to-real gaps where the fix is a known rule ("if slipping, reduce torque").
  - Safety overrides compiled into the net for certified NN runtimes.
  - Red-team "explain the failure" analysis, since the model diagnosed the stall from weights plus one episode.
- **Risks:**
  - Silent regressions elsewhere in state space; an FPC-style concern in reverse.
  - Edits that are hard to verify, compared with an explicit shield.
  - A one-scene demo. Kinetix tasks are 2D with structured observations, and pixel policies and big nets (millions of parameters) are untested.
- **Likelihood.** **Likely** to become an LLM-assisted debugging tool for small and medium policies (under about 1M parameters), probably tool-augmented (probing activations, running a few rollouts) rather than purely no-tools. **Unlikely** to scale to large vision-language-action (VLA) robot policies soon, given context limits.

### Gaps
- Kinetix scenes beyond one were not tested.
- No measurement of side effects on other levels.
- No comparison against JSRL, a code override, or a short PPO fine-tune with reset-to-opening.
- No published work yet compares LLM weight edits with RL-specific model editing.

## 5. Expensive or dangerous interaction (robotics, healthcare, real-world control, offline RL) vs cheap JAX simulators

### Takeaway
"No environment feedback" matters most where rollouts are costly or unsafe. But the post's demos all ran in simulators doing millions of steps per second, where PPO at 500M steps costs minutes. In real-world domains the LLM rarely has exact dynamics source code, which is the key input in MinAtar.

Verdict: **unlikely in the near term for real robotics or healthcare as a policy author; plausible as a prior/init or patch combined with offline data.**

### Cited Findings
- **Cheap simulation.** gymnax runs MinAtar Breakout at about 0.19 s per 1M steps on an A100. — [gymnax](https://github.com/RobertTLange/gymnax)
- Pgx's PPO reaches high MinAtar scores in under a minute (Seaquest: more than 80 s per 20M frames). — [Pgx](https://arxiv.org/pdf/2303.17503)
- Kinetix uses Jax2D to "cheaply simulate billions of environment steps". — [Matthews et al. 2025](https://arxiv.org/abs/2410.23208)
- **What the LLM was given.** Astra had the full game source code for MinAtar, and a scene description plus one episode for Kinetix. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **LLM cost.** About $12 for 9 MinAtar attempts. — [repro](https://github.com/yzw-22/astra-weight-space-repro)
- **Offline RL (background).** Learning from fixed datasets suffers distribution shift and overestimation outside the data, so priors and constraints are valuable. — [Levine et al. 2020](https://arxiv.org/abs/2005.01643)

### Inferences
- **In JAX sims,** compute cost is not the motivation: about $12 of LLM tokens vs minutes of GPU time. The motivations are escaping local minima (Kinetix) and the policy quality PPO fails to reach (Breakout).
- **In real-world control,** the useful inputs would be a physics model, a controller spec or domain rules, which is already the territory of classical control and MPC (more transparent than hand-written weights).
- **Most plausible real-world role:** (a) an LLM-compiled safe baseline controller as the network init or behaviour policy for offline-to-online RL; (b) targeted patches to fielded policies where retraining requires new real data.
- **Healthcare and dosing** need auditability. A program or rule set is preferable to opaque weights, even hand-written ones. **Unlikely** there.
- **Offline RL:** an LLM-written policy prior could act as the behaviour regulariser instead of the dataset policy. Speculative; no evidence.

### Gaps
- No weight-space-programming result on any real-robot, offline-RL or partially specified-dynamics task.
- No results without source code access.

## 6. Reward models and value functions: inspecting or fixing reward models (reward hacking) or value nets

### Takeaway
There is no direct evidence yet for RL reward models or critics. The post's weight-reading results (identifying the game from a PPO MLP; finding copying heads) and its failure (could not find a sycophantic Gemma 3 270M from weights alone, but succeeded once it could view activations) suggest LLMs could audit **small** learned reward models for obvious spurious features.

Verdict: **plausible for small hand-crafted or learned shaping rewards and critics; unlikely for LLM-scale RLHF reward models** in the near term. LLM-written reward **code** (Eureka) is the stronger, established route.

### Cited Findings
- **Weight reading.** Identified the training game from a 17,253-weight PPO MLP; identified languages and copying heads in transformer blocks; failed on sycophancy from weights alone in all four attempts, then succeeded in all three pairs when attention patterns were allowed. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **Eureka (background).** LLM-written reward code plus evolutionary refinement on training statistics beat human rewards on 83% of 29 tasks. — [Ma et al. 2023](https://arxiv.org/abs/2310.12931)
- **Reward overoptimization (background, from prior knowledge).** Optimising against a proxy reward model makes the gold reward rise then fall, following predictable scaling laws. — [Gao et al. 2022](https://arxiv.org/abs/2210.10760)
- **Survey (background, 2024).** Cao et al. survey LLM-enhanced RL, sorting LLM roles into information processor, reward designer, decision-maker and generator. — [Cao et al. 2024](https://arxiv.org/abs/2404.00282)

### Inferences
- **Small learned reward models** (for example, a classifier reward in robotics) could be audited by weight reading for reliance on spurious features (a timer, a pixel). If a hack is found, a weight edit could remove the feature, a targeted debiasing with no data.
- **Value nets / critics:** hand-writing a critic consistent with an LLM-written actor could give a ready actor-critic init, avoiding PPO's early phase where the critic is wrong and destroys a good actor. Speculative, but relevant to the warm-start pathology in §3.
- **Large reward models** (billions of parameters): the sycophancy failure shows weight-only reading does not yet find behavioural flaws. Activation-based interpretability tools are the competitor.

### Gaps
- No work applies weight-space programming to reward models or critics.
- No evidence it detects reward hacking.

## 7. Multi-agent and game playing: the hand-programmed 9x9 Go net vs known heuristics and engines; AlphaZero-scale reality

### Takeaway
Beating a tiny PPO net (32-unit hidden layers) in 9x9 Go says little about absolute strength. Classical engines (GnuGo, Pachi) and even a single-GPU Gumbel AlphaZero (about 8 A100-hours, which beats Pachi-10K-sims 62–38) are vastly stronger. An LLM-programmed policy net with no search is plausibly in the strength range of simple pattern heuristics.

Verdict: **unlikely to matter for game strength; plausible for fast, cheap, interpretable opening books or heuristics, or as an init for AlphaZero-style training.**

### Cited Findings
- **Go details from the post.** The Astra net has 1.48M parameters and no search. The opponents are two PPO nets (243→32→32→82) trained for 20,000 iterations × 1,024 games (about 20M games). There are no exact win rates; it "wins more than half" at 0 passes and beats the PPO net at 50 passes. — [Takehi et al. 2026](https://rikiyat.github.io/blog/weight-space-programming/)
- **Pgx 9x9 Go baseline.**
  - Training: Gumbel AlphaZero via Mctx, 6 ResNet blocks, 32 simulations per move, 400 iterations; the 200-iteration (about 52M frames) checkpoint was chosen.
  - Compute: about 8 hours on a single A100.
  - Result: at 800 simulations per move it beat Pachi (10K simulations) 62–38 over 100 games.
  — [Pgx, Koyamada et al. 2023](https://arxiv.org/html/2303.17503)
- **Pgx's own PPO training** of MinAtar agents is a baseline example in its appendix. — [Pgx](https://arxiv.org/pdf/2303.17503)

### Inferences
- **The evaluation opponent is weak.** A 32-unit-wide MLP trained by PPO self-play on 9x9 Go is plausibly near beginner strength. Beating it shows the LLM can encode Go knowledge (captures, atari, eyes, liberties) into a 1.48M-weight MLP. It does not show competitive strength.
- **The field moved on.** Even 8 GPU-hours of Gumbel AlphaZero gives a Pachi-beating 9x9 player, and KataGo-class 9x9 is superhuman. Search plus self-play dominates, and a no-search policy, hand-written or not, cannot compete.
- **Constructive use:** an LLM-written policy prior encoding Go basics could speed early AlphaZero training (like a reincarnation teacher). Gumbel AlphaZero's early-iteration cost is small, though, so the savings are modest.
- **Multi-agent:** "read opponent weights → infer strategy → write a counter-policy" is an intriguing exploit direction (opponent modelling from parameters), relevant to security of released policies. No evidence beyond the game-identification result.

### Gaps
- No exact Go win rates.
- No evaluation against GnuGo, Pachi or any rated engine.
- No Elo.
- No per-move policy accuracy against strong play.
- I did not retrieve sources on simple 9x9 Go heuristic bots or on KataGo 9x9 strength this session.

## Summary verdict table (synthesis of the sections above)

| Area | Competes with | Evidence for WSP | Verdict |
|---|---|---|---|
| Policy repair of trained actors | Exploration (Go-Explore, RND), curricula, reward shaping, JSRL, shields/code overrides, retraining | Kinetix 0% → 100% with a 3.5% edit, 1 run | **Likely** (most promising), mainly for small nets; must check regressions |
| Zero-shot policies from source code | Code-as-policy, LLM heuristics, PPO/DQN in cheap JAX sims | MinAtar: Breakout 517 (repro 471); loses Seaquest/Asterix to PPO-500M | **Unlikely** as a replacement; code + BC is easier; niche where NN form is needed |
| Warm start / init for RL | BC/DAgger from scripted expert, kickstarting, JSRL, QDagger | None yet (no fine-tuning experiment); saturated weights raise plasticity concerns | **Plausible as a teacher**, unlikely to beat BC-from-code as a raw init |
| Expensive/dangerous real-world RL | MPC/classical control, offline RL, sim-to-real | None (all demos in JAX sims with full source) | **Unlikely** near-term |
| Reward models / critics audit and fix | Eureka-style reward code, activation interpretability | Indirect (game ID from weights; sycophancy failure) | **Plausible** for small reward models; unlikely for RLHF-scale |
| Go / game strength | MCTS + self-play (AlphaZero/KataGo), GnuGo/Pachi | Beats tiny PPO MLPs; no rated opponents | **Unlikely** for strength; maybe an init/prior |
| Policy forensics (what was this trained on?) | Behavioural probing, rollouts | 4-way game ID from 17K weights | **Plausible** for auditing released small policies |
