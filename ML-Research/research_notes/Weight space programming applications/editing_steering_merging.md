# Weight-Space Programming, editing side: where LLM-written weight edits could apply (editing, steering, unlearning, repair, merging) and how they compare with existing methods

Scope note: "the post" = Takehi, Teoh, Zhang, Khattab, "Sparks of Weight-Space Programming," MIT CSAIL blog, Nov 2 2026 ([post](https://rikiyat.github.io/blog/weight-space-programming/)). Facts about the post below come from one fetch of that page. Work from before 2025 is marked **[background]**. Several classic papers (ROME, MEMIT, GRACE, WISE, RepE, ActAdd, CAA, TOFU, task arithmetic, TIES, model soups, Git Re-Basin, model stitching) are cited from the arXiv abstracts as I know them, and were **not re-fetched this session**. Their headline numbers are flagged "(not re-verified)".

Facts from the post that every section depends on:
- Setup: "GPT-6 Astra" with a Python sandbox (numpy/PyTorch on CPU). Gradients, training loops, data fitting and search were disallowed. For Qwen, one forward pass ran the model on up to 512 problems or 1,024 texts, with budgets of 10, 25 or 50 passes — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Qwen3.5-0.8B: 85 of the first 96 practice answers hit the 32,768-token limit. Astra traced the loops to one direction written by the MLPs of layers 15 and 19 and subtracted it from 64 output columns in each layer (131,072 weights, about 0.016%). The post does not fully say how the direction was found — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Results (MATH-500 / GSM8K / IFEval / % of MATH-500 answers hitting the token limit): base 7.9 / 13.8 / 21.0 / 93.0; 10 passes 12.3 / 25.7 / 49.0 / 87.2; 25 passes 14.1 / 25.1 / 39.9 / 86.4; 50 passes 48.1 / 67.1 / 62.3 / 33.1. The post says six other benchmarks were evaluated but does not list them — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Sampling for every run: temperature 0.6, top-p 0.95, top-k 20, **presence penalty 1.5** — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Gemma 3 270M rarely loops (8.5% hit the token limit). Astra found only ordinary reasoning errors. MATH-500 went 6.8 (base), 7.0 (5 passes), 7.6 (10), 7.7 (25), 7.0 (50). The authors conclude that editing can remove an obstacle hiding an ability but cannot add a missing one — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- **No baselines**: the post does not compare against repetition penalties, fine-tuning/LoRA or activation steering, and gives **no cost figures** (tokens, API spend, wall-clock). Steering, unlearning, merging and grafting are listed only as future possibilities — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Other editing evidence in the post: in Exp. 4, Astra edited 3.5% of a 171,664-weight PPO actor in one try, and the car succeeded in 1,024 of 1,024 episodes (the original failed 256 of 256). In Exp. 7, it could not detect sycophancy from weights alone (0 of 4), but did with attention-pattern access (3 of 3) — [post](https://rikiyat.github.io/blog/weight-space-programming/)

## 1. Direction ablation and orthogonalization (refusal direction, abliteration, RepE, ActAdd/CAA, persona vectors): what exists, and what an LLM agent adds

### Takeaway
The Qwen fix is structurally a one-direction ablation baked into the MLP output weights. That is exactly what Arditi-style weight orthogonalization ("abliteration") and Steer2Edit already do, cheaply and in closed form, once the direction is known. The only new contribution an agent could make is *finding* the direction for a behavior nobody has framed as a contrast set. The post does not show this, because it does not say how the direction was found and runs no difference-in-means baseline.

### Cited Findings
- Arditi et al. (2024) found that refusal in 13 open chat models up to 72B is mediated by one direction: removing it stops refusal and adding it triggers refusal. The resulting white-box jailbreak has "minimal effect on other capabilities" — [arXiv 2406.11717](https://arxiv.org/abs/2406.11717)
- "Abliteration" is the community name for orthogonalizing weights against that direction. A 2025 cross-architecture comparison of abliteration tools (DECCP, ErisForge, Heretic) reports that single-pass methods preserved capability better than the optimization-based Heretic, on three models — [arXiv 2512.13655](https://arxiv.org/html/2512.13655v2)
- Vendor and model-card claims for abliterated Qwen builds: harmful-prompt refusal falls from 64–99% to 0–6%, with capability benchmarks within ±1.3 points. Not peer-reviewed, and the model naming there is questionable — [orcarouter blog](https://www.orcarouter.ai/blog/qwen-3-8-27b-uncensored-benchmarks)
- Single-direction pushback: a 2026 paper argues that steering along any refusal-related direction produces nearly identical refusal / over-refusal trade-offs, a shared one-dimensional knob. Wollschläger et al. argue that refusal lives in multi-dimensional "concept cones" — [arXiv 2602.02132](https://arxiv.org/html/2602.02132v1)
- **[background]** Representation Engineering (Zou et al. 2023) reads and controls concepts such as honesty and power-seeking through directions found from contrastive prompts — [arXiv 2310.01405](https://arxiv.org/abs/2310.01405) (not re-verified)
- **[background]** ActAdd (Turner et al. 2023) adds an activation difference from a single prompt pair at inference time. CAA (Rimsky et al. 2023) averages residual differences over many A/B contrast pairs on Llama 2 Chat to steer behaviors such as sycophancy — [ActAdd arXiv 2308.10248](https://arxiv.org/abs/2308.10248); [CAA arXiv 2312.06681](https://arxiv.org/abs/2312.06681) (not re-verified)
- Persona vectors (Anthropic, Aug 2025) are activation directions for evil, sycophancy and hallucination on Qwen2.5-7B-Instruct and Llama-3.1-8B-Instruct. Post-hoc steering against a vector works but costs capability. "Preventative steering" during fine-tuning caused "little-to-no degradation" in MMLU. The vectors also flag training data likely to cause a trait — [Anthropic](https://www.anthropic.com/research/persona-vectors?mode=reply); [arXiv 2507.21509](https://arxiv.org/pdf/2507.21509)
- Steer2Edit (Sun, Yan, Wang, Weng, 2026; NeurIPS 2026 poster) turns steering vectors into closed-form, training-free rank-1 edits on individual attention heads and MLP neurons. At matched downstream performance it reports +17.2% safety, +9.8% truthfulness and **−12.2% reasoning length** — [arXiv 2602.09870](https://arxiv.org/html/2602.09870); [project page](https://lilywenglab.github.io/Steer2Edit). Figures come from search snippets, not the full text.
- Contrastive weight steering (ICLR 2026) isolates a behavior direction in weight space by subtracting the weight deltas of two fine-tuned models — per a search summary of [arXiv 2511.05408](https://arxiv.org/pdf/2511.05408v2) (not fetched)
- Dual use: a 2026 paper (ACL 2026) "compiles" steering into weights under null-space constraints to plant stealthy backdoors — [papernotes summary](https://en.papernotes.org/ACL2026/llm_safety/compiling_activation_steering_into_weights_via_null-space_constraints_for_stealt/)

### Inferences
- The Qwen edit (subtract one direction from 2 × 64 MLP output columns) is mechanically equivalent to projecting out a direction from W_out, which is Arditi orthogonalization restricted to a few columns. The edit itself is not novel. The open question is whether a difference-in-means between looping and non-looping rollouts would have found the same direction. My guess is yes: looping is easy to label automatically (did the answer hit the limit), so a contrast set is free. The post gives no evidence that the agent beat that baseline.
- What an agent plausibly adds: (a) deciding *which* layers and columns to edit, rather than ablating everywhere, which may explain the small footprint; (b) behaviors with no obvious contrast pair (the post's sycophancy result needed attention access even to *detect* the behavior); (c) checking side effects within a fixed forward-pass budget. Steer2Edit already automates (a) in closed form.
- **Verdict, steering / direction ablation: LIKELY to be the first real application, as an automated front end for direction-finding and edit placement, not as a replacement for abliteration or steering math.** It needs fewer than 50 forward passes and suits behaviors that one or a few directions control (refusal, looping, verbosity, persona traits). The evidence for single-direction control is strong for refusal and persona traits, and contested for multi-dimensional behaviors.
- **Verdict, "zero-data" steering: UNLIKELY as stated.** The Qwen fix used 50 forward passes over up to 512 problems each. That is data, just unlabeled and self-generated. With 10 or 25 passes the gains were small and the token-limit rate barely moved (87.2%, 86.4%).

### Gaps
- How Astra found the direction (activation statistics? reading W_out? rollouts?) is not explained. Without that, "the agent found what difference-in-means would find" cannot be ruled out.
- I found no head-to-head of an LLM agent against difference-in-means, CAA or Steer2Edit on the same behavior.
- I could not verify the abliteration MMLU/GSM8K degradation numbers against the Arditi paper itself (only the abstract was fetched).

## 2. Knowledge editing (ROME, MEMIT, AlphaEdit, GRACE, WISE) and its failure modes: could an LLM editor do better?

### Takeaway
Locate-and-edit methods already write closed-form, least-squares-optimal rank-one or low-rank updates for individual facts. Their known failures (ripple effects, loss of locality, collapse after many edits) are not problems a smarter author of the edit would solve, because the edit is already optimal for its objective. An LLM editor is **unlikely** to beat them on mass fact editing, but **plausible** as an orchestrator: choosing what to edit and checking ripple effects.

### Cited Findings
- **[background]** ROME (Meng et al. 2022) edits one fact through a rank-one update to a mid-layer MLP, treated as a key-value store. MEMIT (Meng et al. 2022) spreads the update over several layers and scales to thousands of edits (10,000 on GPT-J / GPT-NeoX in the paper) — [ROME arXiv 2202.05262](https://arxiv.org/abs/2202.05262); [MEMIT arXiv 2210.07229](https://arxiv.org/abs/2210.07229) (not re-verified)
- **[background]** GRACE adds a discrete key-value codebook adapter at one layer for lifelong sequential edits without changing the original weights. WISE (2024) routes between main memory and a side memory to balance reliability, generalization and locality — [GRACE arXiv 2211.11031](https://arxiv.org/abs/2211.11031); [WISE arXiv 2405.14768](https://arxiv.org/abs/2405.14768) (not re-verified)
- AlphaEdit (ICLR 2025) projects each update into the null space of preserved knowledge and beats MEMIT, PRUNE and RECT under sequential editing of several thousand facts on LLaMA3, GPT-2 XL and GPT-J — [arXiv 2410.02355](https://arxiv.org/html/2410.02355v4)
- A 2026 reproducibility study confirms AlphaEdit's metrics at the original scale, but finds performance degrades at much higher edit counts: the null-space protection is "bounded rather than unconditional." It also flags a discrepancy in a fluency/consistency metric — [arXiv 2606.26783](https://arxiv.org/pdf/2606.26783)
- BetaEdit (IJCAI 2026) argues that null-space methods use an approximate null space that leaks knowledge. It claims effectiveness after 10,000 sequential edits, where existing editors "typically fail" with near-zero efficacy. This is the authors' own comparison — [IJCAI 2026](https://www.ijcai.org/proceedings/2026/0508.pdf)
- Ripple effects: on RippleEdits, parametric editors such as ROME score well on the edited fact but average **under 50%** on related facts that should change too — [arXiv 2307.12976](https://arxiv.org/pdf/2307.12976). A 2024 study links ripple success to gradient similarity between facts, so how knowledge is stored determines how edits propagate — [arXiv 2407.12828](https://export.arxiv.org/pdf/2407.12828)
- Scaling: ROME and MEMIT edits are "not as localized" as believed. ROME has "disabling edits," single edits that destroy the model's function. MEMIT is more robust to these — [arXiv 2401.07453](https://ar5iv.arxiv.org/html/2401.07453)
- Collapse: even one edit can cause catastrophic degradation. MEMIT avoids collapse in some cases only by giving up much of its edit success, a robustness / efficacy trade-off — [arXiv 2402.09656 summary](https://api.emergentmind.com/papers/2402.09656)

### Inferences
- ROME-family edits are the *optimal* answer to "change this key's value while preserving these other keys" under a covariance constraint. An LLM writing the update by reasoning over weights can at best rediscover that solve, and will probably be worse. Its comparative advantage is knowing *what* to edit: generating the ripple set (the facts that should change too), choosing layers, writing the preservation set, then calling ROME/AlphaEdit as a tool. That makes it an editing agent, not weight-space programming.
- Weight-space programming's demonstrated mode (remove a direction, unblock an existing ability) is the opposite of knowledge editing (insert a new association). The Gemma result, where nothing could be added, is direct evidence against "LLM writes new facts into weights better than MEMIT."
- At thousands to 10,000 edits, the bottleneck is interference in a shared subspace (AlphaEdit's bound, BetaEdit's leakage). That is linear algebra, and an LLM's per-edit judgment does not change the rank or capacity limits.
- **Verdict, mass fact editing: UNLIKELY to beat MEMIT / AlphaEdit / BetaEdit / WISE.** **Verdict, a few high-stakes edits with ripple-aware planning: PLAUSIBLE**, as an orchestrator over existing editors with forward-pass verification.

### Gaps
- No study evaluates an LLM agent writing knowledge edits directly. All comparisons above are inference.
- I could not read the BetaEdit or AlphaEdit collapse curves (only snippets).

## 3. Machine unlearning (gradient ascent / NPO, RMU on WMDP, TOFU, representation misdirection) and robustness to relearning: prospects for LLM-written edits

### Takeaway
Current unlearning mostly *hides* knowledge, and RMU is undone by a direction ablation, which is the very operation weight-space programming performs. An agent that can find and subtract directions is therefore more naturally an **attacker or auditor** of unlearning than a better unlearner. "Zero-data unlearning" that survives relearning is **unlikely**. Auditing whether unlearning really erased something is **plausible**.

### Cited Findings
- WMDP is 3,668 multiple-choice questions on biosecurity, cybersecurity and chemical security, released with the RMU unlearning method — [arXiv 2403.03218](https://arxiv.org/abs/2403.03218)
- Łucki et al. (Zephyr-7B-β): WMDP-Bio 64.4 (MMLU 58.1) falls to **29.9** after RMU (MMLU 57.1, near the 25% chance level). Attacks bring it back: fine-tuning on **10 retain-set (unrelated) examples** gives 61.6; 5 forget-set examples give 62.4 (MMLU 58.0); **orthogonalization (removing a direction) gives 64.7** (MMLU 57.3), full recovery; an enhanced GCG prefix gives 53.9 — [arXiv 2409.18025](https://arxiv.org/html/2409.18025v4)
- Łucki et al.'s conclusion: "unlearning methods primarily obscure knowledge rather than eliminate it," so RMU and NPO are vulnerable to the same attacks as refusal training, and output-based evaluations are not enough — [arXiv 2409.18025](https://arxiv.org/html/2409.18025v4)
- The WMDP authors acknowledged that RMU cannot prevent fine-tuning from recovering performance, and placed post-unlearning fine-tuning outside their (closed-weights) threat model — [arXiv 2403.03218 PDF](https://arxiv.org/pdf/2403.03218)
- Relearning: Deeb & Roger showed that RMU and two other methods are not robust to fine-tuning on data from the unlearned distribution (one summary cites >88% recovery). Layered Unlearning (2025) improves resistance, but a corpus-based fine-tuning attack bypasses it more effectively — [Layered Unlearning arXiv 2505.09500](https://arxiv.org/html/2505.09500v1); [LessWrong discussion, "Unlearning via RMU is mostly shallow"](https://www.greaterwrong.com/posts/6QYpXEscd8GuE7BgW/unlearning-via-rmu-is-mostly-shallow/comment/6t7LN7ftsA9B9rxt4)
- "Watch the Weights" (ICLR 2026) monitors fine-tuned models from their weights. It detects inference on erased topics with up to 95.42% accuracy and can steer the model to recover "unlearned" information — [arXiv 2508.00161](https://arxiv.org/pdf/2508.00161)
- Agentic LLM Unlearning (ALU) uses a pipeline of LLM agents to "unlearn" at inference time with no parameter updates. This is a different, non-weight use of agents — [arXiv 2502.00406](https://arxiv.org/html/2502.00406v2)
- **[background]** TOFU is a benchmark of 200 fictitious author profiles for testing whether fine-tuned-in knowledge can be forgotten — [arXiv 2401.06121](https://arxiv.org/abs/2401.06121) (not re-verified)

### Inferences
- The post's own operation (subtract one direction from a few columns) is the kind of edit Łucki et al. used to *undo* RMU. A direction-subtraction edit that "removes" a capability is likely just another obscuring edit, and should be just as reversible by fine-tuning or by re-adding the direction. The post's framing ("remove a behavior by deleting a direction") fits suppression, not erasure.
- The Gemma result ("cannot add a missing ability") has a mirror image: real erasure means destroying knowledge spread across many weights. That is the hard, non-sparse case where the post's method did nothing.
- Where an agent could help: (a) **auditing**, i.e. reading an "unlearned" model to find the suppression direction and showing the knowledge is still there (Watch the Weights shows this is feasible with simpler tools); (b) generating forget and retain probes without a curated dataset; (c) red-teaming unlearning before release.
- **Verdict, robust unlearning via LLM-written sparse edits: UNLIKELY.** It is the same mechanism class that is already shown to be reversible. **Verdict, cheap suppression for a closed-weights deployment** (the WMDP threat model): **PLAUSIBLE**, no better than RMU. **Verdict, unlearning audit / red-teaming: LIKELY to be a useful application.**

### Gaps
- No experiment applies an LLM weight editor to WMDP or TOFU. All of the above is extrapolation.
- The ">88% recovery" figure is from a secondary summary, and I did not fetch the Deeb & Roger paper.

## 4. Model merging and grafting (task arithmetic, TIES, DARE, soups, evolutionary merge, Git Re-Basin, stitching, cross-architecture transplant): where an LLM that understands weights could help

### Takeaway
Same-architecture merging is already cheap, mostly data-free and well tuned by evolutionary search, so an LLM author adds little. The post's "true cross-architecture merging by grafting circuits" lines up with the hardest open problem. The best 2026 method (Transport and Merge, OT alignment of neurons) gets modest gains of about 0.1 to 2 points on averages, with large gains only on some subtasks. An LLM could plausibly propose correspondences and graft sites, but there is **no evidence** yet. Verdict: **unlikely in the near term** for capability grafting between different LLMs. **Plausible** as a merge-recipe designer.

### Cited Findings
- **[background]** Task arithmetic: subtracting pre-trained from fine-tuned weights gives a "task vector" that can be added, negated (to forget) or combined (Ilharco et al. 2022) — [arXiv 2212.04089](https://arxiv.org/abs/2212.04089) (not re-verified)
- **[background]** TIES-Merging trims low-magnitude deltas, elects a sign per parameter, and merges only agreeing values — [arXiv 2306.01708](https://arxiv.org/abs/2306.01708); summarized in [review arXiv 2503.08998](https://arxiv.org/pdf/2503.08998)
- DARE randomly drops delta parameters at rate p and rescales the rest by 1/(1−p). It can drop up to **99%** of deltas with minimal loss at 70B scale, and the rescaling is essential (dropping 30–40% without it already hurts) — [arXiv 2311.03099](https://arxiv.org/html/2311.03099v3). A review notes that DARE degrades badly at extreme drop rates in other settings, which motivated DELLA — [arXiv 2503.08998](https://arxiv.org/pdf/2503.08998)
- Souper-Model (Nov 2025): **52.99%** of active parameters had 2-vs-1 sign conflicts, and **81.63%** of the top-10% magnitude parameters were conflicted. TIES and DARE introduced "severe regressions" in domains such as tool use, while simple weighted soups did well — [arXiv 2511.13254](https://arxiv.org/pdf/2511.13254)
- **[background]** Model soups: averaging fine-tuned weights improves accuracy without extra inference cost (ViT-G ImageNet SOTA in 2022) — [arXiv 2203.05482](https://arxiv.org/abs/2203.05482) (not re-verified)
- **[background]** Evolutionary merge (Akiba et al., Sakana, 2024): the best source model scored about 30.0 on MGSM-JA. The evolved parameter-space merge reached **52.0**, and the parameter + data-flow (layer-routing) hybrid **55.2**. EvoLLM-JP-v1-7B scored 70.5 against 66.1 for the best source on lm-eval-harness Japanese, and is reported to beat some 70B models — [arXiv 2403.13187](https://arxiv.org/html/2403.13187v2); [alphaXiv overview](https://alphaxiv.org/overview/2403.13187v2); [liner review](https://liner.com/review/evolutionary-optimization-model-merging-recipes)
- **[background]** Git Re-Basin (Ainsworth et al. 2022) permutes the hidden units of one network to align with another, so the two can be linearly interpolated with (near) zero loss barrier in some wide-network settings. Model stitching (Bansal et al. 2021) joins the lower layers of one network to the upper layers of another with a trained linear layer — [Git Re-Basin arXiv 2209.04836](https://arxiv.org/abs/2209.04836); [stitching arXiv 2106.07682](https://arxiv.org/abs/2106.07682) (not re-verified)
- Transport and Merge (Cui et al., ICML 2026) is cross-architecture merging that aligns activations with optimal transport on about 2,000 inputs per dataset, then fuses weights directly with no distillation. Sources are LLaMA-3 8B family models, targets are about 1B models. Results (base → fused → fused + adaptation): Indonesian average 38.43 → 39.18 → 39.30; Cantonese CMMLU 25.26 → 27.41 → 27.44; Thai average 0.41 → 0.45 → 0.50 (Thai MGSM 0.50 → 0.72); finance 0.32 → 0.34 → 0.35; medical 46.30 → 46.23 → 47.87; MalayMMLU category gains of +3.3 to +6.5. Baselines (distillation, SFT) appear only as normalized z-scores in a figure. No compute is reported. Results are sensitive to the mixing coefficient α — [arXiv 2602.05495](https://arxiv.org/html/2602.05495)

### Inferences
- Same-architecture merging already works with little data (soups, task arithmetic, DARE) or needs only a cheap fitness function plus search (Sakana). An LLM writing merge coefficients by hand has to beat CMA-ES over a fitness function. That is plausible only where the fitness evaluations are expensive and the LLM's prior reduces how many are needed. This is the same "a few forward passes" economy as the post.
- Cross-architecture grafting is the post's most ambitious claim, and the strongest current baseline gets modest gains even with OT alignment on 2,000 inputs. "Transplant a reasoning module" requires (a) that the capability is localized, when the post's Gemma result and the reasoning-is-distributed evidence suggest it often is not, and (b) an interface alignment between residual streams, which needs activation data (stitching layers are trained). An LLM cannot skip (b) from weights alone.
- Where an LLM could actually help: proposing which layers or blocks to route (Sakana's data-flow merge is a search over exactly that), diagnosing merge interference (sign conflicts, as in Souper-Model), and choosing per-layer α in OT merges. All of these are orchestration with forward-pass verification.
- **Verdict, same-architecture merge recipe design: PLAUSIBLE but marginal** compared with evolutionary search. **Verdict, cross-architecture circuit grafting ("true merging"): UNLIKELY in the near term.** There is no demonstration, and the best non-LLM method gives single-digit gains.

### Gaps
- No paper or post demonstrates LLM-authored merging or grafting.
- The Transport and Merge baselines are visual only, so I cannot quantify its margin over distillation.

## 5. Repairing specific failure modes (looping in small reasoning models): known causes and fixes, sparse FT/LoRA as the baseline, and whether the gain is "unblocking"

### Takeaway
The Qwen gain is almost certainly **unblocking**. Answers hit the token limit 93% of the time at baseline, so most of the 7.9 → 48.1 jump is answers that simply never finished before the edit. The Gemma null result supports that reading. The baseline already used Qwen's recommended presence penalty of 1.5, so the edit beats the standard decoding fix. Training-time fixes (data, RL, LoRA) are the untested comparison.

### Cited Findings
- The base looped heavily even with presence penalty 1.5 (93.0% of MATH-500 answers hit the limit). The 50-pass edit cut this to 33.1%, which still leaves a third looping — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Qwen3 model cards advise presence_penalty between 0 and 2 to reduce "endless repetitions" (1.5 if repetition is significant). They warn that higher values can cause language mixing and slightly lower performance, and that greedy decoding causes endless repetitions. Recommended thinking-mode settings are T=0.6, top-p 0.95, top-k 20, min-p 0, the same as the post used — [friendli.ai mirror of Qwen3-0.6B card](https://friendli.ai/models/yrrhall/Qwen3-0.6B); a later Qwen3.6 card recommends 1.5 for thinking and 0.0 for coding — [Qwen3.6-35B-A3B commit](https://gitserver.onethingai.com/ai-models/Qwen3.6-35B-A3B/commit/a005c49d476ed5a283c9ec0d2a6b524723f4d925)
- "Wait, Wait, Wait... Why Do Reasoning Models Loop?" (Pipis et al., ICML 2026) attributes looping to learning errors, not decoding: hard steps push the model toward an easy cyclic action, and small persistent estimation errors among near-tied actions keep picking the same options. Distilled students loop most: OpenThinker3-1.5B loops in **30%** of greedy responses, while its teacher QwQ-32B rarely does. Looping rises with difficulty and falls with model size. Raising temperature only masks the problem. The authors recommend training-time fixes — [arXiv 2512.12895](https://arxiv.org/abs/2512.12895); [ICML 2026](https://icml.cc/virtual/2026/spotlight/84640)
- Distilled models show content repetition and over-reflection that leave no final answer. Tree-based CoT distillation data reduces repetition — [arXiv 2503.01461](https://arxiv.org/html/2503.01461v1)
- Steer2Edit, a training-free rank-1 component edit, already reports −12.2% reasoning length at matched performance, a direct prior for "edit weights to fix over-long reasoning" — [arXiv 2602.09870](https://arxiv.org/html/2602.09870)

### Inferences
- Unblocking arithmetic: at a 93% token-limit rate, only about 7% of MATH-500 answers finish, yet accuracy is 7.9%. So nearly every finished answer is right, and some truncated ones may be scored from partial output (the post does not say how truncated answers are graded). After the edit, 66.9% finish and accuracy is 48.1%, meaning about 72% of finished answers are right. Accuracy is set almost entirely by how many answers finish. The edit mostly lets the model finish. It does not make it reason better per finished answer. IFEval (21 → 62.3) fits too: instruction-following fails when the model never stops.
- Pipis et al.'s mechanism (a learned bias toward one easy cyclic action) is exactly what a single direction could encode, which makes a one-direction fix believable. It also predicts the fix is partial (33% still loop), because some of the problem is the distribution of near-tied actions, not one direction.
- Gradient baselines the post omits: (1) LoRA or SFT on a few thousand non-looping self-generated traces (rejection sampling); (2) short RL with a length or termination penalty; (3) difference-in-means ablation (Section 1); (4) Steer2Edit. Option (3) needs the same rollouts the agent used and no frontier model. Without these, it is unknown whether the agent adds anything beyond "someone looked for the loop direction."
- Sparse-edit advantages are real but unmeasured. 0.016% of weights changed suggests little collateral damage, but the post does not report its other six benchmarks, so forgetting is unverified.
- **Verdict, failure-mode repair (looping, verbosity, refusal over-trigger, format breakage) in small open models: LIKELY to be the most credible near-term application.** It should be framed as "unblocking existing capability." Gemma shows it does nothing when there is no single blocking component.

### Gaps
- I found no published Qwen3.5-0.8B MATH-500 / GSM8K numbers to tell how close 48.1 / 67.1 is to the model's ceiling without loops.
- No LoRA or RL anti-looping baseline exists for this exact model.

## 6. Cost and scale: LLM-agent editing vs a LoRA fine-tune; context limits at 7B–70B+

### Takeaway
The post gives no cost data, so any comparison is a back-of-envelope estimate. Weights cannot be "read" at 7B–70B. Any agent must work through tools (SVD, projections, activation statistics), which makes it an automated interpretability researcher, and its edge over scripted methods has to come from choosing what to compute. The forward-pass budget alone is comparable to or larger than a small LoRA run.

### Cited Findings
- No token, API or wall-clock costs are reported. Context length and harness design are named as the main bottlenecks. The Qwen budget is up to 50 passes × 512 problems at up to 32,768 tokens each — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- The post's largest edited model is 0.8B, and the largest model it read was "four middle transformer blocks" of a small model (7.16M weights). Its MinAtar and Go networks were 17k to 1.48M weights — [post](https://rikiyat.github.io/blog/weight-space-programming/)
- Arditi et al. applied single-direction orthogonalization to models up to 72B, so the edit operation scales trivially once the direction is known — [arXiv 2406.11717](https://arxiv.org/abs/2406.11717)
- DARE claims are strongest at 70B (99% of deltas droppable), i.e. large models have highly redundant deltas. That helps sparse editing but also means a small edit may be absorbed — [arXiv 2311.03099](https://arxiv.org/html/2311.03099v3)

### Inferences (my own estimates, not from sources)
- Forward-pass cost upper bound for the Qwen run: 50 × 512 × 32,768 ≈ 8.4 × 10^8 generated tokens on a 0.8B model ≈ 2 × 0.8e9 × 8.4e8 ≈ 1.3 × 10^18 FLOPs. Looping answers dominate, so the real figure is probably a sizable fraction of that. A LoRA SFT on, say, 5,000 traces of 4k tokens (2 × 10^7 tokens, with the trainable fraction tiny but the full forward/backward still run) costs about 6 × 0.8e9 × 2e7 ≈ 10^17 FLOPs. So LoRA is likely **cheaper or similar** in target-model compute, before counting the frontier agent's own tokens, which are unreported and probably dominant.
- Context: a 7B model in bf16 is about 14 GB (about 7 × 10^9 numbers) and a 70B model about 140 GB. Even one 4096 × 11008 MLP matrix is about 45M numbers, far beyond any context. The "read the weights as text" mode used in the small experiments ends somewhere around 10^5 to 10^6 parameters. Beyond that, the agent's choice of analyses is the method.
- Scale works in two directions. Larger models are more linear and more redundant (single directions for refusal held to 72B, DARE at 70B), which favors direction edits. But each forward pass costs 10 to 100x more at 7B–70B, which hurts an agent that needed 50 passes to succeed at 0.8B.
- **Verdict, cost advantage over LoRA: UNLIKELY** for anything a contrast set or SFT can address. **Possible advantage**: no gradient memory (CPU-feasible edits on huge models), auditable and reversible diffs (131k numbers), and no training data needed beyond self-generated rollouts.

### Gaps
- The agent-token cost and wall-clock time are unknown, which blocks any real comparison.
- No result exists for any model above 0.8B, or for an MoE.

### Summary verdict table (my synthesis of the sections above)
| Application | Verdict | Core reason |
|---|---|---|
| Failure-mode repair / unblocking (looping, verbosity, over-refusal) | LIKELY | Demonstrated once. One-direction behaviors are common, and the ablation math scales to 72B |
| Automated direction-finding for steering / abliteration | LIKELY (as a front end) | The agent's value is choosing the direction and placement. The edit itself is the known Arditi / Steer2Edit operation |
| "Zero-data" steering | UNLIKELY as stated | It needed 50 passes over up to 512 problems. With 10 or 25, the gains were small |
| Knowledge editing at scale | UNLIKELY to beat MEMIT / AlphaEdit / WISE | The closed-form least-squares edits are already optimal, and the limits are capacity and interference |
| Few ripple-aware fact edits | PLAUSIBLE | As an orchestrator over existing editors |
| Robust unlearning | UNLIKELY | Direction edits obscure rather than erase. Orthogonalization *restores* RMU-unlearned knowledge (64.7 vs 64.4) |
| Unlearning audit / red-team | LIKELY | Same operation, aimed at finding hidden knowledge |
| Same-architecture merge recipes | PLAUSIBLE, marginal | Evolutionary search and data-free merges are already strong |
| Cross-architecture circuit grafting | UNLIKELY (near term) | Not demonstrated. The best OT method gains about 0.1 to 2 points on averages. Interfaces need activation alignment |
| Cost advantage over LoRA | UNLIKELY | Forward-pass compute is comparable, and the frontier-agent cost is extra and unreported |
