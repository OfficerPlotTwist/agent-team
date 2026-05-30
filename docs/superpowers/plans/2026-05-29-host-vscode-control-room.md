# host-vscode + Control Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@agent-team/host-vscode` — a VS Code extension that runs the agent team scheduler and shows a live feed + action inbox in a Control Room webview panel.

**Architecture:** New leaf package `packages/host-vscode/`. `composeVscode` mirrors `composeHeadless` with one substitution: `onGate` calls `panel.askGate(req)` instead of readline. `ControlRoomPanel` owns the webview lifecycle, `pushEvent` (live feed), and `askGate` (pending-promise gate inbox). Extension entry point registers a single command. Webview UI is vanilla HTML/CSS/JS.

**Tech Stack:** TypeScript ESM (NodeNext), `vscode` API (peer dep, ^1.85.0), `@agent-team/core`, `@agent-team/adapters-claude`, `@anthropic-ai/claude-agent-sdk`, `vitest` v2 (mocking `vscode` via `vi.mock`).

---

## File Map

| File | Responsibility |
|---|---|
| `packages/host-vscode/package.json` | Package manifest, peer dep on vscode |
| `packages/host-vscode/tsconfig.json` | TypeScript config (mirrors adapters-claude) |
| `packages/host-vscode/.vscodeignore` | Exclude src/tests from extension package |
| `packages/host-vscode/src/control-room/panel.ts` | `ControlRoomPanel` — webview lifecycle, `pushEvent`, `askGate` |
| `packages/host-vscode/src/compose.ts` | `composeVscode` — composition root |
| `packages/host-vscode/src/extension.ts` | `activate` / `deactivate` — VS Code entry point |
| `packages/host-vscode/media/control-room.html` | Webview HTML entry |
| `packages/host-vscode/media/control-room.js` | Webview client JS |
| `packages/host-vscode/media/control-room.css` | Webview styles (VS Code CSS vars) |
| `packages/host-vscode/tests/panel.test.ts` | `ControlRoomPanel` unit tests (mock vscode) |
| `packages/host-vscode/LIVE-SMOKE.md` | Manual smoke instructions |
| `package.json` (workspace root) | Add host-vscode to build/test scripts |

---

## Task 1: Package scaffold

**Files:**
- Create: `packages/host-vscode/package.json`
- Create: `packages/host-vscode/tsconfig.json`
- Create: `packages/host-vscode/.vscodeignore`

- [ ] **Step 1: Create directories**

```bash
mkdir -p "packages/host-vscode/src/control-room" \
         "packages/host-vscode/tests" \
         "packages/host-vscode/media"
```

- [ ] **Step 2: Write `packages/host-vscode/package.json`**

```json
{
  "name": "@agent-team/host-vscode",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/extension.js",
  "engines": { "vscode": "^1.85.0" },
  "activationEvents": ["onCommand:agent-team.run"],
  "contributes": {
    "commands": [
      { "command": "agent-team.run", "title": "Agent Team: Run" }
    ]
  },
  "files": ["dist", "media"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@agent-team/core": "*",
    "@agent-team/adapters-claude": "*",
    "@anthropic-ai/claude-agent-sdk": "0.3.154"
  },
  "peerDependencies": {
    "vscode": "^1.85.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/vscode": "^1.85.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Write `packages/host-vscode/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests", "media"]
}
```

- [ ] **Step 4: Write `packages/host-vscode/.vscodeignore`**

```
src/**
tests/**
tsconfig.json
node_modules/**
.gitignore
```

- [ ] **Step 5: Install the new package into the workspace**

```bash
npm install
```

Expected: `@agent-team/host-vscode` linked in workspace.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/host-vscode/package.json" \
            "vsCode Fork/packages/host-vscode/tsconfig.json" \
            "vsCode Fork/packages/host-vscode/.vscodeignore"
git commit -m "chore(host-vscode): package scaffold"
```

---

## Task 2: ControlRoomPanel — `pushEvent`

**Files:**
- Create: `packages/host-vscode/src/control-room/panel.ts`
- Create: `packages/host-vscode/tests/panel.test.ts` (first batch of tests)

- [ ] **Step 1: Write the failing test for `pushEvent`**

Create `packages/host-vscode/tests/panel.test.ts`:

```ts
import { it, expect, vi, beforeEach } from "vitest";

// vi.mock must be called before any import that uses 'vscode'
vi.mock("vscode", () => ({
  window: { createWebviewPanel: vi.fn() },
  ViewColumn: { Beside: 2 },
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) =>
      ({ toString: () => parts.join("/"), fsPath: parts.join("/") }),
  },
}));

import { ControlRoomPanel } from "../src/control-room/panel.js";
import * as vscode from "vscode";
import type { BusEvent, ActionRequestEvent } from "@agent-team/core";

// ── helpers ────────────────────────────────────────────────────────────────

function makeMockWebviewPanel() {
  let msgHandler: (msg: unknown) => void = () => {};
  const disposeHandlers: Array<() => void> = [];
  const posted: unknown[] = [];

  const webviewPanel = {
    webview: {
      html: "",
      cspSource: "vscode-resource:",
      asWebviewUri: (u: unknown) => u,
      postMessage: vi.fn((msg: unknown) => { posted.push(msg); return Promise.resolve(true); }),
      onDidReceiveMessage: (fn: (msg: unknown) => void) => {
        msgHandler = fn;
        return { dispose: vi.fn() };
      },
    },
    onDidDispose: (fn: () => void) => {
      disposeHandlers.push(fn);
      return { dispose: vi.fn() };
    },
    dispose: vi.fn(() => { disposeHandlers.forEach(fn => fn()); }),
    reveal: vi.fn(),
  };

  return {
    webviewPanel,
    posted,
    sendFromWebview: (msg: unknown) => msgHandler(msg),
    triggerDispose: () => disposeHandlers.forEach(fn => fn()),
  };
}

function fakeExtensionUri(): vscode.Uri {
  return { fsPath: "/ext", toString: () => "/ext" } as unknown as vscode.Uri;
}

function makeDoneEvent(): BusEvent {
  return { kind: "done", from: "coder#1", summary: "ok", seq: 1, ts: 0 };
}

function makeGateReq(requestId = "req-abc"): ActionRequestEvent {
  return { kind: "action_request", from: "coder#1", requestId, category: "destructive", summary: "delete x", timeoutMs: 30_000 };
}

// ── tests ──────────────────────────────────────────────────────────────────

beforeEach(() => vi.clearAllMocks());

it("pushEvent posts { type: 'event', payload } to the webview", () => {
  const { webviewPanel, posted } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());
  const event = makeDoneEvent();
  panel.pushEvent(event);
  expect(posted).toEqual([{ type: "event", payload: event }]);
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm run test -w @agent-team/host-vscode
```

Expected: fail with `Cannot find module '../src/control-room/panel.js'`

- [ ] **Step 3: Write minimal `ControlRoomPanel` with `pushEvent` only**

Create `packages/host-vscode/src/control-room/panel.ts`:

```ts
import * as vscode from "vscode";
import type { BusEvent, ActionRequestEvent } from "@agent-team/core";

export class ControlRoomPanel {
  readonly #panel: vscode.WebviewPanel;
  readonly #pending = new Map<string, (allow: boolean) => void>();

  private constructor(panel: vscode.WebviewPanel) {
    this.#panel = panel;

    panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { type?: string; requestId?: string };
      if ((m.type !== "allow" && m.type !== "deny") || typeof m.requestId !== "string") return;
      const resolve = this.#pending.get(m.requestId);
      if (!resolve) return;
      this.#pending.delete(m.requestId);
      resolve(m.type === "allow");
    });

    panel.onDidDispose(() => {
      for (const resolve of this.#pending.values()) resolve(false);
      this.#pending.clear();
    });
  }

  static create(extensionUri: vscode.Uri): ControlRoomPanel {
    const panel = vscode.window.createWebviewPanel(
      "agentTeamControlRoom",
      "Agent Team — Control Room",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );
    panel.webview.html = ControlRoomPanel.#getHtml(panel.webview, extensionUri);
    return new ControlRoomPanel(panel);
  }

  pushEvent(event: BusEvent): void {
    void this.#panel.webview.postMessage({ type: "event", payload: event });
  }

  askGate(req: ActionRequestEvent): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#pending.set(req.requestId, resolve);
      void this.#panel.webview.postMessage({
        type: "gate",
        requestId: req.requestId,
        category: req.category,
        summary: req.summary,
        payload: req.payload,
      });
    });
  }

  dispose(): void {
    this.#panel.dispose();
  }

  static #getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "control-room.js"),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "control-room.css"),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${String(cssUri)}">
  <title>Agent Team Control Room</title>
</head>
<body>
  <section id="feed-section">
    <h2>Live Feed</h2>
    <ul id="feed"></ul>
  </section>
  <section id="inbox-section">
    <h2>Action Inbox</h2>
    <div id="inbox"></div>
  </section>
  <script src="${String(scriptUri)}"></script>
</body>
</html>`;
  }
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm run test -w @agent-team/host-vscode
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add -f "vsCode Fork/packages/host-vscode/src/control-room/panel.ts" \
            "vsCode Fork/packages/host-vscode/tests/panel.test.ts"
git commit -m "feat(host-vscode): ControlRoomPanel skeleton + pushEvent test"
```

---

## Task 3: ControlRoomPanel — `askGate`

**Files:**
- Modify: `packages/host-vscode/tests/panel.test.ts` (add gate tests)
- No source changes needed — `askGate` is already implemented in Task 2

- [ ] **Step 1: Add `askGate` tests to `panel.test.ts`**

Append these tests to the existing file (after the `pushEvent` test):

```ts
it("askGate posts { type: 'gate', requestId, ... } then resolves true on allow", async () => {
  const { webviewPanel, posted, sendFromWebview } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());
  const req = makeGateReq("req-1");
  const promise = panel.askGate(req);

  expect(posted.at(-1)).toMatchObject({ type: "gate", requestId: "req-1", category: "destructive" });

  sendFromWebview({ type: "allow", requestId: "req-1" });
  expect(await promise).toBe(true);
});

it("askGate resolves false when webview sends deny", async () => {
  const { webviewPanel, sendFromWebview } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());
  const promise = panel.askGate(makeGateReq("req-2"));
  sendFromWebview({ type: "deny", requestId: "req-2" });
  expect(await promise).toBe(false);
});

it("askGate resolves false automatically when panel is disposed", async () => {
  const { webviewPanel, triggerDispose } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());
  const promise = panel.askGate(makeGateReq("req-3"));
  triggerDispose();
  expect(await promise).toBe(false);
});

it("multiple concurrent askGate calls resolve independently", async () => {
  const { webviewPanel, sendFromWebview } = makeMockWebviewPanel();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(
    webviewPanel as unknown as vscode.WebviewPanel,
  );
  const panel = ControlRoomPanel.create(fakeExtensionUri());

  const p1 = panel.askGate(makeGateReq("req-a"));
  const p2 = panel.askGate(makeGateReq("req-b"));

  // Respond in reverse order
  sendFromWebview({ type: "deny", requestId: "req-b" });
  sendFromWebview({ type: "allow", requestId: "req-a" });

  expect(await p1).toBe(true);
  expect(await p2).toBe(false);
});
```

- [ ] **Step 2: Run tests — expect all pass**

```bash
npm run test -w @agent-team/host-vscode
```

Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add -f "vsCode Fork/packages/host-vscode/tests/panel.test.ts"
git commit -m "test(host-vscode): askGate round-trip + concurrent gate tests"
```

---

## Task 4: Webview UI

**Files:**
- Create: `packages/host-vscode/media/control-room.html`
- Create: `packages/host-vscode/media/control-room.js`
- Create: `packages/host-vscode/media/control-room.css`

These files are served directly — no compilation. The HTML is generated in `panel.ts` via `#getHtml`; the standalone file here is a reference/fallback only if needed. The actual serving goes through `webview.asWebviewUri`.

- [ ] **Step 1: Write `packages/host-vscode/media/control-room.css`**

```css
:root {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
body {
  margin: 0; padding: 8px;
  display: flex; flex-direction: column; height: 100vh; box-sizing: border-box;
}
h2 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.05em; margin: 4px 0; opacity: 0.7; }
#feed-section { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
#feed { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 0; }
.feed-item { display: flex; align-items: baseline; gap: 6px; padding: 2px 0; font-size: 0.85em; border-bottom: 1px solid var(--vscode-editorGroup-border, #333); }
.time { opacity: 0.5; min-width: 72px; flex-shrink: 0; }
.badge { padding: 1px 6px; border-radius: 3px; font-size: 0.78em; color: #fff; white-space: nowrap; flex-shrink: 0; }
.text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#inbox-section { max-height: 40vh; overflow-y: auto; border-top: 1px solid var(--vscode-editorGroup-border, #333); padding-top: 4px; margin-top: 4px; }
.gate-card { background: var(--vscode-editor-inactiveSelectionBackground, #2a2a2a); border-radius: 4px; padding: 8px; margin-bottom: 6px; }
.gate-header { font-weight: bold; margin-bottom: 4px; }
.gate-payload { font-size: 0.8em; opacity: 0.8; margin: 4px 0; overflow: hidden; max-height: 60px; white-space: pre; }
.gate-actions { display: flex; gap: 6px; margin-top: 6px; }
button { padding: 3px 12px; border: none; border-radius: 3px; cursor: pointer; font-size: 0.85em; }
.btn-allow { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn-deny { background: var(--vscode-button-secondaryBackground, #555); color: var(--vscode-button-secondaryForeground, #ccc); }
```

- [ ] **Step 2: Write `packages/host-vscode/media/control-room.js`**

```js
// @ts-check
// Runs inside the VS Code webview sandbox — no Node APIs.

const vscode = acquireVsCodeApi();
const feed = /** @type {HTMLUListElement} */ (document.getElementById("feed"));
const inbox = /** @type {HTMLDivElement} */ (document.getElementById("inbox"));
let userScrolled = false;

if (feed) {
  feed.addEventListener("scroll", () => {
    userScrolled = feed.scrollTop + feed.clientHeight < feed.scrollHeight - 20;
  });
}

const BADGE_COLORS = /** @type {Record<string, string>} */ ({
  file_change: "#4a9eff",
  done: "#4caf50",
  error: "#f44336",
  action_request: "#ff9800",
  tool_call: "#9c7cff",
  message: "#888",
});

window.addEventListener("message", (/** @type {MessageEvent} */ event) => {
  const msg = /** @type {{ type: string; payload?: unknown; requestId?: string; category?: string; summary?: string; payload?: unknown }} */ (event.data);
  if (msg.type === "event") appendToFeed(/** @type {Record<string,unknown>} */ (msg.payload));
  if (msg.type === "gate") appendGateCard(msg);
});

/**
 * @param {Record<string, unknown>} event
 */
function appendToFeed(event) {
  if (!feed) return;
  const li = document.createElement("li");
  li.className = "feed-item";

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date().toLocaleTimeString();

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = String(event["kind"] ?? "");
  badge.style.backgroundColor = BADGE_COLORS[String(event["kind"])] ?? "#888";

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = summarize(event);

  li.append(time, badge, text);
  feed.appendChild(li);
  if (!userScrolled) feed.scrollTop = feed.scrollHeight;
}

/**
 * @param {Record<string, unknown>} e
 * @returns {string}
 */
function summarize(e) {
  const kind = String(e["kind"]);
  if (kind === "file_change") return String(e["path"] ?? "");
  if (kind === "done") return `${e["from"]}: ${String(e["summary"] ?? "").slice(0, 120)}`;
  if (kind === "error") return `${e["from"]}: ${String(e["message"] ?? "").slice(0, 120)}`;
  if (kind === "action_request") return `${e["from"]} [${e["category"]}] ${String(e["summary"] ?? "").slice(0, 120)}`;
  if (kind === "tool_call") return `${e["from"]} → ${e["name"]}`;
  if (kind === "message") return `${e["from"]}: ${String(e["text"] ?? "").slice(0, 120)}`;
  return "";
}

/**
 * @param {{ requestId?: string; category?: string; summary?: string; payload?: unknown }} msg
 */
function appendGateCard(msg) {
  if (!inbox) return;
  const card = document.createElement("div");
  card.className = "gate-card";

  const header = document.createElement("div");
  header.className = "gate-header";
  header.textContent = `[${msg.category ?? "?"}] ${msg.summary ?? ""}`;

  const payload = document.createElement("pre");
  payload.className = "gate-payload";
  payload.textContent = msg.payload
    ? JSON.stringify(msg.payload, null, 2).slice(0, 200)
    : "";

  const actions = document.createElement("div");
  actions.className = "gate-actions";

  const allow = document.createElement("button");
  allow.className = "btn-allow";
  allow.textContent = "Allow";
  allow.addEventListener("click", () => {
    vscode.postMessage({ type: "allow", requestId: msg.requestId });
    card.remove();
  });

  const deny = document.createElement("button");
  deny.className = "btn-deny";
  deny.textContent = "Deny";
  deny.addEventListener("click", () => {
    vscode.postMessage({ type: "deny", requestId: msg.requestId });
    card.remove();
  });

  actions.append(allow, deny);
  card.append(header, payload, actions);
  inbox.appendChild(card);
}
```

- [ ] **Step 3: Write `packages/host-vscode/media/control-room.html`** (standalone reference file — not loaded by the extension, which inlines URIs via `#getHtml`)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Team Control Room</title>
  <link rel="stylesheet" href="control-room.css">
</head>
<body>
  <section id="feed-section">
    <h2>Live Feed</h2>
    <ul id="feed"></ul>
  </section>
  <section id="inbox-section">
    <h2>Action Inbox</h2>
    <div id="inbox"></div>
  </section>
  <script src="control-room.js"></script>
</body>
</html>
```

- [ ] **Step 4: Commit**

```bash
git add -f "vsCode Fork/packages/host-vscode/media/control-room.html" \
            "vsCode Fork/packages/host-vscode/media/control-room.js" \
            "vsCode Fork/packages/host-vscode/media/control-room.css"
git commit -m "feat(host-vscode): Control Room webview UI (feed + gate inbox)"
```

---

## Task 5: `composeVscode`

**Files:**
- Create: `packages/host-vscode/src/compose.ts`

No unit test — this is a composition root (integration-tested by live smoke only, same discipline as `host-headless/compose.ts`).

- [ ] **Step 1: Write `packages/host-vscode/src/compose.ts`**

```ts
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  IntegrationCoordinator,
  Scheduler,
  NoopContextProvider,
  TaskGraph,
} from "@agent-team/core";
import type {
  TaskNode,
  BusEvent,
  ActionRequestEvent,
  AgentId,
  Role,
  BrokerHandlers,
  AgentAdapter,
  ScheduleResult,
} from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import {
  ClaudeAdapter,
  PendingPermissions,
  CostLedger,
  type QueryFn,
} from "@agent-team/adapters-claude";
import type { ControlRoomPanel } from "./control-room/panel.js";

const BASE_REF = "agentteam/integration";

async function ensureIntegrationBranch(repoRoot: string): Promise<void> {
  const git = new NodeGitRunner();
  const result = await git.run(["rev-parse", "--verify", BASE_REF], repoRoot);
  if (result.code !== 0) {
    await git.run(["branch", BASE_REF], repoRoot);
  }
}

export async function composeVscode(
  graphPath: string,
  panel: ControlRoomPanel,
): Promise<ScheduleResult> {
  const repoRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoRoot) throw new Error("No workspace folder open — open a git repo first.");

  await ensureIntegrationBranch(repoRoot);

  const graph = new TaskGraph(
    JSON.parse(readFileSync(graphPath, "utf8")) as TaskNode[],
  );

  const git = new NodeGitRunner();
  const bus = new MessageBus();
  const ledger = new CostLedger();
  const pending = new PendingPermissions();
  const store = new PolicyStore();
  store.applyPreset("autopilot");

  const handlers: BrokerHandlers = {
    gate: (req: ActionRequestEvent, _from: AgentId) => {
      void panel.askGate(req).then((allow) =>
        pending.resolve(
          req.requestId,
          allow
            ? { behavior: "allow" }
            : { behavior: "deny", message: "denied at gate" },
        ),
      );
    },
    route: (_req: ActionRequestEvent, _from: AgentId, _to: Role) => {},
    notify: (_req: ActionRequestEvent, _from: AgentId) => {},
  };
  const broker = new ActionBroker(store, handlers);

  bus.subscribe((e: BusEvent) => {
    if (e.kind !== "action_request") return;
    if (!pending.has(e.requestId)) return;
    const res = broker.handle(e);
    if (res.mode !== "GATE") {
      pending.resolve(e.requestId, { behavior: "allow" });
    }
  });

  // Forward every bus event to the live feed
  bus.subscribe((e: BusEvent) => panel.pushEvent(e));

  const worktrees = new WorktreeManager(git, repoRoot, new NoopContextProvider());
  const integration = new IntegrationCoordinator(git, worktrees, bus, repoRoot);
  const scheduler = new Scheduler({
    bus,
    budget: { maxTurns: 50 },
    graph,
    worktrees,
    integration,
    baseRef: BASE_REF,
  });

  const adapterFor = (_node: TaskNode): AgentAdapter =>
    new ClaudeAdapter({
      query: query as unknown as QueryFn,
      git,
      pending,
      ledger,
      model: "claude-opus-4-8",
      maxTurns: 50,
      permTimeoutMs: 60_000,
    });

  return scheduler.run(adapterFor);
}
```

- [ ] **Step 2: Build the package — expect clean**

```bash
npm run build -w @agent-team/host-vscode
```

Expected: exit 0. If you see `Module '"@agent-team/core"' has no exported member 'TaskGraph'` or similar, check that `@agent-team/core` is built first (`npm run build -w @agent-team/core`).

- [ ] **Step 3: Commit**

```bash
git add -f "vsCode Fork/packages/host-vscode/src/compose.ts"
git commit -m "feat(host-vscode): composeVscode composition root"
```

---

## Task 6: Extension entry point

**Files:**
- Create: `packages/host-vscode/src/extension.ts`

- [ ] **Step 1: Write `packages/host-vscode/src/extension.ts`**

```ts
import * as vscode from "vscode";
import { ControlRoomPanel } from "./control-room/panel.js";
import { composeVscode } from "./compose.js";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("agent-team.run", async () => {
      const panel = ControlRoomPanel.create(context.extensionUri);
      context.subscriptions.push({ dispose: () => panel.dispose() });

      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { "Task Graph": ["json"] },
        title: "Select a task graph JSON file",
      });
      if (!uris?.[0]) {
        panel.dispose();
        return;
      }

      try {
        const result = await composeVscode(uris[0].fsPath, panel);
        void vscode.window.showInformationMessage(
          `Agent Team done — status: ${result.status} | completed: ${result.completed.join(", ") || "none"} | blocked: ${result.blocked.join(", ") || "none"}`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`Agent Team error: ${String(err)}`);
      }
    }),
  );
}

export function deactivate(): void {
  // No persistent state to clean up — each run is self-contained
}
```

- [ ] **Step 2: Build — expect clean**

```bash
npm run build -w @agent-team/host-vscode
```

Expected: exit 0.

- [ ] **Step 3: Run tests — all 5 still pass**

```bash
npm run test -w @agent-team/host-vscode
```

Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add -f "vsCode Fork/packages/host-vscode/src/extension.ts"
git commit -m "feat(host-vscode): activate/deactivate extension entry point"
```

---

## Task 7: Workspace integration + LIVE-SMOKE.md

**Files:**
- Modify: `package.json` (workspace root)
- Create: `packages/host-vscode/LIVE-SMOKE.md`

- [ ] **Step 1: Update root `package.json`**

Add `host-vscode` at the end of build and test scripts (leaf — depends on everything):

```json
{
  "name": "agent-team-workspace",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build -w @agent-team/core && npm run build -w @agent-team/adapters-claude && npm run build -w @agent-team/adapters-deepseek && npm run build -w @agent-team/host-headless && npm run build -w @agent-team/host-vscode",
    "test": "npm run test -w @agent-team/core && npm run test -w @agent-team/adapters-claude && npm run test -w @agent-team/adapters-deepseek && npm run test -w @agent-team/host-headless && npm run test -w @agent-team/host-vscode",
    "build:core": "npm run build -w @agent-team/core"
  }
}
```

Note: if `adapters-deepseek` does not exist yet (other sub-project still in progress), omit that entry for now and add it once both are complete.

- [ ] **Step 2: Write `packages/host-vscode/LIVE-SMOKE.md`**

```markdown
# host-vscode Live Smoke

Manual validation checklist. Run after every structural change to `composeVscode` or `ControlRoomPanel`.

## Prerequisites

- VS Code 1.85+
- A git repo open as the workspace folder (use the same repo as `host-headless` live smoke)
- `agentteam/integration` branch exists (or will be created automatically)
- Claude Code CLI auth present at `~/.claude/.credentials.json`

## Build

```bash
npm run build -w @agent-team/host-vscode
```

## Install the extension (dev mode)

In VS Code: **Run > Start Debugging** with a launch config pointing to `packages/host-vscode/dist/extension.js`, or use the Extension Development Host:

1. Open `packages/host-vscode/` in VS Code
2. Press F5 (or Run > Start Debugging)
3. A new Extension Development Host window opens

## Smoke steps

### 1. Run a single-node graph

Create `/tmp/smoke-graph.json`:
```json
[{ "id": "n1", "role": "coder", "goal": "write a file called hello.txt containing the text hello world", "dependsOn": [] }]
```

In the Extension Development Host:
1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **"Agent Team: Run"**
3. Select `smoke-graph.json` when prompted
4. The Control Room panel opens

**Expected:**
- Live feed shows `tool_call` and `file_change` events as the agent works
- `done` event appears when the agent finishes
- VS Code notification: "Agent Team done — status: completed | completed: n1 | blocked: none"
- Verify `hello.txt` committed to `agentteam/integration`:
  ```bash
  git show agentteam/integration:hello.txt
  ```

### 2. Verify gate card (GATE path)

Temporarily change `store.applyPreset("autopilot")` in `compose.ts` to `store.applyPreset("gatekeep")`, rebuild, and re-run the smoke.

**Expected:**
- A gate card appears in the Action Inbox with Allow / Deny buttons
- Clicking Allow unblocks the agent
- Clicking Deny causes an error event in the feed

Revert the preset change after confirming.

### 3. Verify retain-context

While a run is in progress:
1. Switch to another editor tab (hides the webview)
2. Switch back to the Control Room tab

**Expected:** Feed log is intact (no blank panel, no reset to empty).

## Pass criteria

- [ ] Live feed populates during run
- [ ] Gate card appears and resolves correctly
- [ ] `done` event and VS Code notification fire on completion
- [ ] `hello.txt` present in `agentteam/integration`
- [ ] Panel state survives tab switch
```

- [ ] **Step 3: Run full workspace build**

```bash
npm run build
```

Expected: exit 0 for all packages.

- [ ] **Step 4: Run full workspace tests**

```bash
npm run test
```

Expected: 70 + 27 + 19 + 8 + 5 = **129 tests pass** (the 19 is adapters-deepseek; if that package isn't complete yet, total is 110).

- [ ] **Step 5: Commit**

```bash
git add -f "vsCode Fork/package.json" \
            "vsCode Fork/packages/host-vscode/LIVE-SMOKE.md"
git commit -m "chore(host-vscode): workspace integration + live smoke doc"
```
