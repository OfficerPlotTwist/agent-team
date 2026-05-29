# B2 — Live Parallel Team + Cost Ceiling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a host-enforced team cost ceiling (capping spend via the existing `CostLedger`) and the multi-node CLI + live-smoke needed to drive and validate the parallel Scheduler with real agents — with zero `@agent-team/core` changes.

**Architecture:** All work is in `@agent-team/host-headless`. A new `BudgetExceededAdapter` (implements core's `AgentAdapter`) is returned by the host's `adapterFor(node)` when `ledger.total()` has reached a configured ceiling, refusing the node without calling the SDK (no spend). The CLI gains `--graph <file.json>` (drive N>1 nodes) and `--cost-ceiling <usd>`. A manual `LIVE-SMOKE-PARALLEL.md` validates the parallel path live. Enforcement is best-effort at node-dispatch granularity (the first parallel wave can overshoot; downstream/later nodes are reliably gated).

**Tech Stack:** TypeScript ESM (NodeNext), Vitest, `@anthropic-ai/claude-agent-sdk@0.3.154`, npm workspaces, git worktrees via `NodeGitRunner`.

**Spec:** `docs/superpowers/specs/2026-05-28-b2-live-parallel-cost-ceiling-design.md`

---

## File structure (locked)

```
packages/host-headless/
  src/
    budget-guard.ts        CREATE  BudgetExceededAdapter (AgentAdapter)
    compose.ts             MODIFY  + costCeilingUsd option; adapterFor guard; widen return type
    cli.ts                 MODIFY  + --graph <file.json>, --cost-ceiling <usd>
  tests/
    budget-guard.test.ts   CREATE  unit: emits one budget error, no-op interrupt
    cost-ceiling.test.ts   CREATE  offline integration: ceiling-hit / under / none
  LIVE-SMOKE-PARALLEL.md   CREATE  manual parallel + ceiling procedure
```

**Conventions (same as B1):**
- The git repo root is `C:\Users\nik\Documents\AI`; `vsCode Fork/` is gitignored, so NEW files need `git add -f`. **NEVER `git add -A`/`.`/`-u`** — only the exact listed paths.
- Commit messages end with a blank line then: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Build order is enforced (core → adapters-claude → host-headless); core + adapters-claude are already built. Run host-headless vitest from `packages/host-headless/`.
- ESM `.js` import specifiers for local TS sources (NodeNext) — correct, do not change to `.ts`.

**Confirmed core API (do not deviate; if reality differs, STOP and report):**
- `AgentAdapter` = `{ readonly backend: string; startTask(ctx: TaskContext, emit: Emit): Promise<void>; interrupt(): void }`.
- `TaskContext` = `{ goal, role, agentId, cwd?, branch? }`; `Emit = (e: AgentEvent) => void`; error event = `{ kind: "error", from, message }`.
- `Scheduler.run(adapterFor: (node: TaskNode) => AgentAdapter)`; `TaskGraph` ctor takes `TaskNode[]` where `TaskNode = { id, role, goal, dependsOn }`.
- `CostLedger` (from `@agent-team/adapters-claude`) exposes `add(agentId, usd)`, `total(): number`, `perAgent(): Map`.

---

### Task 1: `BudgetExceededAdapter` (TDD)

**Files:**
- Create: `packages/host-headless/src/budget-guard.ts`
- Test: `packages/host-headless/tests/budget-guard.test.ts`

- [ ] **Step 1: Write the failing test** — `packages/host-headless/tests/budget-guard.test.ts`

```ts
import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@agent-team/core";
import { BudgetExceededAdapter } from "../src/budget-guard.js";

describe("BudgetExceededAdapter", () => {
  it("emits exactly one budget error naming the agent, no other events", async () => {
    const adapter = new BudgetExceededAdapter(0.5, 0.6);
    const events: AgentEvent[] = [];
    await adapter.startTask(
      { goal: "x", role: "coder", agentId: "coder#a", cwd: "/tmp/x", branch: "b" },
      (e) => events.push(e),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("error");
    expect(events[0].kind === "error" && events[0].message).toContain("team cost ceiling");
    expect(events[0].kind === "error" && events[0].message).toContain("coder#a");
  });

  it("backend is budget-guard and interrupt() is a no-op", () => {
    const adapter = new BudgetExceededAdapter(1, 2);
    expect(adapter.backend).toBe("budget-guard");
    expect(() => adapter.interrupt()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `packages/host-headless/`): `npx vitest run tests/budget-guard.test.ts`
Expected: FAIL — cannot find module `../src/budget-guard.js`.

- [ ] **Step 3: Write the implementation** — `packages/host-headless/src/budget-guard.ts`

```ts
import type { AgentAdapter, TaskContext, Emit } from "@agent-team/core";

/**
 * Returned by the host when the team cost ceiling has been reached. Refuses the
 * node WITHOUT calling the SDK (no spend), emitting a single error so the
 * Scheduler treats the node as failed. interrupt() is a no-op (nothing runs).
 */
export class BudgetExceededAdapter implements AgentAdapter {
  readonly backend = "budget-guard";

  constructor(
    private readonly ceilingUsd: number,
    private readonly spentUsd: number,
  ) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    emit({
      kind: "error",
      from: ctx.agentId,
      message: `team cost ceiling $${this.ceilingUsd.toFixed(4)} reached (spent $${this.spentUsd.toFixed(4)}); skipping ${ctx.agentId}`,
    });
  }

  interrupt(): void {}
}
```

- [ ] **Step 4: Run to verify it passes**

Run (from `packages/host-headless/`): `npx vitest run tests/budget-guard.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/packages/host-headless/src/budget-guard.ts" "vsCode Fork/packages/host-headless/tests/budget-guard.test.ts"
git commit -m "$(printf 'feat(host-headless): BudgetExceededAdapter — refuse a node with no spend\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Wire the cost-ceiling guard into `compose.ts`

**Files:**
- Modify: `packages/host-headless/src/compose.ts`

(No standalone test — exercised by Task 3's integration test. Typecheck only here.)

- [ ] **Step 1: Add the `AgentAdapter` type import + the `BudgetExceededAdapter` import**

In `compose.ts`, add `AgentAdapter` to the existing `import type { ... } from "@agent-team/core";` block (the one that currently imports `TaskGraph, TaskNode, GitRunner, BusEvent, ActionRequestEvent, AgentId, Role, BrokerHandlers`). Then add a new import after the adapters-claude import:

```ts
import { BudgetExceededAdapter } from "./budget-guard.js";
```

- [ ] **Step 2: Add `costCeilingUsd?` to `ComposeOptions`**

Add this field to the `ComposeOptions` interface (after `permTimeoutMs`):

```ts
  /** Optional team budget cap (USD). When ledger.total() reaches it, further nodes
   *  are refused (no spend) at dispatch time. Omitted ⇒ no enforcement. Best-effort:
   *  nodes already running in the same parallel wave are not clawed back. */
  costCeilingUsd?: number;
```

- [ ] **Step 3: Replace `adapterFor` with the guarded version**

Replace the existing `adapterFor` const (currently `const adapterFor = (_node: TaskNode): ClaudeAdapter => new ClaudeAdapter({...});`) with:

```ts
  const adapterFor = (_node: TaskNode): AgentAdapter => {
    if (opts.costCeilingUsd != null && ledger.total() >= opts.costCeilingUsd) {
      return new BudgetExceededAdapter(opts.costCeilingUsd, ledger.total());
    }
    return new ClaudeAdapter({
      query: opts.query,
      git,
      pending,
      ledger,
      model: opts.model,
      maxTurns: opts.maxTurns,
      permTimeoutMs: opts.permTimeoutMs,
    });
  };
```

- [ ] **Step 4: Typecheck (core + adapters-claude already built)**

Run (from `vsCode Fork/`): `npm run typecheck -w @agent-team/host-headless`
Expected: exit 0. (If `AgentAdapter` is not exported from `@agent-team/core`, STOP and report — it is defined in `packages/core/src/adapter.ts` and re-exported via the barrel.)

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/packages/host-headless/src/compose.ts"
git commit -m "$(printf 'feat(host-headless): cost-ceiling guard in adapterFor (host-only, no core change)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Offline cost-ceiling integration test

**Files:**
- Create: `packages/host-headless/tests/cost-ceiling.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/host-headless/tests/cost-ceiling.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskGraph } from "@agent-team/core";
import type { AgentEvent } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeHeadless } from "../src/compose.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

// Fake SDK: each node writes <alpha|beta>.txt into its worktree and costs 0.05.
const query: QueryFn = async function* ({ prompt, options }) {
  const file = prompt.includes("alpha") ? "alpha.txt" : "beta.txt";
  yield asMsg({ type: "assistant", message: { content: [{ type: "text", text: `creating ${file}` }] } });
  writeFileSync(join(options.cwd as string, file), `${file}\n`);
  yield asMsg({ type: "result", subtype: "success", is_error: false, result: `made ${file}`, total_cost_usd: 0.05 });
};

// b depends on a, so dispatch is sequential and the ceiling check is deterministic.
const chain = () =>
  new TaskGraph([
    { id: "a", role: "coder", goal: "create alpha", dependsOn: [] },
    { id: "b", role: "coder", goal: "create beta", dependsOn: ["a"] },
  ]);

describe("host-headless cost ceiling (offline)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "b2-ceiling-"));
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "README.md"), "# base\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "base"], repo);
    await git.run(["branch", "agentteam/integration"], repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("refuses the downstream node once the ceiling is reached — no spend, no merge", async () => {
    const host = composeHeadless({
      repoRoot: repo, graph: chain(), query, model: "claude-test",
      maxTurns: 50, permTimeoutMs: 1000, costCeilingUsd: 0.04, // < a's 0.05 cost
    });
    const feed: AgentEvent[] = [];
    host.bus.subscribe((e) => feed.push(e));

    const result = await host.run();

    // a ran and merged; b was refused for budget
    expect(result.completed).toContain("a");
    expect(result.completed).not.toContain("b");
    expect(feed.some((e) => e.kind === "error" && e.message.includes("team cost ceiling"))).toBe(true);
    expect(host.ledger.total()).toBeCloseTo(0.05); // only a spent
    expect((await git.run(["show", "agentteam/integration:alpha.txt"], repo)).code).toBe(0);
    expect((await git.run(["show", "agentteam/integration:beta.txt"], repo)).code).not.toBe(0); // never created
  });

  it("runs both nodes when the ceiling is high enough", async () => {
    const host = composeHeadless({
      repoRoot: repo, graph: chain(), query, model: "claude-test",
      maxTurns: 50, permTimeoutMs: 1000, costCeilingUsd: 1.0,
    });
    const result = await host.run();
    expect(result.completed.sort()).toEqual(["a", "b"]);
    expect(host.ledger.total()).toBeCloseTo(0.10);
    expect((await git.run(["show", "agentteam/integration:beta.txt"], repo)).code).toBe(0);
  });

  it("no ceiling ⇒ both nodes run (regression: omitting the option changes nothing)", async () => {
    const host = composeHeadless({
      repoRoot: repo, graph: chain(), query, model: "claude-test",
      maxTurns: 50, permTimeoutMs: 1000,
    });
    const result = await host.run();
    expect(result.completed.sort()).toEqual(["a", "b"]);
    expect(host.ledger.total()).toBeCloseTo(0.10);
  });
});
```

- [ ] **Step 2: Build deps + run**

Run (from `vsCode Fork/`): `npm run build:core && npm run build -w @agent-team/adapters-claude`
Then (from `packages/host-headless/`): `npx vitest run tests/cost-ceiling.test.ts`
Expected: PASS (3 cases).

> If the ceiling-hit case's `result.completed`/merge assertions surprise you because the Scheduler reports a budget-refused (errored) node differently than expected, DO NOT weaken the budget invariants (`ledger.total()` ≈ 0.05, `beta.txt` absent, a budget-error event present). First confirm the real `ScheduleResult` shape; the certain invariant is **b neither ran nor spent**. Report any `completed`/`blocked` field nuance.

- [ ] **Step 3: Commit**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/packages/host-headless/tests/cost-ceiling.test.ts"
git commit -m "$(printf 'test(host-headless): offline cost-ceiling — refuse downstream node, no spend\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: CLI — `--graph <file.json>` + `--cost-ceiling <usd>`

**Files:**
- Modify: `packages/host-headless/src/cli.ts`

- [ ] **Step 1: Replace the imports + `Args` + `parseArgs`**

At the top of `cli.ts`, change the `node:process` import line to also import `readFileSync`, and add a `TaskNode` type import. Replace the existing `import { TaskGraph } from "@agent-team/core";` line with:

```ts
import { readFileSync } from "node:fs";
import { TaskGraph } from "@agent-team/core";
import type { BusEvent, ActionRequestEvent, TaskNode } from "@agent-team/core";
```
(Remove the now-duplicate `import type { BusEvent, ActionRequestEvent } from "@agent-team/core";` line — fold it into the line above as shown.)

Replace the `Args` interface and `parseArgs` function with:

```ts
interface Args {
  goal?: string;
  graph?: string;
  repo: string;
  model: string;
  maxTurns: number;
  role: string;
  costCeiling?: number;
}

function parseArgs(argv: string[]): Args {
  const getOpt = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const get = (flag: string, def: string): string => getOpt(flag) ?? def;

  const graph = getOpt("--graph");
  const goal = getOpt("--goal");
  if (graph === undefined && goal === undefined) {
    throw new Error("provide --goal <text> or --graph <file.json>");
  }
  const ceilingRaw = getOpt("--cost-ceiling");
  return {
    goal,
    graph,
    repo: get("--repo", process.cwd()),
    model: get("--model", "claude-opus-4-6"),
    maxTurns: Number(get("--max-turns", "50")),
    role: get("--role", "coder"),
    costCeiling: ceilingRaw !== undefined ? Number(ceilingRaw) : undefined,
  };
}
```

- [ ] **Step 2: Build the graph from `--graph` or `--goal`, and pass `costCeilingUsd`**

In `main()`, replace the single-node graph construction:

```ts
  const graph = new TaskGraph([
    { id: "n1", role: args.role as never, goal: args.goal, dependsOn: [] },
  ]);
```

with:

```ts
  const graph = args.graph
    ? new TaskGraph(JSON.parse(readFileSync(args.graph, "utf8")) as TaskNode[])
    : new TaskGraph([{ id: "n1", role: args.role as never, goal: args.goal as string, dependsOn: [] }]);
```

Then in the `composeHeadless({ ... })` call, add `costCeilingUsd: args.costCeiling,` (e.g. right after `permTimeoutMs: 60_000,`).

- [ ] **Step 3: Build the package**

Run (from `vsCode Fork/`): `npm run build -w @agent-team/host-headless`
Expected: exit 0; `packages/host-headless/dist/cli.js` exists.

- [ ] **Step 4: Verify arg-parsing without creds (no API spend)**

Run (from `vsCode Fork/`): `node packages/host-headless/dist/cli.js`
Expected: prints `fatal: Error: provide --goal <text> or --graph <file.json>` and exits non-zero. (Confirms the new required-arg wiring without invoking the SDK. Do NOT pass `--goal`/`--graph` here — that would run a live agent.)

- [ ] **Step 5: Commit**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/packages/host-headless/src/cli.ts"
git commit -m "$(printf 'feat(host-headless): CLI --graph <file.json> + --cost-ceiling <usd>\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: `LIVE-SMOKE-PARALLEL.md`

**Files:**
- Create: `packages/host-headless/LIVE-SMOKE-PARALLEL.md`

- [ ] **Step 1: Write `packages/host-headless/LIVE-SMOKE-PARALLEL.md`**

```markdown
# B2 Live Smoke — Parallel Team + Cost Ceiling (manual — costs real API tokens)

Live analog of the offline two-node + cost-ceiling tests. Run manually after changes
touching the host, adapter, or SDK version. NOT part of CI. Throwaway repo only — B1/B2
are NOT OS-sandboxed.

## Prereqs
- Claude Code CLI auth available (`~/.claude/.credentials.json`) or `ANTHROPIC_API_KEY` set.
- Workspace built: from `vsCode Fork/`: `npm run build`.

## 1. Parallel multi-agent (two independent nodes)
1. Throwaway repo:
   ```sh
   tmp=$(mktemp -d); cd "$tmp" && git init -b main && git config user.email t@t.com && git config user.name T
   printf '# scratch\n' > README.md && git add . && git commit -m base && git branch agentteam/integration
   ```
2. Graph file (two INDEPENDENT nodes ⇒ run concurrently):
   ```sh
   cat > graph.json <<'JSON'
   [
     { "id": "a", "role": "coder",     "goal": "create a file alpha.txt containing the text ALPHA", "dependsOn": [] },
     { "id": "b", "role": "architect", "goal": "create a file beta.txt containing the text BETA",  "dependsOn": [] }
   ]
   JSON
   ```
3. Run:
   ```sh
   node "/c/Users/nik/Documents/AI/vsCode Fork/packages/host-headless/dist/cli.js" --graph "$tmp/graph.json" --repo "$tmp" --max-turns 6
   ```
4. Confirm: both `coder#a` and `architect#b` appear on the feed; each shows a `~ <file>` + `✓ done`;
   `git show agentteam/integration:alpha.txt` and `:beta.txt` both succeed; `total cost` ≈ sum of both;
   `completed: a, b`.

## 2. Cost ceiling (dependency chain so the cap bites deterministically)
1. New throwaway repo (repeat step 1 with a fresh `$tmp`).
2. Chain graph (`b` depends on `a`):
   ```sh
   cat > graph.json <<'JSON'
   [
     { "id": "a", "role": "coder", "goal": "create a file a.txt with the text A", "dependsOn": [] },
     { "id": "b", "role": "coder", "goal": "create a file b.txt with the text B", "dependsOn": ["a"] }
   ]
   JSON
   ```
3. Run with a ceiling BELOW the expected cost of one node (use a tiny number, e.g. 0.01):
   ```sh
   node "/c/Users/nik/Documents/AI/vsCode Fork/packages/host-headless/dist/cli.js" --graph "$tmp/graph.json" --repo "$tmp" --cost-ceiling 0.01 --max-turns 6
   ```
4. Confirm: `a` runs and merges (`:a.txt` present); `b` is refused with `✗ … team cost ceiling $0.0100 reached …`;
   `:b.txt` is ABSENT; `completed` does not include `b`.

## Best-effort note
The ceiling is enforced at node-dispatch time against `ledger.total()`. Two INDEPENDENT nodes
launched in the same parallel wave can both start before either's cost lands, so the first wave
may overshoot the cap. The ceiling reliably gates downstream/later nodes (hence the dependency
chain in test 2). For strict pre-spend bounding, model work as a chain.

## Cleanup
`rm -rf "$tmp"` for each throwaway repo.
```

- [ ] **Step 2: Commit**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/packages/host-headless/LIVE-SMOKE-PARALLEL.md"
git commit -m "$(printf 'docs(host-headless): manual parallel + cost-ceiling live-smoke procedure\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: Full workspace build + test gate + zero-core-rework proof

**Files:** none (verification + optional final commit)

- [ ] **Step 1: Clean build of the whole workspace in order**

Run (from `vsCode Fork/`): `npm run build`
Expected: exit 0 (core → adapters-claude → host-headless).

- [ ] **Step 2: Full test suite**

Run (from `vsCode Fork/`): `npm run test`
Expected: PASS — core (68), adapters-claude (27), host-headless (single-node + two-node + gated-write + budget-guard 2 + cost-ceiling 3). Report the host-headless total (should increase by 5 over B1's 3 suites).

- [ ] **Step 3: Zero-core-rework proof**

Run (from `C:\Users\nik\Documents\AI`): `git --no-pager diff --stat <B2-first-commit>~1 HEAD -- "vsCode Fork/packages/core"`
Expected: EMPTY (no `packages/core` changes in B2 at all). Use the Task-1 commit SHA as `<B2-first-commit>`.

- [ ] **Step 4: Final lockfile commit (only if dirty)**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/package-lock.json"
git commit -m "$(printf 'build(b2): finalize lockfile\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage:**
- Team cost ceiling, host-level `adapterFor` gate, `BudgetExceededAdapter`, `costCeilingUsd` option (spec §Components 1–2) → Tasks 1, 2. ✓
- Best-effort node-dispatch boundary documented (spec §Architecture decision) → comment in Task 2 Step 2, note in Task 3 Step 2, LIVE-SMOKE §Best-effort note. ✓
- Multi-node CLI `--graph` + `--cost-ceiling` (spec §Components 3) → Task 4. ✓
- Offline tests: ceiling-hit / under / none + guard unit (spec §Testing) → Tasks 1, 3. ✓
- Live parallel smoke (spec §Components 4) → Task 5. ✓
- Zero-core-rework gate (spec §Testing) → Task 6 Step 3. ✓

**2. Placeholder scan:** No TBD/"add error handling"/"similar to". Every code step shows full code. ✓

**3. Type consistency:** `BudgetExceededAdapter(ceilingUsd, spentUsd)` ctor matches its use in `compose.ts` Task 2 (`new BudgetExceededAdapter(opts.costCeilingUsd, ledger.total())`). `adapterFor` return type widened to `AgentAdapter` (matches `Scheduler.run` param). `costCeilingUsd` named identically in `ComposeOptions` (Task 2), the test (Task 3), and the CLI pass-through (Task 4, via `args.costCeiling`). `TaskNode`/`TaskGraph` usage matches core. `error` event shape `{kind,from,message}` matches core. ✓

---
Generated by claude-opus-4-8 · task completed
