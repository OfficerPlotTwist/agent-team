# File-Ownership Locks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each task-DAG node a declared set of files it owns, and never co-dispatch two nodes whose owned-file sets overlap — so parallel worktree agents avoid the file-collision class of merge conflict before it happens.

**Architecture:** Three pieces. (1) A pure `normalizePath` util so every path comparison is canonical (Windows `\`, `./`, `..`, `//` all collapse). (2) `TaskNode` gains `writes?: string[]`, normalized at `TaskGraph` construction. (3) A pure, synchronous `WriteClaims` table (`canDispatch`/`acquire`/`release`) the Scheduler consults: a node dispatches only when its *entire* declared write-set is free; claims are held until the node's branch **merges** (not when it emits `done`). A write-overlap is thus an implicit dependency edge resolved by S2's existing merge-inheritance; all-or-nothing acquisition makes it deadlock-free; undeclared overlaps fall through to S2's existing `merge_conflict` safety net.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, the existing `packages/core` engine.

**Design source:** `docs/superpowers/specs/2026-05-27-file-ownership-locks-design.md`

---

## ⚠️ Sequencing note — read before starting

The S2 DAG **Scheduler does not exist yet**. `packages/core/src/orchestrator.ts` is still the S1 fixed-team loop (`run(goal, team)`); the S2 `run(graph, adapterFor)` DAG-execution loop (spec S2 §4) is unimplemented, even though `task-graph.ts`, `worktree.ts`, `context-provider.ts`, and `git.ts` exist and are unit-tested.

Consequence:

- **Tasks 1–3 (Phase 1) are buildable and fully testable right now.** They are pure units with pure tests and stand alone — this plan produces working, tested software on its own from Phase 1.
- **Task 4 (Phase 2 — Scheduler gating) is BLOCKED on the S2 DAG Scheduler.** It is documented here with the exact gating code and integration test so it drops in cleanly the moment the Scheduler lands. **Do not attempt Task 4 until `orchestrator.ts` has the DAG `run(graph, adapterFor)` loop.** Implement Tasks 1–3 now; leave Task 4's checkboxes unchecked and revisit it during the S2 Scheduler work.

**Working directory for all commands:** `packages/core/` (i.e. `vsCode Fork/packages/core` from the repo root). `npx vitest run` and `git` both resolve correctly from there.

---

## File Structure

| File | Responsibility | Status |
|------|----------------|--------|
| `packages/core/src/paths.ts` | `normalizePath(p)` — canonical repo-relative, forward-slash path. Shared by TaskGraph + WriteClaims so they cannot drift. | **Create** (Task 1) |
| `packages/core/tests/paths.test.ts` | Unit tests for `normalizePath`. | **Create** (Task 1) |
| `packages/core/src/task-graph.ts` | `TaskNode` gains `writes?: string[]`; constructor normalizes writes + defaults to `[]`. | **Modify** (Task 2) |
| `packages/core/tests/task-graph.test.ts` | Add cases for the `writes` field. | **Modify** (Task 2) |
| `packages/core/src/write-claims.ts` | `WriteClaims` — pure claim table: `canDispatch`/`acquire`/`release`. | **Create** (Task 3) |
| `packages/core/tests/write-claims.test.ts` | Unit tests for `WriteClaims`. | **Create** (Task 3) |
| `packages/core/src/orchestrator.ts` | Scheduler gating: dispatch on `ready() ∧ canDispatch`, acquire on dispatch, release on merge. | **Modify** (Task 4 — BLOCKED) |
| `packages/core/tests/scheduler-write-locks.test.ts` | Real-temp-repo test: two overlapping nodes serialize. | **Create** (Task 4 — BLOCKED) |

---

## Phase 1 — Buildable now

### Task 1: `normalizePath` shared util

**Files:**
- Create: `packages/core/src/paths.ts`
- Test: `packages/core/tests/paths.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/paths.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizePath } from "../src/paths.js";

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("src\\a.ts")).toBe("src/a.ts");
  });

  it("strips a leading ./", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
  });

  it("collapses duplicate slashes", () => {
    expect(normalizePath("src//a.ts")).toBe("src/a.ts");
  });

  it("resolves .. segments", () => {
    expect(normalizePath("src/sub/../a.ts")).toBe("src/a.ts");
  });

  it("is idempotent on an already-canonical path", () => {
    expect(normalizePath("src/a.ts")).toBe("src/a.ts");
  });

  it("treats the three Windows/relative spellings as equal", () => {
    const canonical = normalizePath("src/a.ts");
    expect(normalizePath("src\\a.ts")).toBe(canonical);
    expect(normalizePath("./src/a.ts")).toBe(canonical);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/paths.test.ts`
Expected: FAIL — `Failed to resolve import "../src/paths.js"` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/paths.ts`:

```ts
/**
 * Canonicalize a repo-relative path so two spellings of the same file compare
 * equal: forward slashes, no leading "./", no "." or duplicate-slash segments,
 * ".." resolved. Idempotent. Declared file ownership ("writes") is normalized
 * through this so a Windows "src\a.ts" and a "src/a.ts" claim the same lock.
 */
export function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/paths.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "feat(core): normalizePath util for canonical path comparison"
```

---

### Task 2: `TaskNode.writes` field, normalized at construction

**Files:**
- Modify: `packages/core/src/task-graph.ts:3-28`
- Test: `packages/core/tests/task-graph.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/tests/task-graph.test.ts`:

```ts
describe("TaskGraph write-ownership", () => {
  it("normalizes a node's declared writes at construction", () => {
    const g = new TaskGraph([
      { id: "a", role: "coder", goal: "do a", dependsOn: [], writes: ["src\\a.ts", "./src/b.ts"] },
    ]);
    expect(g.ready()[0].writes).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("defaults writes to [] when omitted", () => {
    const g = new TaskGraph([{ id: "a", role: "coder", goal: "do a", dependsOn: [] }]);
    expect(g.ready()[0].writes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/task-graph.test.ts`
Expected: FAIL — the first new test gets `undefined` (or the un-normalized array) for `.writes`; the second gets `undefined` instead of `[]`.

- [ ] **Step 3: Add `writes` to the interface and normalize in the constructor**

In `packages/core/src/task-graph.ts`, change the import line and the `TaskNode` interface:

```ts
import type { Role } from "./events.js";
import { normalizePath } from "./paths.js";

export interface TaskNode {
  id: string;
  role: Role;
  goal: string;
  dependsOn: string[];
  /** Repo-relative file paths this node owns; default []. Normalized at construction. */
  writes?: string[];
}
```

Then in the constructor, replace the node-storing loop so each stored node carries a normalized, defaulted `writes` array. Change:

```ts
    for (const node of nodes) {
      if (this.nodes.has(node.id)) throw new Error(`Duplicate task id: ${node.id}`);
      this.nodes.set(node.id, node);
    }
```

to:

```ts
    for (const node of nodes) {
      if (this.nodes.has(node.id)) throw new Error(`Duplicate task id: ${node.id}`);
      this.nodes.set(node.id, { ...node, writes: (node.writes ?? []).map(normalizePath) });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/task-graph.test.ts`
Expected: PASS — the two new tests plus all pre-existing TaskGraph tests (the `n()` helper's nodes now carry `writes: []`, which no existing assertion contradicts).

- [ ] **Step 5: Commit**

```bash
git add src/task-graph.ts tests/task-graph.test.ts
git commit -m "feat(core): TaskNode.writes — declared file ownership, normalized at construction"
```

---

### Task 3: `WriteClaims` claim table

**Files:**
- Create: `packages/core/src/write-claims.ts`
- Test: `packages/core/tests/write-claims.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/write-claims.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { WriteClaims } from "../src/write-claims.js";
import type { TaskNode } from "../src/task-graph.js";

const node = (id: string, writes: string[] = []): TaskNode => ({
  id, role: "coder", goal: `do ${id}`, dependsOn: [], writes,
});

describe("WriteClaims", () => {
  it("lets disjoint write-sets both dispatch and coexist", () => {
    const claims = new WriteClaims();
    const a = node("a", ["src/a.ts"]);
    const b = node("b", ["src/b.ts"]);
    expect(claims.canDispatch(a)).toBe(true);
    claims.acquire(a);
    expect(claims.canDispatch(b)).toBe(true);
  });

  it("blocks an overlapping node until the holder releases", () => {
    const claims = new WriteClaims();
    const a = node("a", ["src/shared.ts"]);
    const b = node("b", ["src/shared.ts"]);
    claims.acquire(a);
    expect(claims.canDispatch(b)).toBe(false);
    claims.release(a);
    expect(claims.canDispatch(b)).toBe(true);
  });

  it("never blocks a node that claims nothing", () => {
    const claims = new WriteClaims();
    claims.acquire(node("a", ["src/x.ts"]));
    expect(claims.canDispatch(node("reader"))).toBe(true);
    claims.acquire(node("reader")); // no-op, must not throw
    expect(claims.canDispatch(node("b", ["src/y.ts"]))).toBe(true);
  });

  it("treats different spellings of the same path as one claim", () => {
    const claims = new WriteClaims();
    claims.acquire(node("a", ["src/a.ts"]));
    expect(claims.canDispatch(node("b", ["src\\a.ts"]))).toBe(false);
    expect(claims.canDispatch(node("c", ["./src/a.ts"]))).toBe(false);
  });

  it("does not let a node block itself", () => {
    const claims = new WriteClaims();
    const a = node("a", ["src/a.ts"]);
    claims.acquire(a);
    expect(claims.canDispatch(a)).toBe(true);
  });

  it("throws if acquire is called when a path is already held by another node", () => {
    const claims = new WriteClaims();
    claims.acquire(node("a", ["src/a.ts"]));
    expect(() => claims.acquire(node("b", ["src/a.ts"]))).toThrow(/held by a/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/write-claims.test.ts`
Expected: FAIL — `Failed to resolve import "../src/write-claims.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/core/src/write-claims.ts`:

```ts
import type { TaskNode } from "./task-graph.js";
import { normalizePath } from "./paths.js";

/**
 * In-memory file-ownership table. A node may dispatch only when its entire
 * declared write-set is free (all-or-nothing — so there is no hold-and-wait
 * and therefore no deadlock). Claims are held from dispatch until the node's
 * branch MERGES, so the next writer of a path is cut from a tip that already
 * contains the previous writer's version. Pure and synchronous: no git, no I/O.
 */
export class WriteClaims {
  private readonly held = new Map<string, string>(); // normalizedPath -> nodeId

  /** True iff none of the node's declared writes is held by a different node. */
  canDispatch(node: TaskNode): boolean {
    for (const w of node.writes ?? []) {
      const owner = this.held.get(normalizePath(w));
      if (owner !== undefined && owner !== node.id) return false;
    }
    return true;
  }

  /** Record this node as owner of each of its declared writes. */
  acquire(node: TaskNode): void {
    for (const w of node.writes ?? []) {
      const p = normalizePath(w);
      const owner = this.held.get(p);
      if (owner !== undefined && owner !== node.id) {
        throw new Error(`Cannot acquire ${p} for ${node.id}: held by ${owner}`);
      }
      this.held.set(p, node.id);
    }
  }

  /** Drop every claim this node holds. Call when the node's branch has merged. */
  release(node: TaskNode): void {
    for (const w of node.writes ?? []) {
      const p = normalizePath(w);
      if (this.held.get(p) === node.id) this.held.delete(p);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/write-claims.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the whole core suite to confirm nothing regressed**

Run: `npx vitest run`
Expected: PASS — all suites green, including the unchanged S1/S2 unit tests.

- [ ] **Step 6: Commit**

```bash
git add src/write-claims.ts tests/write-claims.test.ts
git commit -m "feat(core): WriteClaims — deadlock-free per-node file-ownership table"
```

---

## Phase 2 — BLOCKED on the S2 DAG Scheduler

### Task 4: Scheduler gating + integration test

> **BLOCKED:** Do not start until `packages/core/src/orchestrator.ts` contains the S2 DAG-execution loop (`run(graph: TaskGraph, adapterFor)` per S2 §4) that selects `graph.ready()` nodes, creates worktrees, and merges on `done`. The code below targets that loop's shape; adapt names to the final Scheduler if they differ, but keep the three gating rules and the release-on-merge timing exactly.

**Files:**
- Modify: `packages/core/src/orchestrator.ts` (the S2 DAG run loop — exact lines TBD by the Scheduler implementation)
- Create: `packages/core/tests/scheduler-write-locks.test.ts`

- [ ] **Step 1: Construct the Scheduler with a `WriteClaims` instance**

In the S2 Scheduler, instantiate one `WriteClaims` per run (alongside the `completed`/worktree bookkeeping):

```ts
import { WriteClaims } from "./write-claims.js";
// ...
const claims = new WriteClaims();
```

- [ ] **Step 2: Gate dispatch — `ready() ∧ canDispatch`, acquire on dispatch**

Where the loop picks nodes to start from `graph.ready()`, filter by the claim table and acquire before spawning. The deterministic tie-break (spec §3.4) is the `topologicalOrder()` rank so two co-ready overlappers start in a stable order:

```ts
const rank = new Map(graph.topologicalOrder().map((nd, i) => [nd.id, i]));
const dispatchable = graph
  .ready()
  .filter((nd) => claims.canDispatch(nd))
  .sort((x, y) => rank.get(x.id)! - rank.get(y.id)!);

for (const nd of dispatchable) {
  // Re-check inside the loop: an earlier acquire this pass may now block nd
  // (two ready nodes that overlap each other).
  if (!claims.canDispatch(nd)) continue;
  claims.acquire(nd);
  graph.start(nd.id);
  // ... existing worktree-create + adapter-spawn for nd ...
}
```

- [ ] **Step 3: Release on MERGE-complete (not on `done`)**

At the point where a node's branch has been merged into integration and the Scheduler calls `graph.complete(nd.id)` (S2 §4.5 clean-merge path), release its claims so its file paths unlock for the next writer:

```ts
graph.complete(nd.id);
claims.release(nd);
// ... existing unlock-dependents / loop-to-reschedule ...
```

Do **not** release at the `done` event — releasing before the merge lands would let an overlapping node start editing the same file on an un-updated base, recreating the conflict (design §4).

- [ ] **Step 4: Write the integration test**

Create `packages/core/tests/scheduler-write-locks.test.ts`. Mirror the existing S2 scheduler/integration tests for harness setup (`NodeGitRunner`, temp repo, `FakeAdapter`s that write a file then emit `done`). Pattern:

```ts
import { describe, it, expect } from "vitest";
// import the S2 Scheduler entrypoint + helpers exactly as the existing
// scheduler/integration tests do (NodeGitRunner, temp-repo helper, a
// FakeAdapter that writes `writes[0]` and emits done). See
// tests/integration.test.ts / tests/worktree-integration.test.ts.

describe("Scheduler file-ownership locking", () => {
  it("serializes two dependency-independent nodes that declare the same write", async () => {
    // GRAPH: a and b, no dependsOn between them, BOTH writes: ["src/shared.ts"].
    // Each FakeAdapter appends a distinct line to src/shared.ts then emits done.
    //
    // ASSERT:
    //  - the two nodes did NOT run concurrently (capture dispatch order /
    //    timestamps via the bus or adapter start hooks; assert the second
    //    started only after the first's merge completed),
    //  - the final integrated src/shared.ts contains BOTH lines (the second
    //    node's worktree was cut from the tip already holding the first's
    //    edit) and the run completed with NO merge_conflict action_request.
    expect(true).toBe(true); // replace with the assertions above once wired
  });

  it("runs two nodes editing DIFFERENT files truly in parallel", async () => {
    // GRAPH: a writes ["src/a.ts"], b writes ["src/b.ts"], no deps.
    // ASSERT both are dispatched in the same scheduling pass (overlapping
    // in-flight) and both merge clean. This is the contrast case proving the
    // lock only serializes on actual overlap.
    expect(true).toBe(true);
  });
});
```

Replace the `expect(true)` placeholders with the concrete assertions described in the comments, using the same observation hooks the existing scheduler tests use (do not invent a new mechanism).

- [ ] **Step 5: Run the integration test**

Run: `npx vitest run tests/scheduler-write-locks.test.ts`
Expected: PASS — overlapping nodes serialize with a clean combined file and no conflict; disjoint nodes run in parallel and merge clean.

- [ ] **Step 6: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — all suites green.

- [ ] **Step 7: Export `WriteClaims` (and the other S2 units) from `index.ts`**

When the Scheduler lands, the S2 units become public. Add to `packages/core/src/index.ts`, grouped with the other S2 exports being introduced by the Scheduler work:

```ts
export * from "./task-graph.js";
export * from "./write-claims.js";
```

(Only add lines not already present — the Scheduler PR may export some of these already.)

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator.ts src/index.ts tests/scheduler-write-locks.test.ts
git commit -m "feat(core): gate Scheduler dispatch on file-ownership write-claims"
```

---

## Self-Review (completed against the design spec)

- **Spec coverage:** §3.1 `writes` + normalization → Task 2; §3.2 exact paths → inherent (no glob code); §3.3 `WriteClaims` canDispatch/acquire/release → Task 3; §3.4 Scheduler gating + deterministic tie-break → Task 4 Steps 2; §3.5 TaskGraph stays pure → respected (no "running" state added to TaskGraph; arbitration lives in Scheduler + WriteClaims); §4 release-on-merge → Task 4 Step 3 (with the rationale called out); §5 deadlock-free → enforced by all-or-nothing `acquire` (Task 3) + the in-pass re-check (Task 4 Step 2); §6 safety net → Task 4 Step 4 second assertion (no `merge_conflict` on the locked path; the undeclared-overlap path remains S2's existing flow, unchanged); §7 testing → Tasks 1–4 tests; path-normalization equivalence → Task 1 + Task 3.
- **Placeholder scan:** the only placeholders are the two `expect(true)` lines in Task 4's test, which are explicitly BLOCKED on the not-yet-existing Scheduler and harness; the surrounding comments specify the exact graph, edits, and assertions to write against the existing test helpers. All Phase 1 steps contain complete, runnable code.
- **Type consistency:** `normalizePath` (Task 1) is imported identically by `task-graph.ts` (Task 2) and `write-claims.ts` (Task 3). `WriteClaims` method names — `canDispatch`/`acquire`/`release` — are consistent across the unit, its tests, and the Scheduler call sites. `TaskNode.writes?: string[]` is the single shared shape used by the graph and the claim table.
