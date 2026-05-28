# Plan B1 — Headless Claude Adapter — Design

**Date:** 2026-05-27
**Status:** Approved design, pre-implementation-plan
**Builds on:** S1 (talking-team core) + S2 (parallel worktree + DAG), both merged to `master`.
**Decomposes:** "Plan B" (VS Code extension + real adapters + Control Room) into three slices. **This spec is B1 only.**

---

## 1. Goal & intent

Prove that a **real Claude agent**, driven by the Claude Agent SDK, maps cleanly onto the existing `@agent-team/core` seams — the `AgentAdapter` interface, the normalized event vocabulary, and the `ActionBroker` permission flow — by running it **end-to-end through the existing `Scheduler`, headless, with no VS Code**.

B1 retires the single highest-risk unproven assumption in the system: *does the normalized-event design survive contact with a real backend's stream, and does permission gating work against it?* It does this with the least possible scaffolding.

### 1.1 Plan B decomposition (context)

| Slice | Adds | Status |
|---|---|---|
| **B1** | Real Claude Agent-SDK adapter + headless host that runs it through the Scheduler. | **This spec** |
| B2 | VS Code extension host + Control Room webview (live feed, action inbox, diff review, Involvement Dial). | Later |
| B3 | CodeWhale sidecar adapter (second, heterogeneous backend). | Later |

## 2. Scope honesty — what B1 does and does NOT prove

**Proves:** a real Claude stream → normalized events; `canUseTool` → `action_request` → broker resolution against a live backend; worktree → commit → merge with a real agent.

**Does NOT prove (deferred, not retired):**
- The S1 thesis that a *talking team* beats one agent — B1 runs a **single-node graph** (one goal → one Claude) by default. No inter-agent bus messaging, no broker routing between real peers, no real merge conflicts.
- S2's parallel machinery under load — with one node, concurrency/dependency/serial-merge run trivially (N=1).
- The interactive human-in-the-loop gating UX — headless Autopilot mostly walks the AUTO path; GATE fires only on hard-rules via a crude readline prompt. The Control Room UX is B2.

"B1 passes" must not be read as "the system works." It means the adapter seam holds.

## 3. Locked decisions (from brainstorming)

- **Headless first.** No VS Code, no webview in B1.
- **Approach 1.** Reusable adapter library + a thin headless host (CLI `bin` + integration test); full permission mapping wired now; adapter auto-commits the worktree; tests use a recorded SDK stream + a manual live smoke.
- **Autonomy model** (already locked by S1 §4.3): Claude owns its own loop, tools, MCP, subagents; subagents are opaque below the runtime boundary.
- **`canUseTool` → `action_request`** (already locked by S1 §4.2): the SDK's permission callback is the gate that produces normalized `action_request`s.
- **Multi-agent forward-compat principle:** design *shared* pieces to be concurrency-correct and keyed (not single-slot), even though B1 drives them with N=1. **Seams, not features** — nothing here adds a second agent to B1 or touches the Scheduler.

## 4. Architecture & package boundaries

B1 writes **zero lines inside `packages/core`**. It adds two new packages.

```
packages/
  core/                  UNCHANGED — port-pure engine, the AgentAdapter seam
  adapters-claude/   NEW  ClaudeAdapter + SDK→event mapper (reusable library)
                          deps: @agent-team/core, @anthropic-ai/claude-agent-sdk
  host-headless/     NEW  composition root: wires Scheduler + NodeGitRunner +
                          ClaudeAdapter + ActionBroker; exposes a `bin` CLI + the
                          integration test that proves the slice
```

**Why two packages, not one:** the adapter is reusable — B2's extension imports `ClaudeAdapter` but not the CLI host. Bundling them would force the extension to drag in CLI/process code. So the adapter is a clean library; the host is a leaf app (the composition root — the only place allowed to import both `core/node/` and a concrete adapter), mirroring how `core` isolates `NodeGitRunner` in `src/node/`.

```
        host-headless (leaf app)
        ┌──────────────────────────────────────┐
        │  Scheduler ── bus ── ActionBroker      │  ← all from core (unchanged)
        │      │         │         │             │
        │  NodeGitRunner │     PolicyStore        │
        │  + PendingPermissions (keyed) [MA seam] │
        │  + CostLedger (per-agent)     [MA seam] │
        │  adapterFor(node) ─► ClaudeAdapter ─────┼──► adapters-claude (new lib)
        └──────────────────────────────────────┘         │
                                                          └─► @anthropic-ai/claude-agent-sdk
```

### 4.1 Monorepo / build-order infra (a real B1 task)

`adapters-claude` can only typecheck against core's **emitted `.d.ts`**, and `host-headless` deep-imports `NodeGitRunner` (the barrel deliberately does not export `src/node/`). B1 must:

- Set up workspace resolution (npm/pnpm workspaces) so the three packages resolve each other by name.
- Establish a build order: `core` builds before `adapters-claude` and `host-headless`.
- Decide the `NodeGitRunner` import path so the host does not hard-couple to a `dist/` layout. **Decision:** add a `package.json` `exports` subpath in `core` (e.g. `"@agent-team/core/node"` → the built `node/git-runner.js`) so the host imports a *named* entry, not a dist file path. This is the one intentional, narrow widening of core's public surface (an export map entry, not a barrel re-export — `core`'s purity rule that `src/index.ts` excludes `src/node/` is preserved).

## 5. Components & boundaries

### 5.1 `adapters-claude` (reusable library)

| Unit | Does | Depends on |
|---|---|---|
| `ClaudeAdapter` | `implements AgentAdapter`; `backend="claude"`. `startTask(ctx, emit)` runs the `query()` loop in `ctx.cwd`; `interrupt()` calls `abortController.abort()`. On final `result`: emits `file_change` (git-diffed), auto-commits (or empty-result path), emits `done`/`error`, records cost. | injected `query` fn, `GitRunner` port, mapper, bridge, `CostLedger` sink |
| `event-mapper.ts` | **Pure** `SDKMessage → AgentEvent[]`: `assistant` text → `message`; `tool_use` block → `tool_call`; `result` success → `done`, error subtypes → `error`. No I/O. The core proof lives here. | `@agent-team/core` event types only |
| `permission-bridge.ts` | The `canUseTool` impl. Per gated call: classify → emit `action_request{requestId}` → register a resolver in `PendingPermissions` → **await** resolution or `timeoutMs`→deny → return `PermissionResult`. | `PendingPermissions` registry, `tool-category` |
| `tool-category.ts` | Deterministic table: SDK tool name → `RequestCategory`. `Write`/`Edit`→`approval`; `Bash`→`external_action`, with destructive patterns (`rm`, `git push`, etc.)→`destructive`; credential patterns→`credential`; `WebFetch`/`WebSearch`→`external_action`; read-only (`Read`/`Glob`/`Grep`)→`info`/auto. | — |

**Injected `query`** is the key test seam: tests pass a fake async-generator (a recorded transcript); the host passes the real SDK `query`. **Injected `GitRunner` port** lets the adapter commit without importing `child_process` (host supplies `NodeGitRunner`). Adapter instance state (`AbortController`, the running query) is **per-instance**, so N adapters never share mutable run state.

### 5.2 `host-headless` (leaf app — composition root)

| Unit | Does | Depends on |
|---|---|---|
| `compose.ts` | Builds `MessageBus`, `PolicyStore` (Autopilot preset), `ActionBroker` (handlers below), `WorktreeManager(NodeGitRunner)`, `IntegrationCoordinator`, `Scheduler`. Creates the shared `PendingPermissions` registry and `CostLedger`. `adapterFor = node => new ClaudeAdapter({...})`. | core, `@agent-team/core/node`, `adapters-claude`, real `query` |
| `cli.ts` (`bin`) | `agent-team-run --goal "…" [--repo .] [--model …] [--max-turns N]`. Builds a **single-node** `TaskGraph` (N>1 = supplied graph, same path), runs the Scheduler, prints the live bus feed + final status + `CostLedger` total. | `compose.ts`, `readline` |
| broker handlers | `notify`→log; `auto`→noop; `route`→log+auto-allow (no peers in B1); `gate`→**readline CLI prompt** (only hit by Credential/Destructive hard-rules under Autopilot). The CLI presenter is the *only* single-agent-shaped piece — replaced by the webview in B2. | `readline` |

### 5.3 Shared multi-agent seams (keyed, concurrency-safe; B1 drives at N=1)

- **`PendingPermissions`** — host-scoped registry mapping `requestId → resolver`. Because it is keyed by globally-unique `requestId` (not a single in-flight slot), multiple concurrent adapters each blocking in `canUseTool` resolve independently. Also owns the timeout→deny logic.
- **`CostLedger`** — maps `agentId → total_cost_usd`. B1 sums and reports; B2 enforces a team ceiling against the same ledger.
- **`agentId` stamping** — each adapter stamps events with its node's `agentId`; SDK subagents collapse under the parent. The bus id-space equals our roster at any N.
- **Per-worktree commit** — each agent commits only its own `cwd`; no cross-agent contention. `IntegrationCoordinator` already serializes merges.

## 6. Data flow (one goal; N>1 fans out identically)

```
compose():  core graph + PendingPermissions(keyed) + CostLedger
per ready node A:
 1. WorktreeManager.create(A) → {cwd, branch};  ContextProvider.hydrate = Noop (B1)
 2. adapterFor(A) → new ClaudeAdapter({query, git, classify, pending, ledger, budget})
 3. startTask(ctx{goal,role,agentId,cwd,branch}, emit)
 4. query({ prompt:goal, options:{ cwd, model, maxTurns←Budget,
            permissionMode:"default", disallowedTools:["Bash(git*)"],
            allowedTools:[Read,Glob,Grep],   // read-only auto; ALL mutating tools
            canUseTool:bridge, abortController }})   // (Write/Edit/Bash/WebFetch) route via broker
 5. each SDKMessage → mapper → AgentEvent[]; stamp from=agentId; emit → bus → feed
        assistant.text → message      tool_use → tool_call (observability)
 6. permission-requiring tool → canUseTool(name,input):
        classify→category; mk requestId; pending.register(requestId)
        emit action_request{requestId,category,timeoutMs}; broker.handle→mode
        AUTO→allow · NOTIFY→log+allow · GATE→CLI prompt · ROUTE→log+allow (no peers B1)
        await pending[requestId]  OR  timeoutMs → DENY
 7. final result:
        success + changes → git diff → file_change events → ONE squash commit → done
        success + NO changes → done{note:"no changes"}, skip commit
        error subtype → error{from errors[]}, no commit
        ledger.add(agentId, result.total_cost_usd)
 8. Scheduler: done → IntegrationCoordinator.integrate(A,branch); complete
 9. graph.isDone → ScheduleResult; CLI prints status + ledger total + integration tip
```

## 7. Error handling & safety

| Failure | Handling |
|---|---|
| `canUseTool` GATE/route never resolves | `timeoutMs` fires → resolve pending as **deny** (with reason) so the SDK never hangs |
| SDK `result` error subtype (`error_max_turns`/`error_during_execution`/`error_max_budget_usd`) | emit `error`; branch **abandoned, not merged**; node not completed → Scheduler reports it `blocked` |
| `interrupt()` | `abortController.abort()`; no commit; branch abandoned |
| Agent makes no file changes | empty-result: `done` with note, no commit, integrate is a no-op |
| Agent attempts git | blocked by `disallowedTools:["Bash(git*)"]`; auto-commit remains sole committer |
| SDK throws / network error | caught in `startTask` → `error` event; branch abandoned |
| Runaway cost | per-agent SDK `maxTurns` (from `Budget`) + `CostLedger`; B1 **reports** total, leaves team-ceiling seam for B2 |

**Limitations & safety:** a worktree isolates the **git working tree, not the OS process**. A headless Claude with `Bash`/`Write` under Autopilot can touch anything the OS user can (`rm` on an absolute path, network, `git push`) — none of which the worktree contains. **B1 is not OS-sandboxed.** The only guardrails are the tool→category classifier + the Credential/Destructive hard-rules. Therefore B1 defaults to a conservative `allowedTools` (**only** read-only Read/Glob/Grep auto-approved; **every mutating tool — Write/Edit/Bash/WebFetch/WebSearch — routes through `canUseTool`** so the broker policy is authoritative and a stricter preset in B2 can actually gate them), and the classifier's hard-rules get **explicit unit tests** rather than relying on a green Autopilot run to catch a miscategorization.

**Mock/prod divergence:** the recorded SDK stream is a snapshot of one SDK version's message shapes; the SDK is fast-moving. The manual live smoke is the divergence guard, and **fixtures are re-recorded from each live smoke run**.

## 8. Testing

- **`event-mapper` (pure unit):** recorded `SDKMessage` fixtures → expected `AgentEvent[]` (text, tool_use, result success/error). The core proof.
- **`tool-category` (unit, safety-critical):** the table, **especially hard-rules** — `Bash(rm …)`→destructive, credential patterns→credential — tested directly because Autopilot won't surface a miscategorization.
- **`permission-bridge` (unit):** fake broker → AUTO→allow, GATE→allow/deny, **timeout→deny**; **concurrency test: two `requestId`s pending at once resolve independently** (proves the multi-agent seam at N=1).
- **Integration, offline (single node):** injected recorded `query` generator + `NodeGitRunner` in a temp repo → Scheduler on a 1-node graph asserts: `file_change` emitted, one commit on the branch, `done` emitted, integration tip has the change, `.agent-context` absent (existing invariant), cost recorded.
- **Integration, offline (two independent nodes) — the multi-agent consideration, zero new product code:** two recorded streams writing **different** files run through the real Scheduler + WorktreeManager + IntegrationCoordinator → both branches merge clean, both costs aggregate, both `agentId`s appear on the feed.
- **Live smoke (manual, real creds):** one real goal in a throwaway temp repo; confirm a real diff + `done` + cost; **re-record fixtures** from this run.

## 9. Out of scope (B1)

- VS Code extension / Control Room webview → B2.
- CodeWhale / DeepSeek adapter → B3.
- Inter-agent bus messaging exercised with *real* agents, real merge conflicts, broker routing between real peers → needs B2/B3.
- Streaming/partial assistant messages (`includePartialMessages:true`) → B2 may need per-token feed; B1 uses `false`.
- Per-edit (incremental) `file_change` events via PostToolUse hooks → B1 batches diffs at `done`; B2 may revisit.
- Team-level cost-ceiling *enforcement* → seam only in B1.
- OS-level sandboxing of the agent process.

## 10. Open items for planning

- Exact pinned `@anthropic-ai/claude-agent-sdk` version + Claude model ID.
- Auth: confirm the SDK picks up CLI auth vs. `ANTHROPIC_API_KEY` from the environment; the live smoke needs whichever is present.
- Workspace tooling choice (npm vs pnpm workspaces) and whether `core` adopts a `package.json` `exports` map now.
- The destructive/credential regex set for `tool-category` (start conservative, expand from live-smoke observations).
- Whether the single-goal CLI builds a 1-node graph inline or accepts a supplied graph file (default: 1-node inline; graph-file flag optional).

---
Generated by claude-opus-4-7 · task completed
