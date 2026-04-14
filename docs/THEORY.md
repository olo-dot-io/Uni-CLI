# The Deterministic Compilation Thesis

> **AI agents are probabilistic. Software is deterministic. The gap between "probably right" and "right" is where systems break. Uni-CLI is the deterministic compilation layer that bridges this gap.**

This document grounds every design decision in Uni-CLI in computer science theory. Each section links a foundational result to a concrete engineering choice. Citations use `\cite{key}` markers resolved against `docs/refs.bib`; the `refs:verify` CI job checks every arXiv ID against `arxiv.org` on each push.

## Table of Contents

1. [Core Thesis](#core-thesis)
2. [Part I: Decidable Subsets and the Softened Restriction](#part-i-decidable-subsets-and-the-softened-restriction)
3. [Part II: Bimodal Agent Capability](#part-ii-bimodal-agent-capability)
4. [Part III: The Agent Tool Trilemma](#part-iii-the-agent-tool-trilemma)
5. [Part IV: Self-Repair as Search-Space Contraction](#part-iv-self-repair-as-search-space-contraction)
6. [Part V: Information-Theoretic Optimality](#part-v-information-theoretic-optimality)
7. [Part VI: Empirical Evidence](#part-vi-empirical-evidence)
8. [Part VII: Formal Verification](#part-vii-formal-verification)
9. [Part VIII: Open Problems](#part-viii-open-problems)
10. [References](#references)

---

## Core Thesis

An AI agent produces probabilistic predictions of intent. Software systems require deterministic execution. This mismatch creates a reliability gap that grows with system complexity and with every stochastic step interposed between the agent and the outcome.

**Definition (Deterministic Compilation Layer).** A function $D: I \times C \to A$ that maps an agent's intent $I$ and execution context $C$ to a deterministic action $A$. The compilation is _correct_ when $A$ achieves $I$ with probability $1$, given that $C$ is accurate.

In Uni-CLI, this compilation takes the form of YAML adapter pipelines: a roughly 20-line declarative specification that compiles a natural-language intent ("get trending topics from Twitter") into a deterministic sequence of HTTP requests, DOM interactions, and data transformations. The TypeScript escape hatch (about 10% of adapters) exists for cases where pipeline primitives are insufficient; the remaining 90% are pure YAML over a fixed-step grammar.

**Definition (Self-Repairing Adapter).** A triple $(S, R, V)$ where $S$ is the adapter specification, $R: S \times E \to S'$ is a repair function that takes a specification and structured error feedback $E$ to produce a corrected specification, and $V: S \to \{\mathrm{pass}, \mathrm{fail}\}$ is a verification function. The system is _self-repairing_ when the sequence $S_0, S_1 = R(S_0, E_0), S_2 = R(S_1, E_1), \ldots$ converges to a fixed point $S^*$ where $V(S^*) = \mathrm{pass}$.

This document argues that such a compilation layer is both theoretically necessary and empirically achievable with today's models, provided we restrict the adapter language, structure the error feedback, and honestly account for the bimodal distribution of agent capability at release time.

---

## Part I: Decidable Subsets and the Softened Restriction

### 1.1 Rice's Theorem and the Restriction Principle

**Rice's Theorem (1953)** states that for any non-trivial semantic property of programs, no algorithm decides whether an arbitrary program has that property. Dantsin and Wolpert generalised this result to recurrent neural networks \cite{dantsin2024extensional}: every non-trivial extensional property of an RNN is undecidable. The theorem applies directly to LLM-driven tool invocation: determining whether an arbitrary natural-language intent maps to the correct sequence of tool calls is undecidable in general.

Earlier versions of this document claimed a stronger result — that adapter semantics are "decidable" because YAML pipelines are finite. That claim is tighter than the literature supports and has been softened here. The honest statement is:

> **Softened Restriction Principle.** Adapter semantics are _verifiable_ up to the semantics of each primitive step, not decidable in the Rice sense. YAML pipelines form a finite composition over a fixed set of typed primitives; correctness of the composition reduces to correctness of each primitive. Primitive correctness is enforced by human authorship, automated tests, and schema validation, not by decision procedure.

de Melo et al. proved the weaker but usable result: while verifying arbitrary AI alignment is undecidable, there exists an _enumerable_ set of provably aligned AI systems — those built from finite compositions of provably correct operations \cite{demelo2024undecidability}. Uni-CLI's pipeline is one such enumerable set. The `λ_A` typed agent calculus \cite{kumar2026lambdaa} formalises this observation, showing that 94.1% of 835 real-world agent configurations fail structural well-formedness checks — suggesting that typed, finite pipelines are an empirically scarce but theoretically tractable design point.

**Design rule — Decidable composition over undecidable primitives.** Every adapter is a finite pipeline of typed steps (`fetch`, `select`, `map`, `filter`, `navigate`, ...). The composition is checked by the schema validator. Each primitive has a finite behavioural contract enforced by tests. No Turing-complete constructs (arbitrary code execution, unbounded recursion) exist inside YAML; the TS escape hatch opts out of decidability by design, and is flagged as such in the registry.

### 1.2 Gödel's Incompleteness and the Incomplete Catalog

**Gödel's First Incompleteness Theorem (1931)** states that any consistent formal system strong enough to express arithmetic contains true statements unprovable within the system. Translated to tool catalogs: no catalog can be simultaneously complete (covering every intent) and consistent (every description exactly matches behaviour). There will always be intents outside the catalog and descriptions that drift from implementation.

**Design rule — Self-repair compensates for incompleteness.** Since no catalog can be complete, the system must extend itself. Self-repair is the mechanism by which agents patch gaps at runtime (see Part IV).

### 1.3 Brooks' No Silver Bullet

Brooks (1986) distinguished _accidental_ complexity (artifacts of our tools) from _essential_ complexity (inherent in the domain). LLMs are excellent at accidental complexity — parsing APIs, reading documentation, generating boilerplate. They are poor at essential complexity under load: authentication flows, rate limiting, data validation, idempotency. CLI adapters encode the essential complexity as deterministic pipelines that the LLM does not need to reason about at call time.

---

## Part II: Bimodal Agent Capability

The single biggest shift between 2024 and 2026 in the agent landscape is that _model identity is no longer a stable predictor of capability_. The same Opus 4.6 endpoint that scores 80.8% on SWE-Bench Verified on the benchmark harness scores dramatically lower in production when silent quantisation, batching pressure, or adaptive-thinking budget cuts are in effect. Any reliability analysis built on the assumption of monotonic capability progress is fragile. Uni-CLI instead assumes a **bimodal capability distribution**.

### 2.1 The Two Modes

**Mode A (pre-Mythos).** Frontier models (Opus 4.x, GPT-5.x, Gemini 3.x, GLM-5.1) under realistic production pressure. SWE-Bench Verified 70–85%, SWE-Bench Pro 17–58% \cite{scaleai2025swebenchpro}, Terminal-Bench 2.0 60–65% \cite{mythos2026systemcard}. Navigation errors dominate: 27–52% of long-horizon agent failures are navigation, not tool use \cite{ramachandran2026amazingagentrace}. Judgment under uncertainty is broken: no frontier model recovers more than a fraction of full-info performance on HiL-Bench \cite{yao2026hilbench}.

**Mode B (Mythos-equivalent).** Rate-limited, tightly-gated tier with substantially higher capability. Mythos Preview reports 93.9% SWE-Bench Verified, 82.0% Terminal-Bench 2.0, 80.0% GraphWalks BFS (2× Opus 4.6) \cite{mythos2026systemcard}. Pricing 5× Opus 4.6 and partner-only availability make this mode economically inaccessible for routine tool calls. GLM-5.1 from Zhipu is the first open-weight model approaching this mode at 58.4% SWE-Bench Pro \cite{glm2026report}.

### 2.2 Why Bimodal, Not Monotonic

The METR horizon-doubling curve \cite{metr2025horizon} is real and independently reproduced by BRIDGE \cite{bridge2026reproduction} with a ~6-month doubling time. The counter-hypothesis from Thompson et al. \cite{thompson2026risingtide} using 17,000+ O*NET worker evaluations shows broad-based rising task success (50% at 3-4h tasks in 2024 Q2 → 65% in 2025 Q3) rather than cliffs. Both curves are *aggregate\* — neither addresses within-release stability.

Empirical signal of within-release instability:

- 1,085-point HN thread "Claude Code is being dumbed down?" (2026-02) \cite{hn2026claudedumbed}
- The Register / AMD AI director quantitative analysis: stop-hook violations 0→10/day, file reads 6.6→2, across 6,852 sessions and 234,760 tool calls \cite{theregister2026amdclaude}
- Document-Q&A fabrication triples from 32K → 128K context, exceeds 10% at 200K across all models \cite{hallucination2026documentqa}
- Reasoning models hallucinate _more_ than their base counterparts: o3 PersonQA 33%, o4-mini 48% \cite{openai2025o3o4report}

**Design implication — the 30K context advisory.** Uni-CLI commands are designed to fit within a ≤30K-token advisory budget for the calling agent's effective context: per-call response p50 under 2K tokens (see `docs/BENCHMARK.md`), manifest lazy-loaded (not eagerly registered), tool descriptions truncated to one paragraph. This is not a hard limit on any particular frontier model; it is the honest accounting that says "if the agent is in Mode A and degraded, Uni-CLI keeps the budget tight enough to still function." The advisory tracks the context-rot curve \cite{hallucination2026documentqa} where fabrication triples above 128K.

### 2.3 Consequence for Self-Repair

A self-repair loop that assumes Mode B capability to patch a broken YAML adapter will fail on a Mode A agent that received the same structured error envelope. The repair function $R$ must be robust to both modes. Concretely:

- Error envelopes must name the file path, line/step number, and propose a diff candidate — not rely on the agent to infer any of these.
- Each repair cycle must be locally verifiable by running `unicli test <site>/<command>` (structural, not LLM) before proposing the next patch.
- If three repair cycles fail to pass `V`, the system escalates to quarantine and human review, rather than burning budget on an agent that cannot see the problem.

This design holds under Mode A and is slightly wasteful under Mode B — an acceptable trade.

---

## Part III: The Agent Tool Trilemma

> **Original contribution.** No prior work formalises this trade-off. The closest analogs are CAP (distributed systems) and the accuracy–diversity dilemma (recommender systems); neither addresses the specific constraints of agent tool interfaces.

### 3.1 The Three Properties

For any tool interface connecting an AI agent to external systems:

1. **Coverage ($C$):** fraction of user intents the interface can execute. $C=1$ handles any request.
2. **Accuracy ($A$):** probability that a selected tool call achieves the user's intent. $A=1$ never makes wrong calls.
3. **Performance ($P$):** inverse of resource consumption (tokens, latency, API calls) per interaction. $P=1$ uses theoretical minimum resources.

### 3.2 The Impossibility

**Claim (Agent Tool Trilemma).** Any tool interface optimises at most two of $\{C, A, P\}$ simultaneously.

**Argument sketch.**

- **High $C$ + High $A$ → Low $P$.** Exposing many tools requires either sending all tool descriptions to the agent (high token cost) or a retrieval step (embedding + scoring infrastructure). Semantic Tool Discovery achieves 99.6% token reduction but requires dedicated embedding infrastructure \cite{mudunuri2026semantictool}. Graph of Skills cuts tokens 37.8% but adds PageRank computation \cite{liu2026graphskills}.
- **High $C$ + High $P$ → Low $A$.** Compact representations (short descriptions, few tokens) sacrifice detail needed for correct selection. CCTU found no LLM exceeds 20% strict compliance under complex constraints \cite{ye2026cctu}, and this worsens as the tool set grows. ToolFlood demonstrated 95% attack success at 1% adversarial tool injection \cite{jawad2026toolflood}.
- **High $A$ + High $P$ → Low $C$.** Curated, well-described tool sets with deterministic execution achieve both accuracy and performance — but only for a fixed domain. This is the CLI trade-off.

### 3.3 Where Uni-CLI Sits

Uni-CLI optimises **Accuracy × Performance**.

- **Accuracy.** Deterministic YAML pipelines eliminate stochastic tool selection errors within an adapter. Structured error feedback enables convergent self-repair. Pipelines are literal canonical paths in the sense of Lee et al. \cite{lee2026canonicalpath}, who causally demonstrated that each off-canonical call raises the next deviation probability by 22.7 percentage points.
- **Performance.** Per-call token cost is measured in `docs/BENCHMARK.md` with p50/p95 across categories, measured on a harness wired into `npm run bench`. Target: beat GitHub MCP 55K-token cold-start by 30× on p50 response for bread-and-butter commands. External benchmarks (Firecrawl, Scalekit, OnlyCLI, Apideck) report 4–35× savings \cite{firecrawl2026mcptoken, scalekit2026mcp}.
- **Coverage.** Extensible but not universal. Currently 195 sites, 956 commands. Self-repair and the `unicli init` + `unicli import opencli-yaml` tools extend coverage incrementally.

MCP optimises **Coverage × Accuracy** (19,800+ servers, rich schemas, high token cost). Raw function calling optimises **Coverage × Performance** (any function, compact descriptions, selection errors grow with scale).

### 3.4 Transport Composition Does Not Break the Trilemma

The v0.212 transport abstraction (7 transports: http, cdp-browser, subprocess, desktop-ax, desktop-uia, desktop-atspi, cua) might appear to increase coverage without cost. It does not: each transport adds a capability surface that the pipeline runner must enforce (see `src/core/schema-v2.ts` `capabilities`/`minimum_capability` fields), and every new step increases the adapter author's surface to make errors. The trilemma is preserved; the design choice is which two axes to optimise for each transport class. `http` maximises $A \times P$. `cua` maximises $C \times A$ at 10–50× the cost of `http`. Users (and schedulers) see the cost envelope per call.

---

## Part IV: Self-Repair as Search-Space Contraction

### 4.1 Banach's Fixed-Point Theorem

**Banach's Fixed-Point Theorem (1922).** If $(X, d)$ is a complete metric space and $T: X \to X$ is a contraction (i.e. $d(T(x), T(y)) \le q \cdot d(x, y)$ for some $q < 1$), then $T$ has a unique fixed point and the sequence $x_0, T(x_0), T^2(x_0), \ldots$ converges to it.

Rodemann et al. \cite{rodemann2024reciprocal} proved that active learning, bandits, and self-training converge at linear rates when the adaptation function satisfies the Banach contraction property. Kadurha et al. \cite{kadurha2025bellman} applied the same framework to RL Bellman operators.

### 4.2 Self-Repair as Contraction

In Uni-CLI's self-repair loop:

- $X$ is the set of adapter specifications under a fixed schema.
- $d(S_1, S_2)$ measures behavioural difference between specifications (weighted by test outcomes).
- $R(S, E) = S'$ takes a specification and structured error feedback, producing a corrected specification.
- Structured error feedback (adapter*path, step, action, suggestion, diff_candidate) provides \_directional* information. Each repair narrows the gap between current behaviour and correct behaviour, making $R$ a contraction in expectation.

**When does self-repair converge?** When the feedback is structured, specific, and directional. Uni-CLI's error envelope provides exactly this:

```json
{
  "ok": false,
  "error": {
    "adapter_path": "~/.unicli/adapters/twitter/timeline.yaml",
    "step": 2,
    "action": "fetch",
    "transport": "http",
    "message": "HTTP 403 Forbidden",
    "suggestion": "Cookie may be expired. Re-authenticate via `unicli auth setup twitter`.",
    "diff_candidate": null,
    "minimum_capability": null
  }
}
```

Without these fields the contraction property fails. A bare `"HTTP 403"` from curl forces the agent to search the entire specification space for candidate fixes; the envelope above restricts search to the cookie-re-auth neighbourhood.

### 4.3 Closest Academic Analogs

The Self-Healing Router \cite{bholani2026selfhealing} provides the closest formal analog: Dijkstra-based deterministic routing that matches ReAct's correctness with 93% fewer LLM calls. When a tool path fails, the failed edge is reweighted to infinity and the path is recomputed — a contraction in the routing graph. Fission-GRPO \cite{zhang2026fissiongrpo} trains tool-use agents for error recovery with explicit reward decomposition on recovery steps; InspectCoder \cite{wang2025inspectcoder} extends this to runtime debugging; Self-Healing ML \cite{rauba2024selfhealingml} formalises the outer loop at model level rather than adapter level.

### 4.4 Lehman's Laws and Continuous Adaptation

**Lehman's First Law (1974).** A system used in a real-world environment must be continually adapted or it becomes progressively less satisfactory.

Web APIs change constantly. Khan et al. validated six of eight Lehman laws for web frameworks \cite{khan2019lehman}. Serbout \cite{serbout2024apievolution} proposed usage-driven API evolution tracking that mirrors the pattern.

Static adapters decay. Self-repair is not optional — it is a mathematical necessity imposed by Lehman's laws on top of the API-drift problem. The self-repair architecture converts a maintenance burden (manually updating adapters when APIs change) into an automated feedback loop with bounded cost per cycle.

### 4.5 When the Contraction Fails

Three failure modes, each with a designed response:

1. **Non-directional feedback.** If the upstream API returns only an opaque error (e.g. Cloudflare challenge page), the envelope degrades gracefully — `suggestion` is empty or templated, and the agent is told so. The system does not claim convergence it cannot deliver.
2. **Repair oscillation.** Two consecutive repairs that undo each other indicate the model is in Mode A and thrashing. Cycle detection in `unicli repair` triggers quarantine after 3 unsuccessful repair passes.
3. **Spec drift.** The upstream changed semantics, not syntax. No structural patch converges; the adapter is quarantined with a human-review flag and remains runnable but marked `[quarantined]` in `unicli list`.

---

## Part V: Information-Theoretic Optimality

### 5.1 Shannon's Source Coding Theorem

**Shannon's Source Coding Theorem (1948).** The optimal compression of a message is bounded by its entropy. No lossless encoding compresses below the source entropy.

He et al. treated the compressor LM as a noisy channel and proved that mutual information predicts downstream agent performance \cite{he2025informationtheoretic}. Larger compressors convey 5.5× more bits per token. This directly supports the CLI claim: a CLI command encodes the same information as a multi-step API interaction, within a tight per-call envelope. See `docs/BENCHMARK.md` for measured numbers.

### 5.2 Honest Token Accounting

The 2026-04-15 round-2 self-audit \cite{internalaudit2026} retired an earlier fixed-size per-call claim. The honest decomposition is:

| Component                   | Typical tokens     | Notes                                     |
| --------------------------- | ------------------ | ----------------------------------------- |
| Invocation string           | 6–20               | `unicli reddit hot --limit 5` ≈ 10 tokens |
| Response body (p50)         | see `BENCHMARK.md` | Depends on command and `--limit`          |
| Error envelope              | 80–200             | When failing; otherwise zero              |
| Tool description (MCP mode) | 30–120             | Only if agent uses `unicli mcp serve`     |

The earlier fixed number in prior docs referred to the invocation string plus an idealised response of ~60 tokens. Real responses at `--limit 5` for list-style commands sit in the 1,100–2,100 token range, measured by the bench harness with GPT-4o (o200k_base) tokenisation. This is still well below MCP tool descriptions + call (320–2,800 tokens \cite{firecrawl2026mcptoken, scalekit2026mcp}), but the correct framing is "CLI is 4–35× cheaper than MCP on equivalent interactions" rather than the more aggressive prior claim.

### 5.3 The Compression Path

JTON \cite{nandakishore2026jton} demonstrates structured data encoding reduces JSON token counts by 15–60%. JSPLIT \cite{antonioni2025jsplit} provides a taxonomy of MCP prompt bloating and shows that filtering improves task success. ITR Dynamic System Instructions \cite{itr2025dynamic} achieves 95% context token reduction through per-step retrieval of minimal system prompts. These validate Uni-CLI's deferred tool-loading approach: 4 meta-tools by default, full catalog exposed on demand via `unicli list`.

### 5.4 The Compilation Analogy

TDAD \cite{rehan2026tdad} treats agent prompts as compiled artifacts from behavioural specifications, achieving 92% compilation success and 97% hidden test pass rate. OpenKedge \cite{heyu2026openkedge} compiles declarative intent proposals into execution contracts with bounded scope and time. The MARIA OS Agent Tool Compiler \cite{maria2026compiler} explicitly frames the pipeline as natural-language intent → intermediate representation → executable code. Compiler.next \cite{cogo2025compilernext} generalises this to a compilable agent programming model.

These independent formalisations confirm that the compilation metaphor is not merely illustrative — it describes a concrete, implementable transformation from probabilistic intent to deterministic action.

---

## Part VI: Empirical Evidence

### 6.1 Canonical Path Deviation

Lee et al. \cite{lee2026canonicalpath} causally demonstrated that agent failures are primarily reliability failures from stochastic drift off canonical tool paths. Each off-canonical call raises the next-deviation probability by 22.7pp. Mid-trajectory monitoring and restart lifts success by +8.8pp. Uni-CLI's YAML pipelines are literal canonical paths; there is no stochastic tool selection within an adapter, which eliminates the cascading deviation problem at the primitive level.

### 6.2 Constraint Compliance

CCTU \cite{ye2026cctu} evaluated LLMs on 200 tasks across 12 constraint categories. No model exceeds 20% strict compliance; models violate constraints in over 50% of cases. Self-refinement after feedback remains weak. Essential constraints (rate limiting, authentication, data formats) must be enforced by the execution layer — not left to the model. Uni-CLI's typed pipeline steps do this deterministically.

### 6.3 Tool Use Efficiency

ZebraArena \cite{zhao2026zebraarena} provides procedurally generated, knowledge-minimal benchmarks with deterministic solutions and known optimal query counts. GPT-5 achieves only 60% on hard tasks and uses 70–270% more tool calls than optimal. Even the best models are far from optimal in tool-use efficiency. Pre-compiled tool paths (CLI adapters) close this gap by definition: one CLI call equals one optimal path for the adapter's domain.

### 6.4 Guardrail Efficacy

TraceSafe \cite{chen2026tracesafe} found guardrail efficacy is driven by _structural data competence_ — the ability to parse and reason about JSON and structured formats ($\rho = 0.79$) — rather than safety alignment. Architecture matters more than scale. Uni-CLI's structured JSON output (both for results and errors) directly improves the safety and reliability of downstream agent behaviour.

### 6.5 Tool-Call Boundary Safety

ClawGuard \cite{clawguard2026} documents MCP/skill-file prompt-injection attacks affecting five SOTA models. Uni-CLI's `assert` step ships a built-in preset for tool-call boundary enforcement (user-confirmed rule set) as a first-class deterministic alternative to alignment-based defence.

### 6.6 Long-Horizon Aggregation

Agentic Aggregation \cite{agentic2026aggregation} shows aggregator agents on parallel rollouts beat single-context long-horizon execution by 5–10%. Uni-CLI's `parallel` pipeline step exposes rollout-merge strategies beyond `merge_first`/`merge_all` to take advantage of this finding at the adapter level rather than the agent level.

### 6.7 Hallucination Under Production Pressure

BridgeBench Hallucination \cite{bridgemind2026} reported Opus 4.6 fell from #2 to #10 (+98% hallucination rate) after silent degradation. The Claude regression saga \cite{cherny2026regression} remains unresolved as of 2026-04-15. Uni-CLI treats hallucination not as a model property but as an environment property: the deterministic execution layer ensures that even a hallucinating agent cannot fabricate an HTTP response — only a call that fails loudly.

---

## Part VII: Formal Verification

### 7.1 Process Calculus for Tool Protocols

Schlapbach \cite{schlapbach2026formal} provided the first process calculus formalisation of tool protocols (including MCP). Key finding: MCP and schema-guided dialogue are structurally bisimilar in the forward direction (client → server), but **MCP is lossy in the reverse mapping** (server → client). The paper proposes MCP+ with type-system extensions to address this. Uni-CLI's envelope (§4.2) is one concrete answer: a typed, directional feedback channel from adapter → agent that preserves the repair information MCP drops.

### 7.2 Verification Over Probabilistic Agents

VeriSafe \cite{lee2025verisafe} achieves 94–98% verification accuracy for GUI agent actions through autoformalisation of user intent into verifiable specifications. This confirms that a deterministic verification layer over probabilistic agents produces reliable systems.

Type-Checked Compliance \cite{rashie2026typechecked} treats every agent action as a mathematical conjecture; execution is permitted if and only if Lean 4 proves compliance. This is the theoretical extreme of the deterministic compilation thesis: compile agent actions to formal proofs before execution. Uni-CLI sits a pragmatic notch below — the proof obligation is a successful `unicli test` rather than a Lean 4 term — but the architecture is aligned with this trajectory.

### 7.3 Security Implications

ToolFlood \cite{jawad2026toolflood} demonstrated adversarial tools achieve 95% attack success at just 1% injection rate in embedding-based tool retrieval. GrantBox \cite{zhang2026grantbox} showed 84.8% attack success under prompt injection in tool privilege evaluation. These results highlight a security advantage of curated CLI adapters over open tool registries: a fixed, auditable set of adapters has a smaller attack surface than a dynamic, embedding-based tool discovery system. Schema-v2 introduces `trust` (`first-party` | `community` | `user`) and `confidentiality` (`public` | `auth` | `sensitive`) fields per adapter; quarantine applies to anything that fails a three-cycle self-repair or is flagged by audit.

---

## Part VIII: Open Problems

Honest accounting demands listing what this thesis does not resolve.

1. **Primitive verification.** The softened Restriction (§1.1) reduces correctness of a pipeline to correctness of each step. We enforce step correctness by tests and review — not by proof. Moving a subset of steps to formally verified implementations (e.g. the `fetch` step under a typed HTTP lens) is future work.
2. **Bimodal repair verification.** The self-repair loop (§4) converges when feedback is directional; in Mode A (§2) directionality drops. We do not yet have a closed-form relationship between envelope richness and expected repair cycles as a function of agent capability mode.
3. **Transport coherence.** The 7-transport architecture promises unified semantics across `cdp-browser`, `desktop-ax`, `desktop-uia`, `desktop-atspi`, and `cua`. `λ_A` \cite{kumar2026lambdaa} suggests 94.1% of real agent configs are structurally incomplete — coherence across transports is a heavy theoretical obligation still to be discharged.
4. **Benchmark contamination.** Hodoscope \cite{hodoscope2026} found a Commit0 benchmark exploit inflating 5+ models' scores. SWE-Bench Pro 58.4% for GLM-5.1 may not survive a Hodoscope-style audit. The empirical evidence in §6 should be read with this caveat.
5. **The "rising tide vs crashing wave" tension.** Thompson et al.'s rising tide \cite{thompson2026risingtide} and METR's horizon-doubling \cite{metr2025horizon} are both real, but they target different task distributions. The design choice in §2.3 — the ≤30K advisory — is a hedge, not a prediction. If Mode B becomes the norm by 2027, the advisory relaxes; if Mode A regressions intensify, the advisory tightens.

---

## References

All arXiv IDs in `docs/refs.bib` are verified against `arxiv.org` by the `refs:verify` CI job on every push.

### Impossibility and Foundations

- \cite{demelo2024undecidability} de Melo, G. et al. (2024). "On the Undecidability of AI Alignment." arXiv:2408.08995.
- \cite{dantsin2024extensional} Dantsin, E. & Wolpert, D. (2024). "Extensional Properties of RNNs are Undecidable." arXiv:2410.22730.

### Convergence Theory

- \cite{rodemann2024reciprocal} Rodemann, T. et al. (2024). "Reciprocal Learning." arXiv:2408.06257.
- \cite{kadurha2025bellman} Kadurha, D. et al. (2025). "Bellman Operator Convergence Enhancements." arXiv:2505.14564.

### Benchmarks and Empirical

- \cite{ye2026cctu} Ye, F. et al. (2026). "CCTU: Benchmark for Tool Use under Complex Constraints." arXiv:2603.15309.
- \cite{mudunuri2026semantictool} Mudunuri, V. et al. (2026). "Semantic Tool Discovery for MCP Tool Selection." arXiv:2603.20313.
- \cite{liu2026graphskills} Liu, Z. et al. (2026). "Graph of Skills: Dependency-Aware Structural Retrieval." arXiv:2604.05333.
- \cite{lee2026canonicalpath} Lee, S. (2026). "Capable but Unreliable: Canonical Path Deviation." arXiv:2602.19008.
- \cite{zhao2026zebraarena} Zhao, W. et al. (2026). "ZebraArena: Diagnostic Simulation for Reasoning-Action Coupling." arXiv:2603.18614.
- \cite{ramachandran2026amazingagentrace} Ramachandran, K. et al. (2026). "The Amazing Agent Race." arXiv:2604.10261.
- \cite{yao2026hilbench} Yao, S. et al. (2026). "HiL-Bench: Do Agents Know When to Ask for Help?" arXiv:2604.09408.
- \cite{hallucination2026documentqa} "How Much Do LLMs Hallucinate in Document Q&A?" (2026). arXiv:2603.08274.
- \cite{metr2025horizon} METR (2025). "Time-Horizon v1.1." METR Research.
- \cite{bridge2026reproduction} BRIDGE (2026). "Predicting Human Task Completion Time From Model Performance." arXiv:2602.07267.
- \cite{thompson2026risingtide} Thompson, N. et al. (2026). "Crashing Waves vs. Rising Tides." arXiv:2604.01363.

### Self-Repair and Robustness

- \cite{bholani2026selfhealing} Bholani, R. (2026). "Self-Healing Router: Graph-Based Fault-Tolerant Tool Routing." arXiv:2603.01548.
- \cite{zhang2026fissiongrpo} Zhang, Y. et al. (2026). "Fission-GRPO: Robust Tool Use via Error Recovery." arXiv:2601.15625.
- \cite{wang2025inspectcoder} Wang, H. et al. (2025). "InspectCoder." arXiv:2510.18327.
- \cite{rauba2024selfhealingml} Rauba, L. et al. (2024). "Self-Healing Machine Learning." arXiv:2411.00186.
- \cite{chen2026tracesafe} Chen, X. et al. (2026). "TraceSafe: Systematic Assessment of LLM Guardrails." arXiv:2604.07223.
- \cite{agentic2026aggregation} "Agentic Aggregation." (2026). arXiv:2604.11753.
- \cite{clawguard2026} "ClawGuard: Prompt-Injection Defence for MCP and Skill Files." (2026). arXiv:2604.11790.

### Formal Semantics and Verification

- \cite{schlapbach2026formal} Schlapbach, M. (2026). "Formal Semantics for Agentic Tool Protocols." arXiv:2603.24747.
- \cite{lee2025verisafe} Lee, K. et al. (2025). "VeriSafe Agent." arXiv:2503.18492.
- \cite{rashie2026typechecked} Rashie, A. & Rashi, B. (2026). "Type-Checked Compliance: Lean 4 for Agentic Systems." arXiv:2604.01483.
- \cite{kumar2026lambdaa} Kumar, P. et al. (2026). "λ_A: A Typed Agent Calculus." arXiv:2604.11767.

### Compilation Thesis

- \cite{rehan2026tdad} Rehan, A. (2026). "TDAD: Test-Driven AI Agent Definition." arXiv:2603.08806.
- \cite{heyu2026openkedge} He, Z. & Yu, L. (2026). "OpenKedge: Governing Agentic Mutation." arXiv:2604.08601.
- \cite{maria2026compiler} MARIA OS (2026). "Agent Tool Compiler." os.maria-code.ai.
- \cite{cogo2025compilernext} Cogo, V. et al. (2025). "Compiler.next." arXiv:2510.24799.

### Information Theory and Token Efficiency

- \cite{he2025informationtheoretic} He, Z. et al. (2025). "An Information Theoretic Perspective on Agentic System Design." arXiv:2512.21720.
- \cite{nandakishore2026jton} Nandakishore, V. (2026). "JTON: Token-Efficient JSON Superset." arXiv:2604.05865.
- \cite{antonioni2025jsplit} Antonioni, L. et al. (2025). "JSPLIT: Taxonomy for MCP Prompt Bloating." arXiv:2510.14537.
- \cite{itr2025dynamic} "Dynamic System Instructions and Tool Exposure (ITR)." (2025).
- \cite{firecrawl2026mcptoken} Firecrawl (2026). "MCP costs 4–32× more tokens than CLI."
- \cite{scalekit2026mcp} Scalekit (2026). "CLI vs MCP: 10–32× Token Cost."

### Security

- \cite{jawad2026toolflood} Jawad, M. & Brunel, A. (2026). "ToolFlood: Retrieval-Layer Attack on Tool Selection." arXiv:2603.13950.
- \cite{zhang2026grantbox} Zhang, Y. et al. (2026). "GrantBox: Evaluating Privilege Usage." arXiv:2603.28166.

### Evolution and Lehman's Laws

- \cite{khan2019lehman} Khan, M. et al. (2019). "Evolution of WordPress and Django Using Lehman's Laws." Semantic Scholar.
- \cite{serbout2024apievolution} Serbout, S. (2024). "A Data-Driven Approach to Prescribe Web API Evolution." UPC Thesis.

### Model Landscape (2026)

- \cite{mythos2026systemcard} Anthropic (2026). "Claude Mythos Preview System Card." red.anthropic.com.
- \cite{glm2026report} Zhipu (2026). "GLM-5.1 Technical Report."
- \cite{scaleai2025swebenchpro} Scale AI (2025). "SWE-Bench Pro."
- \cite{openai2025o3o4report} OpenAI (2025). "o3 and o4-mini Technical Report."
- \cite{hn2026claudedumbed} HN Submission #38752341 (2026-02-11). "Claude Code is being dumbed down?"
- \cite{theregister2026amdclaude} The Register (2026-04-06). "AMD AI Director Analyses Claude Code Regression."
- \cite{bridgemind2026} BridgeMind AI (2026-04-13). "BridgeBench Hallucination Leaderboard."
- \cite{cherny2026regression} Cherny, B. (2026). "Claude Code Regression Postmortem Discussion." GitHub Issue.
- \cite{hodoscope2026} Hodoscope (2026). "Commit0 Benchmark Exploit." arXiv:2604.11072.

### Internal

- \cite{internalaudit2026} Uni-CLI Round-2 Audit (2026-04-15). "`docs/BENCHMARK.md` honesty pass." `.claude/plans/sessions/2026-04-14-v212-rethink/round2/04-self-audit.md`.

---

_40 references. Last updated: 2026-04-15. Bibtex entries in `docs/refs.bib`. Run `npm run refs:verify` to re-check arXiv IDs._
