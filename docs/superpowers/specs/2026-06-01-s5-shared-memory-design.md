# S5 — Shared Memory (closed-loop semantic retrieval) Design

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-06-01
**Supersedes the implementation note in:** `docs/superpowers/specs/best-graph-analysis.md` (backend recommendation; this spec inherits its locked choices and corrects two of its file-placement details — see §9).

---

## 1. Goal

Give the agent team a **shared memory**: each agent's conclusion is recorded into a single embedded vector store, and every later agent automatically receives the top-k most relevant prior conclusions as context, delivered through the existing `ContextProvider.hydrate` seam. The loop is closed in v1 — agents both **record** (on `done`) and **retrieve** (at worktree creation) — so a run benefits from what earlier runs (and earlier sibling nodes) learned, with zero changes to the Scheduler/bus/worktree runtime.

Non-goal for v1: a knowledge *graph*. v1 is flat vector retrieval over a `decisions` table. Graph traversal, temporal bi-validity, and LLM entity extraction remain deferred (§8).

---

## 2. Locked decisions (inherited from `best-graph-analysis.md`, 2026-05-27)

- **Backend:** `sqlite-vec` extension on `better-sqlite3`. Single embedded file, no server, TS-native, Windows→Linux portable. WAL mode (parallel worktree readers + a writer must coexist).
- **Graphiti dropped** (Python-only, per-write LLM tax, embedded Kùzu archived).
- **Injected `Embedder` port** — the provider never picks an embedding model itself; the host injects one. Tests inject a deterministic hash-embedder (no network).
- **v1 = vector retrieval over a flat `decisions` table** + a `vec_decisions` virtual table. No `nodes`/`edges`.

This spec's new contribution over the recommendation doc: **v1 closes the loop** (adds `record()` + host capture wiring), rather than deferring all writing to a later "S5b". The recommendation doc's read-only framing is superseded here per explicit scoping decision (2026-06-01).

---

## 3. Architecture — two ports, one implementation, zero core-runtime change

```
        ┌─────────────────────────────────────────────┐
        │            SqliteVecContextProvider          │
        │   (packages/core/src/node/, @core/node only) │
        │                                              │
  read  │  hydrate(node, worktreePath, …)  ──┐         │
  ◄─────┤                                    ├─ one    │
        │  record(decision)  ────────────────┘  .db    │
  write │                                    (sqlite-vec│
  ◄─────┤                                     + WAL)    │
        └─────────────────────────────────────────────┘
              ▲                         ▲
              │ hydrate                 │ record
   WorktreeManager.create()    host bus-subscriber on `done`
   (Scheduler-driven, S3 seam) (host only — NOT the Scheduler)
```

- **Read port (existing, unchanged):** `ContextProvider.hydrate(node, worktreePath, envelope?, modality?)`. Called by `WorktreeManager.create()` at worktree-creation time, once per node, pre-run. Writes gitignored files into the worktree (never `git add`).
- **Write port (new):** `DecisionRecorder.record(decision)`. A **separate** interface so the read seam stays clean and `NoopContextProvider`/`TextContextProvider` are not forced to implement a no-op write.
- **One implementation** (`SqliteVecContextProvider`) implements **both** ports over a single sqlite-vec database file.
- **Capture is wired in the host, not core.** The Scheduler, bus, worktree, and task-graph are **untouched** (same discipline proved in S3/S4 — `packages/core` orchestrator runtime gets no behavioral edit). The host attaches a bus subscriber that, on each `done` event, correlates the event's `from` (`AgentId`) to its dispatched `TaskNode` and calls `record({ id, role, goal, summary })`.

**Rejected alternatives:**
- Widening `ContextProvider` with `record()` — forces every provider (Noop, Text) to implement a no-op write; pollutes the read seam. Rejected.
- Recording inside the Scheduler — breaks the zero-core-change rule and couples orchestration to persistence. Rejected.

---

## 4. Interfaces

### 4.1 Existing read seam (no change)
```ts
// packages/core/src/context-provider.ts
export interface ContextProvider {
  hydrate(
    node: TaskNode,
    worktreePath: string,
    envelope?: ContextEnvelope,
    modality?: ContextModality,
  ): Promise<void>;
}
```
`SqliteVecContextProvider.hydrate` ignores `envelope`/`modality` (it retrieves by `node.goal`), and `modality` defaults to `"text"`.

### 4.2 New write port
```ts
// packages/core/src/node/decision-recorder.ts  (or co-located with the provider)
export interface RecordedDecision {
  id: string;        // node id
  role: Role;        // node role
  goal: string;      // what the node was asked to do
  summary: string;   // the agent's done-summary (what it concluded/did)
}

export interface DecisionRecorder {
  record(decision: RecordedDecision): Promise<void>;
}
```

### 4.3 Embedder port (injected; locked)
```ts
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  readonly dim: number;
}
```

### 4.4 Provider construction
```ts
new SqliteVecContextProvider({
  dbPath: string,
  embedder: Embedder,
  k?: number,          // default 5
});
```
`SqliteVecContextProvider implements ContextProvider, DecisionRecorder`.

---

## 5. Data model

```sql
-- created on first open if absent; PRAGMA journal_mode=WAL
CREATE TABLE IF NOT EXISTS decisions (
  rowid       INTEGER PRIMARY KEY,   -- aligns with the vec table rowid
  node_id     TEXT NOT NULL,
  role        TEXT NOT NULL,
  goal        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  created_at  TEXT NOT NULL          -- ISO-8601; supplied by the caller/host clock
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_decisions USING vec0(
  embedding float[<dim>]             -- <dim> = embedder.dim, fixed at create
);
```

- **Embedded text:** `goal + "\n" + summary` — captures both the intent and what was learned, so a future node retrieves by similar-intent *and* by relevant outcomes.
- **Append-only** in v1. No upsert/dedup. (Re-recording the same node id across runs yields multiple rows — acceptable; dedup deferred.)
- `created_at` is passed in by the host (the provider does not call the clock itself — keeps the provider deterministic and testable; matches the project's `Date.now`-injection discipline).

---

## 6. Flows

### 6.1 record (write)
1. Host bus-subscriber receives a `done` event (`{ kind:"done", from, summary }`).
2. Host maps `from` → the dispatched `TaskNode` (host owns the graph) and builds `RecordedDecision`.
3. `record()`: `embedder.embed(goal+"\n"+summary)` → `INSERT INTO decisions(...)` → `INSERT INTO vec_decisions(rowid, embedding)` with the same rowid. Synchronous better-sqlite3 write under WAL.

### 6.2 hydrate (read)
1. `WorktreeManager.create()` calls `hydrate(node, worktreePath, …)` after `git worktree add`, before the agent runs.
2. `embedder.embed(node.goal)` → sqlite-vec KNN query (the real API uses `MATCH` + `distance`, not a pgvector operator): `SELECT d.*, distance FROM vec_decisions JOIN decisions d ON d.rowid = vec_decisions.rowid WHERE embedding MATCH :q ORDER BY distance LIMIT :k`.
3. Each hit is written as `<worktreePath>/.agent-team/memory-<node_id>.md` (one file per hit) containing the hit's role/goal/summary. The `.agent-team/` dir is the existing gitignored context dir (shared with S3's `editor-context.md`).
4. Zero hits ⇒ no files written (clean no-op).

### 6.3 Ordering / self-retrieval
A node **hydrates at creation** and **records at done** — so within a run a node never retrieves its own decision, and a sequential successor retrieves its predecessors. Parallel siblings won't see each other mid-run (acceptable). Across runs, all prior decisions are retrievable. No special guard needed in v1.

---

## 7. Error handling

- **Missing/!loadable sqlite-vec extension:** fail fast at provider construction with a clear message (the host chose `--memory`, so a broken store is a hard error, not a silent skip).
- **DB file absent:** created (with schema + WAL) on first open. Parent dir must exist or is created.
- **`embed()` rejects:** `hydrate` swallows-and-skips (no memory is non-fatal to the agent run — log to the bus/feed as a soft `error`-less notice; the run proceeds with no memory files). `record` swallows-and-logs (failing to persist one decision must not crash a completed run). Both paths must never throw out of the Scheduler-driven `hydrate`.
- **Concurrent writers/readers:** WAL mode + better-sqlite3's per-connection serialization. v1 uses a single writer (the one host subscriber) and N readers (worktree creators) — within WAL's supported concurrency.
- **dim mismatch** (embedder swapped against an existing db): detected at open (stored dim vs `embedder.dim`) → fail fast with a message to rebuild the store.

---

## 8. Scope fence

**In v1:**
- `SqliteVecContextProvider` (hydrate + record) under `src/node/`, exported via `@agent-team/core/node`.
- `Embedder` port + deterministic hash-embedder test fixture.
- host-headless wiring: `--memory <db>` flag / `composeHeadless` option; absent ⇒ today's behavior verbatim.
- Offline round-trip test (record → later hydrate retrieves it).

**Deferred (explicit out of scope):**
- Capturing `ambient_report` findings (S4 reviewer → memory) — natural next step, adds coupling.
- Graph traversal (`nodes`/`edges` tables).
- Real embedder selection (OpenAI/local) and live smoke.
- host-vscode wiring.
- Temporal / bi-validity, dedup/upsert, cross-run task-graph persistence.

---

## 9. File map

| File | Action |
|---|---|
| `packages/core/src/node/sqlite-vec-context-provider.ts` | NEW — `SqliteVecContextProvider` (impl of both ports) |
| `packages/core/src/node/decision-recorder.ts` | NEW — `DecisionRecorder` + `RecordedDecision` types (or co-locate in the provider file) |
| `packages/core/src/embedder.ts` | NEW — `Embedder` port (pure type; may live in the pure barrel since it's type-only) + hash-embedder fixture in tests |
| `packages/core/src/node/index.ts` | MODIFY — `export * from "./sqlite-vec-context-provider.js"` (and recorder) |
| `packages/core/package.json` | MODIFY — add `better-sqlite3` + `sqlite-vec` deps |
| `packages/core/tests/sqlite-vec-context-provider.test.ts` | NEW — offline record→hydrate round-trip + error paths |
| `packages/host-headless/src/compose-headless.ts` | MODIFY — optional `--memory`/option: swap provider + attach record subscriber |
| `packages/host-headless/src/cli.ts` | MODIFY — parse `--memory <db>` |
| `packages/host-headless/tests/*` | NEW/MODIFY — offline test that a recorded decision hydrates into a later node's worktree |

**Port-purity corrections vs. the recommendation doc** (which predated the rule): the provider uses `better-sqlite3` (a native module), so it **must** live under `src/node/` and export only via `@agent-team/core/node` — NOT from the pure barrel `src/index.ts`. This mirrors `TextContextProvider`/`NodeGitRunner`. The `Embedder` port is type-only and may stay in the pure barrel. Hit files go in the existing `.agent-team/` dir, not a new `.agent-context/`.

---

## 10. Open question for the planning phase (not a blocker)

**AgentId→TaskNode correlation in the host.** `record()` needs the node's `role`/`goal`, but the `done` event carries only `from` (`AgentId`) + `summary`. The host built the graph, so it can maintain an `AgentId → TaskNode` map. The plan must confirm `composeHeadless` retains (or can cheaply build) that map. **Fallback if correlation is awkward:** record/embed **summary-only** (drop `goal` from the embedded text; store `node_id` from the AgentId). Slightly less precise retrieval, zero correlation needed. Decide during plan-writing after reading the current `composeHeadless`.

---

## 11. Acceptance criteria

- `npm run build` exit 0; full suite green and above the current 160 baseline.
- Core barrel stays port-pure (no `node:*`/`better-sqlite3` in `dist/index.js`; provider only under `dist/node/`).
- Scheduler/bus/worktree/task-graph runtime unchanged (additive types + host wiring only).
- Offline round-trip test passes with the deterministic hash-embedder: a `record()`ed decision is retrieved and written as a `.agent-team/memory-<id>.md` file into a later node's worktree.
- `--memory` absent ⇒ host-headless behaves exactly as today (Noop provider, no recorder).
