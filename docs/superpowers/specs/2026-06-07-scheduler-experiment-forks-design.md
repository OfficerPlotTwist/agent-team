# Scheduler experiment forks — `@agent-team/host-experiment` (design)

**Date:** 2026-06-07
**Status:** Approved design, pre-plan
**Milestone:** `@agent-team/host-experiment` v1

## 1. Goal

Compare **K agent variants on one task** in a single parallel run, capture clean
per-variant metrics, and emit a ranked report. All variant branches are kept for
inspection; nothing is auto-merged; core is untouched.

A **Variant** is a named bundle `{name, model, …adapter knobs}` — one concept
covering "a few models / skills / harness configs." An experiment is: run task T
across variants V1…Vn, log the differences.

**v1 varied axis = model + adapter knobs** (`maxTurns`, `permTimeoutMs`) — i.e.
whatever a `ClaudeAdapter` instance can vary today. Richer skill-set / harness-
config variation is the `Variant` struct's extension point, not built further in
v1; adding an axis later means widening `Variant` + the per-variant adapter
construction, with no change to the experiment machinery around it.

## 2. Locked decisions (from brainstorming)

1. **Per-node variants, built by graph-expansion (Approach A), not a Scheduler
   rewrite.** Each variant becomes an independent sibling `TaskNode`; the existing
   1:1:1 Scheduler runs them concurrently in one run. No core/Scheduler change.
2. **Metrics:** cost + turns + wall-clock, completion status, diff-shape. No LLM judge.
3. **Selector output: rank + report, keep all branches.** No auto-merge of a
   winner (that is the deferred "embedded-node tournament" mode).
4. **Execution: parallel; wall-clock advisory.** Cost + turns + status + diff are
   the *primary*, concurrency-invariant comparators; wall-clock is labeled
   advisory because concurrent variants contend for CPU + the Anthropic rate limit.
5. **Validity is the spine** (§3). Memory recording is disabled during an
   experiment; all variants fork from one frozen base; the bus is observation-only.

## 3. The validity model

Three isolation guarantees make the comparison fair. Each rides an existing
mechanism; none is new code.

- **Common frozen base.** Every variant worktree is cut from one fixed commit.
  Provided by reusing core `AmbientIntegration` (§5.2): `init(base)` freezes the
  base, `tip()` returns it, so every `worktrees.create(node, tip())` forks from
  the identical commit.
- **No cross-merge.** `AmbientIntegration.integrate()` returns `{status:"merged"}`
  **without merging**, so each variant node *completes* (the DAG/report counts it)
  while its branch only **stages**. No variant ever sees another's work via the
  shared integration branch.
- **Frozen memory.** The experiment never wires the S5 `done`→record subscriber,
  so no finishing variant can leak a decision into a later-hydrating variant's
  context (the one real contamination vector found in brainstorming). If a memory
  db is supplied it is **hydrate-only (read-only)**; default is no memory.

Why the live feed does NOT contaminate: agents never *read* the bus — their input
is only `goal` + worktree `cwd` + hydrated context files. The bus is an output
channel (→ feed / broker / turn-counter), never an input to a variant's prompt.

## 4. Why this is zero-core (verified against source)

- `AmbientIntegration`, `Scheduler`, `WorktreeManager`, `TaskGraph`,
  `IntegrationLike` are all exported from the core barrel (`index.ts` re-exports
  `./ambient.js`, `./orchestrator.js`, `./worktree.js`, `./task-graph.js`,
  `./integration.js`).
- `CostLedger.perAgent(): Map<AgentId, number>` (adapters-claude) gives
  per-variant USD directly — no result-event parsing.
- `adapterFor(node) → AgentAdapter` is host-supplied; the host closes over a
  `variantByNodeId` map to build a per-variant `ClaudeAdapter`. No `adapterFor`
  signature change.
- Each variant is a normal node with a **unique id**, so the per-agent turn
  budget (Fix 1), done-gate (Fix 2), and memory-recover parsing all work
  unchanged — the agentId-collision problem of a 1:K rewrite never arises.

## 5. Package layout

```
packages/host-experiment/
  package.json            # deps: @agent-team/core, @agent-team/adapters-claude,
                          #       @anthropic-ai/claude-agent-sdk
  src/
    variant.ts            # Variant type + git-safe node-id helpers (pure)
    expand.ts             # expandTask(task, variants) -> { graph, variantByNodeId } (pure)
    metrics.ts            # MetricsCollector: bus subscription + git diff-shape (per agentId)
    report.ts             # renderReport(results) -> { markdown, json } (pure)
    compose.ts            # composeExperiment(opts): Scheduler + AmbientIntegration + per-variant adapterFor
    cli.ts                # agent-team-experiment entry
  tests/                  # offline vitest (fake adapters, real-git temp repo)
```

## 5.1 `variant.ts`

```ts
export interface Variant {
  name: string;                 // git-safe: [A-Za-z0-9_-]+ (validated)
  model: string;                // e.g. "claude-opus-4-8", "claude-haiku-4-5-20251001"
  maxTurns?: number;            // adapter knob; defaults to the experiment default
  permTimeoutMs?: number;       // adapter knob
  // Forward-compatible: further harness/skill knobs the SDK query options expose.
}

// Variant node id: `${taskId}__${variant.name}`. Double-underscore — NOT ":" —
// because git ref names forbid ":" and these ids become branch names
// (`agentteam/${role}-${nodeId}`, WorktreeManager.branchFor).
export function variantNodeId(taskId: string, variantName: string): string;
export function assertGitSafe(name: string): void; // throws on ":", "..", space, etc.
```

## 5.2 `expand.ts`

```ts
import { TaskGraph } from "@agent-team/core";
import type { Role } from "@agent-team/core";
import type { Variant } from "./variant.js";

export interface ExperimentTask {
  taskId: string;   // base id, e.g. "fizzbuzz"
  role: Role;       // same role for every variant (default "coder")
  goal: string;     // the identical prompt every variant receives
}

export interface ExpandedExperiment {
  graph: TaskGraph;
  variantByNodeId: Map<string, Variant>;
  baseRole: Role;
}

/**
 * One task + K variants -> K dependency-free sibling nodes (same goal/role,
 * id = `${taskId}__${variant.name}`). All ready in one wave => run in parallel.
 * Throws on duplicate / non-git-safe variant names.
 */
export function expandTask(task: ExperimentTask, variants: Variant[]): ExpandedExperiment;
```

## 5.3 `metrics.ts`

```ts
import type { MessageBus, BusEvent } from "@agent-team/core";
import type { CostLedger } from "@agent-team/adapters-claude";
import type { GitRunner } from "@agent-team/core";

export interface VariantMetrics {
  variant: string;
  nodeId: string;
  status: "completed" | "failed";      // emitted `done` AND staged a branch
  costUsd: number;                     // ledger.perAgent() for this agentId
  turns: number;                       // bus events counted for this agentId
  wallMs: number;                      // first-event -> done; ADVISORY (see §2.4)
  filesChanged: number;                // git diff --shortstat base..branch
  insertions: number;
  deletions: number;
  commits: number;                     // git rev-list --count base..branch
  branch: string;                      // agentteam/${role}-${nodeId} (kept, unmerged)
  error?: string;                      // present iff status === "failed"
}

/**
 * Subscribes to the bus and tallies per-agentId turns/wall-clock/done. After the
 * run, reads per-variant cost from ledger.perAgent() and diff-shape from git
 * (each staged branch vs the frozen base). Timestamps via the host clock — this
 * is host runtime, not a workflow script, so Date is permitted.
 */
export class MetricsCollector {
  constructor(deps: {
    bus: MessageBus;
    ledger: CostLedger;
    git: GitRunner;
    repoRoot: string;
    base: string;                                  // frozen base sha
    variantByNodeId: Map<string, Variant>;
    role: Role;
  });
  // call once after scheduler.run() settles:
  collect(): Promise<VariantMetrics[]>;
}
```

Mapping: `agentId = ${role}#${nodeId}`; strip the `${role}#` prefix → `nodeId`
→ `variantByNodeId.get(nodeId)`. Branch reconstructed as `agentteam/${role}-${nodeId}`.

## 5.4 `report.ts`

```ts
export interface ReportOptions {
  taskGoal: string;
  rankBy?: keyof VariantMetrics;   // default ranking: status, then costUsd, then turns
  modelId: string;                 // for the attribution footer
}

/** Pure: ranked markdown table + machine-readable JSON. Wall-clock column is
 *  explicitly annotated "(advisory)". */
export function renderReport(metrics: VariantMetrics[], opts: ReportOptions):
  { markdown: string; json: string };
```

The markdown report is a human-readable artifact → written under
`Book_Library`, with the model-attribution footer (`Generated by <model> · task
completed`). The JSON sibling is for programmatic use / future auto-select.

## 5.5 `compose.ts`

```ts
export interface ComposeExperimentOptions {
  repoRoot: string;
  experiment: ExpandedExperiment;
  query: QueryFn;
  defaultMaxTurns: number;
  defaultPermTimeoutMs: number;
  git?: GitRunner;
}

export interface ComposedExperiment {
  bus: MessageBus;
  ledger: CostLedger;
  base: string;                 // frozen base sha (repo HEAD at compose time)
  run(): Promise<ScheduleResult>;
}

// Wiring (mirrors composeHeadless minus the merging integration + memory recorder):
//  - base = rev-parse HEAD (frozen) — the committed HEAD sha; uncommitted
//    working-tree changes are NOT included, so every variant starts from an
//    identical clean checkout of that commit.
//  - integration = new AmbientIntegration(); init(base) inside scheduler.run
//  - worktrees = new WorktreeManager(git, repoRoot, new TextContextProvider(), noEnvelope)
//  - scheduler = new Scheduler({ bus, budget:{maxTurns:defaultMaxTurns}, graph,
//                worktrees, integration, baseRef: base })
//  - adapterFor(node) = new ClaudeAdapter({ query, git, pending, ledger,
//                model: variantByNodeId.get(node.id).model, maxTurns/permTimeoutMs
//                from variant or defaults })
//  - autopilot PolicyStore + ActionBroker + the standard bus->broker->pending
//    subscriber (gates auto-resolve under autopilot; experiments are non-interactive:
//    onGate defaults to deny, but autopilot only GATEs credential/destructive).
//  - NO memory recorder subscriber (validity §3).
export function composeExperiment(opts: ComposeExperimentOptions): ComposedExperiment;
```

## 5.6 `cli.ts` — `agent-team-experiment`

Flags: `--task <goal>` (required), `--task-id <id>` (default "task"),
`--role <role>` (default "coder"), `--variants <file.json>` (required; a
`Variant[]`), `--repo <path>` (default cwd), `--report <path>` (default under
`Book_Library`), `--max-turns <n>` (default 50), `--model <id>` (fallback when a
variant omits `model`). Reads variants, `expandTask`, `composeExperiment`,
attaches `MetricsCollector`, `run()`, `collect()`, `renderReport()`, writes
markdown + json, prints the ranked table + the kept branch names.

## 6. Data flow

```
expandTask(task, variants)
   → composeExperiment (base=HEAD frozen, AmbientIntegration stage-only, no memory)
   → scheduler.run(adapterFor)   [K nodes, dependency-free, run in parallel]
        · each variant: worktree from frozen base → ClaudeAdapter(variant.model)
          → stages agentteam/${role}-${taskId}__${variant} → completes (no merge)
   → MetricsCollector.collect()   [cost=ledger.perAgent, turns/wall from bus, diff from git]
   → renderReport (ranked md + json)
   → all K branches kept for inspection
```

## 7. Failure handling

v1 experiments **one task (leaf), no dependents** — a variant that errors or
never emits `done` is `status: "failed"` in the report (its `error` captured from
the emitted error event); it cannot block the others (no merge, no downstream).
A run where *every* variant fails still produces a report (all rows failed).

## 8. Testing (offline)

vitest + fake adapters + real-git temp repo (the host-headless idiom):

- **Two fake variants** (A "cheap/fast": few turns, small diff, low cost; B
  "expensive/thorough": more turns, bigger diff) via a fake `query` that varies
  files written + `total_cost_usd` + message count by the cwd/branch it sees.
- **Staging invariant:** after run, both variant branches exist, the frozen base
  (`HEAD`) is unmoved, the integration branch was never created/advanced.
- **Metrics correctness:** `costUsd` matches `ledger.perAgent()`, `turns` matches
  the per-agent bus count, diff-shape matches `git diff --shortstat`.
- **Ranking:** `renderReport` orders rows by status→cost→turns; wall-clock column
  annotated advisory.
- **Isolation test (the validity guarantee):** a variant that calls a memory
  `record` does NOT appear in another variant's hydrated context — assert
  identical pre-run context across variants (recorder not wired).
- **Failure isolation:** one variant emitting `error`/no-`done` yields a `failed`
  row while the other reports `completed`.

Live smoke (real models, real cost) is manual + deferred (a `LIVE-SMOKE.md`),
per B1/host-web precedent.

Gate: full workspace `npm run build` exit 0 and all suites green, count strictly
greater than the current **220**.

## 9. Non-goals (v1)

- No auto-merge / winner-grafting (deferred "tournament" mode — needed only when
  an experimented node is embedded mid-graph with dependents consuming the winner).
- No LLM-judge scoring.
- No web UI (headless + report file; the run can still be watched via any host
  later if desired — out of scope).
- No clean head-to-head wall-clock (parallel execution; wall-clock advisory).
- No per-variant resource isolation (containers/rate-limit pinning).

## 10. Done criteria

1. `agent-team-experiment --task "<goal>" --variants v.json --repo <r>` runs K
   variants in parallel against a frozen base, stages K unmerged branches, and
   writes a ranked markdown + json report under `Book_Library` listing per-variant
   cost / turns / status / diff-shape (+ advisory wall-clock) and the kept branches.
2. Zero diff outside `packages/host-experiment` (+ root workspace wiring).
3. Build + tests green per §8 gate (> 220).
4. The isolation test proves no cross-variant memory contamination.
