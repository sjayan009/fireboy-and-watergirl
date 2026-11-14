# Weight-Space Programming: the primary source, reactions, critiques, prior work, and risks (as of 2026-11-05)

Scope note: the post appeared on 2026-11-02, three days before these notes. "Verified" below means an independent party re-ran the released artifacts and published the numbers. Most independent work is GitHub repos, issues and blogs, not peer-reviewed papers. I could not read the main X threads (X returned HTTP 402), and I found no LessWrong or Alignment Forum post and no r/MachineLearning thread through search. Those are gaps, not evidence that nothing exists.

## What exactly was measured, against what baselines, and what did the authors say does not work?

### Takeaway
The post covers 8 experiments plus one extra Gemma experiment. They mix four regimes: raw weights in context with no tools (Exps 1, 2, 4, 5), Python over the weights without running the network (Exp 3), Python plus a budget of forward passes (Exps 6, 8), and an attention-pattern tool (Exp 7). The authors themselves report three failures: sycophancy could not be detected from weights alone, Gemma 3 270M could not be improved, and the 10- and 25-pass Qwen edits barely reduced looping. Every experiment reports one run per condition. The PPO baselines are best-of-3-to-10 seeds.

### Cited Findings
**Framing and definitions**
- Authors: Rikiya Takehi* and Jayden Teoh* (equal contribution), Alex Zhang, Omar Khattab, all MIT CSAIL. Published 2026-11-02. The model is "GPT-6 Astra". The post defines Weight-Space Programming as a general-purpose LLM that "reads and writes a network's weights directly (i.e., not through an optimizer, and in particular not with gradient descent) around some natural language spec, sometimes even with no environment feedback at all" — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Current TL;DR: frontier LLMs read and write weights "using a variety of recent tools and algorithms or even via direct weight editing", and the results "may extend beyond what we'd expect from humans or conventional algorithms". It also predicts that weights "will soon be natively optimized by LLMs" — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- The abstract was softened after publication. The original version (commit 6bfa7a6, 2026-11-02) said "well past what we'd expect from humans or conventional algorithms". Commit e35f074 (2026-11-03) changed this to "using a variety of recent tools and algorithms ... may extend beyond..." — [Zhang, Rethinking WSP](https://zhangyiqun018.github.io/rethinking-weight-space-programming/); [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)
- The Hacker News submission used the title "Astra can read and write weights to improve Qwen" (~2,950 points, ~893 comments). The logs repo description says "LLMs can understand and write neural network weights", which suggests an earlier title — [HN 50341174](https://news.ycombinator.com/item?id=50341174); [GitHub API, repo metadata](https://github.com/RikiyaT/lm_understand-logs)

**Exp 1: which game, from raw weights**
- Setup: four PPO policies (Breakout, Pong, Pac-Man, Freeway) on the authors' own 10×10 grid versions. All share the same 5 input channels, 5 actions and MLP 500→32→32→5 tanh (17,253 weights). PPO ran for 1B steps; the best of 3 seeds was kept per game. Astra got all the weights as text with no game named and no list of options. Result: 4/4 correct (e.g., "Breakout 99% confident") — [post](https://rikiyat.github.io/blog/weight-space-programming/)

**Exp 2: which shape a diffusion model draws**
- Setup: three DDPMs on 12×12 images (filled circle, square, triangle), MLP 160→64→64→144 ReLU (23,824 weights), Adam for 40k steps. No tools and no forward pass allowed. Result: 3/3 correct. Astra drew every shape as an outline even though the models generate filled shapes, and the authors read this error as evidence that it did not compute the forward pass — [post](https://rikiyat.github.io/blog/weight-space-programming/)

**Exp 3: language of a char-LM, from the middle layers only**
- Setup: 7.16M-parameter char transformers (4 layers × 6 heads, width 384, 28 characters), each trained on 1B characters of Python, romaji (Aozora Bunko) or English Wikipedia. Input and output layers were removed. Astra got Python for analysis (up to 100 runs) but could not run the network or any layer on any input, and could not search. Result: the right language in 2/2 attempts for all three models, with confidence 0.48–0.62. It named exactly the ground-truth copying (induction) heads: Python 2.1, 3.1, 3.5; romaji 3.3; English 3.1. The method matches Elhage et al.'s K-composition analysis, which the prompt never mentioned — [post](https://rikiyat.github.io/blog/weight-space-programming/)

**Exp 4: fix a stuck Kinetix car policy**
- Setup: the official Kinetix actor, 679→128→5×128→16 (171,664 weights), trained with the official PPO for 1B steps. It got 0/256 successes, stalling on the ramp. Astra got the weights, a scene description and one recorded episode, with no tools and one reply. Result: 1,024/1,024 successes, with 3.5% of the weights changed. Per Astra's reasoning, the edit adds a small path that reverses the car and then hands control back to the trained network — [post](https://rikiyat.github.io/blog/weight-space-programming/)

**Exp 5: write MinAtar policies from scratch, zero-shot**
- Setup: Breakout, Seaquest and Asterix, network 600→32→32→6 tanh, all weights starting at 0. Astra got "the game's rules and source code" plus the I/O layout and the scoring rule. No data, loss, gradients or tools; one reply; the network never played before it was scored. Scoring: 1,000 episodes, sampled actions, sticky actions 0.1, max 10,000 steps. PPO: best of 3–10 seeds — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Reported scores (PPO-100M / PPO-500M / Astra): Breakout 15.8 / 25.3 / 517.4; Seaquest 5.6 / 88.9 / 53.1; Asterix 25.8 / 55.2 / 53.2. So Astra beats PPO-100M on all three games, but against PPO-500M it wins only Breakout (about 20×). It trails on Asterix (close) and Seaquest (about 60%) — [post](https://rikiyat.github.io/blog/weight-space-programming/)

**Exp 6: write a 9×9 Go network (1,480,274 weights)**
- Setup: 243→512×6→82 ReLU, all weights starting at 0. A Python sandbox with numpy/PyTorch on CPU, no Go library, no internet. Not allowed: training or fitting, tree search, rollouts. Forward-pass budget from 0 to 50, each pass being up to 128 games against a practice opponent or outputs on 256 positions. Scoring: 2,000 games against each of two small PPO nets (243→32→32→82) — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Result: with 0 passes, it wins "more than half" of its games against the two small PPO nets. With 50 passes, it beats an equal-sized PPO trained on 20M games. The post gives no win rate for the equal-size comparison — [post](https://rikiyat.github.io/blog/weight-space-programming/); [issue #8](https://github.com/RikiyaT/lm_understand-logs/issues/8)

**Exp 7: which Gemma 3 270M is sycophantic (stated failure, then a relaxed success)**
- Setup: pairs of Gemma 3 270M-IT fine-tuned identically, one honest and one that follows the user's suggested answer. Input embeddings and output layers were frozen. The sycophant follows 100% of wrong guesses, the honest model 1–3%. Weights alone: Astra failed in all 4 attempts; it found weight differences but could not map them to behavior. Relaxed version: an attention-pattern tool (up to 16 texts Astra writes, attention weights only, at most 20 runs) got 3/3 pairs. Head 10.2 in the sycophant puts 85.7% of its attention on the user's answer, against 0.75% in the honest model — [post](https://rikiyat.github.io/blog/weight-space-programming/)

**Exp 8: make Qwen3.5-0.8B better at math (the headline)**
- Setup: thinking on. A Python kernel over the weights (no GPU), practice problems from the GSM8K and MATH train sets, and 10, 25 or 50 forward passes. Evaluation: MATH-500, GSM8K and six others, up to 32,768 tokens. Sampling: temperature 0.6, top-p 0.95, top-k 20, presence penalty 1.5. The post notes that Qwen's model card warns about thinking loops. 85 of the base model's first 96 practice answers hit the 32,768-token limit — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Edit: one "loop" direction written by the MLPs of layers 15 and 19, "subtracted" from 64 output columns in each layer, for 131,072 weights (0.016%). The post compares this to single-direction ablation (Arditi et al.) — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Results, as MATH-500 / GSM8K / IFEval / share hitting the token limit:
  - Base: 7.9 / 13.8 / 21.0 / 93.0
  - 10 passes: 12.3 / 25.7 / 49.0 / 87.2
  - 25 passes: 14.1 / 25.1 / 39.9 / 86.4
  - 50 passes: 48.1 / 67.1 / 62.3 / 33.1

  — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Gemma 3 270M (stated failure): it rarely loops (8.5% of answers hit the limit). The authors' wording is that weight editing "could not add an ability the model lacked". MATH-500 went 6.8 → 7.0 / 7.6 / 7.7 / 7.0 across 5 to 50 passes, under the model card's sampling — [post](https://rikiyat.github.io/blog/weight-space-programming/)

**Stated limitations and future plans**
- The authors say capabilities are "exciting but still limited, specifically due to inefficiencies in context length and harnesses". They state that they "are currently building a benchmark and a harness". Applications they list: auditing without evaluation (e.g., backdoors), cheaper optimization, zero-data steering and unlearning, recursive self-improvement, and cross-architecture "true" model merging — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Released: complete logs (prompts, replies, reasoning summaries, code, networks, evals) at [RikiyaT/lm_understand-logs](https://github.com/RikiyaT/lm_understand-logs). The repo was created 2026-10-29 and had about 1,013 stars, 137 forks and 10 issues on 2026-11-05. The edited Qwen is at [RikiyaT/Qwen3.5-0.8B-weight-space-programming](https://huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming) (about 1,968 downloads, 105 likes), with a live demo at [akhaliq's HF Space](https://huggingface.co/spaces/akhaliq/weight-space-programming-demo) — [GitHub API](https://github.com/RikiyaT/lm_understand-logs); [HF API](https://huggingface.co/RikiyaT/Qwen3.5-0.8B-weight-space-programming)

### Inferences
- The TL;DR line "just by looking at the raw weights" literally describes only Exps 1, 2 and 4. All the LLM-scale results use Python, and Exp 8 also uses model runs. Honnibal makes the same point (next section).
- The authors' own negatives already set the boundary: weight edits can remove an obstacle such as looping, but they have not been shown to add a capability. Reading behavior from the weights of a 270M LM failed without activations.

### Gaps
- The post gives no numeric win rate for the Exp 6 claim against the equal-sized PPO.
- The post gives no variance across repeated Astra sessions, and nothing on GPT-6 Astra's training data (for example, whether it was trained on interpretability or weight-reading tasks).

## Has anyone replicated, extended, or criticized it? Is there a released harness, benchmark or code?

### Takeaway
Yes, heavily, within 72 hours. The released artifacts reproduce bit-exact: the edited Qwen re-evaluates at 48–51% on MATH-500 under the post's protocol. Independent audits, though, find that the headline comparisons rest on a looping decoding regime, untuned PPO baselines, single selected runs and simulator source code in the prompt. A live re-run of the whole Exp 8 process with GPT-6 Astra (OpenWSP) scored only 12.9%, and OpenWSP's re-run of the Exp 4 car repair failed. The authors have announced a benchmark and harness but not released one. Community tools and a third-party benchmark (WSPBench) exist.

### Cited Findings
**Reproductions of the released artifacts (they hold)**
- Hugging Face rebuild (ML Intern, 2026-11-02): the author's `apply_edit.py` was re-applied with sha256 checks on every rebuilt tensor; only `layers.15/19.mlp.down_proj.weight` differ. Full MATH-500, 500 × 4 samples under the post's protocol: edited model 51.0% (post: 48.1%), 31.6% hitting the 32k limit (post: 33.1%). The base model was only smoke-tested on 25 problems (5.0%) — [ML-Intern-lab HF card](https://huggingface.co/ML-Intern-lab/Qwen3.5-0.8B-weight-space-programming)
- Carlos Toledo (issue #4, 2026-11-03) re-derived the edit from the bytes. 130,188 bf16 entries actually differ (131,072 are addressed; 884 round back to their original values). The experiment history computes **W = W₀ − 6·outer(u, mask·(uᵀW₀))**, so the loop component is "reversed and amplified, not subtracted", contrary to the post's wording. The dose of 6 was chosen on 3,680 practice answers, never on a MATH-500 problem — [issue #4](https://github.com/RikiyaT/lm_understand-logs/issues/4); [Toledo report](https://carlostoledo.co/reports/weight-space-programming.html)
- Yiqun Zhang (2026-11-05): "Every reported score we re-ran reproduces." The Exp 8 config reproduces at 8.3 → 50.6 (MATH-500), 12.4 → 67.9 (GSM8K) and 20.5 → 62.9 (IFEval). Exp 5 on official MinAtar 1.0.15 gives 500.1 ± 7.8 (Breakout), 53.7 (Seaquest) and 54.3 (Asterix). Exp 4 gives 1,024/1,024 — [Zhang blog](https://zhangyiqun018.github.io/rethinking-weight-space-programming/); [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)
- hamley241 (preregistered, 2026-11-04) re-evaluated the released MinAtar networks over 1,000 episodes and reproduced the 10k-step means within its gate: Breakout 505.3, Seaquest 51.0 (published 53.1), Asterix 53.3 (published 53.2) — [weight-space-horizon](https://github.com/hamley241/weight-space-horizon)

**Re-runs of the process (mixed or failed)**
- OpenWSP (no affiliation with the authors) did a live Exp 8 re-run with `gpt-6-astra` at max reasoning effort through Codex. It completed 50 passes, but the final edit scores 258/2,000 = **12.9% on MATH-500**, with 84.25% hitting the token limit. That is below the authors' 48.1% and below OpenWSP's own 50.6% calibration of the released edit. An earlier API attempt stopped at 4 of 50 passes. The raw-weight CPU replications with Astra: all seven game and shape labels correct, but "the one-shot car repair fails" — [OpenWSP README](https://github.com/openwsp/openwsp)
- Zhang's 10 fresh Exp 5 replies per game (authors' prompt) have these medians: Breakout 490 (9/10 reach 90% of the authors' network), Asterix 62.5 (7/10), Seaquest 33.5 (only 1/10 reaches 90% of 53.7). So the published Seaquest network was the luckiest-looking draw — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)
- Zhang compared open-weight models on Exp 1: DeepSeek V4.1 got 4/8 (original) and 3/8 (anonymized), Kimi K3 got 3/8 and 3/8, and both confidently named a game for randomly initialized weights. Astra abstained 12/12 on random weights. On Exp 2, DeepSeek V4.1, Kimi K3 and GLM 5.3 "fail or hallucinate" — [Zhang blog](https://zhangyiqun018.github.io/rethinking-weight-space-programming/)
- On HN, user fancyfredbot reported an informal attempt with Claude: it could interpret a ~10k-weight classifier but did not reliably propose improvements, and its edits lowered accuracy. This is anecdotal and unverified — [HN 50341174](https://news.ycombinator.com/item?id=50341174)
- Other replication repos are listed but I did not read them: Alan Turing Institute `weights_editing` (now 404), Sarabamoun (Claude Opus 5.5), Ludvik1kul (Claude Fable 5.1), and statsleelab (EN/KO guide) — [awesome-weight-space-programming](https://github.com/SajjadPSavoji/awesome-weight-space-programming)

**Issues raised on the authors' repo (no author replies visible as of 2026-11-05)**
- #3: requests sample Go game records. A commenter asks why PPO is the strength yardstick when configurable-strength Go bots exist, and why about 10% of games "end by repetition" — [issue #3](https://github.com/RikiyaT/lm_understand-logs/issues/3)
- #5: asks for a prompt ablation, because the Exp 8 prompt explicitly names repetition and failure-to-finish as possible failure modes — [issue #5](https://github.com/RikiyaT/lm_understand-logs/issues/5)
- #6: in the Exp 2 events.jsonl, Astra's first reasoning turn on the square model is already titled "Analyzing rectangle geometry" (and similarly for the other shapes), although the prompt names no shape. The reporter asks whether this is leakage — [issue #6](https://github.com/RikiyaT/lm_understand-logs/issues/6)
- #8: asks for multi-seed variance on the headline edits, the missing Exp 6 numbers, and an explanation of the non-monotonic pass-count results (IFEval 49.0 → 39.9 from 10 to 25 passes). It also notes, citing a Sol Messing thread, that the Exp 4 edit is large in magnitude: the largest edited weight goes from about 0.095 to about 876 — [issue #8](https://github.com/RikiyaT/lm_understand-logs/issues/8)
- #1, #7, #9 and #10 add missing scorer code and fix paths and cutoffs. Per #9, the Exp 3 copy-head cutoff is 0.3 in scores.json but 0.2 in the post — [issues list](https://github.com/RikiyaT/lm_understand-logs/issues)

**Public reactions**
- Matthew Honnibal (2026-11-03), "...is misleading": he does not dispute the results but the framing that they show one capability. "Just by looking at the raw weights" applies only to Exps 1, 2 and 4 (17K–172K weights); every LM experiment uses Python, and Exp 8 runs the model. He calls the Qwen result real and hard, and says the weight-editing tasks are ones a human ML engineer could do — [honnibal.dev](https://honnibal.dev/blog/astra-read-write-misleading)
- Hacker News (~2,950 points, 893 comments) — [HN 50341174](https://news.ycombinator.com/item?id=50341174):
  - Critiques: the work is overhyped given ROME and steering vectors (top comment by yurimo); the math gain is mostly loop-fixing; a comment claims Claude Code wrote Astra's prompt and included details of the loop bug (porridgeraisin, unverified); it is not recursive self-improvement because Gemma did not improve; results on tiny MLPs may not scale; possible contamination.
  - Defenses: the agentic, automated workflow is notable; reading game structure from raw matrices is impressive; Tracr makes LLM-written weights plausible.
  - No author replies were visible in the portion I read.
- A second HN thread: stymaar called directional ablation "natively editing" misleading; kenjackson defended the claim and proposed a frontier-model-versus-top-researchers challenge — [HN 50355966](https://news.ycombinator.com/item?id=50355966)
- Christopher Keruac on X checked the TL;DR sentence by sentence and concluded "an interesting demo, but much less than claimed". I saw only the search snippet; X blocked the fetch — [X/CKeruac](https://x.com/CKeruac/status/2117497983650382175)
- Rikiya Takehi's announcement thread on X (headline: 0.016% of weights, math "up to 6x", IFEval 3x) — [X/rikiyatakehi](https://x.com/rikiyatakehi/status/2117313742891327994)
- Media coverage was largely uncritical: The Register quotes only Takehi and no outside critics ([The Register](https://www.theregister.com/ai-and-ml/2026/11/03/forget-retraining-ai-can-now-tweak-another-ais-weights/5307105)); VentureBeat ran "Like gene editing for neural networks" ([VentureBeat](https://venturebeat.com/technology/like-gene-editing-for-neural-networks-mit-researchers-used-gpt-6-astra-to-edit-qwens-open-weights-directly-boosting-math-performance)). R&D World reported that critics say the biggest result "relied on standard ML engineering" ([R&D World](https://www.rdworldonline.com/mit-team-says-gpt-6-astra-can-fix-an-ai-model-by-editing-its-weights-critics-say-the-method-was-standard-ml-engineering/)). A Turing Post explainer is titled "...why it suddenly blew up the internet" ([Turing Post](https://www.turingpost.com/p/what-is-weight-space-programming-and-why-it-suddenly-blew-up-the-internet)).
- A secondary explainer mentions a rebuttal by Sean Goedecke ("clever but far from superhuman"). I did not find or read the primary post — [PiyushAI](https://piyushai.com/weight-space-programming-explained/)

**Harnesses, benchmarks and tools**
- Authors: a benchmark and harness are announced but not released. The logs repo contains a `harness/` folder — [post](https://rikiyat.github.io/blog/weight-space-programming/); [repo](https://github.com/RikiyaT/lm_understand-logs)
- WSPBench v0.2.2 (alexcarterhq, third party; its design was shaped by Honnibal's critique) — [WSPBench](https://github.com/alexcarterhq/wspbench):
  - Task: diagnosis and selective repair, comparing a probes-only arm with a probes-plus-weights arm.
  - Result: GPT-6.1 Sol repaired 14/32 faults with behavior probes alone and 30/32 with probes plus weights. A scripted solver repaired 5/32. All arms preserved 8/8 clean controls.
  - In a 12k-token-limited follow-up, the scores were 1/4 vs 2/4.
- OpenWSP: a Python kernel over the weights, a forward-pass service, a versioned edit format, and a CLI/SDK/MCP server. Many agent skills and kits are listed (wsp-kit, weightspace, weights-lab by Oumi, OpenWiSH, weight-surgery, and others) — [OpenWSP](https://github.com/openwsp/openwsp); [awesome list](https://github.com/SajjadPSavoji/awesome-weight-space-programming)

### Inferences
- Reproducibility of the artifacts is strong because the authors released bit-exact diffs and full logs, and every critic credits them for it. Reproducibility of the process is the open question: one of one independent live Exp 8 run fell far short, and the authors' own logs show only one of 14 thinking-on runs (p50c) produced the large gain (next section).
- The wording "subtracted" vs "reversed and amplified ×6" matters for how a reader understands the mechanism. It does not change the measured result.

### Gaps
- Authors' responses: none were visible on the GitHub issues or in the HN portion I read. X was not accessible.
- I found no LessWrong, Alignment Forum or r/MachineLearning threads. I did not read the replications that used Claude models (Sarabamoun, Ludvik1kul).

## How strong are the baselines?

### Takeaway
They are weak in several places. In Exp 5, the authors' PPO uses CleanRL defaults that a sweep finds to be the worst setting. Tuned PPO beats Astra by about 2× on Seaquest and cuts the Breakout lead from 20× to 1.1–9×. Breakout's 20× is also partly an artifact of the 10,000-step evaluation cap. In Exp 6, a 30-line tactics script beats the same PPO nets by more than Astra's 0-pass net does. In Exp 8, the 7.9% base comes from a looping decoding regime: with thinking off, the unedited model scores about 44–52%.

### Cited Findings
**MinAtar (Exp 5)**
- The authors' PPO-500M scores are Breakout 25.3, Seaquest 88.9 and Asterix 55.2, best of 3–10 seeds — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- For reference, gymnax-blines PPO checkpoints are listed at Breakout-MinAtar R ≈ 28, Asterix-MinAtar R ≈ 15, Freeway 58, SpaceInvaders 131, with no Seaquest entry. So the authors' Breakout PPO (25.3) is in line with a common JAX PPO reference, not unusually low — [gymnax README](https://github.com/RobertTLange/gymnax)
- Pgx adapted PureJaxRL's PPO to MinAtar, tuning hyperparameters on Asterix and training each run for 20M frames — [Pgx paper](https://arxiv.org/pdf/2303.17503)
- Zhang: the authors' PPO uses CleanRL defaults (64 environments, lr 5e-4), and "64 envs is the worst setting in every game." With lr 1e-3, 512 envs, 500M steps and 5 seeds, under the same network and evaluation:
  - Breakout: 56–440, so Astra's ~500 still leads, by 1.1–9×.
  - Seaquest: 99–114, about 2× Astra.
  - Asterix: 36–43; here the authors' baseline was fine and Astra roughly ties or beats it.

  — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)
- Horizon artifact: MinAtar Breakout refills the bricks and ends only when the ball is missed. 51.6% of the Astra network's episodes were still running at the 10,000-step cap. Raising the cap to 30,000 lifts its mean from 505 to 911, while at a 300-step horizon it scores only about 24.6, roughly PPO-500M level. The network survives about 25.5× longer than PPO but earns less reward per step (about 0.78×). Seaquest and Asterix saturate by 3,000 steps — [weight-space-horizon](https://github.com/hamley241/weight-space-horizon)
- Astra's Breakout network is deterministic (policy entropy 0.000 nats), only 4% of its weights are nonzero, and it is close to a hand-written simulator-lookahead heuristic, which scores 546.4 — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)

**Go (Exp 6)**
- A preregistered 1-ply script (capture, save atari, threaten, avoid self-atari; no network or search) beats the same-size PPO s0/s1/s2 74.1/61.1/69.3%. Astra's 0-pass net scores 42.6/26.3/36.3% and its 50-pass net 74.2/70.0/78.5%. Astra's nets do beat the script head-to-head (90% for 0 passes, 95% for 50 passes). The 50-pass run practised against a seed-1 PPO, a sibling of the test opponents. The big-PPO baseline was tuned only on learning rate (3 values, 1 seed) — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)

**Qwen (Exp 8)**
- Toledo (pre-registered, vLLM 0.33.0, the authors' prompt and template, 4 × 500 samples): under the authors' settings the base model scores 7.8% with 93.1% hitting the limit. Under the Qwen card's non-thinking settings (temperature 1.0, top-p 1.0, presence penalty 2.0) it scores 45.6% (floor) / 51.7% (decided) with 0.3% hitting the limit. His summary: "the edit recovers what the recommended settings give" — [issue #4](https://github.com/RikiyaT/lm_understand-logs/issues/4)
- Zhang: with thinking off, the unedited model scores 44.2 / 56.0 / 54.7 (MATH-500 / GSM8K / IFEval). Against the best no-edit decoding setting, the edit adds +6.4, +11.5 and −2.2. Repetition penalty alone lifts the base from 7.9 to 23.1 on MATH-500. With thinking off, the edit gives +0.4 MATH-500 (not significant) and −4.7 IFEval. Per Zhang, the authors' own `code/profiles.py` comment records about 50–55% with thinking off, before they switched to thinking on — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)
- No-LLM control: a textbook difference-of-means direction (k chosen on a practice split) reaches 41.9% on MATH-500, recovering 79% of Astra's 8.3 → 50.6 gain. Random-direction and random-column controls score 5.1% and 8.0%. 31/64 and 22/64 of the top-64 columns overlap with Astra's. Astra adds +8.8 points [+6.6, +10.8] over the recipe — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)
- Selective reporting: the release lists 14 thinking-on runs and the post shows 3. Only p50c gave a large gain; other runs made no edit or duplicated p25c. The logs make this visible — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)

**Other experiments**
- Exp 4: a 2-parameter open-loop controller (reverse 16 steps, then drive, ignoring observations) matches the edit across most of the perturbation grid. It differs only at the edges (friction ×2.0, start shift −0.6), where the edit wins 16/16 vs 0/16 — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)
- Exp 1: a 20-line, 3-rule action-axis script with no LLM gets 3/4. Under anonymization plus shuffling, Astra's pattern is "exactly the script's pattern" (Freeway, Breakout and Pong 9/9; abstains on Pac-Man 3/3) — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)

### Inferences
- Whether "no environment feedback" is fair depends on the source code. Zhang's no-source ablation (Seaquest median 0.8, Asterix 17.4, Breakout 381) indicates the Exp 5 networks are programs compiled from the simulator's code, not policies learned from play.
- The single-model question (only GPT-6 Astra) is partly answered. Open-weight models fail at reading, OpenAI-family models succeed on WSPBench, and the Claude replications are unread. Contamination (Astra trained on weight-reading or interpretability data) is raised on HN but is untestable from outside.

### Gaps
- I could not extract DQN or actor-critic numbers from the MinAtar paper (Young & Tian 2019; the PDF had no text layer). Note also that MinAtar scores depend on the evaluation horizon and sticky actions, so cross-paper comparisons need a matched protocol.
- I found no independent check of the Exp 3 or Exp 7 claims beyond Zhang's static audit, and his weight-distance check for Exp 7 (5/6, below a preregistered 6/6 bar).

## What is genuinely new versus prior hand-crafted or compiled-weights work?

### Takeaway
The individual techniques are not new. Hand-setting or compiling weights (Tracr/RASP, AdderBoard's hand-coded entries), single-direction ablation and steering, ROME-style editing, and K-composition analysis of induction heads all predate this work. What looks new is a general-purpose, untuned frontier LLM choosing and executing those techniques end to end from a natural-language goal. That includes compiling explicit programs (a Breakout lookahead, Go tactics) into MLP weights and reading obvious structure from raw floats, which open-weight models cannot do.

### Cited Findings
- The post itself names its contrasts as "custom networks trained to write them" (fast weight programmers) and "compilers from formal programs" (Tracr). It cites AdderBoard ("coding agents setting the weights of a tiny transformer by hand"). It claims novelty as "a general-purpose frontier model, used as it is, that reads and writes the weights themselves" — [post](https://rikiyat.github.io/blog/weight-space-programming/); [Schlag et al. 2021](https://arxiv.org/abs/2102.11174); [Tracr, Lindner et al. 2023](https://arxiv.org/abs/2301.05062)
- Prior work on LLMs reading weights or activations, cited by the post: Weight Oracles (Kabra, Venhoff, Schroeder de Witt, arXiv 2610.07334); Learning to Interpret Weight Differences (Goel et al., arXiv 2510.05092); Activation Oracles (Karvonen et al., arXiv 2512.15674); and OpenAI's neuron explanations (Bills et al. 2023). Per the post, these involve readers trained for the task. I did not read these papers — [post bibliography](https://rikiyat.github.io/blog/weight-space-programming/)
- AdderBoard is an open challenge for the smallest transformer that adds two 10-digit numbers at ≥99% accuracy. It has "hand-coded" (analytically set weights) and "trained" categories; hand-coded entries count as constructive proofs of what the architecture can represent. Reported parameter counts vary by source (hand-coded as low as 12–36), so the live leaderboard should be checked — [AdderBoard repo](https://github.com/anadim/AdderBoard); [besthub summary](https://www.besthub.dev/articles/how-small-can-a-transformer-get-inside-the-121-parameter-adderboard-challenge-47695bdfd4c6)
- RASP (Weiss, Goldberg, Yahav, ICML 2021) is a programming language for transformer computations; Tracr compiles RASP programs into transformer weights — [RASP](https://arxiv.org/abs/2106.06981); [Tracr](https://arxiv.org/abs/2301.05062)
- Exp 8's mechanism matches single-direction ablation (Arditi et al. 2024, cited by the post) and steering methods (ActAdd, CAA, RepE). Model editing (ROME, MEMIT) and task arithmetic are listed as prior work by the community list — [awesome list](https://github.com/SajjadPSavoji/awesome-weight-space-programming); [Arditi et al.](https://arxiv.org/abs/2406.11717)
- Zhang's assessment: Astra "correctly applies a known interpretability recipe without being told it" in Exp 3. His fixed scripts recover the ranking of heads but not the final decision. The Exp 5 and 6 networks are compiled programs: Astra's Go nets beat a 30-line script 90–95%, and open-weight models lack these abilities — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md); [Zhang blog](https://zhangyiqun018.github.io/rethinking-weight-space-programming/)
- Reading does not scale to behavior. At 1.5M weights, fresh blind Astra sessions identified which Go net was PPO (3/3, dense vs sparse), but swapped the 0-pass and 50-pass nets 3/3 at ≥94% confidence. Their behavioral predictions were no better than a control without weights (e.g., capture-rate MAE 31 vs 28 points) — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)

### Inferences
- "Weight-space programming", as shown, is best described as an LLM acting as an automated ML/interpretability engineer: it compiles programs into weights (Tracr-like, but untyped and done by the LLM itself) and applies known editing recipes. It does not show a new perceptual skill of reading large networks' behavior from raw floats. The from-scratch writing (Exps 5 and 6) is closest to Tracr or hand-coded AdderBoard entries, scaled up to 20K–1.5M-parameter MLPs.

### Gaps
- I did not verify the Weight Oracles or Goel et al. papers directly, or how their trained readers compare quantitatively with zero-shot Astra.
- I did not verify "Curve Circuits" (Distill) or other classic hand-set-weight demonstrations here.

## What safety and security concerns or opportunities follow?

### Takeaway
The authors pitch weight-level auditing (including backdoors), zero-data unlearning and recursive self-improvement. The evidence so far cuts against strong versions of each. Weights-only sycophancy detection failed 4/4; behavior prediction from 1.5M-parameter weights was no better than without weights; and edits removed an obstacle but added no capability. The nearer-term dual-use point is mundane: an agent can automate known weight surgery (directional ablation, as in "abliteration") on open-weight models. Third-party WSPBench suggests weight access does help an agent repair planted faults.

### Cited Findings
- The authors list "Auditing without evaluation": identifying issues "directly from the weights (e.g., backdoors)". They also list zero-data capability steering and unlearning ("Can you add Capability X to the model?"), and recursive self-improvement, where an LLM inspecting and improving "its own weights, or those of a newer model" is "a richer, more native path" — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Evidence against weights-only auditing today: Exp 7 failed from weights alone in 4/4 attempts and succeeded only with an attention-pattern tool on prompts Astra wrote — [post](https://rikiyat.github.io/blog/weight-space-programming/). Zhang adds that the prompt stated the exact behavioral contrast and training template, and that the base model already follows 100% of wrong guesses, so the "honest" model is the one that changed — [CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)
- Evidence against capability addition: Gemma 3 270M could not be improved ([post](https://rikiyat.github.io/blog/weight-space-programming/)). Zhang says the edit gives no math gain once looping is removed and calls the "add Capability X" vision overstated ([CLAIMS.md](https://github.com/ZhangYiqun018/rethinking-weight-space-programming/blob/main/results/CLAIMS.md)).
- On recursive self-improvement, HN commenters (YeGoblynQueenne and others) argue there is no evidence a model can improve a larger model or transfer new capabilities — [HN 50341174](https://news.ycombinator.com/item?id=50341174)
- Opportunity for detection and repair: on WSPBench, weight access raised GPT-6.1 Sol's repair of planted faults from 14/32 to 30/32, with clean controls preserved. This is a third-party, small-scale benchmark — [WSPBench](https://github.com/alexcarterhq/wspbench)
- Guardrail removal: HN discussed abliteration and "uncensored" models as precedent rather than a new risk. stymaar noted Exp 8 is the same technique used in community decensoring — [HN 50341174](https://news.ycombinator.com/item?id=50341174). Secondary coverage is split between "help detect hidden backdoors" and "safety guardrails are now LLM-removable" (search-result snippets; I did not read the primary pieces) — [PiyushAI](https://piyushai.com/weight-space-programming-explained/); [gopenai blog](https://blog.gopenai.com/weight-space-programming-llms-edit-neural-network-weights-35ef19e10290)
- Edit magnitude: the Exp 4 edit drives one weight from about 0.095 to about 876 (Messing, via issue #8; Toledo also notes the car policy's edited weights "reach 876"). So "3.5% of weights" understates how much the edit perturbs the network — [issue #8](https://github.com/RikiyaT/lm_understand-logs/issues/8); [issue #4](https://github.com/RikiyaT/lm_understand-logs/issues/4)
- Speculation by an HN commenter (Christopear): strong results may mean labs now train models on model weights, which the commenter finds more concerning than the blog's framing. This is unverified — [HN 50341174](https://news.ycombinator.com/item?id=50341174)

### Inferences
- Security-relevant capabilities shown:
  - (a) Automated, sparse, targeted edits to open-weight LMs from a goal plus about 50 forward-pass batches. This is a low-cost tampering path, but its techniques were already public (abliteration, ROME).
  - (b) Compiling hand-designed programs into weights. In principle this could graft a hidden trigger circuit into a small network, the mirror image of backdoor detection. No source demonstrates backdoor insertion.
- A detection asymmetry follows from the evidence. Inserting known circuits (writing) works better than inferring behavior from opaque weights (reading at scale). That favors attackers over weights-only auditors for now, unless auditors get activation or probe access, as in Exp 7b and WSPBench.
- Very sparse edits (0.016% of weights) that change behavior drastically suggest checksum- or diff-based integrity checks matter more than distribution-level weight statistics. Tiny diffs can hide large magnitude changes.

### Gaps
- I found no published experiment on LLM-driven backdoor insertion or detection via weight-space programming. I found no LessWrong or Alignment Forum safety analysis, and no statement from OpenAI about GPT-6 Astra's weight-editing capabilities or evaluations.
