# Agent-Team Dev Environment — Design (S1: Talking Team Core)

**Date:** 2026-05-26
**Status:** Approved design, pre-implementation-plan
**Scope of this spec:** Sub-project **S1** only (the first slice). S2–S4 are sketched for context but out of scope.

---

## 1. Goal & intent

A **personal power-tool**: a VS Code environment where a *team of specialist agents* splits a goal into sub-tasks, **talks to each other** to coordinate, and produces work you review — with a **tunable human-involvement layer** that lets you be as in-the-loop or hands-off as you want, per agent and per kind of action.

Not a distributed product. Not a source fork. Built as a **VS Code extension layer** on stock VS Code so there is no upstream-rebase burden.

## 2. Decomposition (full vision)

| # | Sub-project | Adds | Status |
|---|---|---|---|
| **S1** | **Talking Team Core** | Lead decomposes a goal, spawns specialists, they work + message over a refereed bus, Action Broker routes escalations, Lead integrates & declares done. | **This spec** |
| S2 | Parallel isolation | Worktree-per-agent; truly parallel edits; Lead merges branches. | Later |
| S3 | Deep editor fusion | Native inline diffs in the editor, jump-to-file, decorations, run tasks/debug. | Later |
| S4 | Ambient agents | Background triggers (on-save/on-commit) that act and post to a feed. | Later |

**Why S1 first:** it proves the novel, risky thesis — that a lead-refereed *talking* team produces better results than one agent — and everything else is additive on top.

## 3. Locked decisions

- **Form factor:** VS Code extension + webview panel ("Control Room"). No fork.
- **Topology:** hierarchical **Lead + specialists**, with a **mediated message bus** the Lead referees. Specialists may message each other by role, but traffic is visible to the Lead, who can break ties and call "done."
- **Runtime:** heterogeneous backends behind a common **Agent Adapter** interface.
  - S1 ships two adapters: **Claude** (Claude Agent SDK, in-process) and **CodeWhale** (`Hmbown/CodeWhale`, a DeepSeek-backed CLI agent run as a local HTTP/SSE sidecar).
  - Raw DeepSeek-API adapter **dropped as redundant** — CodeWhale already wraps DeepSeek as a full runtime and avoids the `reasoning_content` state-machine gotcha.
- **Editing model:** **propose-diff** — specialists stage diffs, never write the workspace directly (avoids parallel-write conflicts in v1). Worktree isolation deferred to S2.
- **Human-in-the-loop:** **Action Broker** + **Involvement Dial** (see §6).
- **Roster:** Lead, Architect, Coder, Reviewer, **Ops** (privileged fulfiller for routed external/destructive actions).

## 4. Architecture

Two processes (extension host ↔ webview via `postMessage`), plus child runtimes.

```
┌─ VS Code Extension Host (Node) ──────────────────────────────┐
│  Orchestrator (Lead controller)                              │
│    • lifecycle · turn/token budget · termination             │
│                                                              │
│  Message Bus  ── in-proc pub/sub, envelopes ────────┐        │
│    {from, to:role|instance, kind, payload, seq}      │        │
│    Lead subscribes to ALL (referee)                  ▼        │
│  Agent Adapter Registry        Action Broker                 │
│    • Claude adapter            • classify (category)         │
│      (Agent SDK query())       • lookup Policy Table         │
│    • CodeWhale adapter           (agent × category)          │
│      (sidecar HTTP/SSE)        • GATE→UI / ROUTE→agent /      │
│    each NORMALIZES to:           NOTIFY / AUTO               │
│    message·tool_call·          • hard rules (cred/destruct)  │
│    file_change·action_request· Policy Store · Diff Store      │
│    done                        Sidecar Manager               │
└──────────┬──────────────────────────────────────────────────┘
           ├─► Claude (in-process SDK)
           └─► codewhale serve --http (child proc, loopback + bearer)
┌─ Webview "Control Room" ─────────────────────────────────────┐
│  Goal input · Roster+status · Live bus feed ·                │
│  Action inbox (GATE) · Diff review · Involvement Dial         │
└──────────────────────────────────────────────────────────────┘
```

**Load-bearing idea:** Bus, Broker, and Orchestrator speak **only** the normalized event vocabulary. Adapters translate each backend's native stream into it. Every backend's "someone must approve/do this" normalizes to one `action_request` → the Broker — the single chokepoint that makes heterogeneous backends + the Involvement Dial tractable.

### 4.1 Components & boundaries (each independently testable)

| Unit | Does | Depends on |
|---|---|---|
| **Agent Adapter** | native backend stream → normalized events; expose `startTask / interrupt / steer / resume` | a backend (Claude SDK / CodeWhale sidecar) |
| **Message Bus** | pub/sub of envelopes; addressing by role/instance; broadcast; cycle detection | — |
| **Action Broker** | classify `action_request`, look up Policy Table, resolve to GATE/ROUTE/NOTIFY/AUTO, enforce hard rules | Policy Store, Bus, Webview |
| **Orchestrator (Lead controller)** | decompose, spawn specialists, budget, termination | Adapters, Bus |
| **Policy Store** | persist per-agent×per-category table + presets | VS Code settings |
| **Diff Store** | stage proposed diffs, apply on approval, discard on reject | VS Code edit API |
| **Sidecar Manager** | spawn/health-check/restart/kill `codewhale serve` | child_process |
| **Webview (Control Room)** | pure view over state; goal input; controls | extension host via postMessage |

### 4.2 Normalized event vocabulary

`message` · `tool_call` · `file_change` (proposed diff) · `action_request` · `done` · `error`.
Adapters MUST map their native approval/permission hooks to `action_request` (Claude `canUseTool` callback; CodeWhale `approval.required` SSE event).

### 4.3 Adapter notes (from research, 2026-05)

- **Claude:** Claude Agent SDK; in-process; owns its own loop, tools, MCP, subagents. Subagents are opaque below the runtime boundary (not addressable on our Bus — by design).
- **CodeWhale (`Hmbown/CodeWhale`):** Rust CLI, DeepSeek-first. Drive via `codewhale serve --http --auth-token <generated>` on loopback; thread/turn model (`POST /v1/threads`, `POST /v1/threads/{id}/turns`), SSE event stream (`item.delta` kinds: `agent_message`/`tool_call`/`file_change`/`command_execution`; plus `approval.required`), `since_seq` replay. Auth = local bearer token. Uses `DEEPSEEK_API_KEY` under the hood. **Pre-1.0, fast-moving (v0.8.x) — pin a version.** No SDK: we own the HTTP/SSE client + normalization.

## 5. Data flow (lifecycle of one goal)

1. **Goal in** — webview → `postMessage` → Orchestrator.
2. **Decompose** — Lead breaks goal into sub-tasks; spawns specialists (adapter instance per role, Claude or CodeWhale per role-capability map).
3. **Work + talk** — specialists run; every utterance/tool-call/diff/request → normalized event on the Bus. Specialists address each other by role; Lead sees all.
4. **Action requests** — out-of-scope need → `action_request` → Broker classifies → Policy Table lookup → GATE (Action Inbox) / ROUTE (fulfiller agent, e.g. Ops) / NOTIFY (feed) / AUTO.
5. **Diffs** — changes staged in Diff Store as proposals; Reviewer signs off (agent) and/or you approve (GATE) → applied via VS Code edit API.
6. **Converge** — Lead declares goal met (or budget trips) → `done` → final summary to webview.

## 6. Action Broker & Involvement Dial

Every `action_request` is classified on two axes.

**Who can fulfill:** Human (you) · peer/external agent · privileged tool-agent (Ops).
**Kind of request:** Approval/sign-off · Credential/secret · Judgment/taste · External action · Destructive confirm · Information/answer.

**Handling modes:** **GATE** (pause, human OK) · **ROUTE** (hand to fulfiller agent) · **NOTIFY** (do it, show in feed) · **AUTO** (silent).

**Granularity:** **per-agent × per-category** policy table. Three **presets** (Co-pilot / Pair / Autopilot) stamp the whole table at once; individual cells overridable.

**Hard rules (non-overridable by presets):** *Credential/secret* and *Destructive confirm* stay **GATE** unless the user explicitly forces otherwise per cell.

**Example table — "Pair" preset** (GATE=you · ROUTE→X · NOTIFY · AUTO · —=N/A):

| Agent | Approval | Credential | Judgment | External action | Destructive | Info |
|---|---|---|---|---|---|---|
| Lead | AUTO | GATE | GATE | ROUTE→Ops | GATE | AUTO |
| Architect | NOTIFY | GATE | ROUTE→Lead | — | — | AUTO |
| Coder | ROUTE→Reviewer | GATE | ROUTE→Lead | ROUTE→Ops | GATE | ROUTE→Lead |
| Reviewer | AUTO | GATE | ROUTE→Lead | — | — | AUTO |
| Ops | NOTIFY | GATE | — | NOTIFY | GATE | AUTO |

The two `External action` cells (Coder `ROUTE→Ops` vs Ops `NOTIFY`) demonstrate why per-agent granularity is required: same category, different trust per role.

## 7. Error handling

- **Termination (3 independent stops):** Lead declares goal met · global turn/token budget exhausted · user Stop. First to fire wins; all agents get cancel.
- **Deadlock:** every request carries a timeout → on expiry escalate to Lead → if unresolved, GATE to user. Bus cycle detection (A→B→C→A) → Lead breaks it.
- **Adapter/sidecar crash:** Claude error → error event, agent failed, Lead retries/reassigns. CodeWhale sidecar death → Sidecar Manager restarts once (with `since_seq` replay); second failure → fail agent, notify user.
- **Budget guardrail:** per-agent and per-team token ceilings; approaching → NOTIFY; hitting → forced termination with partial summary. No silent overspend.

## 8. Testing

- **Adapter conformance:** shared suite every adapter passes against a deterministic **fake backend**; assert correct normalized vocabulary incl. native-approval → `action_request` mapping.
- **Bus:** addressing/broadcast/ordering; cycle detection.
- **Broker:** table-driven `(agent, category, preset) → expected mode`; hard-rule tests (Credential/Destructive always GATE on Autopilot).
- **Orchestrator:** termination races, budget cutoffs with scripted agents.
- **Diff Store:** stage → approve → apply; reject discards cleanly.
- **E2E smoke:** one tiny real goal through Claude + CodeWhale; assert a diff is proposed and a gated request pauses.

## 9. Out of scope (S1)

- Parallel worktree editing (S2).
- Native in-editor inline diffs / decorations (S3).
- Ambient/background-trigger agents (S4).
- Raw DeepSeek-API adapter (redundant with CodeWhale).
- Distribution/packaging/branding (this is a personal tool).

## 10. Open items to resolve in planning

- Exact specialist roster instantiation per goal (fixed vs. Lead-chosen subset).
- CodeWhale version to pin + its exact tool-call JSON schema (read `TOOL_SURFACE.md`/source).
- Policy Table persistence location (workspace vs. global settings).
- Webview framework choice (plain TS vs. a lightweight UI lib).
