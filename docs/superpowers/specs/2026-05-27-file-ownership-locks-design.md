# File-Ownership Locks — Static Write-Claims for Parallel Worktree Writes — Design

**Date:** 2026-05-27
**Status:** Approved design, pre-implementation-plan
**Extends:** [S2 — Parallel Worktree Isolation + Task-DAG Scheduling](./2026-05-26-s2-parallel-worktree-dag-design.md) (approved, pre-implementation). This is **Approach A — static write-ownership**. It folds into the S2 implementation; it is not a separate subsystem.

---

## 1. Goal & intent

When S2 agents write **directly in their own worktrees in parallel** (S2 §2), two agents editing the *same file* produce divergent branches that collide at the serial integration merge. The merge already catches this (a `merge_conflict` `action_request`, S2 §4.5), but a caught conflict is still rework: a human resolves it or an agent is re-dispatched.

This design **avoids that class of conflict before it happens** by giving each task node a declared set of files it owns, and refusing to co-dispatch two nodes whose owned-file sets overlap. It is the file-level analogue of S2's guiding line — *"merges are ordered topologically so most conflicts are avoided rather than resolved"* (S2 §1) — extended from declared `dependsOn` edges to runtime-discovered write overlaps.

**Non-goal:** this is not a hard mutual-exclusion guarantee against *all* same-file writes (an agent can still write a file it never declared). It is best-effort *avoidance* of declared overlaps, backed by S2's existing merge as the *guaranteed catch* for anything that slips through. The two layers together leave no gap.

## 2. The core insight: a write-overlap *is* a dependency edge

S2 already serializes two tasks safely. A dependent node's worktree is **cut from the integration tip that already contains its prerequisite's merged changes** (S2 §4.2), so the dependent edits the up-to-date file and merges clean.

A file-ownership lock is exactly that relationship, discovered dynamically instead of declared statically:

```
If node A and node B both write src/foo.ts, and neither statically dependsOn
the other, then at runtime B must be treated as if it dependsOn A:

  - do NOT co-dispatch A and B
  - run one (say A), let it merge into integration
  - cut the other (B) from the integration tip that now contains A's foo.ts
  - B edits A's version → clean merge

  lock(path) ≡ implicit dependency edge ≡ "cut the loser from the winner's merged tip"
```

This is why the lock needs **no new runtime protocol, no mutex held across agent turns, and no cross-process coordination**: it reuses the merge-inheritance mechanism S2 already builds for declared dependencies. The only new behavior is in *scheduling* — choosing not to start the second writer yet.

## 3. Architecture

All changes are in `packages/core/src`, layered on the S2 units. No new ports, no git access beyond what S2 already has.

```
┌─ packages/core/src ───────────────────────────────────────────┐
│  task-graph.ts     Node gains optional `writes: string[]`;     │
│                    paths normalized at construction            │
│                                                                │
│  write-claims.ts   WriteClaims (NEW): pure, synchronous        │
│                    in-memory claim table over normalized       │
│                    paths. canDispatch / acquire / release.     │
│                                                                │
│  orchestrator.ts   Scheduler: dispatch candidate =            │
│                    ready(completed) AND claims.canDispatch;    │
│                    acquire on dispatch; release on             │
│                    MERGE-complete (not on `done`)              │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 `Node` gains `writes?: string[]` (`task-graph.ts`)

Each node declares the repo-relative file paths it intends to own:

```ts
// S2: Node = { id: string; role: Role; goal: string; dependsOn: string[] }
// extended:
type Node = {
  id: string;
  role: Role;
  goal: string;
  dependsOn: string[];
  writes?: string[]; // repo-relative paths this node owns; default []
};
```

- **Default `[]` = "I claim nothing."** A node with no declared writes never blocks and is never blocked by the claim table. This is the correct default for read-only roles (reviewer, ops) and for nodes whose file set genuinely is not known up front — those fall through to the merge-conflict safety net (§6) rather than over-serializing.
- **Paths are normalized at TaskGraph construction**, once, into a canonical form: repo-relative, forward-slash separators, no leading `./`, no `..` segments. This is load-bearing for correctness — `src/a.ts`, `src\a.ts` (Windows), and `./src/a.ts` must compare equal, or the overlap check silently misses and the lock gives a *false* sense of safety with no error raised. Normalization is a pure function shared with the WriteClaims comparison so both sides agree.

### 3.2 Exact paths, not globs (this iteration)

`writes` holds **exact file paths**, not globs. Overlap is then plain set intersection — O(n), provably correct, trivially testable. Glob intersection (does `src/**/*.ts` overlap `src/foo.*`?) is genuinely hard to compute correctly, and a wrong answer is a *silent missed lock*. Globs are deferred until there's a demonstrated need; the merge-conflict safety net covers the gap in the meantime.

### 3.3 `WriteClaims` — new pure unit (`write-claims.ts`)

A small, synchronous, in-memory unit mirroring the existing small-unit style of `DiffStore` / `PolicyStore`. No git, no async, no I/O.

```ts
class WriteClaims {
  private held = new Map<string /* normalizedPath */, string /* nodeId */>();

  /** True iff none of the node's declared writes is currently claimed by another node. */
  canDispatch(node: Node): boolean;

  /** Record this node as owner of each of its declared writes. Precondition: canDispatch(node). */
  acquire(node: Node): void;

  /** Drop all claims held by this node. Called when the node's branch has MERGED. */
  release(node: Node): void;
}
```

- `acquire` is **all-or-nothing**: it is only ever called after `canDispatch` returned true for the node's *entire* `writes` set. There is no partial acquisition, no "hold one path and wait for another."
- A node re-acquiring is not a scenario (each node dispatches once); `acquire` may assert its precondition for safety.

### 3.4 Scheduler gating (`orchestrator.ts`)

The only behavioral change to the S2 Scheduler loop:

1. **Dispatch candidate** = `graph.ready(completed)` **AND** `claims.canDispatch(node)`. A node that is dependency-ready but write-blocked simply waits for the next scheduling pass.
2. **On dispatch** → `claims.acquire(node)` (immediately before creating the worktree / spawning the adapter).
3. **On node merge-complete** → `claims.release(node)`. See §4 — the release point is a correctness requirement, not a free choice.
4. **Deterministic tie-break.** When several co-ready nodes overlap on a path, dispatch the one that sorts first by (topological order, then node id). This makes runs reproducible and makes the "which writer wins" question testable.

### 3.5 TaskGraph stays pure — rejected alternative

`TaskGraph` does **not** learn about "running" nodes or claims; it remains the pure data structure S2 specifies (`ready/complete/isDone/topologicalOrder`, no async, no git). All claim arbitration lives in the Scheduler + `WriteClaims`.

**Considered and rejected:** computing write-overlaps at TaskGraph construction and inserting *implicit `dependsOn` edges* to serialize overlappers statically. Rejected because:
- It can create **cycles** with existing edges (if `A→B` already exists and they also overlap, the only conflict-free overlap edge would be `B→A`, which cycles).
- It **over-serializes**: two overlapping nodes that, at runtime, never happen to be ready at the same moment would still be forced into a fixed order.
- It **mutates the pure DAG**, breaking the clean S2 boundary.

Dynamic scheduler gating serializes overlappers **only when they are actually co-ready**, cannot cycle, and leaves `TaskGraph` untouched.

## 4. Claim lifetime: release on MERGE, not on `done` (correctness)

Claims are held from **dispatch** until the node's branch is **merged into integration** — i.e. released at `graph.complete(id)` / the merge-complete step, **not** when the agent emits `done`.

Why this is forced, not chosen: if a claim released at `done` (before the serial merge lands), an overlapping node could be dispatched and start writing `foo.ts` in its own worktree while the first node's branch is still unmerged. Both branches would then carry independent edits to `foo.ts` → the exact merge conflict this design exists to prevent. Holding the claim until merge guarantees the next writer's worktree is **cut from a tip that already contains the first node's `foo.ts`**, reproducing the safe dependent-node path from §2.

So: claim lifetime = node lifetime, and a node's lifetime (for scheduling purposes) ends at merge, consistent with how S2 unlocks dependents only after a prerequisite merges (S2 §4.5).

## 5. Why this is deadlock-free

Because claims are acquired **all-or-nothing at dispatch** — a node only dispatches when its *entire* `writes` set is free — there is never a "hold one path, wait for another" state. No hold-and-wait ⇒ no deadlock, ever. This is the structural advantage of expressing the lock as scheduling rather than as a runtime mutex.

**Liveness / no starvation:** in a finite DAG with serialized merges that release claims, every running node eventually completes and frees its claims, and topological progress is guaranteed, so any write-blocked node eventually becomes dispatchable. The deterministic tie-break (§3.4) ensures a stable order among contenders rather than indefinite deferral of one of them.

## 6. Safety net for undeclared writes

Static ownership is **best-effort avoidance**, not a hard guarantee: an agent can still write a file it did not list in `writes`. That case is not a gap, because S2's serial integration merge catches **any** real same-file divergence as a `merge_conflict` `action_request` routed through the Action Broker (S2 §4.5). Therefore:

- **Declared overlaps** → *avoided* (the two writers never run concurrently).
- **Undeclared overlaps** → *caught* (resolved via the existing GATE/ROUTE merge-conflict flow).

Two layers, no gap.

**Optional future enhancement (out of scope here):** after a node's work, compare `git diff --name-only` in its worktree against the declared `writes` and warn on under-declaration, to tighten declarations over time. Not needed for correctness — the merge already catches the harmful case — so it is deliberately excluded from this iteration.

## 7. Testing (extends the S2 test plan)

- **WriteClaims (pure unit):**
  - disjoint write-sets → both `canDispatch` true; after `acquire` of one, the disjoint other is still dispatchable.
  - overlapping write-sets → after `acquire` of one, the overlapping other has `canDispatch` false; after `release`, true again.
  - empty `writes` → always `canDispatch` true, never blocks others.
  - path-normalization equivalence: `src\a.ts`, `src/a.ts`, and `./src/a.ts` are treated as the same claim.
- **Scheduler (real temp repo + FakeAdapters):**
  - two dependency-independent nodes both declaring `writes: ["src/foo.ts"]` → they run **sequentially**: the second dispatches only after the first merges, and the second node's worktree base **already contains** the first's committed `foo.ts`, so its merge is clean. (Contrast: the existing S2 test where two nodes editing *different* files run truly in parallel.)
  - deterministic tie-break: two co-ready overlapping nodes dispatch in the asserted (topological, id) order.
  - undeclared-overlap path still surfaces a `merge_conflict` action_request (i.e. the safety net is exercised, confirming the lock does not suppress it).

## 8. Out of scope

- **Glob / pattern ownership** — exact paths only this iteration (§3.2).
- **Directory-prefix ownership** (claiming `src/feature/` as a unit) — possible later extension; exact paths cover the immediate need.
- **Under-declaration audit** (`git diff --name-only` vs `writes`) — optional enhancement (§6), excluded.
- **Where `writes` comes from in real (lead-produced) runs** vs headless (supplied) — inherits S2 §9; this design takes `writes` as node input alongside `dependsOn`.
- Everything already out of scope for S2 (§7) remains so.

## 9. Open items for planning

- Whether `acquire`'s all-or-nothing precondition should `throw` on violation (defensive) or be a silent no-op contract guaranteed by the Scheduler — settle when wiring the Scheduler call sites.
- Exact home of the path-normalization helper (shared between `task-graph.ts` construction and `write-claims.ts` comparison) — likely a tiny shared util so both sides cannot drift.
- Whether the deterministic tie-break key is the node's index in `topologicalOrder()` or a precomputed rank — settle against the Scheduler's existing ready-set iteration.
