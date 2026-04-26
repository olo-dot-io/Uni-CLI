# Deterministic Compilation Thesis

> Agents are probabilistic. Software execution should be deterministic. Uni-CLI
> is the layer that compiles an agent's intent into a small, typed, repairable
> command.

This page is a public explanation of Uni-CLI's design. It avoids product-by-
product comparisons; external projects are studied internally, while public
claims here are tied to Uni-CLI's own code, catalog, and benchmark harness.

## Core Thesis

An agent starts with intent. A software surface requires exact actions. The
system boundary is the compiler:

$$
D: I \times C \to A
$$

Where:

- $I$ is the user's intent.
- $C$ is the current execution context.
- $A$ is the concrete action sequence.
- $D$ is correct when $A$ achieves $I$ under the observed context.

In Uni-CLI, $D$ is implemented as a searchable adapter catalog plus a typed
pipeline engine. Most adapters are YAML because finite declarative pipelines are
cheap for agents to read, patch, and verify. TypeScript remains an escape hatch
for surfaces that exceed the pipeline grammar.

## Adapter Contract

An adapter is intentionally small:

$$
S = (args, pipeline, output, errors)
$$

- `args` names the accepted inputs.
- `pipeline` declares the deterministic steps.
- `output` defines the fields returned to the agent.
- `errors` are normalized into a v2 `AgentEnvelope`.

The current public catalog has **223 sites**, **1304 commands**,
**987 adapters**, and **59 pipeline steps**. Those numbers are generated from
the repo by `scripts/count-stats.ts`, not hand-maintained marketing copy.

## Self-Repair

Self-repair is a bounded search problem. A failing adapter returns structured
feedback:

$$
E = (path, step, code, message, suggestion, alternatives)
$$

The repair function is:

$$
R: S \times E \to S'
$$

The verification function is:

$$
V: S \to \{\mathrm{pass}, \mathrm{fail}\}
$$

The loop is useful only when each iteration reduces ambiguity. That is why
Uni-CLI errors include `adapter_path`, `step`, `retryable`, `suggestion`, and
`alternatives`. A generic error asks the agent to search the whole problem
space; a Uni-CLI error points to one file and one failing step.

## Tool-Surface Tradeoff

Every agent tool surface balances three constraints:

1. **Coverage**: how many intents can be executed.
2. **Accuracy**: how often the selected operation does exactly what the user
   meant.
3. **Performance**: how little context, latency, and runtime state the operation
   consumes.

Uni-CLI optimizes the hot path for accuracy and performance, then expands
coverage through adapters. The strategy is:

1. Discover or operate a surface once.
2. Compile the reliable path into an adapter.
3. Reuse the adapter as a command.
4. Repair the adapter when upstream behavior changes.

That gives agents a narrow deterministic path for repeated work without losing
the ability to add new surfaces.

## Information Budget

The public benchmark target is not an abstract claim. It is a budget:

$$
B = T_{invoke} + T_{response}
$$

Where $T_{invoke}$ is the command string and $T_{response}$ is the returned
envelope. In the current fixture suite:

- representative response bodies: **357-415 tokens**;
- representative invocation strings: **7-11 tokens**;
- representative total budgets: **364-423 tokens**;
- full catalog output: **66272 tokens** because it intentionally lists all
  223 sites and 1304 commands.

The operational rule follows directly: agents should search and describe first,
then execute the smallest matching command. Full catalog output is available,
but it should be explicit.

## Public Design Rules

Uni-CLI's public contract follows five rules:

1. **Search first.** Natural-language intent maps to a small set of commands.
2. **Run narrow.** Use the smallest transport that can finish the task.
3. **Return structure.** Success and failure share the same v2 envelope shape.
4. **Repair locally.** The error tells the agent where to patch and how to
   verify.
5. **Publish measured numbers.** Counts and benchmark tables come from scripts,
   fixtures, and CI-verifiable commands.

## Direction

The goal is to make CLI-native execution the default interface between agents
and software. Protocol servers and editor integrations remain useful
compatibility layers, but the fastest and most inspectable path is a command an
agent can search, execute, compose, and repair.

_Last reviewed: 2026-04-26._
