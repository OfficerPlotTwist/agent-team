# B2 — Live Parallel Team + Team Cost Ceiling — Design

**Goal:** Validate the existing parallel Scheduler with *multiple real Claude agents* running concurrently in isolated worktrees (B1 proved only N=1 live), and add a **team cost ceiling** that caps spend using the already-keyed `CostLedger`. No architecture change: core (`@agent-team/core`) is untouched; all new behavior lives in the host (`@agent-team/host-headless`).

**Non-goals (explicitly deferred to B3):** wiring the broker's `ROUTE`/`NOTIFY` peer-collaboration paths (still host no-ops), lead-driven dynamic decomposition, and the merge-conflict re-resolution loop. B2 hardens the parallel foundation and adds a budget safety rail — nothing more.

**Spec for B1 (prior milestone):** `docs/superpowers/specs/2026-05-27-plan-b1-claude-adapter-design.md`.

---

## Context — what already exists

- `Scheduler.run(adapterFor)` already executes a `TaskGraph` DAG, runs independent nodes in parallel over per-node git worktrees, and merges each completed node to `agentteam/integration` via `IntegrationCoordinator` (offline two-node test passes; B1 live smoke proved one node end-to-end against the real SDK).
- `CostLedger` (`@agent-team/adapters-claude`) accumulates per-agent USD; `ClaudeAdapter` calls `ledger.add(agentId, costUsd)` on a successful result. It was built for this milestone — its doc comment reads "B1 reports; B2 enforces a team ceiling against it."
- `composeHeadless` owns the `CostLedger` and supplies `adapterFor(node)` — the per-node dispatch hook the Scheduler calls as each node becomes runnable. This is the seam B2 uses.

## Architecture decision — enforce at the host, at node-dispatch granularity

The ceiling is checked in the host's `adapterFor(node)`, **before** a real adapter is created for that node.

- *Rejected — scheduler-level gate:* would make core depend on cost/ledger. Architecture change. No.
- *Rejected — bridge-level mid-run denial:* the SDK reports `total_cost_usd` only in the terminal `result` message, so there is no incremental cost signal to enforce against mid-run. Not feasible cleanly.
- *Chosen — host-level `adapterFor` gate:* `compose` already owns the ledger and the factory. No core change, fully testable offline.

**Best-effort boundary (documented, not hidden):** enforcement is at *node-dispatch* granularity. Independent nodes that start in the same parallel wave both begin before either's cost lands in the ledger, so the first wave can exceed the ceiling. The ceiling reliably gates nodes dispatched *after* prior costs are recorded (i.e. dependent/downstream nodes, and later waves). For strict pre-spend bounding, model work as a dependency chain. This boundary is stated in code comments, the live-smoke doc, and `ScheduleResult` semantics.

---

## Components (all in `@agent-team/host-headless`)

### 1. `BudgetExceededAdapter` (`src/budget-guard.ts`)
A tiny `AgentAdapter` (`backend = "budget-guard"`) whose `startTask(ctx, emit)` emits a single `error` event (`"team cost ceiling $<ceiling> reached (spent $<total>); skipping <agentId>"`) and returns without calling the SDK. `interrupt()` is a no-op. One clear responsibility: represent a node that was refused for budget reasons, so the Scheduler treats it as failed/blocked without spending.

### 2. `composeHeadless` change (`src/compose.ts`)
- `ComposeOptions` gains `costCeilingUsd?: number` (omitted ⇒ no enforcement, exactly today's behavior).
- `adapterFor(node)`: if `costCeilingUsd != null && ledger.total() >= costCeilingUsd`, return a `BudgetExceededAdapter`; otherwise return the real `ClaudeAdapter` (unchanged). This is the only logic change to compose.

### 3. CLI (`src/cli.ts`)
- `--graph <file.json>`: load a `TaskGraph` from a JSON array of `{ id, role, goal, dependsOn }`. When present it supersedes the single-node `--goal` path (which stays as the default for one-off runs).
- `--cost-ceiling <usd>`: parsed to a number and passed as `costCeilingUsd`.
- The live feed already prints `error` events, so a budget refusal surfaces as `✗ <agentId>: team cost ceiling …`.

### 4. `LIVE-SMOKE-PARALLEL.md`
Manual, real-creds procedure (not CI), analogous to B1's `LIVE-SMOKE.md`:
1. Throwaway repo + `agentteam/integration` branch.
2. A 2-node independent graph (`--graph`) run live → confirm both agents run concurrently in separate worktrees, both `~ file` + `✓ done`, both files on the integration tip, `total cost` ≈ sum, both `agentId`s on the feed.
3. A low-`--cost-ceiling` run on a 2-node **dependency chain** → confirm the downstream node is refused (`✗ … team cost ceiling …`) and never spends.
4. Records any live-only concurrency findings (parallel SDK sessions, `PendingPermissions` keying under real concurrency, cost aggregation) — the same divergence-guard role the B1 smoke played.

---

## Data flow

```
Scheduler → adapterFor(node)
              │  costCeilingUsd set AND ledger.total() ≥ ceiling ?
              ├─ yes → BudgetExceededAdapter.startTask → emit error → (no SDK, no spend)
              │           Scheduler marks node failed → blocked; continues other nodes
              └─ no  → ClaudeAdapter.startTask → SDK loop → events → commit in worktree
                          → ledger.add(agentId, costUsd) on success → IntegrationCoordinator merge
```

The ledger only grows from real adapter successes; the guard only reads `ledger.total()`. No new shared mutable state, no core change.

## Error handling
- `costCeilingUsd` omitted/`undefined` ⇒ no guard (regression-safe default).
- A budget-refused node emits `error` and **does no work** — verified by: `ledger.total()` excludes it (no spend) and its file never reaches the integration tip (no merge of refused work). **Reporting caveat (confirmed against `orchestrator.ts`):** because the guard *emits* an error rather than *throwing* — exactly like `ClaudeAdapter` does on a failed result — `runNode` still performs an empty no-op merge of the untouched worktree, so a refused node lands in `ScheduleResult.completed`, not `blocked`. The authoritative skip signals are the **`team cost ceiling` error event** and the **absent file**, not the `completed`/`blocked` lists. Making error-emitting nodes report as not-completed is a Scheduler change (core) — deliberately out of B2's no-arch-change scope; it folds into the existing deferred item that `blocked` doesn't distinguish "ran and failed" from "never started". B2 does not special-case the budget adapter to throw, because that would make budget-skips report differently from real agent errors.
- `--graph` file missing/malformed ⇒ CLI prints `fatal: …` and exits non-zero (existing CLI error path).

## Testing
**Offline (Vitest, deterministic — `tests/cost-ceiling.test.ts`):**
- *Ceiling hit:* 2-node chain `b dependsOn a`; fake `query` makes `a` cost 0.05; `costCeilingUsd: 0.04`. Assert: `a` completes and merges; `b` emits the budget error and never runs (no file_change for b); `ledger.total()` ≈ 0.05; `result.completed == ["a"]`, `result.blocked` includes `"b"`.
- *Under ceiling (regression):* same graph, `costCeilingUsd: 1.0` ⇒ both complete and merge, ledger ≈ sum.
- *No ceiling (regression):* `costCeilingUsd` omitted ⇒ identical to current two-node behavior.
- `BudgetExceededAdapter` unit test: `startTask` emits exactly one `error`, makes no git/SDK calls, `interrupt()` is a no-op.

**Live (manual):** `LIVE-SMOKE-PARALLEL.md` as above. Not in CI (costs real tokens).

**Gate:** full workspace `npm run build` + `npm run test` green; `packages/core/src` unchanged (same zero-core-rework proof as B1).

## File structure (locked)
```
packages/host-headless/
  src/
    budget-guard.ts        CREATE  BudgetExceededAdapter
    compose.ts             MODIFY  costCeilingUsd option + adapterFor guard
    cli.ts                 MODIFY  --graph <file.json> + --cost-ceiling <usd>
  tests/
    cost-ceiling.test.ts   CREATE  ceiling-hit / under-ceiling / no-ceiling / guard unit
  LIVE-SMOKE-PARALLEL.md   CREATE  manual parallel + ceiling procedure
```

---
Generated by claude-opus-4-8 · task completed
