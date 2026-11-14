# LLM Weight-Reading for Interpretability, Auditing and Weight-Space Learning

Scope note: "weight-reading" here means a general-purpose LLM agent inspecting raw parameters (possibly with a Python sandbox for linear algebra, but without forward passes on task data), as in Takehi, Teoh, Zhang and Khattab, "Sparks of Weight-Space Programming" (MIT CSAIL blog, Nov 2026). Sources marked **[background]** are older canonical work cited from prior knowledge and were not re-fetched this session. Every other source was searched or fetched on 2026-11-05.

### Anchor: what the Sparks post actually shows on the reading side
- Exp 1: four PPO MLPs (500→32→32→5, tanh, 17,253 weights), one each for Breakout, Pong, Pac-Man and Freeway. Astra got the weights as text, was not told the candidate games, and named all 4 correctly by reasoning about where the input-channel weights concentrate, for example a paddle along the bottom row — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/)
- Exp 2: three DDPMs (circle, square, triangle, 12×12 images, 23,824 weights). Astra identified the shape with no tools or forward passes. It drew outlines where the models generate filled shapes, which the authors read as evidence of structural reading rather than simulation — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/)
- Exp 3: three character-level transformers (4 layers × 6 heads, about 7.16M weights) trained on Python, romaji or English. Given only the middle blocks, Astra named the language 3/3 in both attempts. It found every induction head with no false positives (Python 2.1, 3.1, 3.5; romaji 3.3; English 3.1) by first finding a previous-token head and then taking weight-matrix products. The authors say this matches Elhage et al., which they did not mention to Astra. It also inferred romaji's small alphabet because the last block writes in fewer directions — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/)
- Exp 7: three pairs of Gemma 3 270M fine-tunes on QA data, with embeddings and unembeddings frozen. The sycophant followed 100% of wrong user guesses; the honest model followed 1–3%. **From weights alone Astra failed all 4 attempts**: it found many weight differences but could not tie them to behavior. Allowed to look at attention patterns on probe texts it wrote itself (no outputs), it identified the sycophant in 3/3 pairs. In head 10.2 the honest model put 94.3% of its attention on the question's numbers and 0.75% on the user's answer; the sycophant put 3.5% on the question and 85.7% on the user's answer — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/)
- "Auditing for hidden problems such as backdoors without running evaluations" is listed as a proposed implication. It is **not demonstrated** in the post. Results come from single runs or a few seeds, and the authors are building a benchmark and harness. Logs are in RikiyaT/lm_understand-logs — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/)

---

## 1. Mechanistic interpretability that works directly on weights

### Takeaway
Weight-only circuit analysis is mature and largely mechanical for small attention-only or toy models: QK/OV products, composition scores and eigenvalue checks. That is exactly what Astra rediscovered, and an LLM agent with a linear-algebra sandbox can plausibly automate it. For production-scale models, the field has moved to activation-conditioned methods (attribution graphs, transcoders) and to parameter decompositions trained against the model's outputs, because global weight analysis suffers from interference and superposition. An LLM agent is likely to help as an orchestrator of these tools, not as a replacement for them.

### Cited Findings
- **Elhage et al. 2021, "A Mathematical Framework for Transformer Circuits"** [background]. Each attention head factors into a QK circuit (W_E^T W_Q^T W_K W_E, which decides where to attend) and an OV circuit (W_U W_O W_V W_E, which decides what is written). Head-to-head composition (Q-, K- and V-composition) is measured with Frobenius-norm ratios of weight-matrix products. Copying heads show up as OV circuits with mostly positive eigenvalues. Induction heads are found as K-composition with a previous-token head. All of this needs only the weights — [Elhage et al. 2021](https://transformer-circuits.pub/2021/framework/index.html)
- The Sparks induction-head finding is a re-derivation of this method from middle layers only — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/)
- **Attribution graphs / circuit tracing (Anthropic, Mar 2025).** These need a trained cross-layer transcoder (CLT) replacement model and per-prompt activations. The replacement model may use different mechanisms than the real model, so the authors validate graphs with perturbation experiments, which are "mostly consistent" with some deviations. Attention patterns are frozen per prompt, so QK reasoning (why the model attended) is not explained, and reconstruction error leaves part of the computation unexplained — [Anthropic methods paper](https://transformer-circuits.pub/2025/attribution-graphs/methods.html?slug=calc-36-plus-59); [summary](https://ibl.ai/blog/anthropic-circuit-tracing-revealing-computational-graphs-in-language-models)
- Anthropic notes that **global weights (prompt-independent feature-to-feature connections) are often less interpretable than per-prompt attribution graphs because of weight interference** — [Transformer Circuits](https://transformer-circuits.pub/2025/attribution-graphs/methods.html?slug=calc-36-plus-59)
- "Circuit Insights: Towards Interpretability Beyond Activations" (arXiv 2510.14936, 2025) works on weight-based analysis of transcoder circuits. It reports that some weight connections look meaningful but interference is a major challenge, and names context-dependent components as a main source of it — [arXiv 2510.14936](https://arxiv.org/pdf/2510.14936)
- An independent, non-peer-reviewed SPAR 2025 write-up argues that cross-layer transcoders are incentivized to learn unfaithful circuits, and that per-layer and cross-layer transcoders can tell different stories about the same behavior — [GreaterWrong](https://www.greaterwrong.com/posts/6CS2NDmoLCFcEJMor/cross-layer-transcoders-are-incentivized-to-learn-unfaithful)
- Open-source tooling exists: the `circuit-tracer` package reproduces the method with transcoders on Gemma-2-2B and Llama-3.2-1B — [PyPI circuit-tracer](https://pypi.org/project/circuit-tracer/)
- **Parameter decomposition.** APD (Braun et al., Jan 2025) [background] splits weights into parameter components that sum to the original weights — [APD arXiv 2501.14926](https://arxiv.org/abs/2501.14926). SPD (Bushnaq, Braun, Sharkey, Goodfire, Jun 2025) splits each matrix into rank-one subcomponents. Faithfulness is enforced as a soft Frobenius loss so that the components sum back to the weights. SPD fixes APD's cost and hyperparameter sensitivity, avoids parameter shrinkage, and recovers ground-truth mechanisms better on toy models. A library is released — [SPD arXiv 2506.20790](https://arxiv.org/html/2506.20790v2); [AF post](https://alignmentforum.org/posts/yjrpmCmqurDmbMztW/paper-stochastic-parameter-decomposition); [Substack review](https://axelkldiv.substack.com/p/mechanistic-interpretability-review). It is still trained by gradient descent against the model's outputs on data, so it is not weight-only. I found no independent LLM-scale replication.
- **Weight SVD of fine-tune deltas works at the 7–8B scale.** WeightWatch (Watch the Weights, 2025) takes the top 20 left singular vectors of ΔW for each attention-output and MLP-down matrix (40 directions per layer) and monitors activation cosines along them. Details are in §4 — [arXiv 2508.00161](https://arxiv.org/html/2508.00161v2)

### What each method needs, and whether an LLM agent could automate it

| Method | Inputs needed | Automatable by an LLM agent? |
|---|---|---|
| QK/OV / composition / eigenvalue analysis | Weights only (plus embeddings for full circuits) | **Yes, likely**: deterministic linear algebra plus pattern-reading. Sparks Exp 3 is a demonstration. |
| Weight SVD of ΔW | Base and fine-tuned weights | **Yes** for computing it; the LLM's added value is labeling directions, which needs activations or token projections. |
| SAE/transcoder "weight-based" feature circuits | A trained dictionary plus weights | Partly. The agent can read virtual weights, but interference makes it noisy (Anthropic, arXiv 2510.14936). |
| Attribution graphs | CLT plus per-prompt activations plus perturbation checks | The agent can drive the pipeline and read graphs, but cannot do without activations. |
| APD/SPD | Optimization against outputs on data | The agent can run and interpret it, but the method itself needs forward and backward passes. |

### Inferences
- Astra's induction-head success has a strong prior: a well-known closed-form recipe exists, the models are attention-only-like and tiny, and the target property is a canonical weight-visible circuit. That is not evidence that LLMs can read novel or distributed circuits.
- The Sparks Exp 3 targets (about 7.16M weights) cannot fit as raw text in any current context. Exp 6 calls 1.48M weights "too large for context". So Exp 3 almost certainly used sandboxed matrix operations. "Reading" in practice means "an agent writing linear-algebra code over weights", which is the same affordance a human interpretability researcher has.
- Most likely value: running the Elhage-style and ΔW-SVD playbooks automatically across many heads and layers, and writing hypotheses that activation-based tools then test.
- Unlikely value: replacing attribution graphs or SPD on billion-parameter models, because the interference and superposition problem is in the weights themselves, not in the analyst.

### Gaps
- I found no published head-to-head of an LLM agent against a human or a scripted Elhage pipeline on circuit discovery from weights.
- I found no LLM-scale SPD/APD faithfulness results, so I could not verify how they compare to transcoders.
- How Astra's Exp 3 harness exposed 7M weights (raw text, chunked, or sandbox) is not stated in the summary I fetched. Check the RikiyaT/lm_understand-logs repo.

---

## 2. Automated interpretability agents: inputs and results compared

### Takeaway
Every automated interpretability or auditing agent with published numbers uses activations, behavior, or both. None works from weights alone. On the strongest current benchmark (AuditBench, 2026), scaffolded behavioral tools beat white-box tools, and white-box tools help mainly on easier targets. Weight-only reading would be a new input modality starting below this baseline: the Sparks sycophancy result itself shows weights failing where activations succeeded.

### Cited Findings
- **OpenAI neuron explanations (Bills et al., 2023)** [background]. GPT-4 explains GPT-2 XL neurons from top-activating text and scores each explanation by simulating activations. Input: activations. Most explanations scored poorly; a small fraction of neurons (on the order of 1,000+) scored at least 0.8 — [OpenAI 2023](https://openai.com/index/language-models-can-explain-neurons-in-language-models/)
- **MAIA (Shaham et al., ICML 2024)** [background]. A multimodal agent that runs experiments on vision-model components (synthesizing and editing images, measuring activations) to describe neurons, remove spurious features and find failure modes. Input: activations plus interventions — [arXiv 2404.14394](https://arxiv.org/abs/2404.14394)
- **Auditing language models for hidden objectives (Anthropic, Mar 2025).** A model was trained to hold a hidden objective (reward-model sycophancy). **3 of 4 blind human teams** found it, using SAEs, behavioral attacks (prefill was notable) and training-data search. A follow-up unblinded study compared 8 techniques. Anthropic cautions against reading much into team comparisons with n=4 — [arXiv 2503.10965](https://arxiv.org/html/2503.10965); [Anthropic](https://www.anthropic.com/research/auditing-hidden-objectives)
- **Alignment auditing agents (Anthropic, Jul 2025).** The investigator agent solves the same game **10–13%** of the time with realistic affordances, and **42%** with a "super-agent" that aggregates many parallel runs. The main failure mode is fixating on early hypotheses — [Anthropic alignment blog](https://alignment.anthropic.com/2025/automated-auditing); [LessWrong](https://www.lesswrong.com/posts/DJAZHYjWxMrcd2na3/building-and-evaluating-alignment-auditing-agents)
- **AuditBench (Anthropic, 2026).** 56 Llama-3.3-70B target models (plus a Qwen3-32B replication) with 14 implanted behaviors (sycophantic deference, anti-AI-regulation views, secret loyalties and others), each trained not to confess. 13 tool configurations, 16 runs per model.
  - The default chat-only agent succeeds about **37%** of the time. Scaffolded user-sampling and scaffolded text-completion exceed **50%**.
  - White-box tools tested: steering vectors, SAE features, logit lens and activation oracles. Activation oracles were the best white-box tool, beating the default on 8/14 behaviors in one setting; Anti-AI-Regulation rose from 0% to 88%.
  - SAEs and logit lens gave "more limited" signal. The authors conclude that white-box tools "can help, but primarily on easier targets".
  - There is a **tool-to-agent gap**: agents make only 5–10 tool calls and are thrown off by noisy SAE lists.
  - Weight access is not listed as a tool.
  - [AuditBench](https://alignment.anthropic.com/2026/auditbench)
- **Weight Oracles (Kabra, Venhoff, Schroeder de Witt, Oxford, Oct 2026)** is the closest existing work to LLM weight-reading for auditing. Qwen2.5-3B is *fine-tuned* to answer questions about the static weights of about 2,000-parameter one-layer transformers. Details are in §4 — [arXiv 2610.07334](https://alphaxiv.org/abs/2610.07334v1)
- Transluce and Goodfire also build interpretability agents. I did not fetch primary sources this session, so I cite no numbers for them (see Gaps).

### Input comparison

| System | Input | Target scale | Headline result |
|---|---|---|---|
| Bills et al. 2023 | Activations | GPT-2 XL neurons | Most explanations poor; a minority score ≥0.8 |
| MAIA 2024 | Activations plus interventions | Vision models | Descriptions comparable to human experts [background] |
| Anthropic blind game 2025 | Behavior, SAEs, training data | Claude-scale model | 3/4 human teams |
| Anthropic investigator agent 2025 | Behavior plus SAEs plus data search | Same | 10–13% single agent, 42% aggregated |
| AuditBench 2026 | Behavior plus white-box activation tools | Llama 70B | 37% default, >50% scaffolded black-box |
| Weight Oracles 2026 | Raw weights (fine-tuned 3B LLM) | ~2K-param transformers | AUROC 0.81–0.93 on toy backdoors |
| Sparks 2026 | Raw weights (frontier LLM), plus attention when allowed | 17K–7M param nets; Gemma 270M | Correct on toy identification; **0/4 on sycophancy from weights**, 3/3 with attention |

### Inferences
- The sycophancy failure fits the AuditBench pattern: behavioral fine-tunes (sycophancy, deference) leave diffuse, distributed weight changes. Context-conditioned signals (attention patterns, activations, sampled behavior) carry the readable evidence.
- Weight-reading is likely to add value as **one tool among several** in an investigator agent: cheap triage ("which layers and heads changed most, and in which directions?") before activation and behavioral probing. That is what WeightWatch already does without an LLM.
- Agents already underuse the tools they have (5–10 calls, per AuditBench). Adding a weight-reading tool brings the same tool-to-agent gap risk.

### Gaps
- No primary-source numbers here for Transluce (e.g., predictive concept decoders, investigator agents) or Goodfire agents.
- No benchmark yet compares weight-only, activation and behavioral access on the same auditing targets. The Sparks authors say they are building one.

---

## 3. Weight-space learning (meta-networks) vs a general LLM

### Takeaway
Trained, symmetry-aware meta-networks (DWSNets, NFNs, Graph Metanetworks, Transformer-NFN) reach Kendall τ ≈ 0.93 on predicting CNN accuracy from weights and handle permutation and scale symmetries by construction. They need a zoo of thousands of labeled models of the same architecture family and do not transfer across tasks or architectures. A general LLM wins on zero-shot, open-ended, cross-architecture questions that come with explanations. It is likely to lose on narrow regression tasks where a trained meta-network or even simple weight statistics already work.

### Cited Findings
- Survey: "A Survey of Weight Space Learning: Understanding, Representation, and Generation" (arXiv 2603.10090, Mar 2026). It covers three areas (weight-space geometry and symmetry, learning representations over weights, and weight generation) and applications such as model retrieval, continual and federated learning, NAS, and data-free reconstruction. Companion list: Zehong-Wang/Awesome-Weight-Space-Learning — [arXiv 2603.10090](https://arxiv.org/html/2603.10090)
- An ICML 2026 invited talk frames the shift from small model zoos to learning from public model-hub populations — [ICML 2026](https://icml.cc/virtual/2026/83856). Model Zoos dataset (NeurIPS 2025) — [aitopics](https://aitopics.org/doc/conferences:9258FDFC)
- **Permutation-Equivariant Neural Functionals (NFN)** predict test accuracy from raw weights on Small CNN Zoo CIFAR-10-GS and SVHN-GS, using Kendall τ — [arXiv 2302.14040](https://arxiv.org/pdf/2302.14040). DWSNets (Navon et al., ICML 2023) [background] — [arXiv 2301.12780](https://arxiv.org/abs/2301.12780)
- **Graph Metanetworks / neural graphs** (NG-T) treat a network as a graph. They beat baselines narrowly on CIFAR10-GS and widely on the heterogeneous "Wild Park" zoo, partly because they can use architecture information that parameters alone lack — [arXiv 2403.12143](https://arxiv.org/pdf/2403.12143); GMN (Lim et al.) — [arXiv 2312.04501](https://arxiv.org/pdf/2312.04501.pdf); Scale-equivariant GMN — [arXiv 2406.10685](https://arxiv.org/pdf/2406.10685)
- Current Small CNN Zoo numbers:
  - Quasi-equivariant Monomial-NFN reaches τ = 0.926 ± 0.002 (ReLU subset), matching HNP — [review of arXiv 2604.23720](https://liner.com/review/quasiequivariant-metanetworks)
  - A leaderboard lists 0.934 as the CIFAR-10-GS best — [wizwand](https://www.wizwand.com/dataset/small-cnn-zoo)
  - MAGEP-NFN's margin over baselines is only about 0.007 τ — [arXiv 2410.04213](https://arxiv.org/pdf/2410.04213)
  - The benchmark is close to saturated.
- Transformer-NFN extends equivariant functionals to transformer checkpoints (MNIST, AGNews) — [arXiv 2410.04209](https://arxiv.org/pdf/2410.04209)
- Predicting training properties from weights:
  - DSiRe (ICLR 2025) predicts the number of fine-tuning samples from spectral features of LoRA/fine-tune weights with a nearest-neighbor classifier — [ICLR 2025](https://iclr.cc/virtual/2025/33074)
  - WARP (arXiv 2607.01686) recovers the training-data domain mixture from weight geometry, with 0.046 MAE on BERT and 0.104 on GPT-2-Small (best supervised variant). Numbers are from a search snippet and not verified — [arXiv 2607.01686](https://arxiv.org/pdf/2607.01686)
- Older background: Unterthiner et al. 2020 introduced the Small CNN Zoo and showed that simple weight statistics predict accuracy well [background] — [arXiv 2002.11448](https://arxiv.org/abs/2002.11448). MLDS (2021) showed weight-space classifiers separate backdoored from clean nets for most, but not all, model types — [arXiv 2104.10555](https://arxiv.org/pdf/2104.10555)

### Where the LLM wins and loses

| Dimension | Trained meta-network | General LLM weight-reader |
|---|---|---|
| Data needed | Thousands of labeled models from one family | Zero-shot (Sparks); or a fine-tune on a generated zoo (Weight Oracles, about 4,400 targets) |
| Symmetry handling | Built in (equivariance) | Must reason it out or canonicalize; not guaranteed |
| Output | One fixed scalar or label | Open-ended answers, explanations, hypotheses |
| Cross-architecture | Poor (GMN/neural graphs help somewhat) | Good in principle |
| Narrow regression (accuracy, hyperparameters) | τ ≈ 0.93, cheap | No evidence it matches; expensive per model |
| Scale | Small CNNs to small transformers | Limited by context and tools; the same ceiling |

### Inferences
- **Likely LLM win:** "What was this model trained to do?" across heterogeneous small models, where no meta-network training set exists. Sparks Exps 1–3 are examples.
- **Likely LLM loss:** benchmarked scalar prediction on a fixed zoo. Equivariant meta-networks are near ceiling, and an LLM pays thousands of tokens per model with no symmetry guarantee.
- **Hybrid is the most plausible direction:** the LLM writes or chooses feature extractors (spectra, composition scores, ΔW SVD), and simple learned heads do the calibrated prediction. Weight Oracles already uses a hybrid of learned row projections and an LLM.
- Weight Oracles' own open question, whether the LLM adds anything over a small detector trained on the same data, is the right question for this whole subfield.

### Gaps
- I found no paper running a frontier LLM zero-shot on Small CNN Zoo or another standard weight-space benchmark, so there is no direct LLM vs NFN/GMN number.
- Exact NG-T τ values were not retrieved (Table 1 of arXiv 2403.12143).

---

## 4. Backdoor and trojan detection from weights; diffing fine-tunes

### Takeaway
Weight-based backdoor detection works well in narrow settings: same-architecture zoos, LoRA fine-tunes with a known base model, toy transformers. It degrades under distribution shift, adaptive attackers and full fine-tuning. The best LLM-scale weight methods (WeightWatch's ΔW SVD) still need activations on calibration data to flag inputs. LLM weight-reading for backdoors has only toy-scale evidence (Weight Oracles, AUROC 0.81–0.93 on about 2K-parameter models). "Auditing without evaluation" at production scale is unsupported today.

### Cited Findings
- **TrojAI Final Report (IARPA and collaborators, arXiv 2602.07152, Feb 2026).** It has a chapter on detection through weight analysis (weight statistics, end-to-end learning of invariant features, linear weight analysis, weight-based anomaly detection) alongside trigger inversion and mitigation. It reports many **"natural" trojans** in large-scale evaluations and documents the limits of existing defenses — [arXiv 2602.07152](https://arxiv.org/abs/2602.07152). The PDF exceeded the fetch limit, so **per-round AUROC/CE numbers were not retrieved** (see Gaps).
- **WeightWatch / Watch the Weights (2025):**
  - Setup: ΔW SVD directions on OLMo-7B, Qwen2.5-7B and Llama-3.1-8B.
  - Backdoors: across 9 setups (LoRA, full fine-tuning, poisoned PPO) it flags **56%–100%** of triggered completions on first sight at **≤ ~1.04% FPR**. It is near-perfect on 5 PPO trojan models, where the BEAT baseline fails at low FPR.
  - Unlearning detection: 36.21% (Zephyr-RMU) to 95.42% (Circuit Breaker).
  - Limitations: needs the base weights; misses triggers that never appear in calibration data; full fine-tuning backdoors are caught less reliably than LoRA ones; not adversarially robust, since hidden-dimension shuffling evades it.
  - [arXiv 2508.00161](https://arxiv.org/html/2508.00161v2)
- **Weight Oracles (Oct 2026):**
  - Setup: a fine-tuned Qwen2.5-3B reads about 2K-parameter one-layer transformers. Phase I simulates forward passes with 99% holdout accuracy. Phase II trains only on a benign "dominant-token" pathology and tests zero-shot on backdoors with a 13-question composite score.
  - Results: AUROC 0.93 ± 0.04 on a single attack (94% TPR at 20% FPR); 0.81 under a four-attack mix (0.74–0.89 per type).
  - Baselines: total L2 norm 0.445; best V/O composite 0.752.
  - Limitations: single-token triggers; "Scaling to realistic model sizes remains the principal open challenge"; full-weight injection is prohibitive beyond a few million parameters; the oracle may be reading statistical correlates rather than the mechanism.
  - [arXiv 2610.07334](https://alphaxiv.org/abs/2610.07334v1)
- **Crosscoder model diffing.** Minder, Dumas, Juang, Chughtai and Nanda (NeurIPS 2025) show that L1 crosscoders misattribute shared concepts as "chat-only". Latent Scaling diagnoses this, and BatchTopK crosscoders on Gemma-2-2B base vs chat find interpretable, causally effective chat-specific latents (false information, personal questions, refusal variants). Crosscoders train on activations from both models — [arXiv 2504.02922](https://arxiv.org/abs/2504.02922v2); [NeurIPS 2025](https://proceedings.neurips.cc/paper_files/paper/2025/hash/9902a53031ebbbab73898028073d4790-Abstract-Conference.html). Original crosscoder proposal (Anthropic 2024) [background] — [transformer-circuits](https://transformer-circuits.pub/2024/crosscoders/index.html)
- Older weight-only detectors: matrix factorization of CV network weights (2022) — [arXiv 2212.08121](https://arxiv.org/pdf/2212.08121); MLDS weight classifiers (2021) — [arXiv 2104.10555](https://arxiv.org/pdf/2104.10555)
- Sparks Exp 7 is effectively a fine-tune-diffing task with base-matched pairs and frozen I/O layers. Weight-only failed (0/4) and the attention-pattern probe succeeded (3/3) — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/)

### Inferences
- In the diffing setting, ΔW is the natural object, and a non-LLM method (WeightWatch) already turns it into 56–100% backdoor detection at about 1% FPR on 7–8B models. An LLM weight-reader has to beat that, and Sparks Exp 7 suggests it currently cannot even match it from weights alone.
- Where an LLM could add value: (a) explaining what a flagged ΔW direction does, by projecting it onto vocabulary and SAE features and writing probe texts as in Exp 7; (b) single-model audits with no base model, where WeightWatch does not apply but where evidence is weakest.
- Trojans built to be weight-stealthy (permuted hidden dimensions, adversarial weight perturbations, distributed triggers) target exactly what a weight reader sees. Behavioral and activation methods remain necessary.

### Gaps
- TrojAI per-round detection metrics, especially for the weight-analysis track and the LLM rounds, were not retrieved because the PDF was too large. Pull them from Section 4 and §3.E.2 of arXiv 2602.07152.
- No published zero-shot frontier-LLM backdoor-from-weights result exists beyond toy scale.

---

## 5. Fundamental obstacles

### Takeaway
Five obstacles: symmetry, superposition, scale, behavior that lives in context-dependent computation, and verification. Each has evidence. Together they put weight-only LLM reading in the "small models, canonical circuits, or ΔW triage" zone. Credible auditing needs probe-based or behavioral confirmation, and the Sparks authors' own sycophancy result says the same.

### Cited Findings
- **Permutation and scale symmetry.** Equivariant meta-networks exist because hidden-unit permutations and scale symmetries leave function unchanged but alter raw weights — [NFN arXiv 2302.14040](https://arxiv.org/pdf/2302.14040); [Scale-equivariant GMN arXiv 2406.10685](https://arxiv.org/pdf/2406.10685). Adversaries can exploit this: shuffling hidden dimensions is named as an evasion of the weight-based WeightWatch detector — [arXiv 2508.00161](https://arxiv.org/html/2508.00161v2)
- **Superposition and interference.** Global weight-level feature connections are less interpretable than per-prompt graphs because of interference — [Anthropic](https://transformer-circuits.pub/2025/attribution-graphs/methods.html?slug=calc-36-plus-59); [arXiv 2510.14936](https://arxiv.org/pdf/2510.14936)
- **Scale.**
  - Sparks: 1.48M weights are "too large for context", and scaling depends on tools and forward passes — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/)
  - Weight Oracles: full-weight injection is prohibitive beyond a few million parameters — [arXiv 2610.07334](https://alphaxiv.org/abs/2610.07334v1)
  - Production audit targets are 70B or more (AuditBench) — [AuditBench](https://alignment.anthropic.com/2026/auditbench)
- **Behavioral properties are context-dependent.** Sycophancy was invisible from weights but obvious in attention on probe texts — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/). Fine-tune method also matters for auditability: SDF-trained models are easier to audit than TD-trained ones, and KTO-trained models harder than SFT-trained ones — [AuditBench](https://alignment.anthropic.com/2026/auditbench)
- **Verification.**
  - Attribution-graph claims need perturbation experiments to check faithfulness — [Anthropic](https://transformer-circuits.pub/2025/attribution-graphs/methods.html?slug=calc-36-plus-59)
  - Bills et al. score explanations by simulation [background] — [OpenAI](https://openai.com/index/language-models-can-explain-neurons-in-language-models/)
  - Weight Oracles admits it may be reading correlates rather than mechanisms, and that AUROC does not establish a deployable threshold — [arXiv 2610.07334](https://alphaxiv.org/abs/2610.07334v1)
  - Sparks Exp 2 shows a plausible but wrong reading: outlines for filled shapes — [Sparks](https://rikiyat.github.io/blog/weight-space-programming/)

### Inferences
- Verifying a weight-reader's claim almost always needs a forward pass: run the model, ablate the named head, patch the named direction. So "auditing without evaluation" can at best mean auditing *without a behavioral eval suite*, not without any execution. Exp 7's success itself used forward-pass attention.
- Sparks' known-answer setups (ground truth exists, small closed answer spaces such as 4 games, 3 shapes or 3 languages) inflate apparent accuracy. Open-ended "find whatever is wrong" auditing has a much larger hypothesis space and the fixation failure seen in Anthropic's agents.

### Verdicts by application

| Application | Verdict | Why |
|---|---|---|
| Identifying the task or domain of small, unknown nets (RL policies, toy generative models, char LMs) | **Likely** | Shown 4/4, 3/3, 3/3 in Sparks; no meta-network training set needed; small closed answer spaces |
| Automating Elhage-style weight-circuit analysis (induction, copying, composition) in small or attention-heavy transformers | **Likely** | Closed-form recipe exists; Sparks rediscovered it; the agent writes the linear-algebra code |
| Labeling ΔW SVD directions of fine-tunes, as a triage layer inside investigator agents | **Likely (as augmentation)** | WeightWatch shows ΔW directions carry backdoor and unlearning signal at 7–8B; an LLM adds naming and probe design; activations still needed to confirm |
| Open-ended explanation and cross-architecture questions in weight-space learning | **Plausible** | Meta-networks cannot do this; no benchmark numbers yet |
| Beating equivariant meta-networks on standard zoo regression (accuracy, hyperparameters, dataset size) | **Unlikely** | τ ≈ 0.93 near ceiling; meta-networks are cheap, symmetry-exact, and calibrated |
| Replacing attribution graphs or SPD for frontier-model circuits | **Unlikely** | Interference and superposition in the weights; scale; these methods are activation- or optimization-dependent by design |
| Detecting behavioral fine-tunes (sycophancy, hidden objectives) from weights alone | **Unlikely (now)** | Sparks 0/4; AuditBench shows even activation tools trail scaffolded behavioral tools |
| Backdoor detection from weights alone at production scale ("auditing without evaluation") | **Unlikely (now), worth researching** | Only toy evidence (Weight Oracles, about 2K params); adaptive attackers can exploit symmetry; claims cannot be verified without execution |

### Gaps
- No study measures how often frontier-LLM weight readings are confidently wrong (a calibration study). Sparks reports few seeds.
- No adversarial evaluation of LLM weight-readers against weight-obfuscated trojans was found.
