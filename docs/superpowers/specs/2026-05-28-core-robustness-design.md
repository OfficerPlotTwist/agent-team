# Core Robustness Pass — Per-Node Budgets + Honest Completion — Design

**Goal:** Fix two orchestrator correctness gaps the B2 live smokes exposed, so parallel runs don't silently drop work or mis-report it. First `@agent-team/core` change since S2. A behavior fix *within* the `Scheduler` — same classes, interfaces, DI seams, and `ScheduleResult` shape; only *which* nodes land in `completed` vs `blocked` (and when interrupts fire) changes.

**Spec for prior milestone:** `docs/superpowers/specs/2026-05-28-b2-live-parallel-cost-ceiling-design.md`.

---

## Context — the two gaps (found by B2's live parallel smoke)

In `packages/core/src/orchestrator.ts` (`Scheduler`):

1. **Global turn budget.** `bus.subscribe(() => { this.turns += 1; })` (`:129`) counts *every* event from *every* parallel agent; the run loop breaks when `this.turns >= budget.maxTurns` (`:172`) and interrupts **all** in-flight adapters (`:182-184`). With N agents, the shared budget exhausts mid-run and interrupts agents that are mid-task. Observed live: 2 nodes at `maxTurns 6` → one agent interrupted before committing.

2. **False completion.** `runNode` (`:144-169`) always calls `integration.integrate(...)` after `startTask` returns; if the merge reports `merged` it calls `graph.complete(node.id)`. An interrupted (or error-emitting) node returns **without committing**, so its branch is empty, the no-op merge **succeeds**, and the node is marked `completed`. Net: dropped work reported as success; `ScheduleResult.blocked` never sees it.

These compound: Gap 1 causes spurious interrupts; Gap 2 then reports the interrupted node as `completed` with its work lost.

## Fix 1 — per-node turn budget

`maxTurns` becomes a **per-agent** budget, not a global event counter.

- Maintain `turnsByAgent: Map<AgentId, number>`. The bus subscriber increments `turnsByAgent[event.from]` per event.
- When a node's own count reaches `maxTurns`, interrupt **only that node's adapter** (looked up via an agentId→adapter map maintained in `runNode`) and record it as budget-interrupted. Other agents are unaffected.
- Remove the global `this.turns >= maxTurns` loop-break. Loop exit is already covered by: `graph.isDone()` (complete), `inflight.size === 0` with graph not done (blocked), and `stop()` (manual halt). Total work stays bounded: ≤ `maxTurns × nodeCount` over a finite graph.
- **Rejected:** keeping an additional global cap on top — reintroduces the cross-agent coupling we're removing, and the finite graph already bounds total work.

**Run status:** keep the existing `ScheduleStatus` vocabulary. Track a `budgetHit` flag set when any node is budget-interrupted. Final status precedence: `complete` (graph done) → `stopped` (stop() called) → `budget` (a node hit its per-agent cap) → `blocked` (other non-completion). The `budget` status now means "a node exceeded its own turn budget" rather than "the whole run did".

## Fix 2 — gate completion on a real `done`

A node counts as completed only if its adapter actually emitted a `done` terminal event.

- Track terminal outcomes from the bus: `done` → mark the agentId succeeded; `error` → mark it errored.
- In `runNode`, after `startTask` returns:
  - **emitted `done`** → `integration.integrate(...)`; if `merged` → `graph.complete`, else `failed`.
  - **no `done`** (errored, or interrupted with no terminal) → `failed` (lands in `blocked`); **skip** the empty/partial integrate entirely.
- This is correct for read-only tasks: `ClaudeAdapter` emits `done "(no changes)"` for a no-change run, which still counts as `done` → completed. The signal is "did the agent finish", not "did the merge change anything".
- **Rejected:** detecting no-op merges as failure — would wrongly fail legitimate no-change tasks.

**Note (work recovery is out of scope):** Fix 2 makes *reporting* honest; it does not recover an interrupted node's uncommitted changes (the worktree is reclaimed in `finally`). With Fix 1, interrupts now fire only when a node genuinely exceeds its own budget — a legitimate failure that *should* report as `blocked`. Commit-on-interrupt is a possible future enhancement, deliberately not included (YAGNI).

## Bonus — this makes B2's cost-ceiling reporting honest

`BudgetExceededAdapter` emits `error` and never `done`, so under Fix 2 a budget-refused node now correctly lands in `blocked`, not `completed`. As part of this pass:
- Update `packages/host-headless/tests/cost-ceiling.test.ts` to assert the refused node is in `result.blocked` (not `completed`).
- Revert the B2 spec's "reporting caveat" and the `LIVE-SMOKE-PARALLEL.md` cost-ceiling `completed`-caveat to state the now-correct `blocked` behavior.
- Update the `LIVE-SMOKE-PARALLEL.md` "maxTurns is a GLOBAL event budget" section to describe the new per-agent semantics.

## Error handling / edge cases
- A node that emits `done` but whose merge conflicts → `failed` (unchanged behavior).
- A node interrupted *after* emitting `done` but before `startTask` returns: it emitted `done`, so it integrates — acceptable (it finished its work; the interrupt was a late global signal, now rare under per-node budgets).
- `stop()` mid-run still interrupts all adapters; interrupted nodes without `done` → `blocked` (now honest).
- Empty graph / single node: unchanged.

## Testing (TDD)
**New orchestrator tests (`packages/core/tests/`):**
- *Per-node budget isolation:* two parallel nodes; one emits many events (exceeds its `maxTurns`) and is interrupted, the other (well-behaved) still completes and merges. Asserts the healthy sibling is unaffected — the regression the live smoke caught.
- *Honest completion:* a node whose adapter emits `error` (or is interrupted with no `done`) lands in `result.blocked`, not `completed`, and its (empty) branch is **not** merged into integration; a node that emits `done "(no changes)"` still counts as `completed`.

**Regression:** run the existing **68 core tests**; update any that assert the old global-budget or empty-merge-completion semantics to the corrected behavior, documenting each change. Update the B2 cost-ceiling test (assert `blocked`). Full workspace `npm run build` + `npm run test` green.

## File structure (locked)
```
packages/core/
  src/orchestrator.ts                 MODIFY  per-node turns + done-gated completion
  tests/<orchestrator|scheduler>.test.ts  MODIFY/CREATE  new isolation + honest-completion tests; update old-semantics asserts
packages/host-headless/
  tests/cost-ceiling.test.ts          MODIFY  refused node now asserts blocked
  LIVE-SMOKE-PARALLEL.md              MODIFY  per-agent budget + blocked reporting
docs/superpowers/specs/2026-05-28-b2-live-parallel-cost-ceiling-design.md  MODIFY  revert reporting caveat to blocked
```

---
Generated by claude-opus-4-8 · task completed
