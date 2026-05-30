# Core Robustness Pass — Per-Node Budgets + Honest Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two `Scheduler` correctness gaps the B2 live smoke exposed — a global turn budget that interrupts healthy parallel agents, and interrupted/errored nodes that false-report as `completed` — without changing the architecture.

**Architecture:** Both fixes live in `packages/core/src/orchestrator.ts` (`Scheduler` only — NOT the S1 `Orchestrator`). Fix 2: track which agents emitted a `done` event and only `integrate`+`graph.complete` a node that emitted `done` (else it's `failed`/blocked, skipping the empty no-op merge). Fix 1: count turns per `agentId` and interrupt only the offending node, dropping the global counter. `ScheduleResult` shape is unchanged; only which nodes land in `completed` vs `blocked` (and when interrupts fire) changes. Bonus: this makes B2's `BudgetExceededAdapter` (emits `error`, no `done`) correctly report as `blocked`, so the B2 cost-ceiling test/spec/smoke-doc caveats revert to `blocked`.

**Tech Stack:** TypeScript ESM (NodeNext), Vitest, real-git temp repos via `tests/helpers/` (`WritingAdapter`, `makeTempRepo`, `cleanupRepos`).

**Spec:** `docs/superpowers/specs/2026-05-28-core-robustness-design.md`

---

## Confirmed current behavior (from reading the code — do not deviate)

`Scheduler.run` (`orchestrator.ts` ~123-201):
- `const off = bus.subscribe(() => { this.turns += 1; });` — global turn counter.
- `runNode`: `create worktree → adapterFor → startTask → const outcome = await integration.integrate(agentId, wt.branch); if (outcome.status === "merged") graph.complete(node.id); else failed.add(node.id);` wrapped in `try/catch(failed.add + publish error)/finally(remove worktree, delete maps, wake)`.
- Loop: `while (!graph.isDone()) { if (this.stopped || this.turns >= budget.maxTurns) break; for ready → start/inflight; if (inflight.size === 0) break; await tick; }`.
- After loop: `if (this.stopped || this.turns >= budget.maxTurns) for (a of adapters.values()) a.interrupt();`
- Status: `graph.isDone() ? "complete" : this.stopped ? "stopped" : this.turns >= budget.maxTurns ? "budget" : "blocked"`.
- `agentId = \`${node.role}#${node.id}\``; events carry `from` = that agentId.
- `WritingAdapter` writes+commits files then emits `{kind:"done",from:agentId}`; on interrupt returns WITHOUT `done`. `AgentEvent` done = `{kind:"done",from,summary}`.

**Conventions:** git root `C:\Users\nik\Documents\AI`; `vsCode Fork/` gitignored ⇒ new files need `git add -f`; NEVER `git add -A`/`.`/`-u`. Commit trailer (blank line then) `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Run core vitest from `packages/core/`.

---

### Task 1: Fix 2 — gate completion on a real `done` event (TDD)

**Files:**
- Modify: `packages/core/src/orchestrator.ts`
- Test: `packages/core/tests/scheduler-completion.test.ts` (CREATE)

- [ ] **Step 1: Write the failing test** — `packages/core/tests/scheduler-completion.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { Scheduler } from "../src/orchestrator.js";
import { MessageBus } from "../src/bus.js";
import { WorktreeManager } from "../src/worktree.js";
import { IntegrationCoordinator } from "../src/integration.js";
import { NoopContextProvider } from "../src/context-provider.js";
import { TaskGraph, type TaskNode } from "../src/task-graph.js";
import type { AgentAdapter, TaskContext, Emit } from "../src/adapter.js";
import { WritingAdapter } from "./helpers/writing-adapter.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";
import { NodeGitRunner } from "../src/node/git-runner.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

afterEach(async () => { await cleanupRepos(); });
const node = (id: string, dependsOn: string[] = []): TaskNode => ({ id, role: "coder", goal: id, dependsOn });

// Commits a file into the worktree but emits `error` instead of `done` — models a
// node that did partial work then failed/refused. Must NOT count as completed.
class NoDoneAdapter implements AgentAdapter {
  readonly backend = "no-done";
  private git = new NodeGitRunner();
  constructor(private file: string) {}
  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    await writeFile(join(ctx.cwd as string, this.file), "X");
    await this.git.run(["add", this.file], ctx.cwd as string);
    await this.git.run(["commit", "-m", "partial"], ctx.cwd as string);
    emit({ kind: "error", from: ctx.agentId, message: "refused" });
  }
  interrupt(): void {}
}

describe("Scheduler honest completion (gate on done)", () => {
  it("a node that does not emit done is blocked and its work is not merged", async () => {
    const { dir, git } = await makeTempRepo();
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const graph = new TaskGraph([node("ok"), node("bad")]);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) =>
      n.id === "ok" ? new WritingAdapter({ "ok.txt": "ok" }) : new NoDoneAdapter("bad.txt"),
    );

    expect(result.completed).toEqual(["ok"]);
    expect(result.blocked).toEqual(["bad"]);
    const intg = `${dir}/.worktrees/integration`;
    expect(existsSync(join(intg, "ok.txt"))).toBe(true);
    expect(existsSync(join(intg, "bad.txt"))).toBe(false); // partial work NOT merged
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `packages/core/`): `npx vitest run tests/scheduler-completion.test.ts`
Expected: FAIL — `bad` currently lands in `completed` (its commit merges) instead of `blocked`.

- [ ] **Step 3: Implement Fix 2 in `orchestrator.ts`**

(a) Add a done-tracking set and record it in the bus subscription. Replace:
```ts
    const off = bus.subscribe(() => { this.turns += 1; });
```
with:
```ts
    const doneAgents = new Set<string>();
    const off = bus.subscribe((e) => {
      this.turns += 1;
      if (e.kind === "done") doneAgents.add(e.from);
    });
```

(b) In `runNode`, replace the integrate/complete block:
```ts
        const outcome = await integration.integrate(agentId, wt.branch);
        if (outcome.status === "merged") graph.complete(node.id);
        else failed.add(node.id);
```
with:
```ts
        // Only a node that actually emitted `done` may merge + complete. An
        // interrupted or error-emitting node (no `done`) is failed — we do NOT
        // merge its (empty/partial) branch and do NOT mark it completed.
        if (doneAgents.has(agentId)) {
          const outcome = await integration.integrate(agentId, wt.branch);
          if (outcome.status === "merged") graph.complete(node.id);
          else failed.add(node.id);
        } else {
          failed.add(node.id);
        }
```

- [ ] **Step 4: Run to verify it passes**

Run (from `packages/core/`): `npx vitest run tests/scheduler-completion.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole core suite (catch regressions early)**

Run (from `packages/core/`): `npx vitest run`
Expected: all PASS. (`WritingAdapter` emits `done`, so existing completion tests still complete. `ThrowingAdapter`/`HangingAdapter` never emitted `done` and were already `blocked`/`stopped`.) If anything fails, STOP and report which test + why before continuing.

- [ ] **Step 6: Commit**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/packages/core/src/orchestrator.ts" "vsCode Fork/packages/core/tests/scheduler-completion.test.ts"
git commit -m "$(printf 'fix(core): gate node completion on a real done event\n\nInterrupted/error-emitting nodes (no done) are now blocked, not falsely\ncompleted via an empty no-op merge; their branch is not merged. WritingAdapter\nand ClaudeAdapter emit done so success paths are unchanged.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: Fix 1 — per-node turn budget (TDD)

**Files:**
- Modify: `packages/core/src/orchestrator.ts`
- Test: `packages/core/tests/scheduler-budget.test.ts` (CREATE)
- Modify: `packages/core/tests/scheduler.test.ts` (update the global-budget test)

- [ ] **Step 1: Write the failing test** — `packages/core/tests/scheduler-budget.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { Scheduler } from "../src/orchestrator.js";
import { MessageBus } from "../src/bus.js";
import { WorktreeManager } from "../src/worktree.js";
import { IntegrationCoordinator } from "../src/integration.js";
import { NoopContextProvider } from "../src/context-provider.js";
import { TaskGraph, type TaskNode } from "../src/task-graph.js";
import type { AgentAdapter, TaskContext, Emit } from "../src/adapter.js";
import { WritingAdapter } from "./helpers/writing-adapter.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";
import { NodeGitRunner } from "../src/node/git-runner.js";

afterEach(async () => { await cleanupRepos(); });
const node = (id: string, dependsOn: string[] = []): TaskNode => ({ id, role: "coder", goal: id, dependsOn });

// Emits `chatter` message events BEFORE doing its committable work + done. With a
// per-node budget below `chatter`, it is interrupted (no done) -> blocked, WITHOUT
// affecting a well-behaved sibling. interrupt() makes it stop before done.
class ChattyAdapter implements AgentAdapter {
  readonly backend = "chatty";
  private interrupted = false;
  private git = new NodeGitRunner();
  constructor(private chatter: number, private file: string) {}
  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.interrupted = false;
    for (let i = 0; i < this.chatter; i++) {
      if (this.interrupted) return;
      emit({ kind: "message", from: ctx.agentId, to: "all", text: `tick ${i}` });
      await new Promise((r) => setTimeout(r, 5)); // let the bus + interrupt land
    }
    if (this.interrupted) return;
    await writeFile(join(ctx.cwd as string, this.file), "C");
    await this.git.run(["add", this.file], ctx.cwd as string);
    await this.git.run(["commit", "-m", "chatty"], ctx.cwd as string);
    emit({ kind: "done", from: ctx.agentId, summary: "chatty done" });
  }
  interrupt(): void { this.interrupted = true; }
}

describe("Scheduler per-node turn budget", () => {
  it("interrupts only the node that exceeds its own budget; a healthy sibling completes", async () => {
    const { dir, git } = await makeTempRepo();
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const graph = new TaskGraph([node("chatty"), node("calm")]); // independent => parallel
    // maxTurns 5: "chatty" emits 50 messages (exceeds 5) -> interrupted -> blocked.
    // "calm" emits only its single `done` (1 event) -> completes.
    const sched = new Scheduler({ bus, budget: { maxTurns: 5 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) =>
      n.id === "chatty" ? new ChattyAdapter(50, "chatty.txt") : new WritingAdapter({ "calm.txt": "calm" }),
    );

    expect(result.completed).toContain("calm");      // sibling unaffected by chatty's events
    expect(result.completed).not.toContain("chatty");
    expect(result.blocked).toContain("chatty");
    expect(result.status).toBe("budget");
    const intg = `${dir}/.worktrees/integration`;
    expect(existsSync(join(intg, "calm.txt"))).toBe(true);
    expect(existsSync(join(intg, "chatty.txt"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `packages/core/`): `npx vitest run tests/scheduler-budget.test.ts`
Expected: FAIL — under the global counter, `chatty`'s 50 events blow the global budget and interrupt BOTH nodes (`calm` would also be interrupted/blocked), and/or status differs.

- [ ] **Step 3: Implement Fix 1 in `orchestrator.ts`**

(a) Remove the global turn field. Delete the line `private turns = 0;` from the `Scheduler` class, and delete `this.turns = 0;` from the top of `run()`.

(b) Add per-agent budget state at the top of `run()` (after `this.stopped = false;`):
```ts
    const turnsByAgent = new Map<string, number>();
    const adapterByAgent = new Map<string, AgentAdapter>();
    let budgetHit = false;
```

(c) Update the bus subscription (the one from Task 1) to count per-agent and interrupt only the offender. Replace:
```ts
    const doneAgents = new Set<string>();
    const off = bus.subscribe((e) => {
      this.turns += 1;
      if (e.kind === "done") doneAgents.add(e.from);
    });
```
with:
```ts
    const doneAgents = new Set<string>();
    const off = bus.subscribe((e) => {
      if (e.kind === "done") doneAgents.add(e.from);
      const n = (turnsByAgent.get(e.from) ?? 0) + 1;
      turnsByAgent.set(e.from, n);
      if (n >= budget.maxTurns) {
        const a = adapterByAgent.get(e.from);
        if (a) { budgetHit = true; a.interrupt(); }
      }
    });
```

(d) Register the adapter by agentId in `runNode`. After `adapters.set(node.id, adapter);` add:
```ts
        adapterByAgent.set(agentId, adapter);
```
and in the `finally` block, after `adapters.delete(node.id);` add:
```ts
        adapterByAgent.delete(`${node.role}#${node.id}`);
```

(e) Drop the global budget from the loop break. Replace:
```ts
      if (this.stopped || this.turns >= budget.maxTurns) break;
```
with:
```ts
      if (this.stopped) break;
```

(f) Drop the global budget from the post-loop interrupt-all. Replace:
```ts
    if (this.stopped || this.turns >= budget.maxTurns) {
      for (const a of adapters.values()) a.interrupt();
    }
```
with:
```ts
    if (this.stopped) {
      for (const a of adapters.values()) a.interrupt();
    }
```

(g) Update the status computation. Replace:
```ts
    const status: ScheduleStatus = graph.isDone()
      ? "complete"
      : this.stopped
        ? "stopped"
        : this.turns >= budget.maxTurns
          ? "budget"
          : "blocked";
```
with:
```ts
    const status: ScheduleStatus = graph.isDone()
      ? "complete"
      : this.stopped
        ? "stopped"
        : budgetHit
          ? "budget"
          : "blocked";
```

- [ ] **Step 4: Run to verify it passes**

Run (from `packages/core/`): `npx vitest run tests/scheduler-budget.test.ts`
Expected: PASS — `calm` completes, `chatty` blocked, status `budget`.

- [ ] **Step 5: Update the old global-budget test in `scheduler.test.ts`**

The existing test `"stops early when the turn budget is exhausted"` asserts the OLD global semantics (3 nodes, `maxTurns: 1`, expects the run to stop before finishing). Under per-node budgets, each node's single `done` event (WritingAdapter writes/commits silently then emits one `done`) does not pre-empt its own work, so all three complete. Replace that whole `it(...)` block with:

```ts
  it("a per-node turn budget interrupts only the over-budget node", async () => {
    const { dir, git } = await makeTempRepo();
    const graph = new TaskGraph([node("a"), node("b"), node("c")]);
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    // maxTurns 1000: each WritingAdapter emits a single `done` — well under budget,
    // so all three complete. (Per-node budget no longer couples siblings.)
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });
    const result = await sched.run((n) => new WritingAdapter({ [`${n.id}.txt`]: n.id }));
    expect(result.status).toBe("complete");
    expect(result.completed.sort()).toEqual(["a", "b", "c"]);
  });
```

- [ ] **Step 6: Run the whole core suite**

Run (from `packages/core/`): `npx vitest run`
Expected: all PASS (68 baseline + the 2 new tests, with the one test replaced). If any fail, STOP and report.

- [ ] **Step 7: Build core**

Run (from `vsCode Fork/`): `npm run build -w @agent-team/core` → exit 0.

- [ ] **Step 8: Commit**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/packages/core/src/orchestrator.ts" "vsCode Fork/packages/core/tests/scheduler-budget.test.ts" "vsCode Fork/packages/core/tests/scheduler.test.ts"
git commit -m "$(printf 'fix(core): per-node turn budget instead of a shared global counter\n\nTurns are counted per agentId; only the over-budget node is interrupted, so a\nchatty agent no longer starves healthy parallel siblings. Drops the global\nthis.turns break; status budget now means a node hit its own cap.\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: Make B2 cost-ceiling reporting honest (revert the caveats)

**Files:**
- Modify: `packages/host-headless/tests/cost-ceiling.test.ts`
- Modify: `packages/host-headless/LIVE-SMOKE-PARALLEL.md`
- Modify: `docs/superpowers/specs/2026-05-28-b2-live-parallel-cost-ceiling-design.md`

Now that an `error`-emitting node (no `done`) is `blocked`, `BudgetExceededAdapter` refusals report correctly.

- [ ] **Step 1: Update the cost-ceiling test assertions**

In `packages/host-headless/tests/cost-ceiling.test.ts`, the "refuses the downstream node" test currently asserts `expect(result.completed).toContain("b")` (the old caveat). Change the two completion-list assertions for `b` to:
```ts
    expect(result.completed).not.toContain("b");
    expect(result.blocked).toContain("b");
```
Keep all the budget invariants (`ledger.total()` ≈ 0.05, `beta.txt` absent, the `team cost ceiling` error event) unchanged. The other two tests (under-ceiling / no-ceiling, both nodes complete) are unchanged.

- [ ] **Step 2: Run the host-headless suite**

Run (from `vsCode Fork/`): `npm run build -w @agent-team/core && npm run build -w @agent-team/adapters-claude` then (from `packages/host-headless/`) `npx vitest run`
Expected: all PASS (the refused node is now `blocked`).

- [ ] **Step 3: Revert the docs caveats**

In `LIVE-SMOKE-PARALLEL.md`, section 2 step 4: replace the "NOTE: `b` may still appear in the final `completed:` line … known Scheduler reporting limitation …" sentence with:
```
   `b` correctly appears in the final `blocked:` line (it emitted no `done`), not `completed`.
```
Also in the "maxTurns is a GLOBAL event budget" section, replace "increments on **every bus event across ALL parallel agents**" wording and the silent-loss paragraph with the per-node reality:
```
## maxTurns is a per-agent turn budget
`--max-turns` is now counted per agent: only a node that exceeds its OWN budget is
interrupted (and reported in `blocked`); healthy siblings are unaffected. Still set it
generously (≥ ~25/node) so real agents have room to finish; 50 is safe for these smokes.
```

In `docs/superpowers/specs/2026-05-28-b2-live-parallel-cost-ceiling-design.md`, in the error-handling bullet that currently says the refused node lands in `completed` (the "Reporting caveat" text), replace it with:
```
- A budget-refused node emits `error` and **does no work** (no spend; its file never reaches the integration tip). Since the core robustness pass (2026-05-28) gates completion on a real `done` event, a refused node correctly reports in `ScheduleResult.blocked`.
```

- [ ] **Step 4: Commit**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/packages/host-headless/tests/cost-ceiling.test.ts" "vsCode Fork/packages/host-headless/LIVE-SMOKE-PARALLEL.md" "vsCode Fork/docs/superpowers/specs/2026-05-28-b2-live-parallel-cost-ceiling-design.md"
git commit -m "$(printf 'fix(host-headless): cost-ceiling refusal now reports blocked (core gate landed)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: Full workspace build + test gate

**Files:** none (verification + optional final commit)

- [ ] **Step 1: Clean build**

Run (from `vsCode Fork/`): `npm run build` → exit 0 (core → adapters-claude → host-headless).

- [ ] **Step 2: Full suite**

Run (from `vsCode Fork/`): `npm run test`
Expected: all PASS — core (68 + 2 new = 70, one test replaced so net 70), adapters-claude (27), host-headless (8). Report the real core total.

- [ ] **Step 3: Confirm the change is core-scoped + host doc/test only**

Run (from `C:\Users\nik\Documents\AI`): `git --no-pager diff --stat <Task1-commit>~1 HEAD -- "vsCode Fork/packages"`
Expected: only `packages/core/src/orchestrator.ts`, the new/updated core tests, and `packages/host-headless/tests/cost-ceiling.test.ts` + `LIVE-SMOKE-PARALLEL.md`. No changes to `adapters-claude/src`, `host-headless/src`, or `core/src` beyond `orchestrator.ts`.

- [ ] **Step 4: Final lockfile commit (only if dirty)**

```bash
cd "/c/Users/nik/Documents/AI"
git add -f "vsCode Fork/package-lock.json"
git commit -m "$(printf 'build(core-robustness): finalize lockfile\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')" || echo "nothing to commit"
```

---

## Self-Review

**1. Spec coverage:** Fix 1 per-node budget → Task 2. Fix 2 done-gated completion → Task 1. Status `budget`=per-node via `budgetHit` → Task 2(g). B2 reporting bonus → Task 3. Keep 68 core green → Task 1 Step 5, Task 2 Step 6. Full gate + scope proof → Task 4. ✓

**2. Placeholder scan:** No TBD/"add error handling"/"similar to". All code shown. ✓

**3. Type consistency:** `doneAgents: Set<string>` keyed by `e.from` (agentId), checked via `doneAgents.has(agentId)` where `agentId = \`${node.role}#${node.id}\`` — same string space. `adapterByAgent` keyed/deleted by the same `${node.role}#${node.id}`. `budgetHit` declared in `run()` scope, set in the subscriber closure, read in status. `this.turns` fully removed (field + reset + 3 uses: loop break, interrupt-all, status). `ScheduleStatus` values unchanged (`complete|budget|stopped|blocked`). New test adapters implement `AgentAdapter` (`backend`/`startTask`/`interrupt`). ✓

---
Generated by claude-opus-4-8 · task completed
