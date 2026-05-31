# S4 — Ambient Agents (on-commit reactions) — Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation-plan
**Builds on:** S1 (bus + normalized events), S2 (`Scheduler`, `WorktreeManager`, `IntegrationCoordinator`, `TaskGraph`), core robustness (per-agent budget + done-gated completion), B1 (`ClaudeAdapter`), host-headless (`composeHeadless`, CLI) — all on `master` (`bad70f3`). S3 just widened the `ContextProvider.hydrate` seam (available but not required here).
**Slice:** S4, **on-commit reactions, headless-first, report + propose-diff**. A background agent reacts to each commit by staging a proposed diff on its own branch and posting a finding to the feed. It never merges.

---

## 1. Goal & intent

When you commit, a background agent reviews that commit's changed files, **stages a proposed diff on its own branch, and posts a finding to the feed** — without you asking. It never merges to the integration branch; promoting a proposal to a real merge is a separate human action, out of scope for this milestone.

This is the first **ambient** (environment-triggered, single-shot) slice. Everything before it is human-goal-driven and runs a finite task to a terminal state; S4 adds a long-lived watcher that turns environment events into one-shot reactions.

### 1.1 The governing insight

**An ambient reaction is a one-node `Scheduler` run with the merge step swapped out.** The S2 Scheduler lifecycle — create worktree → run the agent → emit `file_change` diffs on `done` → tear the worktree down — *is already* the lifecycle of a single reaction. The only behavioral difference from a normal task is "do not merge into integration." So S4 is mostly a thin driver plus one substituted collaborator, not new orchestration. The `Scheduler`, `MessageBus`, and `WorktreeManager` are reused **untouched**.

### 1.2 What this milestone delivers

- A core `ambient_report` normalized bus event (the finding "header"; proposed diffs ride the existing `file_change` event).
- A core `AmbientTrigger` value type (`{reason, commitSha, scope}`).
- A core `AmbientIntegration` — an `IntegrationCoordinator`-shaped collaborator whose `integrate()` is a **no-op that reports `merged`** so the one-node run completes, and whose `tip()` returns the reviewed commit SHA so the worktree is cut from it.
- A host-headless `CommitWatcher` that watches `.git/logs/HEAD`, derives the changed-file scope, and emits `AmbientTrigger` (deduped by SHA, sequential).
- A host-headless `composeAmbient` driver that maps each trigger to a one-node `Scheduler` run and posts `ambient_report`.
- A host-headless `agent-team-ambient` CLI + a programmatic `fire(trigger)` entry for offline testing.

### 1.3 What this milestone defers

- **On-save / on-test-fail triggers** — only on-commit ships now (others are additive `TriggerSource`s later).
- **host-vscode Ambient panel** — headless-first; the VS Code feed surface is a follow-up (and partly overlaps the deferred diff-review-panel milestone).
- **Auto-merge / ActionBroker gating of ambient diffs** — proposals are stage-only; promotion is a separate human action with no new policy machinery here.
- **A persisted / queryable feed** — the `MessageBus` is the feed this milestone; a durable ambient log is a follow-up.
- **Multi-node ambient reactions** — one reaction = one node in v1.
- **S5 memory** — separate; `composeAmbient` could later hydrate commit scope through the S3 seam, but does not now.

---

## 2. Package boundaries (no new package, no new dependency)

```
packages/
  core/            CHANGED  + ambient_report event kind (events.ts);
                            + AmbientTrigger value type;
                            + AmbientIntegration (stage-only IntegrationCoordinator-shape);
                            + orchestrator.ts: TYPE-ONLY widening of SchedulerDeps.integration
                              to an IntegrationLike interface (no behavior change — see §3.3).
                            Scheduler run-logic, bus, worktree, task-graph UNCHANGED.
  host-headless/   CHANGED  + CommitWatcher (node: watch .git/logs/HEAD);
                            + composeAmbient driver;
                            + agent-team-ambient CLI entry.
  host-vscode/     UNCHANGED (deferred).
```

### 2.1 Port-purity guard (unchanged discipline)

`AmbientIntegration` and the `ambient_report`/`AmbientTrigger` types are pure (no `node:*`) and live in the `core` barrel. `CommitWatcher` uses `node:fs` + `GitRunner` and lives in **host-headless** (not core) — the watcher is host-only the same way `EditorStateSource` is. No `node:*` enters the `core/src/index.ts` barrel.

---

## 3. Core changes

### 3.1 `ambient_report` event (`packages/core/src/events.ts`)

A new member of the `AgentEvent` union:

```ts
export interface AmbientReportEvent {
  kind: "ambient_report";
  from: AgentId;            // the reacting agent, e.g. "reviewer#<sha7>"
  trigger: AmbientTrigger;  // what fired this reaction
  summary: string;          // the finding
  branch?: string;          // the proposal branch (absent when nothing was proposed)
}
```

Added to `AgentEvent`; `BusEvent` (the `seq`-stamped wrapper) covers it for free. Proposed code changes are NOT in this event — they continue to flow as `file_change` events emitted by the adapter during the run. `ambient_report` is the finding header that ties them together.

### 3.2 `AmbientTrigger` value type (`packages/core/src/ambient.ts`, NEW)

```ts
export interface AmbientTrigger {
  reason: "commit";          // the only reason this milestone; widened later (save/test-fail)
  commitSha: string;         // the reviewed commit
  scope: string[];           // repo-relative changed files in that commit
}
```

Pure value type, exported from the barrel.

### 3.3 `AmbientIntegration` (`packages/core/src/ambient.ts`)

Mirrors the three methods the `Scheduler` calls on its integration collaborator (`init`, `tip`, `integrate`) so it is a drop-in. The difference: `integrate()` does **not** merge — it returns `{ status: "merged" }` so the one-node graph completes (the Scheduler only calls `graph.complete` on a `merged` outcome), while leaving the integration branch untouched and the agent's proposal branch intact.

```ts
export interface IntegrationLike {
  init(baseRef: string): Promise<void>;
  tip(): string;
  integrate(agentId: string, branch: string): Promise<IntegrationOutcome>;
}

export class AmbientIntegration implements IntegrationLike {
  private base = "";
  constructor() {}
  async init(baseRef: string): Promise<void> { this.base = baseRef; }
  tip(): string { return this.base; }                 // worktrees cut from the reviewed SHA
  async integrate(_agentId: string, _branch: string): Promise<IntegrationOutcome> {
    return { status: "merged" };                       // report-complete WITHOUT merging
  }
}
```

The `Scheduler`'s `SchedulerDeps.integration` is typed as `IntegrationCoordinator`; this milestone widens that field to an `IntegrationLike` interface (a pure type extraction — `IntegrationCoordinator` already satisfies it) so `AmbientIntegration` is accepted **without changing Scheduler behavior**. This is the one Scheduler-adjacent edit, and it is type-only.

> **Naming honesty:** `integrate()` returning `"merged"` while not merging is a deliberate adapter of the existing contract (Scheduler completes a node iff integrate reports `merged`). The class name + doc comment make the "stage-only" intent explicit so the report-complete path is not mistaken for a real merge.

---

## 4. Host-headless changes

### 4.1 `CommitWatcher` (`packages/host-headless/src/commit-watcher.ts`, NEW)

- Watches `.git/logs/HEAD` (via `node:fs` watch) in the repo; on change, reads current `HEAD` SHA.
- **Dedup:** ignores a SHA already reacted to (tracks last-seen). The seed SHA at startup is recorded but not reacted to (we react to *new* commits, not the one you already had).
- **Scope:** `git diff-tree --no-commit-id --name-only -r <sha>` via `GitRunner` → `scope: string[]`.
- Emits `AmbientTrigger{reason:"commit", commitSha, scope}` to a callback.
- **Sequential:** one reaction at a time; a commit arriving mid-reaction is queued and processed after (v1 keeps it simple — no concurrent reactions).
- Exposes `start()` / `stop()` (disposes the fs watch) and a direct `fire(trigger)` for tests/offline.

### 4.2 `composeAmbient` (`packages/host-headless/src/compose-ambient.ts`, NEW)

Per `AmbientTrigger`:
1. Build a **one-node `TaskGraph`**: `[{ id: sha7, role: "reviewer", goal: <templated from trigger.scope>, dependsOn: [] }]`.
2. Run the **existing `Scheduler`** with `baseRef = trigger.commitSha`, `worktrees` = a `WorktreeManager` over `NodeGitRunner`, `integration = new AmbientIntegration()`.
3. The `ClaudeAdapter` runs in the cut worktree, stages a diff, commits to `agentteam/reviewer-<sha7>`, emits `file_change` + `done`.
4. On the node settling, emit `ambient_report{ from, trigger, summary, branch }` to the bus (`branch` present iff the proposal commit exists; absent on "no changes").
5. The Scheduler tears the worktree down; **the proposal branch persists, unmerged.**

Mirrors `composeHeadless`'s wiring (bus, ledger, pending, policy autopilot, broker) — same composition root pattern, different integration collaborator and a single-node graph.

### 4.3 `agent-team-ambient` CLI

`agent-team-ambient --repo <path> [--model <m>] [--max-turns <n>]` starts the `CommitWatcher` on the repo, prints the live bus feed (incl. `ambient_report`), and runs until interrupted. A `--once <sha>` mode fires a single synthetic reaction (offline / manual driver).

---

## 5. Data flow (one commit → one reaction)

```
you commit on master ──► CommitWatcher sees .git/logs/HEAD move ──► AmbientTrigger{sha, scope}
   ──► composeAmbient: 1-node graph (reviewer, goal = review these files)
   ──► EXISTING Scheduler.run: worktree cut from sha ──► ClaudeAdapter runs
        ──► stages diff, commits to agentteam/reviewer-<sha7>, emits file_change + done
   ──► AmbientIntegration.integrate() = NO-OP (reports "merged") ──► node completes
   ──► driver emits ambient_report{summary, branch} ──► bus (the feed)
   ──► Scheduler tears down worktree ; proposal branch PERSISTS, unmerged
```

**No self-trigger, by construction:** the agent commits to `agentteam/reviewer-*` inside a *separate* worktree; your watched `HEAD` never moves, so a reaction cannot trigger itself.

---

## 6. Error handling

- **Dedup:** react once per SHA; the startup SHA is seeded, not reacted to.
- **Self-trigger:** structurally impossible (§5).
- **Agent failure / budget:** inherited from the post-robustness Scheduler — a node that never emits `done` → `blocked`, no merge; `ambient_report` still posts (summary reflects the failure, `branch` absent). Per-agent turn budget applies unchanged.
- **No proposal:** agent makes no changes → adapter emits `done` (no changes) → `ambient_report` says "nothing to propose," `branch` absent, no branch litter.
- **Watcher races:** commit during a reaction → queued, processed after (sequential). Rapid commits collapse only by dedup of identical SHAs, not by skipping distinct ones.

---

## 7. Testing (all offline — temp repos + scripted `query`, fake adapter where possible)

- **`AmbientIntegration`** (core): after a run, the integration/base branch is **unchanged** and the agent branch **has** the proposal commit; `integrate` returns `merged`; `tip()` returns the seeded SHA.
- **`ambient_report`** (core): in the `AgentEvent` union (type-level) + a bus publish/subscribe round-trip stamps `seq`.
- **`CommitWatcher`** (host-headless): commit in a temp repo → fires once with the correct changed-file `scope`; a re-poll of the same SHA → no re-fire (dedup); startup SHA not reacted to.
- **`composeAmbient`** (host-headless, offline): scripted `query` writes a file → assert `ambient_report` **and** `file_change` emitted, the integration branch NOT advanced, and the proposal commit present on `agentteam/reviewer-<sha7>`. A "no changes" script → `ambient_report` with no `branch`, no proposal branch created.
- **Gate:** full workspace build exit 0; full suite green and strictly above the current 152 baseline.

---

## 8. Out of scope (S4)

On-save / on-test-fail triggers · host-vscode Ambient panel · auto-merge or ActionBroker/Involvement-Dial gating of ambient diffs · persisted/queryable feed (bus only) · multi-node ambient reactions · S5 memory hydration. These are additive on the seams this milestone establishes (new `TriggerSource`s, a feed panel subscribing to `ambient_report`, a promotion action that performs the real merge).

---