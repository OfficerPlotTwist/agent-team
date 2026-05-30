# Host-VSCode + Control Room — Design

**Date:** 2026-05-29
**Status:** Approved design, pre-implementation-plan
**Builds on:** B1 (ClaudeAdapter + headless host), B2 (parallel team), core robustness pass — all on `master`.
**Slice:** Plan B — VS Code extension host (`host-vscode`) + minimal Control Room webview (live feed + action inbox).

---

## 1. Goal & intent

Replace the readline terminal host with a **VS Code extension** that wires the same `Scheduler + NodeGitRunner + ClaudeAdapter` stack behind a `vscode` activation command and routes permission decisions to a **Control Room webview panel** instead of stdin/stdout.

This proves:
- The composition root is host-agnostic — `composeVscode` mirrors `composeHeadless` exactly except for the permission bridge.
- GATE decisions flow through a real UI (Allow / Deny buttons in the webview) rather than readline.
- Live AgentEvents reach a persistent UI panel in real time.

### 1.1 What this defers

- Diff review panel (visual before/after for `file_change` events).
- Involvement Dial (AUTOPILOT ↔ GATE slider that writes `PolicyStore`).
- Multi-graph orchestration from the extension (single graph JSON in this pass).
- `adapters-deepseek` wiring (separate package; a later host version can swap in).
- VS Code test runner setup — live validation via `LIVE-SMOKE.md` (same discipline as `host-headless`).

---

## 2. Package boundaries

Zero changes to `packages/core`, `packages/adapters-claude`, or `packages/host-headless`.

```
packages/
  core/                   UNCHANGED
  adapters-claude/        UNCHANGED
  host-headless/          UNCHANGED
  adapters-deepseek/      (separate spec)
  host-vscode/        NEW  VS Code extension + Control Room webview
```

`host-vscode` is a **leaf app** (composition root) — not a library. It imports `@agent-team/core` (node subpath), `@agent-team/adapters-claude`, and `vscode` (peer dep).

Dependency graph:
```
host-vscode
  └── @agent-team/core/node   (NodeGitRunner, WorktreeManager, etc.)
  └── @agent-team/adapters-claude  (ClaudeAdapter, CostLedger)
  └── vscode (peer, ^1.85.0)
```

No new external npm packages.

---

## 3. Source layout

```
packages/host-vscode/
  src/
    extension.ts              # activate() / deactivate() — VS Code entry point
    compose.ts                # composeVscode() — own composition root, mirrors headless wiring
    control-room/
      panel.ts                # ControlRoomPanel — webview lifecycle, pushEvent, askGate
  media/
    control-room.html         # webview HTML entry (vanilla, no bundler)
    control-room.js           # webview client
    control-room.css          # minimal styles
  tests/
    panel.test.ts             # unit: mock webview, pushEvent + askGate round-trip
  package.json                # engines: { vscode: "^1.85.0" }
  tsconfig.json
  .vscodeignore
  LIVE-SMOKE.md
```

**Package boundary note:** `host-vscode` does NOT import from `host-headless`. Two leaf apps don't import each other. `composeVscode` is its own composition root that mirrors the headless wiring pattern — intentionally, not accidentally. This keeps both hosts independently deployable.

---

## 4. Extension activation & command

**`package.json` contributes:**
```json
{
  "activationEvents": ["onCommand:agent-team.run"],
  "contributes": {
    "commands": [{ "command": "agent-team.run", "title": "Agent Team: Run" }]
  }
}
```

**`activate(context)` in `extension.ts`:**
1. Register disposable for `agent-team.run`.
2. On command: open `ControlRoomPanel` (or reveal if already open).
3. Call `showOpenDialog` to pick a task-graph JSON file.
4. Call `composeVscode(graphPath, panel, context.extensionUri)` — fire-and-forget; errors surface as VS Code notifications.
5. Register panel disposal on `context.subscriptions`.

**`deactivate()`:** no-op (Scheduler cleanup is per-run, not extension-global).

---

## 5. `compose.ts` — `composeVscode`

`composeVscode` is its own composition root — it does NOT import from `host-headless`. It wires the same stack as `composeHeadless` with one difference: the `onGate` callback posts to the webview instead of calling readline.

```ts
export async function composeVscode(
  graphPath: string,
  panel: ControlRoomPanel,
): Promise<ScheduleResult>
```

Wiring (mirrors `composeHeadless` step for step):
1. Read + parse graph JSON → `TaskGraph`.
2. `new MessageBus()`, `new PolicyStore(); store.applyPreset("autopilot")`.
3. `new NodeGitRunner()`, `new WorktreeManager(git, repoRoot, new NoopContextProvider())`.
4. `new CostLedger()`, `new PendingPermissions()`.
5. `new ActionBroker(store, handlers)` where `handlers.gate` calls `opts.onGate`.
6. Subscribe `bus` → broker → `pending.resolve` (same as headless).
7. Subscribe `bus` → `panel.pushEvent(e)` (live feed — the only new line vs headless).
8. `new IntegrationCoordinator(git, worktrees, bus, repoRoot)`.
9. `new Scheduler({ bus, budget, graph, worktrees, integration, baseRef })`.
10. `adapterFor(node)` → `new ClaudeAdapter({ query, git, pending, ledger, model, maxTurns, permTimeoutMs })`.
11. Return `scheduler.run(adapterFor)`.

The `onGate` callback is `(req: ActionRequestEvent) => panel.askGate(req)`.

Cost ceiling (`BudgetExceededAdapter`) is deferred for `host-vscode` — it's a CLI concern in this pass.

---

## 6. `ControlRoomPanel` (`panel.ts`)

Single class — owns both the live feed (push) and the gate inbox (request/response).

```ts
export class ControlRoomPanel {
  static create(extensionUri: vscode.Uri): ControlRoomPanel

  /** Serialize a BusEvent and postMessage it to the live feed. */
  pushEvent(event: BusEvent): void

  /** Show a gate card in the action inbox. Resolves true=allow, false=deny.
   *  Resolves false automatically if the panel is disposed before a response. */
  askGate(req: ActionRequestEvent): Promise<boolean>

  dispose(): void
}
```

**Internal gate flow:**
1. `askGate` stores `pending: Map<requestId, (allow: boolean) => void>`.
2. Posts `{ type: "gate", requestId, category, summary, payload }` to webview.
3. `onDidReceiveMessage` handles `{ type: "allow"|"deny", requestId }` → looks up `pending`, calls resolver.
4. `dispose()` resolves all pending gates with `false`.

**Message protocol (extension ↔ webview):**
```ts
// extension → webview
type EventMessage = { type: "event"; payload: BusEvent }
type GateMessage  = { type: "gate"; requestId: string; category: string; summary: string; payload?: unknown }

// webview → extension
type AllowMessage = { type: "allow"; requestId: string }
type DenyMessage  = { type: "deny";  requestId: string }
```

`retainContextWhenHidden: true` — state survives tab switches.

Under `PolicyStore` autopilot preset, GATE fires only on hard-rule hits (credential/destructive). Most tool calls never reach `askGate`.

---

## 7. Control Room webview UI

Vanilla HTML/CSS/JS — no framework, no bundler. `media/` served via `webview.asWebviewUri`.

### 7.1 Live feed

Scrolling `<ul>`. Each `BusEvent` appended as a `<li>`:
- Timestamp (`seq` + local time)
- Kind badge (color-coded: `file_change` = blue, `done` = green, `error` = red, `action_request` = amber, others = grey)
- Truncated summary (path for `file_change`, summary text for others, truncated to 120 chars)

Auto-scrolls to bottom unless the user has manually scrolled up (detected via scroll position).

### 7.2 Action inbox

Fixed section below the feed. When a `GateMessage` arrives:
1. Append a card: `category` badge + `summary` + `payload` JSON (truncated to 200 chars) + **Allow** / **Deny** buttons.
2. On button click: `vscode.postMessage({ type: "allow"|"deny", requestId })`, remove the card.
3. Multiple pending gates stack as separate cards (parallel agents can gate simultaneously).

### 7.3 Styling

VS Code CSS variables only (`--vscode-editor-background`, `--vscode-button-background`, `--vscode-foreground`, etc.) — inherits the active theme, no custom color palette.

---

## 8. Tests

**`panel.test.ts`** (offline, no VS Code runtime — mock webview object):

```ts
// Mock implements: postMessage(msg), onDidReceiveMessage handler, disposed flag
```

- `pushEvent`: assert correct `EventMessage` shape posted.
- `askGate` → allow: post gate, fire inbound `AllowMessage`, assert resolves `true`.
- `askGate` → deny: post gate, fire inbound `DenyMessage`, assert resolves `false`.
- `askGate` + dispose: post gate, call `dispose()`, assert resolves `false`.
- Multiple concurrent gates: two `askGate` calls, respond in reverse order, assert both resolve correctly.

No vscode integration test runner setup in this pass. Live validation via `LIVE-SMOKE.md`.

---

## 9. Build & workspace integration

`tsconfig.json` excludes `media/` (plain JS, not compiled). References `packages/core/tsconfig.json` and `packages/adapters-claude/tsconfig.json`.

Root `package.json` build/test scripts gain `-w @agent-team/host-vscode` at the end (leaf — depends on everything upstream).

`.vscodeignore` excludes `src/`, `tests/`, `tsconfig.json`, `node_modules/` — packages only `dist/` and `media/`.

---

## 10. Locked decisions

- **`host-vscode` does NOT import `host-headless`.** Two leaf apps don't import each other; `composeVscode` is its own composition root.
- **`onGate` callback pattern.** `composeHeadless` already parameterizes the gate as `onGate?: (req) => Promise<boolean>`; `composeVscode` passes `panel.askGate` — no new interface needed.
- **`requestId` keys all gate round-trips.** Matches `ActionRequestEvent.requestId` from core; no invented `toolCallId`.
- **Vanilla webview UI.** No framework, no bundler — port-pure. React/Svelte is additive if the UI grows.
- **`retainContextWhenHidden: true`.** State survives tab switches.
- **Single graph per run.** Multi-graph scheduling from the extension is deferred.
- **Zero `packages/core` changes.** The composition root is fully outside core.
- **Autopilot preset by default.** Same as headless; the Involvement Dial is deferred.
