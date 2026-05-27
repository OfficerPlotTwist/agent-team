# S2 — Parallel Worktree Isolation + Task-DAG Scheduling — Design

**Date:** 2026-05-26
**Status:** Approved design, pre-implementation-plan
**Builds on:** Plan A core engine (merged to master `5fd28f8`) — events, bus, broker, policy, adapters, orchestrator, propose-diff DiffStore.

---

## 1. Goal & intent

Let specialist agents **work in parallel, each in its own git worktree + branch**, and have the lead **merge their branches back incrementally** — so real parallel editing is possible without clobbering a shared workspace. A **task dependency graph (DAG)** drives scheduling: independent work runs concurrently, dependent work is sequenced, and merges are ordered topologically so most conflicts are *avoided* rather than *resolved*.

The user's live working tree is **never** touched: all work happens on a dedicated integration branch plus per-agent worktrees. Final landing into the user's real branch is an explicit, gated step.

## 2. Premises (locked during brainstorming)

- **Direct writes in worktree.** Agents write/commit directly in their own worktree (that is the parallelism). The merge is the integration/review gate. S1's propose-diff `DiffStore` is retained for single-agent / non-worktree runs but is **not** used inside a worktree run.
- **Incremental lead-merge.** As each agent finishes, its branch is merged into a shared integration branch, one at a time (serialized). The integration branch is always current; later nodes are cut from it.
- **Conflicts are first-class.** A merge conflict becomes a `merge_conflict` `action_request` routed through the existing Action Broker (policy-tunable via the Involvement Dial).
- **DAG-driven scheduling.** The orchestrator executes a task DAG: it runs ready nodes in parallel and unlocks dependents as prerequisites merge.

## 3. Architecture

New/changed units layered on Plan A. The core stays **port-pure**: all git access goes through an injected `GitRunner` interface; the only `child_process` touch is one isolated concrete runner.

```
┌─ packages/core/src ───────────────────────────────────────────┐
│  task-graph.ts     TaskGraph: nodes + deps, ready/complete,    │
│                    topological order, cycle validation         │
│                                                                │
│  git.ts            GitRunner (port): run(args, cwd)            │
│  node/git-runner.ts NodeGitRunner: child_process impl          │
│                    (the one intentional node-builtin module)   │
│                                                                │
│  worktree.ts       WorktreeManager: create/list/merge/remove/  │
│                    pruneAll over a GitRunner; calls            │
│                    ContextProvider.hydrate on create           │
│                                                                │
│  context-provider.ts ContextProvider (port): hydrate(node,    │
│                    path) writes gitignored context files into  │
│                    a fresh worktree. NoopContextProvider       │
│                    default; KG-backed impl is S5               │
│                                                                │
│  integration.ts    IntegrationCoordinator: owns integration    │
│                    branch; serial merge-on-done; conflict →     │
│                    merge_conflict action_request; re-attempt    │
│                                                                │
│  orchestrator.ts   Scheduler (extends Plan A orchestrator):     │
│                    DAG execution, worktree assignment,          │
│                    merge wiring, termination on graph-complete  │
│                                                                │
│  adapter.ts        TaskContext gains optional `cwd` + `branch`  │
│  events.ts         RequestCategory gains `merge_conflict`       │
│  policy/presets.ts presets gain a merge_conflict column         │
└────────────────────────────────────────────────────────────────┘
```

### 3.1 Unit responsibilities & boundaries

- **TaskGraph** (`task-graph.ts`) — pure data structure. Node = `{ id: string; role: Role; goal: string; dependsOn: string[] }`. Methods: `ready(completed: Set<string>): Node[]` (deps ⊆ completed, not yet started/complete), `complete(id)`, `isDone(): boolean`, `topologicalOrder(): Node[]`, and constructor-time **cycle validation** (throws on a dependency cycle). No git, no async.
- **GitRunner** (`git.ts`) — port: `run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>`. Logic depends only on this.
- **NodeGitRunner** (`node/git-runner.ts`) — concrete `child_process` implementation. Isolated so the rest of core stays free of node builtins. Used by integration tests and later by the VS Code host.
- **WorktreeManager** (`worktree.ts`) — over a `GitRunner`: `create(node, base): Promise<{path, branch}>`, `list()`, `merge(branch, into): Promise<MergeResult>` (`MergeResult = {ok: true} | {ok: false; conflicts: string[]}`), `remove(agentId)`, `pruneAll()`. Formats git args, parses results. Worktrees live under `<repo>/.worktrees/<role>-<index>`; branches named `agentteam/<role>-<index>`. After a worktree is created it calls `ContextProvider.hydrate(node, path)` so the tree is seeded before the agent starts.
- **ContextProvider** (`context-provider.ts`) — port: `hydrate(node: Node, worktreePath: string): Promise<void>`. Writes gitignored context files into the fresh worktree (see §3.3). Ships a `NoopContextProvider` default; the KG-backed implementation is **S5**.
- **IntegrationCoordinator** (`integration.ts`) — creates/owns the integration branch (`agentteam/integration` from workspace HEAD). Exposes `integrate(node, branch): Promise<IntegrationOutcome>` that merges one branch into integration; on conflict emits a `merge_conflict` `action_request` (via the bus) and returns a pending outcome the Scheduler resolves. Serializes merges (a queue/lock).
- **Scheduler** (extended `orchestrator.ts`) — replaces the fixed-team loop with DAG execution (see §4). Depends on TaskGraph, WorktreeManager, IntegrationCoordinator, MessageBus.

### 3.2 API shift

Plan A: `run(goal, team: SpecialistSpec[])`.
S2: `run(graph: TaskGraph, adapterFor: (node: Node) => AgentAdapter)` — mints a fresh adapter per node (keyed by its role). Termination = **graph complete** (all nodes merged), budget exhausted, or `stop()`. A terminal integrator/lead node may own the final landing GATE.

`TaskContext` (in `adapter.ts`) gains optional `cwd` (the worktree path) and `branch` (the agent's branch). Real adapters (Plan B) run their backend in `cwd`; `FakeAdapter` ignores them but records them for assertions.

### 3.3 Context hydration seam (KG-ready, KG-free in S2)

The worktree is the per-agent isolation boundary, which makes worktree-creation the natural injection point for **agent context** — relevant decisions, entities, and prior art an agent should know before it starts. S2 builds the **seam**, not the knowledge graph (that is S5), mirroring how `GitRunner` kept the core port-pure.

- **Port, not content.** `ContextProvider.hydrate(node, worktreePath)` is called by `WorktreeManager.create()` right after the tree exists. S2 ships `NoopContextProvider` (writes nothing) and a trivial fixture provider for tests; S5 plugs a graphiti-backed provider into the same seam with no S2 rework.
- **File channel, not prompt injection.** Context is written as files in the worktree (e.g. `.agent-context/` and/or an `AGENTS.md`/`CLAUDE.md` at the worktree root) rather than stuffed into the backend's system prompt. This is **durable across the agent's own context compaction** (the file survives, can be re-read), is **pull-based** (the agent reads only what its subtask needs), and Claude-Code-style backends discover root context files for free.
- **Gitignored ⇒ never committed ⇒ cannot pollute merges.** A single committed `.gitignore` entry (`.agent-context/`) applies across every worktree including integration. The context files are never `git add`ed, so they live only as working-tree files in that one worktree and disappear when the worktree is removed. They are *not* inherited by dependent worktrees (which are cut from the committed integration tip) — each node hydrates fresh for its own task. This is consistent with the no-mid-flight-rebase decision (§9): context is a point-in-time snapshot taken at creation.

Write-back (an agent recording new decisions/entities *into* the KG) is the complementary half of this loop and is **deferred to S5**; the port may later grow a `record()` method, but S2 does not build it.

## 4. Data flow (one parallel run)

1. **Init.** IntegrationCoordinator creates `agentteam/integration` from the workspace HEAD.
2. **Schedule.** Scheduler asks the TaskGraph for `ready(completed)` nodes. For each, WorktreeManager creates a worktree + branch cut from the **current integration tip** (so it inherits already-merged prerequisites), then calls `ContextProvider.hydrate(node, path)` to seed gitignored context files (§3.3). The Scheduler spawns `adapterFor(node)` with `TaskContext { goal: node.goal, role, agentId, cwd, branch }`.
3. **Work.** Ready agents run **in parallel**, writing + committing in their own worktrees.
4. **Merge on done.** When an agent emits `done`, the Scheduler calls `IntegrationCoordinator.integrate(node, branch)`, which merges that branch into integration **one at a time**.
5. **Outcome.**
   - Clean merge → mark node complete → unlock dependents → loop to step 2 with the enlarged ready set.
   - Conflict → `action_request(category: "merge_conflict", from: <author agentId>, payload: {conflicts})` → Broker resolves by policy: **GATE** (you resolve in the worktree, then the Scheduler re-attempts the merge) or **ROUTE** (re-dispatch an agent of the author's role on the updated base to re-resolve, then re-attempt). After resolution → treat as clean.
6. **Complete.** When `graph.isDone()`, the integration branch holds all work. Final **landing** of the integration branch into the user's real branch is itself a GATE by default (you approve).
7. **Cleanup.** `worktree remove` each + `git worktree prune` (self-heals stale registrations). Branches kept until landed.

## 5. Error handling

- **Worktree create failure** (path exists / dirty base) → `error` event, that node's agent fails; the run continues without it; dependents of a failed node are **not** unlocked (and are reported as blocked at termination).
- **Agent fails mid-work** → its branch is abandoned (never merged); dependents stay blocked; reported at termination.
- **Merge conflict** → the `merge_conflict` action_request flow in §4.5 (policy-tunable).
- **Dependency cycle** in the supplied graph → rejected at TaskGraph construction (throws) before any work starts.
- **Interrupt / crash / stop** → Scheduler interrupts in-flight adapters; cleanup runs `git worktree prune` to clear stale registrations.
- **Hard invariant:** nothing ever runs against the user's checked-out HEAD/working tree. All mutation is on `agentteam/*` branches + worktrees until the gated landing.

## 6. Testing

- **TaskGraph** (pure unit): `ready()` sets at each level, `topologicalOrder()`, `isDone()`, and cycle rejection (constructor throws).
- **WorktreeManager:** unit tests with a **fake GitRunner** (arg formatting + output parsing) **plus** real-git integration tests with `NodeGitRunner` in a temp repo — `git init`, seed a commit, create two worktrees, parallel edits to *different* files → `merge` clean; edits to the *same lines* → `MergeResult.ok === false` with the conflicted path listed.
- **IntegrationCoordinator:** real temp repo + `FakeAdapter`s that write files — clean branch merges advance the integration tip; a conflicting branch emits a `merge_conflict` action_request on the bus; a ROUTE resolution triggers re-dispatch + successful re-merge.
- **ContextProvider:** `NoopContextProvider` writes nothing; a fixture provider writes a file into the worktree, and a test asserts WorktreeManager calls `hydrate` after create, the file is present in the tree, and (since the path is gitignored) `git status --porcelain` shows it untracked and a `merge` of that branch carries none of it.
- **Scheduler (DAG):** real temp repo + fakes — a diamond DAG (A → B, C → D) runs B and C in parallel worktrees and starts D only after both merge; a dependent node's worktree base contains its prerequisite's committed changes; independent nodes editing different files all land clean; budget/stop interrupts mid-run and cleans up.

## 7. Out of scope (S2)

- Knowledge-graph shared memory → **S5** (separate sub-project: graphiti-style entities/relationships/decisions as team context). S2 builds only the `ContextProvider` *seam* (§3.3) with a no-op default; the KG-backed provider and any write-back (`record()`) are S5.
- VS Code extension / Control Room webview → Plan B.
- Real Claude / CodeWhale adapters → Plan B (this spec exercises the DAG + worktrees with FakeAdapters).
- Automatic (non-gated) landing of the integration branch into the user's branch.
- Cross-run persistence of the task graph.

## 8. Roadmap (updated)

- **S1** — Talking Team Core (done, merged).
- **S2** — Parallel worktree isolation **+ task-DAG scheduling** (this spec).
- **Plan B** — VS Code extension + Claude/CodeWhale adapters + Control Room webview.
- **S3** — Deep editor fusion. **S4** — Ambient agents. **S5** — Knowledge-graph shared memory.

## 9. Open items for planning

- Where the TaskGraph comes from in real runs (lead-produced) vs. headless (supplied as input) — S2 takes it as input.
- Whether the final landing GATE is a dedicated lead/integrator node or a Scheduler post-step.
- Exact `git worktree` invocation flags for Windows path handling (verify in the NodeGitRunner integration tests).
- Whether in-flight nodes rebase on a newly-merged integration tip mid-run, or only future-scheduled nodes inherit it (default: only future-scheduled nodes; no mid-flight rebase in S2).
- The exact on-disk shape of hydrated context (`.agent-context/` dir vs. root `AGENTS.md` vs. both) and whether the `.gitignore` entry is added by S2 setup or assumed present — settle when wiring the fixture provider; the S5 KG provider can refine it.
