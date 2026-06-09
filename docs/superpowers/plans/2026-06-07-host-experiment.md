# host-experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@agent-team/host-experiment` — run K agent variants on one task in a single parallel run, capture clean per-variant metrics (cost/turns/status/diff-shape + advisory wall-clock), and write a ranked report; all branches kept, nothing auto-merged.

**Architecture:** Graph-expansion (Approach A): one task + K variants → K dependency-free sibling `TaskNode`s the existing 1:1:1 `Scheduler` runs concurrently. Validity comes from reusing core `AmbientIntegration` (every variant forks from one frozen base, none merge) and from never wiring the S5 memory recorder. Per-variant cost from `CostLedger.perAgent()`; wall-clock from bus `event.ts`. New leaf host package; **zero core/adapter change**.

**Tech Stack:** TypeScript ESM (NodeNext), `@agent-team/core` + `@agent-team/adapters-claude` + the Claude Agent SDK, vitest.

**Invariants (from spec `docs/superpowers/specs/2026-06-07-scheduler-experiment-forks-design.md`):**
- ZERO diff outside `packages/host-experiment` except root `package.json` (build/test chains) + root lockfile.
- composeExperiment never wires a memory `record` subscriber (validity).
- All variants fork from one frozen base (`AmbientIntegration` + `tip()=base`).
- Variant node id uses `__` (NOT `:` — git ref names forbid `:`).
- Current workspace suite is **220 green**. Done gate: full `npm run build` exit 0 AND full `npm run test` green, count > 220.

**Conventions for the executor:**
- Paths relative to repo root `C:\Users\nik\Documents\AI\vsCode Fork` (forward slashes OK; git-bash works).
- Run package tests: `npm run test -w @agent-team/host-experiment` (append `-- tests/<file>.test.ts` for one file).
- This repo's lesson: run git commands ONE at a time, never parallel-batched.
- Tests import package source as `../src/<mod>.js` (NodeNext ESM, like host-headless tests).
- Verified seams (do not re-derive): `AmbientIntegration` (core barrel) — `new AmbientIntegration()`, `init(base)`, `tip()→base`, `integrate()→{status:"merged"}` no-merge. `CostLedger` (adapters-claude) — `add`, `total`, `perAgent():Map<AgentId,number>`. `WorktreeManager.branchFor = agentteam/${role}-${id}`. `Scheduler({bus,budget:{maxTurns},graph,worktrees,integration,baseRef})`. `agentId = ${role}#${nodeId}`. `BusEvent` carries `ts`.

---

## File structure

```
packages/host-experiment/
  package.json            # new package + bin agent-team-experiment
  tsconfig.json
  .gitignore
  src/
    variant.ts            # Variant type, variantNodeId, assertGitSafe (pure)
    expand.ts             # expandTask -> { graph, variantByNodeId, baseRole } (pure)
    report.ts             # renderReport(metrics, opts) -> { markdown, json } (pure)
    metrics.ts            # MetricsCollector (bus tally + git diff-shape)
    compose.ts            # composeExperiment (Scheduler + AmbientIntegration + per-variant adapterFor)
    cli-args.ts           # parseArgs (pure)
    cli.ts                # agent-team-experiment entry
  tests/
    variant.test.ts
    expand.test.ts
    report.test.ts
    metrics.test.ts
    compose-experiment.test.ts
    cli-args.test.ts
  LIVE-SMOKE.md
```

---

### Task 1: Package scaffold + root wiring

**Files:**
- Create: `packages/host-experiment/package.json`
- Create: `packages/host-experiment/tsconfig.json`
- Create: `packages/host-experiment/.gitignore`
- Modify: root `package.json` (build/test chains)

- [ ] **Step 1: Create `packages/host-experiment/package.json`**

```json
{
  "name": "@agent-team/host-experiment",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/compose.js",
  "bin": { "agent-team-experiment": "./dist/cli.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@agent-team/core": "*",
    "@agent-team/adapters-claude": "*",
    "@anthropic-ai/claude-agent-sdk": "0.3.154"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/host-experiment/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `packages/host-experiment/.gitignore`**

```
dist/
node_modules/
```

- [ ] **Step 4: Wire root `package.json`.** Append host-experiment to BOTH chains (after host-web):

```json
"build": "npm run build -w @agent-team/core && npm run build -w @agent-team/adapters-claude && npm run build -w @agent-team/adapters-deepseek && npm run build -w @agent-team/host-headless && npm run build -w @agent-team/host-vscode && npm run build -w @agent-team/host-web && npm run build -w @agent-team/host-experiment",
"test": "npm run test -w @agent-team/core && npm run test -w @agent-team/adapters-claude && npm run test -w @agent-team/adapters-deepseek && npm run test -w @agent-team/host-headless && npm run test -w @agent-team/host-vscode && npm run test -w @agent-team/host-web && npm run test -w @agent-team/host-experiment",
```

- [ ] **Step 5: Install + verify**

Run: `npm install`
Expected: exit 0, host-experiment symlinked into the workspace.

Run: `npm run build -w @agent-team/host-experiment`
Expected: exit 0 (no src yet — tsc with empty src is a no-op success; if tsc errors on "no inputs", that's fine to ignore until Task 2 adds a file. If it fails the build chain, add a temporary `src/index.ts` exporting nothing and remove it in Task 2.)

- [ ] **Step 6: Commit**

```bash
git add packages/host-experiment/package.json packages/host-experiment/tsconfig.json packages/host-experiment/.gitignore package.json package-lock.json
git commit -m "feat(host-experiment): scaffold package + workspace wiring"
```

---

### Task 2: Variant type + git-safe ids

**Files:**
- Create: `packages/host-experiment/src/variant.ts`
- Test: `packages/host-experiment/tests/variant.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/host-experiment/tests/variant.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { variantNodeId, assertGitSafe } from "../src/variant.js";

describe("variant ids", () => {
  it("joins task and variant with __ (git-safe, never ':')", () => {
    expect(variantNodeId("fizzbuzz", "opus")).toBe("fizzbuzz__opus");
  });

  it("assertGitSafe accepts plain names", () => {
    expect(() => assertGitSafe("opus-4-8")).not.toThrow();
    expect(() => assertGitSafe("haiku_cheap")).not.toThrow();
  });

  it("assertGitSafe rejects names that break git ref rules", () => {
    for (const bad of ["has:colon", "has space", "..dots", "tilde~", "caret^", "q?", "star*", ""]) {
      expect(() => assertGitSafe(bad), bad).toThrow();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @agent-team/host-experiment -- tests/variant.test.ts`
Expected: FAIL — `Cannot find module '../src/variant.js'`.

- [ ] **Step 3: Create `packages/host-experiment/src/variant.ts`**

```ts
import type { Role } from "@agent-team/core";

export interface Variant {
  /** git-safe: [A-Za-z0-9_-]+ (validated via assertGitSafe). */
  name: string;
  /** e.g. "claude-opus-4-8", "claude-haiku-4-5-20251001". */
  model: string;
  /** Adapter knob; defaults to the experiment default when omitted. */
  maxTurns?: number;
  /** Adapter knob; defaults to the experiment default when omitted. */
  permTimeoutMs?: number;
}

/**
 * Variant node id. Double-underscore, NOT ":", because these ids become git
 * branch names (`agentteam/${role}-${nodeId}`, WorktreeManager.branchFor) and
 * git ref names forbid ":".
 */
export function variantNodeId(taskId: string, variantName: string): string {
  return `${taskId}__${variantName}`;
}

/** Throw if `name` would produce an invalid git ref component. */
export function assertGitSafe(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      `variant/task name "${name}" must match [A-Za-z0-9_-]+ (git ref names forbid ':', spaces, '..', etc.)`,
    );
  }
}

/** Re-export Role for callers building ExperimentTask. */
export type { Role };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @agent-team/host-experiment -- tests/variant.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host-experiment/src/variant.ts packages/host-experiment/tests/variant.test.ts
git commit -m "feat(host-experiment): Variant type + git-safe node ids (TDD)"
```

---

### Task 3: expandTask

**Files:**
- Create: `packages/host-experiment/src/expand.ts`
- Test: `packages/host-experiment/tests/expand.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/host-experiment/tests/expand.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { expandTask } from "../src/expand.js";
import type { Variant } from "../src/variant.js";

const variants: Variant[] = [
  { name: "cheap", model: "claude-haiku-4-5-20251001" },
  { name: "thorough", model: "claude-opus-4-8" },
];

describe("expandTask", () => {
  it("creates one dependency-free sibling node per variant", () => {
    const { graph, variantByNodeId } = expandTask(
      { taskId: "fizzbuzz", role: "coder", goal: "write fizzbuzz" },
      variants,
    );
    expect(graph.ids().sort()).toEqual(["fizzbuzz__cheap", "fizzbuzz__thorough"]);
    const n = graph.get("fizzbuzz__cheap")!;
    expect(n.role).toBe("coder");
    expect(n.goal).toBe("write fizzbuzz");
    expect(n.dependsOn).toEqual([]);
    expect(variantByNodeId.get("fizzbuzz__thorough")!.model).toBe("claude-opus-4-8");
  });

  it("all nodes are ready at once (one parallel wave)", () => {
    const { graph } = expandTask({ taskId: "t", role: "coder", goal: "g" }, variants);
    expect(graph.ready().map((n) => n.id).sort()).toEqual(["t__cheap", "t__thorough"]);
  });

  it("rejects duplicate variant names", () => {
    expect(() =>
      expandTask({ taskId: "t", role: "coder", goal: "g" }, [
        { name: "dup", model: "m" },
        { name: "dup", model: "m2" },
      ]),
    ).toThrow(/duplicate/i);
  });

  it("rejects non-git-safe variant names", () => {
    expect(() =>
      expandTask({ taskId: "t", role: "coder", goal: "g" }, [{ name: "bad:name", model: "m" }]),
    ).toThrow();
  });

  it("requires at least one variant", () => {
    expect(() => expandTask({ taskId: "t", role: "coder", goal: "g" }, [])).toThrow(/at least one/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @agent-team/host-experiment -- tests/expand.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/host-experiment/src/expand.ts`**

```ts
import { TaskGraph } from "@agent-team/core";
import type { Role, TaskNode } from "@agent-team/core";
import type { Variant } from "./variant.js";
import { variantNodeId, assertGitSafe } from "./variant.js";

export interface ExperimentTask {
  taskId: string;
  role: Role;
  goal: string;
}

export interface ExpandedExperiment {
  graph: TaskGraph;
  variantByNodeId: Map<string, Variant>;
  baseRole: Role;
}

/**
 * One task + K variants -> K dependency-free sibling nodes (same goal/role,
 * id = `${taskId}__${variant.name}`). All ready in one wave => parallel.
 */
export function expandTask(task: ExperimentTask, variants: Variant[]): ExpandedExperiment {
  if (variants.length === 0) throw new Error("expandTask needs at least one variant");
  assertGitSafe(task.taskId);

  const variantByNodeId = new Map<string, Variant>();
  const nodes: TaskNode[] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    if (seen.has(v.name)) throw new Error(`duplicate variant name: ${v.name}`);
    seen.add(v.name);
    assertGitSafe(v.name);
    const id = variantNodeId(task.taskId, v.name);
    nodes.push({ id, role: task.role, goal: task.goal, dependsOn: [] });
    variantByNodeId.set(id, v);
  }

  return { graph: new TaskGraph(nodes), variantByNodeId, baseRole: task.role };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @agent-team/host-experiment -- tests/expand.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host-experiment/src/expand.ts packages/host-experiment/tests/expand.test.ts
git commit -m "feat(host-experiment): expandTask -> K sibling variant nodes (TDD)"
```

---

### Task 4: VariantMetrics type + renderReport

**Files:**
- Create: `packages/host-experiment/src/report.ts`
- Test: `packages/host-experiment/tests/report.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/host-experiment/tests/report.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderReport } from "../src/report.js";
import type { VariantMetrics } from "../src/report.js";

const rows: VariantMetrics[] = [
  {
    variant: "thorough", nodeId: "t__thorough", status: "completed",
    costUsd: 0.05, turns: 4, wallMs: 9000, filesChanged: 2, insertions: 40,
    deletions: 3, commits: 1, branch: "agentteam/coder-t__thorough",
  },
  {
    variant: "cheap", nodeId: "t__cheap", status: "completed",
    costUsd: 0.01, turns: 2, wallMs: 4000, filesChanged: 1, insertions: 10,
    deletions: 0, commits: 1, branch: "agentteam/coder-t__cheap",
  },
  {
    variant: "broken", nodeId: "t__broken", status: "failed",
    costUsd: 0.0, turns: 1, wallMs: 500, filesChanged: 0, insertions: 0,
    deletions: 0, commits: 0, branch: "agentteam/coder-t__broken", error: "boom",
  },
];

describe("renderReport", () => {
  it("ranks completed-before-failed, then by cost ascending (default)", () => {
    const { markdown } = renderReport(rows, { taskGoal: "g", modelId: "claude-opus-4-8" });
    const order = [...markdown.matchAll(/\| (cheap|thorough|broken) /g)].map((m) => m[1]);
    expect(order).toEqual(["cheap", "thorough", "broken"]); // cheap < thorough cost; broken failed last
  });

  it("annotates wall-clock as advisory and includes the attribution footer", () => {
    const { markdown } = renderReport(rows, { taskGoal: "g", modelId: "claude-opus-4-8" });
    expect(markdown).toMatch(/wall.*advisory/i);
    expect(markdown).toContain("Generated by claude-opus-4-8");
    expect(markdown).toContain("agentteam/coder-t__cheap"); // branches listed
  });

  it("emits parseable JSON with all rows", () => {
    const { json } = renderReport(rows, { taskGoal: "g", modelId: "claude-opus-4-8" });
    const parsed = JSON.parse(json) as { variants: VariantMetrics[] };
    expect(parsed.variants).toHaveLength(3);
    expect(parsed.variants.some((v) => v.variant === "broken" && v.status === "failed")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @agent-team/host-experiment -- tests/report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/host-experiment/src/report.ts`**

```ts
export interface VariantMetrics {
  variant: string;
  nodeId: string;
  status: "completed" | "failed";
  costUsd: number;
  turns: number;
  /** first-event -> done, from bus event.ts. ADVISORY (concurrency-contaminated). */
  wallMs: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  commits: number;
  /** Kept, unmerged, for inspection. */
  branch: string;
  error?: string;
}

export interface ReportOptions {
  taskGoal: string;
  /** Model id for the attribution footer. */
  modelId: string;
}

/** completed before failed; within a group, cheaper first, then fewer turns. */
function rank(a: VariantMetrics, b: VariantMetrics): number {
  if (a.status !== b.status) return a.status === "completed" ? -1 : 1;
  if (a.costUsd !== b.costUsd) return a.costUsd - b.costUsd;
  return a.turns - b.turns;
}

export function renderReport(
  metrics: VariantMetrics[],
  opts: ReportOptions,
): { markdown: string; json: string } {
  const ranked = [...metrics].sort(rank);

  const header =
    "| variant | status | cost ($) | turns | wall ms (advisory) | files | +/− | commits |\n" +
    "|---|---|---|---|---|---|---|---|";
  const rows = ranked.map(
    (m) =>
      `| ${m.variant} | ${m.status}${m.error ? ` (${m.error})` : ""} | ${m.costUsd.toFixed(4)} | ` +
      `${m.turns} | ${m.wallMs} | ${m.filesChanged} | +${m.insertions}/−${m.deletions} | ${m.commits} |`,
  );
  const branches = ranked.map((m) => `- \`${m.branch}\` (${m.variant}) — kept, unmerged`);

  const markdown =
    `# Experiment report\n\n` +
    `**Task:** ${opts.taskGoal}\n\n` +
    `${header}\n${rows.join("\n")}\n\n` +
    `> wall ms is **advisory** — variants ran in parallel and contend for CPU + the API rate limit; ` +
    `cost / turns / status / diff are the clean comparators.\n\n` +
    `## Staged branches (inspect / adopt manually)\n\n${branches.join("\n")}\n\n` +
    `———\nGenerated by ${opts.modelId} · task completed\n`;

  const json = JSON.stringify({ task: opts.taskGoal, variants: ranked }, null, 2);
  return { markdown, json };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @agent-team/host-experiment -- tests/report.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host-experiment/src/report.ts packages/host-experiment/tests/report.test.ts
git commit -m "feat(host-experiment): VariantMetrics + ranked report (md+json, TDD)"
```

---

### Task 5: MetricsCollector

**Files:**
- Create: `packages/host-experiment/src/metrics.ts`
- Test: `packages/host-experiment/tests/metrics.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/host-experiment/tests/metrics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MessageBus } from "@agent-team/core";
import { CostLedger } from "@agent-team/adapters-claude";
import type { GitRunner } from "@agent-team/core";
import { MetricsCollector } from "../src/metrics.js";
import type { Variant } from "../src/variant.js";

// A fake GitRunner returning canned diff-shape / commit-count per branch.
function fakeGit(byBranch: Record<string, { shortstat: string; commits: string }>): GitRunner {
  return {
    run: async (args: string[]) => {
      const branch = args[args.length - 1] ?? "";
      const key = branch.includes("..") ? (branch.split("..")[1] ?? "") : branch;
      const data = byBranch[key];
      if (args[0] === "diff") return { code: 0, stdout: data?.shortstat ?? "", stderr: "" };
      if (args[0] === "rev-list") return { code: 0, stdout: data?.commits ?? "0", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  } as unknown as GitRunner;
}

describe("MetricsCollector", () => {
  it("tallies per-agent turns + wall-clock + status from the bus, cost from the ledger, diff from git", async () => {
    const bus = new MessageBus();
    const ledger = new CostLedger();
    const variantByNodeId = new Map<string, Variant>([
      ["t__cheap", { name: "cheap", model: "m1" }],
      ["t__slow", { name: "slow", model: "m2" }],
    ]);
    const git = fakeGit({
      "agentteam/coder-t__cheap": { shortstat: " 1 file changed, 10 insertions(+)", commits: "1" },
      "agentteam/coder-t__slow": { shortstat: " 2 files changed, 40 insertions(+), 3 deletions(-)", commits: "2" },
    });

    const collector = new MetricsCollector({
      bus, ledger, git, repoRoot: "/r", base: "BASE", variantByNodeId, role: "coder",
    });

    // cheap: 2 events (msg @100, done @300) -> wall 200; ledger 0.01
    bus.publish({ kind: "message", from: "coder#t__cheap", to: "all", text: "hi" });
    bus.publish({ kind: "done", from: "coder#t__cheap", summary: "ok" });
    ledger.add("coder#t__cheap", 0.01);
    // slow: error, no done -> failed
    bus.publish({ kind: "tool_call", from: "coder#t__slow", name: "Bash", args: {} });
    bus.publish({ kind: "error", from: "coder#t__slow", message: "boom" });
    ledger.add("coder#t__slow", 0.02);

    const rows = await collector.collect();
    const cheap = rows.find((r) => r.variant === "cheap")!;
    const slow = rows.find((r) => r.variant === "slow")!;

    expect(cheap.status).toBe("completed");
    expect(cheap.costUsd).toBeCloseTo(0.01);
    expect(cheap.turns).toBe(2);
    expect(cheap.wallMs).toBeGreaterThanOrEqual(0);
    expect(cheap.filesChanged).toBe(1);
    expect(cheap.insertions).toBe(10);
    expect(cheap.deletions).toBe(0);
    expect(cheap.commits).toBe(1);
    expect(cheap.branch).toBe("agentteam/coder-t__cheap");

    expect(slow.status).toBe("failed");
    expect(slow.error).toBe("boom");
    expect(slow.filesChanged).toBe(2);
    expect(slow.deletions).toBe(3);
    expect(slow.commits).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @agent-team/host-experiment -- tests/metrics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/host-experiment/src/metrics.ts`**

```ts
import type { MessageBus, BusEvent, GitRunner, Role } from "@agent-team/core";
import type { CostLedger } from "@agent-team/adapters-claude";
import type { Variant } from "./variant.js";
import type { VariantMetrics } from "./report.js";

interface Tally {
  firstTs: number | null;
  doneTs: number | null;
  turns: number;
  done: boolean;
  error?: string;
}

export interface MetricsCollectorDeps {
  bus: MessageBus;
  ledger: CostLedger;
  git: GitRunner;
  repoRoot: string;
  /** Frozen base sha all variants forked from. */
  base: string;
  variantByNodeId: Map<string, Variant>;
  role: Role;
}

/**
 * Subscribes to the bus and tallies per-agentId turns/wall-clock/done/error.
 * After the run, reads per-variant cost from ledger.perAgent() and diff-shape
 * from git (each staged branch vs the frozen base). agentId = `${role}#${nodeId}`.
 */
export class MetricsCollector {
  readonly #deps: MetricsCollectorDeps;
  readonly #tally = new Map<string, Tally>(); // keyed by nodeId

  constructor(deps: MetricsCollectorDeps) {
    this.#deps = deps;
    deps.bus.subscribe((e) => this.#onEvent(e));
  }

  #onEvent(e: BusEvent): void {
    const nodeId = e.from.slice(e.from.indexOf("#") + 1);
    if (!this.#deps.variantByNodeId.has(nodeId)) return;
    const t =
      this.#tally.get(nodeId) ?? { firstTs: null, doneTs: null, turns: 0, done: false };
    if (t.firstTs === null) t.firstTs = e.ts;
    t.turns += 1;
    if (e.kind === "done") {
      t.done = true;
      t.doneTs = e.ts;
    } else if (e.kind === "error") {
      t.error = e.message;
    }
    this.#tally.set(nodeId, t);
  }

  async collect(): Promise<VariantMetrics[]> {
    const { ledger, git, repoRoot, base, variantByNodeId, role } = this.#deps;
    const perAgent = ledger.perAgent();
    const out: VariantMetrics[] = [];

    for (const [nodeId, variant] of variantByNodeId) {
      const agentId = `${role}#${nodeId}`;
      const branch = `agentteam/${role}-${nodeId}`;
      const t = this.#tally.get(nodeId) ?? { firstTs: null, doneTs: null, turns: 0, done: false };
      const shape = await this.#diffShape(git, repoRoot, base, branch);
      out.push({
        variant: variant.name,
        nodeId,
        status: t.done ? "completed" : "failed",
        costUsd: perAgent.get(agentId) ?? 0,
        turns: t.turns,
        wallMs: t.firstTs !== null && t.doneTs !== null ? t.doneTs - t.firstTs : 0,
        ...shape,
        branch,
        ...(t.done ? {} : { error: t.error ?? "no done event" }),
      });
    }
    return out;
  }

  async #diffShape(
    git: GitRunner,
    repoRoot: string,
    base: string,
    branch: string,
  ): Promise<{ filesChanged: number; insertions: number; deletions: number; commits: number }> {
    const stat = (await git.run(["diff", "--shortstat", `${base}..${branch}`], repoRoot)).stdout;
    const num = (re: RegExp): number => {
      const m = stat.match(re);
      return m ? Number(m[1]) : 0;
    };
    const commitsOut = (await git.run(["rev-list", "--count", `${base}..${branch}`], repoRoot)).stdout;
    return {
      filesChanged: num(/(\d+) files? changed/),
      insertions: num(/(\d+) insertions?\(\+\)/),
      deletions: num(/(\d+) deletions?\(-\)/),
      commits: Number(commitsOut.trim()) || 0,
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @agent-team/host-experiment -- tests/metrics.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/host-experiment/src/metrics.ts packages/host-experiment/tests/metrics.test.ts
git commit -m "feat(host-experiment): MetricsCollector (per-agent bus tally + git diff-shape, TDD)"
```

---

### Task 6: composeExperiment + offline integration test

**Files:**
- Create: `packages/host-experiment/src/compose.ts`
- Test: `packages/host-experiment/tests/compose-experiment.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/host-experiment/tests/compose-experiment.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { expandTask } from "../src/expand.js";
import { composeExperiment } from "../src/compose.js";
import { MetricsCollector } from "../src/metrics.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("composeExperiment offline integration", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "hx-")).split("\\").join("/");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "base"], repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  // Fake query: behavior varies by the variant's model. cheap writes 1 file at
  // cost 0.01; thorough writes 2 files at cost 0.05. Both Write through canUseTool
  // (approval -> auto-allow under autopilot), then commit, then yield a result.
  const query: QueryFn = async function* ({ options }) {
    const o = options as {
      model?: string;
      cwd?: string;
      canUseTool?: (n: string, i: Record<string, unknown>, x: never) => Promise<{ behavior: string }>;
    };
    const cheap = o.model === "fake-cheap";
    const files = cheap ? ["a.txt"] : ["a.txt", "b.txt"];
    for (const f of files) {
      const d = await o.canUseTool!("Write", { file_path: f }, {} as never);
      if (d.behavior === "allow") writeFileSync(join(o.cwd as string, f), `${o.model}:${f}\n`);
    }
    yield asMsg({
      type: "result", subtype: "success", is_error: false,
      result: `wrote ${files.length}`, total_cost_usd: cheap ? 0.01 : 0.05,
    });
  };

  it("runs K variants in parallel from a frozen base, stages all, merges none, and measures each", async () => {
    const exp = expandTask({ taskId: "t", role: "coder", goal: "write files" }, [
      { name: "cheap", model: "fake-cheap" },
      { name: "thorough", model: "fake-thorough" },
    ]);
    const host = await composeExperiment({
      repoRoot: repo, experiment: exp, query,
      defaultMaxTurns: 50, defaultPermTimeoutMs: 2000, git,
    });
    const collector = new MetricsCollector({
      bus: host.bus, ledger: host.ledger, git, repoRoot: repo,
      base: host.base, variantByNodeId: exp.variantByNodeId, role: "coder",
    });

    const result = await host.run();
    expect(result.status).toBe("complete");

    // staging invariant: both branches exist, none merged anywhere, base unmoved.
    const base = (await git.run(["rev-parse", "main"], repo)).stdout.trim();
    expect(base).toBe(host.base); // main never advanced
    const noIntegration = await git.run(["rev-parse", "--verify", "agentteam/integration"], repo);
    expect(noIntegration.code).not.toBe(0); // AmbientIntegration creates NO integration branch
    for (const b of ["agentteam/coder-t__cheap", "agentteam/coder-t__thorough"]) {
      expect((await git.run(["rev-parse", "--verify", b], repo)).code).toBe(0);
    }

    const rows = await collector.collect();
    const cheap = rows.find((r) => r.variant === "cheap")!;
    const thorough = rows.find((r) => r.variant === "thorough")!;
    expect(cheap.status).toBe("completed");
    expect(cheap.costUsd).toBeCloseTo(0.01);
    expect(cheap.filesChanged).toBe(1);
    expect(thorough.costUsd).toBeCloseTo(0.05);
    expect(thorough.filesChanged).toBe(2);

    // ISOLATION (spec §10.4): each variant forked from the same frozen base and
    // never saw the other's work. cheap wrote only a.txt; thorough also wrote
    // b.txt. cheap's branch must NOT contain thorough's unique file, and BOTH
    // must contain the shared base file — proving no cross-variant contamination.
    expect((await git.run(["show", "agentteam/coder-t__cheap:b.txt"], repo)).code).not.toBe(0);
    expect((await git.run(["show", "agentteam/coder-t__cheap:seed.txt"], repo)).code).toBe(0);
    expect((await git.run(["show", "agentteam/coder-t__thorough:seed.txt"], repo)).code).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @agent-team/host-experiment -- tests/compose-experiment.test.ts`
Expected: FAIL — `Cannot find module '../src/compose.js'`.

- [ ] **Step 3: Create `packages/host-experiment/src/compose.ts`**

```ts
import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  AmbientIntegration,
  Scheduler,
  pickModality,
} from "@agent-team/core";
import type {
  TaskNode,
  GitRunner,
  BusEvent,
  ActionRequestEvent,
  AgentId,
  Role,
  BrokerHandlers,
  AgentAdapter,
  ScheduleResult,
} from "@agent-team/core";
import { NodeGitRunner, TextContextProvider } from "@agent-team/core/node";
import {
  ClaudeAdapter,
  PendingPermissions,
  CostLedger,
  type QueryFn,
} from "@agent-team/adapters-claude";
import type { ExpandedExperiment } from "./expand.js";

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
  /** Frozen base sha all variants forked from (committed HEAD at compose time). */
  base: string;
  run(): Promise<ScheduleResult>;
}

/**
 * Wires the existing Scheduler to run the expanded variant graph against a frozen
 * base with stage-only AmbientIntegration (no variant merges) and a per-variant
 * adapter. Deliberately wires NO memory recorder (validity §3). Non-interactive:
 * gates default-deny, but autopilot only GATEs credential/destructive, so file
 * Writes auto-allow uniformly across variants.
 */
export async function composeExperiment(
  opts: ComposeExperimentOptions,
): Promise<ComposedExperiment> {
  const git = opts.git ?? new NodeGitRunner();
  const { graph, variantByNodeId } = opts.experiment;

  const base = (await git.run(["rev-parse", "HEAD"], opts.repoRoot)).stdout.trim();

  const bus = new MessageBus();
  const ledger = new CostLedger();
  const pending = new PendingPermissions();
  const store = new PolicyStore();
  store.applyPreset("autopilot");

  const handlers: BrokerHandlers = {
    // Non-interactive experiment: a real GATE (credential/destructive) default-denies.
    gate: (req: ActionRequestEvent, _from: AgentId) => {
      pending.resolve(req.requestId, { behavior: "deny", message: "experiment: gate auto-denied" });
    },
    route: (_req: ActionRequestEvent, _from: AgentId, _to: Role) => {},
    notify: (_req: ActionRequestEvent, _from: AgentId) => {},
  };
  const broker = new ActionBroker(store, handlers);

  bus.subscribe((e: BusEvent) => {
    if (e.kind !== "action_request") return;
    if (!pending.has(e.requestId)) return;
    const res = broker.handle(e);
    if (res.mode !== "GATE") {
      pending.resolve(e.requestId, { behavior: "allow" });
    }
  });

  const contextModalities = ["text"] as const;
  const worktrees = new WorktreeManager(
    git,
    opts.repoRoot,
    new TextContextProvider(), // hydrate-only TEXT context; NO memory recorder (validity)
    () => ({ envelope: undefined, modality: pickModality(contextModalities) }),
  );

  const integration = new AmbientIntegration(); // stage-only: tip()=base, integrate() no-merge

  const scheduler = new Scheduler({
    bus,
    budget: { maxTurns: opts.defaultMaxTurns },
    graph,
    worktrees,
    integration,
    baseRef: base, // AmbientIntegration.init(base) freezes it; every worktree cuts from base
  });

  const adapterFor = (node: TaskNode): AgentAdapter => {
    const variant = variantByNodeId.get(node.id);
    if (!variant) throw new Error(`no variant for node ${node.id}`);
    return new ClaudeAdapter({
      query: opts.query,
      git,
      pending,
      ledger,
      model: variant.model,
      maxTurns: variant.maxTurns ?? opts.defaultMaxTurns,
      permTimeoutMs: variant.permTimeoutMs ?? opts.defaultPermTimeoutMs,
    });
  };

  return { bus, ledger, base, run: () => scheduler.run(adapterFor) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @agent-team/host-experiment -- tests/compose-experiment.test.ts`
Expected: PASS (1 test). Real git in a temp repo — allow ~10s.

- [ ] **Step 5: Build + full package test**

Run: `npm run build -w @agent-team/host-experiment` then `npm run test -w @agent-team/host-experiment`
Expected: build exit 0; all host-experiment tests green (~13).

- [ ] **Step 6: Commit**

```bash
git add packages/host-experiment/src/compose.ts packages/host-experiment/tests/compose-experiment.test.ts
git commit -m "feat(host-experiment): composeExperiment — K variants, frozen base, stage-only, no merge (TDD)"
```

---

### Task 7: CLI

**Files:**
- Create: `packages/host-experiment/src/cli-args.ts`
- Create: `packages/host-experiment/src/cli.ts`
- Test: `packages/host-experiment/tests/cli-args.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/host-experiment/tests/cli-args.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli-args.js";

describe("parseArgs (agent-team-experiment)", () => {
  it("requires --task and --variants", () => {
    expect(() => parseArgs(["--variants", "v.json"])).toThrow("--task");
    expect(() => parseArgs(["--task", "g"])).toThrow("--variants");
  });

  it("applies defaults", () => {
    const a = parseArgs(["--task", "write fizzbuzz", "--variants", "v.json"]);
    expect(a).toMatchObject({
      task: "write fizzbuzz", variants: "v.json", taskId: "task",
      role: "coder", maxTurns: 50, model: "claude-opus-4-8",
    });
    expect(a.repo).toBe(process.cwd());
    expect(a.report).toMatch(/Book_Library/);
  });

  it("parses every flag", () => {
    const a = parseArgs([
      "--task", "g", "--task-id", "fizz", "--role", "reviewer",
      "--variants", "v.json", "--repo", "/r", "--report", "/out.md",
      "--max-turns", "9", "--model", "m",
    ]);
    expect(a).toEqual({
      task: "g", taskId: "fizz", role: "reviewer", variants: "v.json",
      repo: "/r", report: "/out.md", maxTurns: 9, model: "m",
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w @agent-team/host-experiment -- tests/cli-args.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/host-experiment/src/cli-args.ts`**

```ts
export interface CliArgs {
  task: string;
  taskId: string;
  role: string;
  variants: string;
  repo: string;
  report: string;
  maxTurns: number;
  model: string;
}

const DEFAULT_REPORT = "C:/Users/nik/Documents/AI/Book_Library/experiment-report.md";

export function parseArgs(argv: string[]): CliArgs {
  const getOpt = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const task = getOpt("--task");
  if (task === undefined) throw new Error("--task <goal> is required");
  const variants = getOpt("--variants");
  if (variants === undefined) throw new Error("--variants <file.json> is required");
  return {
    task,
    taskId: getOpt("--task-id") ?? "task",
    role: getOpt("--role") ?? "coder",
    variants,
    repo: getOpt("--repo") ?? process.cwd(),
    report: getOpt("--report") ?? DEFAULT_REPORT,
    maxTurns: Number(getOpt("--max-turns") ?? "50"),
    model: getOpt("--model") ?? "claude-opus-4-8",
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w @agent-team/host-experiment -- tests/cli-args.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create `packages/host-experiment/src/cli.ts`** (entry — no unit test; exercised by live smoke)

```ts
#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { stdout } from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Role } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { QueryFn } from "@agent-team/adapters-claude";
import { parseArgs } from "./cli-args.js";
import type { Variant } from "./variant.js";
import { expandTask } from "./expand.js";
import { composeExperiment } from "./compose.js";
import { MetricsCollector } from "./metrics.js";
import { renderReport } from "./report.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const variants = JSON.parse(readFileSync(args.variants, "utf8")) as Variant[];

  const experiment = expandTask(
    { taskId: args.taskId, role: args.role as Role, goal: args.task },
    variants,
  );

  const host = await composeExperiment({
    repoRoot: args.repo,
    experiment,
    query: query as unknown as QueryFn,
    defaultMaxTurns: args.maxTurns,
    defaultPermTimeoutMs: 60_000,
  });

  const collector = new MetricsCollector({
    bus: host.bus,
    ledger: host.ledger,
    git: new NodeGitRunner(),
    repoRoot: args.repo,
    base: host.base,
    variantByNodeId: experiment.variantByNodeId,
    role: experiment.baseRole,
  });

  stdout.write(`experiment: ${variants.length} variants on "${args.task}" (base ${host.base.slice(0, 7)})\n`);
  const result = await host.run();

  const rows = await collector.collect();
  const { markdown, json } = renderReport(rows, { taskGoal: args.task, modelId: args.model });
  writeFileSync(args.report, markdown);
  writeFileSync(args.report.replace(/\.md$/, ".json"), json);

  stdout.write(`\nrun: ${result.status}\n`);
  for (const r of [...rows].sort((a, b) => a.costUsd - b.costUsd)) {
    stdout.write(`  ${r.variant}: ${r.status} · $${r.costUsd.toFixed(4)} · ${r.turns} turns · ${r.branch}\n`);
  }
  stdout.write(`report → ${args.report}\n`);
}

main().catch((err) => {
  stdout.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Build + full package test**

Run: `npm run build -w @agent-team/host-experiment` then `npm run test -w @agent-team/host-experiment`
Expected: build exit 0 (`dist/cli.js` exists); all green.

- [ ] **Step 7: Commit**

```bash
git add packages/host-experiment/src/cli-args.ts packages/host-experiment/src/cli.ts packages/host-experiment/tests/cli-args.test.ts
git commit -m "feat(host-experiment): agent-team-experiment CLI (TDD on arg parsing)"
```

---

### Task 8: LIVE-SMOKE doc + workspace gate

**Files:**
- Create: `packages/host-experiment/LIVE-SMOKE.md`

- [ ] **Step 1: Create `packages/host-experiment/LIVE-SMOKE.md`**

```markdown
# host-experiment live smoke (manual, NOT CI)

Prereqs: `npm run build`; Claude Code CLI OAuth creds (`~/.claude/.credentials.json`);
a THROWAWAY git repo with at least one commit (not OS-sandboxed — B1 caveat).

1. Throwaway repo:
   `git init -b main /tmp/hx && cd /tmp/hx && echo seed > seed.txt && git add . && git commit -m base`
2. `variants.json`:
   `[{"name":"haiku","model":"claude-haiku-4-5-20251001"},{"name":"sonnet","model":"claude-sonnet-4-6"}]`
3. Run:
   `node packages/host-experiment/dist/cli.js --task "create fizzbuzz.py printing 1..20" --task-id fizz --variants variants.json --repo /tmp/hx --report /tmp/hx/report.md`
4. VERIFY:
   - [ ] both variants run; the printed table shows per-variant cost / turns / status / branch
   - [ ] `git -C /tmp/hx branch` lists `agentteam/coder-fizz__haiku` and `...__sonnet`, BOTH unmerged
   - [ ] `main` is unchanged (`git -C /tmp/hx rev-parse main` == the base from step 1); NO `agentteam/integration` branch exists
   - [ ] `git -C /tmp/hx show agentteam/coder-fizz__haiku:fizzbuzz.py` shows that variant's output
   - [ ] `/tmp/hx/report.md` (+ `.json`) written, ranked, wall-clock labeled advisory, footer present
5. Validity: confirm the two variants produced INDEPENDENT solutions (neither references the other) —
   they forked from the same frozen base and never saw each other's branch.
```

- [ ] **Step 2: Full workspace gate**

Run: `npm run build`
Expected: exit 0 across all seven packages.

Run: `npm run test`
Expected: ALL suites green; total > 220 (host-experiment adds ~14: variant 3, expand 5, report 3, metrics 1, compose 1, cli-args 3 ≈ 16).

- [ ] **Step 3: Zero-diff-outside check**

Run: `git status --porcelain`
Expected: nothing under `packages/core`, `packages/adapters-*`, `packages/host-headless`, `packages/host-vscode`, `packages/host-web`. Only host-experiment + root `package.json`/`package-lock.json` (committed) + pre-existing untracked stragglers.

- [ ] **Step 4: Commit**

```bash
git add packages/host-experiment/LIVE-SMOKE.md
git commit -m "docs(host-experiment): live smoke checklist"
```

---

## Plan self-review notes (already applied)

- **Wall-clock source:** the spec §5.3 mentioned a host clock; the plan uses bus `event.ts` (BusEvent carries `ts`) — same metric, cleaner, no `Date` call. Documented in `metrics.ts`.
- **No memory recorder:** `composeExperiment` wires only `TextContextProvider` (hydrate-only) and never subscribes a `record` handler — contamination via shared memory is impossible *by construction* (no record path exists), which is stronger than the spec's frozen-snapshot framing.
- **Isolation test (spec §10.4):** rather than a memory-leak test (no recorder to leak), Task 6 asserts the realized isolation — `cheap`'s staged branch lacks `thorough`'s unique file (`b.txt`) while both retain the shared base file (`seed.txt`), proving every variant forked from the frozen base and never saw another's work.
- **Gate policy:** experiments are non-interactive; a real GATE (credential/destructive) default-denies *uniformly* across variants — fair, and file Writes (approval) auto-allow under autopilot.
- **AmbientIntegration creates no integration branch:** the staging-invariant test asserts `agentteam/integration` does NOT exist (distinguishes stage-only from the real coordinator).
- **Wall-clock:** uses bus `event.ts`; advisory by spec §2.4.
```
