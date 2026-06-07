# host-web Control Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@agent-team/host-web` — a browser Control Room (live feed + gate inbox + S6 proposal review) served by a single Node process that owns the run, per spec `docs/superpowers/specs/2026-06-07-host-web-control-room-design.md`.

**Architecture:** New leaf package mirroring `composeHeadless`'s wiring (broker/autopilot/memory/worktrees/scheduler) with three new web parts: a seq-stamped ring buffer + WebSocket server (`ws`), a fail-closed GateBridge, and a ProposalsService wrapping core's `ProposalCoordinator`. UI is vanilla TS built by vite into `ui/dist`, served statically by the same server; the feed uses the pretext virtualizer pattern proven by the 2026-06-06/07 spikes.

**Tech Stack:** TypeScript ESM (NodeNext), `ws` ^8, vite ^6, `@chenglou/pretext` 0.0.7 (UI bundle only), vitest.

**Invariants (from spec):**
- ZERO diff outside `packages/host-web` except: root `package.json` (workspace build/test chains) + root lockfile.
- composeWeb does NOT import `@agent-team/host-headless`. Consequence: `BudgetExceededAdapter` (~25 lines) is DUPLICATED into host-web verbatim — accepted leaf-glue duplication, decided at plan time.
- Server binds `127.0.0.1` only.
- Gate fail-closed: zero clients + pending gates ⇒ deny after 5s grace.
- Current workspace suite is 181 green. Done gate: full `npm run build` exit 0 AND full `npm run test` green with count > 181.

**Conventions for the executor:**
- All paths relative to repo root `C:\Users\nik\Documents\AI\vsCode Fork` (use forward slashes in commands; git bash works).
- Run package tests with: `npm run test -w @agent-team/host-web` (append `-- tests/<file>.test.ts` for one file).
- This repo's tooling lesson: run git commands ONE at a time, never parallel-batched.
- Tests import package source as `../src/<mod>.js` (NodeNext ESM style, same as host-headless tests).

---

### Task 1: Package scaffold + protocol types

**Files:**
- Create: `packages/host-web/package.json`
- Create: `packages/host-web/tsconfig.json`
- Create: `packages/host-web/.gitignore`
- Create: `packages/host-web/src/protocol.ts`
- Modify: root `package.json` (build/test chains)

- [ ] **Step 1: Create `packages/host-web/package.json`**

```json
{
  "name": "@agent-team/host-web",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/compose.js",
  "bin": { "agent-team-web": "./dist/cli.js" },
  "files": ["dist", "ui/dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "build:ui": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "typecheck:ui": "tsc --noEmit -p tsconfig.ui.json"
  },
  "dependencies": {
    "@agent-team/core": "*",
    "@agent-team/adapters-claude": "*",
    "@anthropic-ai/claude-agent-sdk": "0.3.154",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@chenglou/pretext": "0.0.7",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.12",
    "playwright": "^1.60.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/host-web/tsconfig.json`** (host-vscode's, with `ui` excluded)

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
  "exclude": ["node_modules", "dist", "tests", "ui"]
}
```

- [ ] **Step 3: Create `packages/host-web/.gitignore`**

```
dist/
ui/dist/
node_modules/
```

- [ ] **Step 4: Create `packages/host-web/src/protocol.ts`** (types + one pure parser; parser is tested in Task 2)

```ts
import type {
  BusEvent,
  AmbientProposal,
  AcceptOutcome,
  RequestCategory,
} from "@agent-team/core";

/** Broadcast envelopes: seq-stamped by the ring buffer, buffered for resume-replay. */
export type BroadcastEnvelope =
  | { seq: number; type: "event"; payload: BusEvent }
  | { seq: number; type: "gate"; requestId: string; category: RequestCategory; summary: string }
  | { seq: number; type: "gate_resolved"; requestId: string; allowed: boolean }
  | { seq: number; type: "proposals"; items: AmbientProposal[] }
  | {
      seq: number;
      type: "proposal_outcome";
      branch: string;
      outcome: AcceptOutcome | { status: "rejected"; branch: string };
    };

/** Direct envelopes: connection-scoped replies, never buffered; seq is always 0. */
export type DirectEnvelope =
  | { seq: 0; type: "hello"; latestSeq: number; runState: "running" | "settled"; gapped?: true }
  | { seq: 0; type: "proposal_diff"; branch: string; diff: string };

export type ServerEnvelope = BroadcastEnvelope | DirectEnvelope;

export type ClientCommand =
  | { type: "allow"; requestId: string }
  | { type: "deny"; requestId: string }
  | { type: "proposal_show"; branch: string }
  | { type: "proposal_accept"; branch: string; onto?: string }
  | { type: "proposal_reject"; branch: string }
  | { type: "proposal_refresh" }
  | { type: "resume"; afterSeq: number };

/** Strict shape-check of an untrusted client message. Anything off ⇒ null. */
export function parseClientCommand(raw: unknown): ClientCommand | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "allow":
    case "deny":
      return typeof m.requestId === "string" ? { type: m.type, requestId: m.requestId } : null;
    case "proposal_show":
    case "proposal_reject":
      return typeof m.branch === "string" ? { type: m.type, branch: m.branch } : null;
    case "proposal_accept":
      if (typeof m.branch !== "string") return null;
      if (m.onto !== undefined && typeof m.onto !== "string") return null;
      return { type: "proposal_accept", branch: m.branch, onto: m.onto as string | undefined };
    case "proposal_refresh":
      return { type: "proposal_refresh" };
    case "resume":
      return typeof m.afterSeq === "number" && Number.isFinite(m.afterSeq)
        ? { type: "resume", afterSeq: m.afterSeq }
        : null;
    default:
      return null;
  }
}
```

- [ ] **Step 5: Wire root `package.json` chains.** In root `package.json`, replace the `build` and `test` scripts:

```json
"build": "npm run build -w @agent-team/core && npm run build -w @agent-team/adapters-claude && npm run build -w @agent-team/adapters-deepseek && npm run build -w @agent-team/host-headless && npm run build -w @agent-team/host-vscode && npm run build -w @agent-team/host-web",
"test": "npm run test -w @agent-team/core && npm run test -w @agent-team/adapters-claude && npm run test -w @agent-team/adapters-deepseek && npm run test -w @agent-team/host-headless && npm run test -w @agent-team/host-vscode && npm run test -w @agent-team/host-web",
```

- [ ] **Step 6: Install + build**

Run: `npm install`
Expected: exit 0, lockfile gains `ws` + vite/pretext devDeps.

Run: `npm run build -w @agent-team/host-web`
Expected: exit 0, `packages/host-web/dist/protocol.js` exists.

- [ ] **Step 7: Commit**

```bash
git add packages/host-web/package.json packages/host-web/tsconfig.json packages/host-web/.gitignore packages/host-web/src/protocol.ts package.json package-lock.json
git commit -m "feat(host-web): scaffold package + ws protocol types"
```

NOTE: `package-lock.json` already carries an unrelated pre-existing modification (an earlier stray install). Including it here is intended — it re-syncs the lockfile to the workspace.

---

### Task 2: RingBuffer + parseClientCommand tests

**Files:**
- Create: `packages/host-web/src/ring-buffer.ts`
- Test: `packages/host-web/tests/ring-buffer.test.ts`
- Test: `packages/host-web/tests/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/host-web/tests/ring-buffer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";
import type { BusEvent } from "@agent-team/core";

const evt = (text: string) =>
  ({ type: "event", payload: { kind: "message", from: "lead#1", text } as BusEvent }) as const;

describe("RingBuffer", () => {
  it("stamps monotonically increasing seqs starting at 1", () => {
    const ring = new RingBuffer(10);
    expect(ring.stamp(evt("a")).seq).toBe(1);
    expect(ring.stamp(evt("b")).seq).toBe(2);
    expect(ring.latestSeq()).toBe(2);
  });

  it("after(n) returns only envelopes with seq > n, in order", () => {
    const ring = new RingBuffer(10);
    ring.stamp(evt("a")); ring.stamp(evt("b")); ring.stamp(evt("c"));
    const { items, gapped } = ring.after(1);
    expect(items.map((e) => e.seq)).toEqual([2, 3]);
    expect(gapped).toBe(false);
  });

  it("overflow drops oldest and reports gapped for dropped ranges", () => {
    const ring = new RingBuffer(3);
    for (const t of ["a", "b", "c", "d", "e"]) ring.stamp(evt(t)); // seqs 1..5, buffer holds 3..5
    const dropped = ring.after(0);
    expect(dropped.items.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(dropped.gapped).toBe(true);
    const intact = ring.after(2);
    expect(intact.items.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(intact.gapped).toBe(false);
  });

  it("up-to-date and fresh-buffer resumes are empty and not gapped", () => {
    const ring = new RingBuffer(3);
    expect(ring.after(0)).toEqual({ items: [], gapped: false });
    ring.stamp(evt("a"));
    expect(ring.after(1)).toEqual({ items: [], gapped: false });
  });
});
```

`packages/host-web/tests/protocol.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseClientCommand } from "../src/protocol.js";

describe("parseClientCommand", () => {
  it("accepts well-formed commands", () => {
    expect(parseClientCommand({ type: "allow", requestId: "r1" })).toEqual({ type: "allow", requestId: "r1" });
    expect(parseClientCommand({ type: "resume", afterSeq: 7 })).toEqual({ type: "resume", afterSeq: 7 });
    expect(parseClientCommand({ type: "proposal_accept", branch: "b", onto: "main" }))
      .toEqual({ type: "proposal_accept", branch: "b", onto: "main" });
    expect(parseClientCommand({ type: "proposal_refresh" })).toEqual({ type: "proposal_refresh" });
  });

  it("rejects malformed or unknown messages", () => {
    expect(parseClientCommand(null)).toBeNull();
    expect(parseClientCommand("allow")).toBeNull();
    expect(parseClientCommand({ type: "allow" })).toBeNull();
    expect(parseClientCommand({ type: "resume", afterSeq: "7" })).toBeNull();
    expect(parseClientCommand({ type: "proposal_accept", branch: "b", onto: 3 })).toBeNull();
    expect(parseClientCommand({ type: "launch_missiles" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -w @agent-team/host-web`
Expected: FAIL — `Cannot find module '../src/ring-buffer.js'` (protocol tests may already pass; that's fine, the parser shipped in Task 1).

- [ ] **Step 3: Create `packages/host-web/src/ring-buffer.ts`**

```ts
import type { BroadcastEnvelope } from "./protocol.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A broadcast envelope before the ring buffer assigns its seq. */
export type UnstampedBroadcast = DistributiveOmit<BroadcastEnvelope, "seq">;

/** Fixed-capacity buffer of seq-stamped broadcasts; the resume-replay source. */
export class RingBuffer {
  readonly #capacity: number;
  readonly #items: BroadcastEnvelope[] = [];
  #nextSeq = 1;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("RingBuffer capacity must be >= 1");
    this.#capacity = capacity;
  }

  /** Assign the next seq, store, return the stamped envelope. */
  stamp(partial: UnstampedBroadcast): BroadcastEnvelope {
    const env = { ...partial, seq: this.#nextSeq++ } as BroadcastEnvelope;
    this.#items.push(env);
    if (this.#items.length > this.#capacity) this.#items.shift();
    return env;
  }

  latestSeq(): number {
    return this.#nextSeq - 1;
  }

  /** Envelopes with seq > afterSeq, plus whether part of that range was dropped. */
  after(afterSeq: number): { items: BroadcastEnvelope[]; gapped: boolean } {
    const oldest = this.#items[0]?.seq ?? this.#nextSeq;
    const gapped = afterSeq + 1 < oldest && this.latestSeq() > afterSeq;
    return { items: this.#items.filter((e) => e.seq > afterSeq), gapped };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -w @agent-team/host-web`
Expected: PASS (2 files, 6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host-web/src/ring-buffer.ts packages/host-web/tests/ring-buffer.test.ts packages/host-web/tests/protocol.test.ts
git commit -m "feat(host-web): seq ring buffer + client command parsing (TDD)"
```

---

### Task 3: GateBridge (fail-closed)

**Files:**
- Create: `packages/host-web/src/gate-bridge.ts`
- Test: `packages/host-web/tests/gate-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/host-web/tests/gate-bridge.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GateBridge } from "../src/gate-bridge.js";
import type { UnstampedBroadcast } from "../src/ring-buffer.js";

describe("GateBridge", () => {
  let broadcasts: UnstampedBroadcast[];
  let bridge: GateBridge;

  beforeEach(() => {
    vi.useFakeTimers();
    broadcasts = [];
    bridge = new GateBridge({ broadcast: (e) => broadcasts.push(e), graceMs: 5000 });
    bridge.clientConnected(); // default: one client present
  });
  afterEach(() => vi.useRealTimers());

  const ask = () =>
    bridge.askGate({ requestId: "r1", category: "destructive", summary: "rm -rf ./x" });

  it("broadcasts the gate and resolves true on allow (+ gate_resolved)", async () => {
    const p = ask();
    expect(broadcasts[0]).toMatchObject({ type: "gate", requestId: "r1" });
    bridge.command({ type: "allow", requestId: "r1" });
    await expect(p).resolves.toBe(true);
    expect(broadcasts[1]).toMatchObject({ type: "gate_resolved", requestId: "r1", allowed: true });
  });

  it("resolves false on deny", async () => {
    const p = ask();
    bridge.command({ type: "deny", requestId: "r1" });
    await expect(p).resolves.toBe(false);
  });

  it("first command wins; the duplicate is ignored", async () => {
    const p = ask();
    bridge.command({ type: "deny", requestId: "r1" });
    bridge.command({ type: "allow", requestId: "r1" });
    await expect(p).resolves.toBe(false);
    expect(broadcasts.filter((b) => b.type === "gate_resolved")).toHaveLength(1);
  });

  it("fails closed: pending gate with zero clients denies after the grace window", async () => {
    const p = ask();
    bridge.clientDisconnected(); // 1 -> 0
    vi.advanceTimersByTime(5001);
    await expect(p).resolves.toBe(false);
    expect(broadcasts.at(-1)).toMatchObject({ type: "gate_resolved", requestId: "r1", allowed: false });
  });

  it("a reconnect within the grace window cancels the deny", async () => {
    const p = ask();
    bridge.clientDisconnected();
    vi.advanceTimersByTime(2000);
    bridge.clientConnected(); // back before grace expiry
    vi.advanceTimersByTime(10_000);
    expect(bridge.pendingCount()).toBe(1); // still pending, not denied
    bridge.command({ type: "allow", requestId: "r1" });
    await expect(p).resolves.toBe(true);
  });

  it("a gate asked while zero clients are connected arms the grace timer itself", async () => {
    bridge.clientDisconnected(); // 0 clients
    const p = ask();
    vi.advanceTimersByTime(5001);
    await expect(p).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent-team/host-web -- tests/gate-bridge.test.ts`
Expected: FAIL — `Cannot find module '../src/gate-bridge.js'`.

- [ ] **Step 3: Create `packages/host-web/src/gate-bridge.ts`**

```ts
import type { RequestCategory } from "@agent-team/core";
import type { UnstampedBroadcast } from "./ring-buffer.js";

export interface GateBridgeOptions {
  broadcast: (env: UnstampedBroadcast) => void;
  /** How long pending gates survive with zero connected clients before denying. */
  graceMs?: number;
}

/**
 * Browser counterpart of ControlRoomPanel's gate semantics: requestId-keyed
 * pending map, first allow/deny wins, FAIL CLOSED when nobody is connected
 * to answer (panel dispose ⇒ deny becomes zero-clients + grace ⇒ deny).
 */
export class GateBridge {
  readonly #broadcast: (env: UnstampedBroadcast) => void;
  readonly #graceMs: number;
  readonly #pending = new Map<string, (allow: boolean) => void>();
  #clients = 0;
  #graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GateBridgeOptions) {
    this.#broadcast = opts.broadcast;
    this.#graceMs = opts.graceMs ?? 5_000;
  }

  askGate(req: { requestId: string; category: RequestCategory; summary: string }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.#pending.set(req.requestId, resolve);
      this.#broadcast({
        type: "gate",
        requestId: req.requestId,
        category: req.category,
        summary: req.summary,
      });
      this.#armGraceIfOrphaned();
    });
  }

  /** First allow/deny wins; later commands for the same id are ignored. */
  command(cmd: { type: "allow" | "deny"; requestId: string }): void {
    const resolve = this.#pending.get(cmd.requestId);
    if (!resolve) return;
    this.#pending.delete(cmd.requestId);
    resolve(cmd.type === "allow");
    this.#broadcast({ type: "gate_resolved", requestId: cmd.requestId, allowed: cmd.type === "allow" });
  }

  clientConnected(): void {
    this.#clients++;
    if (this.#graceTimer !== null) {
      clearTimeout(this.#graceTimer);
      this.#graceTimer = null;
    }
  }

  clientDisconnected(): void {
    this.#clients = Math.max(0, this.#clients - 1);
    this.#armGraceIfOrphaned();
  }

  pendingCount(): number {
    return this.#pending.size;
  }

  /** Fail closed: pending gates with no one to answer deny after the grace window. */
  #armGraceIfOrphaned(): void {
    if (this.#clients > 0 || this.#pending.size === 0 || this.#graceTimer !== null) return;
    this.#graceTimer = setTimeout(() => {
      this.#graceTimer = null;
      for (const [id, resolve] of this.#pending) {
        resolve(false);
        this.#broadcast({ type: "gate_resolved", requestId: id, allowed: false });
      }
      this.#pending.clear();
    }, this.#graceMs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent-team/host-web -- tests/gate-bridge.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host-web/src/gate-bridge.ts packages/host-web/tests/gate-bridge.test.ts
git commit -m "feat(host-web): fail-closed GateBridge (TDD)"
```

---

### Task 4: BudgetExceededAdapter copy

**Files:**
- Create: `packages/host-web/src/budget-guard.ts` (verbatim copy of `packages/host-headless/src/budget-guard.ts` — accepted duplication, see plan header)
- Test: `packages/host-web/tests/budget-guard.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/host-web/tests/budget-guard.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { BudgetExceededAdapter } from "../src/budget-guard.js";
import type { AgentEvent, TaskContext } from "@agent-team/core";

describe("BudgetExceededAdapter (host-web copy)", () => {
  it("emits a single error naming ceiling and spend, never calls the SDK", async () => {
    const adapter = new BudgetExceededAdapter(1.5, 1.6201);
    const events: AgentEvent[] = [];
    await adapter.startTask({ agentId: "coder#n2" } as TaskContext, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "error", from: "coder#n2" });
    expect((events[0] as { message: string }).message).toContain("$1.5000");
    expect((events[0] as { message: string }).message).toContain("$1.6201");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent-team/host-web -- tests/budget-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/host-web/src/budget-guard.ts`** (verbatim copy)

```ts
import type { AgentAdapter, TaskContext, Emit } from "@agent-team/core";

/**
 * Returned by the host when the team cost ceiling has been reached. Refuses the
 * node WITHOUT calling the SDK (no spend), emitting a single error so the
 * Scheduler treats the node as failed. interrupt() is a no-op (nothing runs).
 *
 * VERBATIM COPY of host-headless/src/budget-guard.ts — host-web must not
 * import host-headless (spec §2.1); ~25 lines of leaf glue is cheaper than a
 * shared util package. Keep the two copies in sync if the semantics change.
 */
export class BudgetExceededAdapter implements AgentAdapter {
  readonly backend = "budget-guard";

  readonly contextModalities = ["text"] as const;
  constructor(
    private readonly ceilingUsd: number,
    private readonly spentUsd: number,
  ) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    emit({
      kind: "error",
      from: ctx.agentId,
      message: `team cost ceiling $${this.ceilingUsd.toFixed(4)} reached (spent $${this.spentUsd.toFixed(4)}); skipping ${ctx.agentId}`,
    });
  }

  interrupt(): void {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent-team/host-web -- tests/budget-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host-web/src/budget-guard.ts packages/host-web/tests/budget-guard.test.ts
git commit -m "feat(host-web): budget guard adapter (verbatim leaf copy from host-headless)"
```

---

### Task 5: ProposalsService (serialized repo mutations)

**Files:**
- Create: `packages/host-web/src/proposals-service.ts`
- Test: `packages/host-web/tests/proposals-service.test.ts`

- [ ] **Step 1: Write the failing test** (fake coordinator; the real-repo path is covered in Task 7's integration test)

`packages/host-web/tests/proposals-service.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ProposalsService } from "../src/proposals-service.js";
import type { AcceptOutcome, AmbientProposal } from "@agent-team/core";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("ProposalsService", () => {
  it("delegates list and diff straight through", async () => {
    const svc = new ProposalsService({
      list: async () => [{ branch: "b" } as AmbientProposal],
      diff: async (b) => `diff-of-${b}`,
      accept: async () => ({ status: "nothing", branch: "b" }) as AcceptOutcome,
      reject: async () => {},
    });
    expect((await svc.list())[0]?.branch).toBe("b");
    expect(await svc.diff("b")).toBe("diff-of-b");
  });

  it("serializes accept/reject: the second mutation starts only after the first settles", async () => {
    const order: string[] = [];
    const first = deferred<AcceptOutcome>();
    const svc = new ProposalsService({
      list: async () => [],
      diff: async () => "",
      accept: async (b) => {
        order.push(`accept-start-${b}`);
        if (b === "b1") return first.promise;
        return { status: "merged", branch: b, onto: "main" };
      },
      reject: async (b) => {
        order.push(`reject-start-${b}`);
      },
    });

    const p1 = svc.accept("b1");
    const p2 = svc.reject("b2"); // queued behind b1
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["accept-start-b1"]); // b2 not started yet
    first.resolve({ status: "merged", branch: "b1", onto: "main" });
    await p1;
    await p2;
    expect(order).toEqual(["accept-start-b1", "reject-start-b2"]);
  });

  it("a rejected mutation does not poison the queue", async () => {
    const svc = new ProposalsService({
      list: async () => [],
      diff: async () => "",
      accept: async () => {
        throw new Error("boom");
      },
      reject: async () => {},
    });
    await expect(svc.accept("bad")).rejects.toThrow("boom");
    await expect(svc.reject("ok")).resolves.toBeUndefined(); // queue still alive
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent-team/host-web -- tests/proposals-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/host-web/src/proposals-service.ts`**

```ts
import type { AmbientProposal, AcceptOutcome } from "@agent-team/core";

/** The slice of ProposalCoordinator the service needs (structural, fake-friendly). */
export interface ProposalOps {
  list(): Promise<AmbientProposal[]>;
  diff(branch: string): Promise<string>;
  accept(branch: string, onto?: string): Promise<AcceptOutcome>;
  reject(branch: string): Promise<void>;
}

/**
 * Serializes repo-MUTATING proposal commands through one in-process queue:
 * two tabs accepting concurrently must not interleave git state (S6's
 * acceptSeq protects worktree paths, not repo state). Reads pass through.
 */
export class ProposalsService {
  readonly #ops: ProposalOps;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(ops: ProposalOps) {
    this.#ops = ops;
  }

  list(): Promise<AmbientProposal[]> {
    return this.#ops.list();
  }

  diff(branch: string): Promise<string> {
    return this.#ops.diff(branch);
  }

  accept(branch: string, onto?: string): Promise<AcceptOutcome> {
    return this.#serialize(() => this.#ops.accept(branch, onto));
  }

  reject(branch: string): Promise<void> {
    return this.#serialize(() => this.#ops.reject(branch));
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn);
    this.#queue = next.catch(() => undefined); // failures don't poison the queue
    return next;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent-team/host-web -- tests/proposals-service.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host-web/src/proposals-service.ts packages/host-web/tests/proposals-service.test.ts
git commit -m "feat(host-web): ProposalsService with serialized mutations (TDD)"
```

---

### Task 6: Control server (http + ws + static + resume)

**Files:**
- Create: `packages/host-web/src/server.ts`
- Test: `packages/host-web/tests/server.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/host-web/tests/server.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createControlServer } from "../src/server.js";
import type { ControlServer } from "../src/server.js";
import type { ServerEnvelope, ClientCommand, DirectEnvelope } from "../src/protocol.js";
import type { BusEvent } from "@agent-team/core";

const evt = (text: string) =>
  ({ type: "event", payload: { kind: "message", from: "lead#1", text } as BusEvent }) as const;

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function connect(port: number): { ws: WebSocket; received: ServerEnvelope[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received: ServerEnvelope[] = [];
  ws.on("message", (d) => received.push(JSON.parse(String(d)) as ServerEnvelope));
  return { ws, received };
}

describe("createControlServer", () => {
  let server: ControlServer | undefined;
  let tmp: string | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await server?.close();
    server = undefined;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  const baseOpts = (over: Partial<Parameters<typeof createControlServer>[0]> = {}) => ({
    uiDist: join(tmpdir(), "definitely-missing-dist"),
    port: 0,
    runState: () => "running" as const,
    onCommand: (_cmd: ClientCommand, _reply: (env: DirectEnvelope) => void) => {},
    ...over,
  });

  it("binds 127.0.0.1 and answers 503 with build hint when ui/dist is missing", async () => {
    server = await createControlServer(baseOpts());
    const res = await fetch(`http://127.0.0.1:${server.port()}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("build:ui");
  });

  it("serves index.html and assets from uiDist", async () => {
    tmp = mkdtempSync(join(tmpdir(), "hw-dist-"));
    writeFileSync(join(tmp, "index.html"), "<html>control room</html>");
    mkdirSync(join(tmp, "assets"));
    writeFileSync(join(tmp, "assets", "app.js"), "console.log(1)");
    server = await createControlServer(baseOpts({ uiDist: tmp }));
    const page = await fetch(`http://127.0.0.1:${server.port()}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("control room");
    const js = await fetch(`http://127.0.0.1:${server.port()}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const traversal = await fetch(`http://127.0.0.1:${server.port()}/../secret`);
    expect([403, 404]).toContain(traversal.status);
  });

  it("sends hello on connect and broadcasts stamped envelopes in order", async () => {
    server = await createControlServer(baseOpts());
    const { ws, received } = connect(server.port());
    sockets.push(ws);
    await until(() => received.length >= 1);
    expect(received[0]).toMatchObject({ seq: 0, type: "hello", latestSeq: 0, runState: "running" });
    server.broadcast(evt("a"));
    server.broadcast(evt("b"));
    await until(() => received.length >= 3);
    expect(received[1]).toMatchObject({ seq: 1, type: "event" });
    expect(received[2]).toMatchObject({ seq: 2, type: "event" });
  });

  it("resume replays exactly the gap", async () => {
    server = await createControlServer(baseOpts());
    server.broadcast(evt("a")); // 1
    server.broadcast(evt("b")); // 2
    server.broadcast(evt("c")); // 3
    const { ws, received } = connect(server.port());
    sockets.push(ws);
    await until(() => received.length >= 1); // hello with latestSeq 3
    expect(received[0]).toMatchObject({ type: "hello", latestSeq: 3 });
    ws.send(JSON.stringify({ type: "resume", afterSeq: 1 }));
    await until(() => received.length >= 3);
    expect(received.slice(1).map((e) => e.seq)).toEqual([2, 3]);
  });

  it("a resume past the ring capacity gets a gapped hello first", async () => {
    server = await createControlServer(baseOpts({ ringCapacity: 2 }));
    for (const t of ["a", "b", "c", "d"]) server.broadcast(evt(t)); // buffer holds 3,4
    const { ws, received } = connect(server.port());
    sockets.push(ws);
    await until(() => received.length >= 1);
    ws.send(JSON.stringify({ type: "resume", afterSeq: 0 }));
    await until(() => received.length >= 4);
    expect(received[1]).toMatchObject({ type: "hello", gapped: true });
    expect(received.slice(2).map((e) => e.seq)).toEqual([3, 4]);
  });

  it("routes commands to onCommand and replies only to the sender", async () => {
    const seen: ClientCommand[] = [];
    server = await createControlServer(
      baseOpts({
        onCommand: (cmd, reply) => {
          seen.push(cmd);
          if (cmd.type === "proposal_show") {
            reply({ seq: 0, type: "proposal_diff", branch: cmd.branch, diff: "DIFF" });
          }
        },
      }),
    );
    const a = connect(server.port());
    const b = connect(server.port());
    sockets.push(a.ws, b.ws);
    await until(() => a.received.length >= 1 && b.received.length >= 1);
    a.ws.send(JSON.stringify({ type: "proposal_show", branch: "x" }));
    await until(() => a.received.length >= 2);
    expect(a.received[1]).toMatchObject({ type: "proposal_diff", diff: "DIFF" });
    expect(b.received).toHaveLength(1); // hello only — reply was direct
    expect(seen).toEqual([{ type: "proposal_show", branch: "x" }]);
  });

  it("notifies client connect/disconnect and emits heartbeat pings", async () => {
    let connects = 0;
    let disconnects = 0;
    server = await createControlServer(
      baseOpts({
        heartbeatMs: 25,
        onClientConnected: () => connects++,
        onClientDisconnected: () => disconnects++,
      }),
    );
    const { ws } = connect(server.port());
    sockets.push(ws);
    let pinged = false;
    ws.on("ping", () => (pinged = true));
    await until(() => connects === 1);
    await until(() => pinged);
    ws.close();
    await until(() => disconnects === 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent-team/host-web -- tests/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/host-web/src/server.ts`**

```ts
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { RingBuffer } from "./ring-buffer.js";
import type { UnstampedBroadcast } from "./ring-buffer.js";
import { parseClientCommand } from "./protocol.js";
import type { ClientCommand, DirectEnvelope, ServerEnvelope } from "./protocol.js";

export interface ControlServerOptions {
  /** Absolute path to the built UI (vite outDir). Missing ⇒ 503 with build hint. */
  uiDist: string;
  /** 0 = ephemeral (tests). Default 7340. Always binds 127.0.0.1 (spec §9). */
  port?: number;
  ringCapacity?: number; // default 5000
  heartbeatMs?: number; // default 15000
  runState: () => "running" | "settled";
  onCommand: (cmd: ClientCommand, reply: (env: DirectEnvelope) => void) => void;
  onClientConnected?: () => void;
  onClientDisconnected?: () => void;
}

export interface ControlServer {
  broadcast(env: UnstampedBroadcast): void;
  port(): number;
  clientCount(): number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
};

function send(ws: WebSocket, env: ServerEnvelope): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env));
}

async function serveStatic(uiDist: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!existsSync(join(uiDist, "index.html"))) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("UI not built — run: npm run build:ui -w @agent-team/host-web");
    return;
  }
  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const path = normalize(join(uiDist, rel));
  if (!path.startsWith(normalize(uiDist))) {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

export function createControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const ring = new RingBuffer(opts.ringCapacity ?? 5_000);
  const http = createHttpServer((req, res) => {
    void serveStatic(opts.uiDist, req, res);
  });
  const wss = new WebSocketServer({ server: http });
  const alive = new WeakMap<WebSocket, boolean>();

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate(); // missed a pong — counts as a disconnect via 'close'
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, opts.heartbeatMs ?? 15_000);

  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    opts.onClientConnected?.();
    send(ws, { seq: 0, type: "hello", latestSeq: ring.latestSeq(), runState: opts.runState() });

    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return; // garbage frames are dropped, not fatal
      }
      const cmd = parseClientCommand(parsed);
      if (cmd === null) return;
      if (cmd.type === "resume") {
        const { items, gapped } = ring.after(cmd.afterSeq);
        if (gapped) {
          send(ws, { seq: 0, type: "hello", latestSeq: ring.latestSeq(), runState: opts.runState(), gapped: true });
        }
        for (const env of items) send(ws, env);
        return;
      }
      opts.onCommand(cmd, (env) => send(ws, env));
    });

    ws.on("close", () => opts.onClientDisconnected?.());
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port ?? 7340, "127.0.0.1", () => {
      resolve({
        broadcast: (env) => {
          const stamped = ring.stamp(env);
          for (const ws of wss.clients) send(ws, stamped);
        },
        port: () => (http.address() as AddressInfo).port,
        clientCount: () => wss.clients.size,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => {
              http.close(() => done());
            });
          }),
      });
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent-team/host-web -- tests/server.test.ts`
Expected: PASS (7 tests). If the traversal assertion fails on Windows path quirks, the 403 guard normalizes both sides — check `normalize` output before changing the test.

- [ ] **Step 5: Commit**

```bash
git add packages/host-web/src/server.ts packages/host-web/tests/server.test.ts
git commit -m "feat(host-web): ws control server with seq broadcast, resume replay, heartbeat (TDD)"
```

---

### Task 7: composeWeb + offline integration tests

**Files:**
- Create: `packages/host-web/src/compose.ts`
- Test: `packages/host-web/tests/compose-web.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/host-web/tests/compose-web.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { TaskGraph } from "@agent-team/core";
import type { BusEvent } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeWeb } from "../src/compose.js";
import type { ServerEnvelope } from "../src/protocol.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function connect(port: number): { ws: WebSocket; received: ServerEnvelope[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const received: ServerEnvelope[] = [];
  ws.on("message", (d) => received.push(JSON.parse(String(d)) as ServerEnvelope));
  return { ws, received };
}

/** Stage a reviewer proposal branch the way composeAmbient does (manual git). */
async function stageProposal(git: NodeGitRunner, repo: string): Promise<string> {
  const sha = (await git.run(["rev-parse", "HEAD"], repo)).stdout.trim();
  const branch = `agentteam/reviewer-${sha.slice(0, 7)}`;
  const wt = join(repo, ".stage-wt");
  await git.run(["worktree", "add", "-b", branch, wt, sha], repo);
  writeFileSync(join(wt, "app.ts"), "export const x = 2; // reviewed\n");
  await git.run(["add", "."], wt);
  await git.run(["commit", "-m", "review: tighten x\n\nAmbient-Finding: tightened x"], wt);
  await git.run(["worktree", "remove", "--force", wt], repo);
  return branch;
}

describe("composeWeb offline integration", () => {
  let repo: string;
  let git: NodeGitRunner;
  const sockets: WebSocket[] = [];
  let closeHost: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "hw-compose-")).split("\\").join("/");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "base"], repo);
    await git.run(["branch", "agentteam/integration"], repo);
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    await closeHost?.();
    closeHost = undefined;
    rmSync(repo, { recursive: true, force: true });
  });

  it("streams bus events to a connected browser and merges the run", async () => {
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "hello.txt"), "from web host\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "wrote hello", total_cost_usd: 0.01 });
    };
    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "write hello", dependsOn: [] }]);
    const host = await composeWeb({
      repoRoot: repo, graph, query,
      model: "claude-test", maxTurns: 50, permTimeoutMs: 2000, port: 0,
    });
    closeHost = host.close;

    const { ws, received } = connect(host.port());
    sockets.push(ws);
    await until(() => received.some((e) => e.type === "hello"));

    const result = await host.run();
    expect(result.status).toBe("complete");
    await until(() =>
      received.some((e) => e.type === "event" && (e.payload as BusEvent).kind === "done"),
    );
    const show = await git.run(["show", "agentteam/integration:hello.txt"], repo);
    expect(show.code).toBe(0);
  });

  it("routes a destructive Bash to a browser gate; allow lets the work proceed", async () => {
    const query: QueryFn = async function* ({ options }) {
      const canUseTool = (
        options as {
          canUseTool?: (n: string, i: Record<string, unknown>, o: never) => Promise<{ behavior: string }>;
        }
      ).canUseTool;
      // "rm -rf" classifies destructive ⇒ GATE under autopilot
      const decision = await canUseTool!("Bash", { command: "rm -rf ./scratch" }, {} as never);
      if (decision.behavior === "allow") {
        writeFileSync(join(options.cwd as string, "gated.txt"), "allowed from browser\n");
      }
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01 });
    };
    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "gated work", dependsOn: [] }]);
    const host = await composeWeb({
      repoRoot: repo, graph, query,
      model: "claude-test", maxTurns: 50, permTimeoutMs: 5000, port: 0,
    });
    closeHost = host.close;

    const { ws, received } = connect(host.port());
    sockets.push(ws);
    await until(() => received.some((e) => e.type === "hello"));

    const runP = host.run();
    await until(() => received.some((e) => e.type === "gate"));
    const gate = received.find((e) => e.type === "gate") as Extract<ServerEnvelope, { type: "gate" }>;
    expect(gate.category).toBe("destructive");
    ws.send(JSON.stringify({ type: "allow", requestId: gate.requestId }));

    const result = await runP;
    expect(result.status).toBe("complete");
    await until(() => received.some((e) => e.type === "gate_resolved"));
    const show = await git.run(["show", "agentteam/integration:gated.txt"], repo);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("allowed from browser");
  });

  it("pushes proposals on connect and accepts one over the socket", async () => {
    const branch = await stageProposal(git, repo);
    const query: QueryFn = async function* () {
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "noop", total_cost_usd: 0 });
    };
    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "noop", dependsOn: [] }]);
    const host = await composeWeb({
      repoRoot: repo, graph, query,
      model: "claude-test", maxTurns: 50, permTimeoutMs: 2000, port: 0,
    });
    closeHost = host.close;

    const { ws, received } = connect(host.port());
    sockets.push(ws);
    await until(() => received.some((e) => e.type === "proposals"));
    const push = received.find((e) => e.type === "proposals") as Extract<ServerEnvelope, { type: "proposals" }>;
    expect(push.items).toHaveLength(1);
    expect(push.items[0]).toMatchObject({ branch, finding: "tightened x" });

    ws.send(JSON.stringify({ type: "proposal_show", branch }));
    await until(() => received.some((e) => e.type === "proposal_diff"));
    expect(
      (received.find((e) => e.type === "proposal_diff") as Extract<ServerEnvelope, { type: "proposal_diff" }>).diff,
    ).toContain("reviewed");

    ws.send(JSON.stringify({ type: "proposal_accept", branch }));
    await until(() => received.some((e) => e.type === "proposal_outcome"));
    const outcome = received.find((e) => e.type === "proposal_outcome") as Extract<
      ServerEnvelope,
      { type: "proposal_outcome" }
    >;
    expect(outcome.outcome).toMatchObject({ status: "merged" });
    expect((await git.run(["show", "main:app.ts"], repo)).stdout).toContain("reviewed");
    // refreshed list after the accept
    await until(() =>
      received.some((e) => e.type === "proposals" && e.items.length === 0),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent-team/host-web -- tests/compose-web.test.ts`
Expected: FAIL — `Cannot find module '../src/compose.js'`.

- [ ] **Step 3: Create `packages/host-web/src/compose.ts`**

```ts
import { fileURLToPath } from "node:url";
import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  IntegrationCoordinator,
  Scheduler,
  pickModality,
  CompositeContextProvider,
  HashEmbedder,
  ProposalCoordinator,
} from "@agent-team/core";
import type {
  TaskGraph,
  TaskNode,
  GitRunner,
  BusEvent,
  ActionRequestEvent,
  AgentId,
  Role,
  BrokerHandlers,
  AgentAdapter,
  ScheduleResult,
  ContextProvider,
  Embedder,
} from "@agent-team/core";
import { NodeGitRunner, TextContextProvider, SqliteVecContextProvider } from "@agent-team/core/node";
import type { DecisionRecorder } from "@agent-team/core/node";
import {
  ClaudeAdapter,
  PendingPermissions,
  CostLedger,
  type QueryFn,
} from "@agent-team/adapters-claude";
import { BudgetExceededAdapter } from "./budget-guard.js";
import { GateBridge } from "./gate-bridge.js";
import { ProposalsService } from "./proposals-service.js";
import { createControlServer } from "./server.js";
import type { ControlServer } from "./server.js";
import type { ClientCommand, DirectEnvelope } from "./protocol.js";

export interface ComposeWebOptions {
  repoRoot: string;
  graph: TaskGraph;
  query: QueryFn;
  model: string;
  maxTurns: number;
  permTimeoutMs: number;
  costCeilingUsd?: number;
  git?: GitRunner;
  /** Shared-memory sqlite-vec db; semantics identical to composeHeadless. */
  memoryDb?: string;
  embedder?: Embedder;
  /** 0 = ephemeral (tests). Default 7340. */
  port?: number;
  /** Default: <package>/ui/dist. */
  uiDist?: string;
  ringCapacity?: number;
  heartbeatMs?: number;
  graceMs?: number;
}

export interface ComposedWebHost {
  bus: MessageBus;
  ledger: CostLedger;
  server: ControlServer;
  port(): number;
  run(): Promise<ScheduleResult>;
  close(): Promise<void>;
}

const BASE_REF = "agentteam/integration";

export async function composeWeb(opts: ComposeWebOptions): Promise<ComposedWebHost> {
  const git = opts.git ?? new NodeGitRunner();
  const bus = new MessageBus();
  const ledger = new CostLedger();
  const pending = new PendingPermissions();
  const store = new PolicyStore();
  store.applyPreset("autopilot");

  let runState: "running" | "settled" = "running";
  let serverRef: ControlServer | undefined; // late-bound: GateBridge needs broadcast before the server exists

  const gates = new GateBridge({
    broadcast: (env) => serverRef?.broadcast(env),
    graceMs: opts.graceMs,
  });
  const proposals = new ProposalsService(new ProposalCoordinator({ git, repoRoot: opts.repoRoot }));

  async function handleCommand(cmd: ClientCommand, reply: (env: DirectEnvelope) => void): Promise<void> {
    switch (cmd.type) {
      case "allow":
      case "deny":
        gates.command(cmd);
        return;
      case "proposal_show":
        reply({ seq: 0, type: "proposal_diff", branch: cmd.branch, diff: await proposals.diff(cmd.branch) });
        return;
      case "proposal_accept": {
        const outcome = await proposals.accept(cmd.branch, cmd.onto);
        serverRef?.broadcast({ type: "proposal_outcome", branch: cmd.branch, outcome });
        serverRef?.broadcast({ type: "proposals", items: await proposals.list() });
        return;
      }
      case "proposal_reject":
        await proposals.reject(cmd.branch);
        serverRef?.broadcast({
          type: "proposal_outcome",
          branch: cmd.branch,
          outcome: { status: "rejected", branch: cmd.branch },
        });
        serverRef?.broadcast({ type: "proposals", items: await proposals.list() });
        return;
      case "proposal_refresh":
        serverRef?.broadcast({ type: "proposals", items: await proposals.list() });
        return;
      case "resume":
        return; // handled inside the server
    }
  }

  const server = await createControlServer({
    uiDist: opts.uiDist ?? fileURLToPath(new URL("../ui/dist", import.meta.url)),
    port: opts.port ?? 7340,
    ringCapacity: opts.ringCapacity,
    heartbeatMs: opts.heartbeatMs,
    runState: () => runState,
    onClientConnected: () => {
      gates.clientConnected();
      void proposals
        .list()
        .then((items) => serverRef?.broadcast({ type: "proposals", items }))
        .catch((err) => console.warn("[host-web] proposals list failed:", err));
    },
    onClientDisconnected: () => gates.clientDisconnected(),
    onCommand: (cmd, reply) => {
      void handleCommand(cmd, reply).catch((err) => console.warn("[host-web] command failed:", err));
    },
  });
  serverRef = server;

  // GATE: route to the browser inbox; resolution feeds adapters-claude's pending map.
  const handlers: BrokerHandlers = {
    gate: (req: ActionRequestEvent, _from: AgentId) => {
      void gates
        .askGate({ requestId: req.requestId, category: req.category, summary: req.summary })
        .then((allow) =>
          pending.resolve(
            req.requestId,
            allow ? { behavior: "allow" } : { behavior: "deny", message: "denied at gate" },
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

  // Every bus event goes to the browser feed.
  bus.subscribe((e: BusEvent) => serverRef?.broadcast({ type: "event", payload: e }));

  // Shared memory (identical to composeHeadless).
  let memory: SqliteVecContextProvider | undefined;
  let recorder: DecisionRecorder | undefined;
  let contextProvider: ContextProvider = new TextContextProvider();
  if (opts.memoryDb) {
    memory = new SqliteVecContextProvider({
      dbPath: opts.memoryDb,
      embedder: opts.embedder ?? new HashEmbedder(),
    });
    recorder = memory;
    contextProvider = new CompositeContextProvider([new TextContextProvider(), memory]);
  }
  if (recorder) {
    const rec = recorder;
    bus.subscribe((e: BusEvent) => {
      if (e.kind !== "done") return;
      const id = e.from.slice(e.from.indexOf("#") + 1);
      const node = opts.graph.get(id);
      if (!node) return;
      void rec.record({
        id: node.id,
        role: node.role,
        goal: node.goal,
        summary: e.summary,
        createdAt: new Date().toISOString(),
      });
    });
  }

  const contextModalities = ["text"] as const;
  const worktrees = new WorktreeManager(git, opts.repoRoot, contextProvider, () => ({
    envelope: undefined,
    modality: pickModality(contextModalities),
  }));
  const integration = new IntegrationCoordinator(git, worktrees, bus, opts.repoRoot);
  const scheduler = new Scheduler({
    bus,
    budget: { maxTurns: opts.maxTurns },
    graph: opts.graph,
    worktrees,
    integration,
    baseRef: BASE_REF,
  });

  const adapterFor = (_node: TaskNode): AgentAdapter => {
    if (opts.costCeilingUsd != null && ledger.total() >= opts.costCeilingUsd) {
      return new BudgetExceededAdapter(opts.costCeilingUsd, ledger.total());
    }
    return new ClaudeAdapter({
      query: opts.query,
      git,
      pending,
      ledger,
      model: opts.model,
      maxTurns: opts.maxTurns,
      permTimeoutMs: opts.permTimeoutMs,
    });
  };

  return {
    bus,
    ledger,
    server,
    port: () => server.port(),
    run: async () => {
      try {
        return await scheduler.run(adapterFor);
      } finally {
        runState = "settled";
      }
    },
    close: async () => {
      memory?.close();
      await server.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent-team/host-web -- tests/compose-web.test.ts`
Expected: PASS (3 tests). These hit real git in temp repos — allow ~10s.

- [ ] **Step 5: Run the whole package + build**

Run: `npm run build -w @agent-team/host-web` then `npm run test -w @agent-team/host-web`
Expected: build exit 0; all host-web tests green (≈20).

- [ ] **Step 6: Commit**

```bash
git add packages/host-web/src/compose.ts packages/host-web/tests/compose-web.test.ts
git commit -m "feat(host-web): composeWeb — run + gates + proposals over one ws server (TDD)"
```

---

### Task 8: CLI

**Files:**
- Create: `packages/host-web/src/cli-args.ts`
- Create: `packages/host-web/src/cli.ts`
- Test: `packages/host-web/tests/cli-args.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/host-web/tests/cli-args.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli-args.js";

describe("parseArgs (agent-team-web)", () => {
  it("requires --graph", () => {
    expect(() => parseArgs([])).toThrow("--graph");
  });

  it("applies defaults", () => {
    const a = parseArgs(["--graph", "g.json"]);
    expect(a).toMatchObject({ graph: "g.json", port: 7340, model: "claude-opus-4-8", maxTurns: 50 });
    expect(a.repo).toBe(process.cwd());
    expect(a.costCeiling).toBeUndefined();
    expect(a.memory).toBeUndefined();
  });

  it("parses every flag", () => {
    const a = parseArgs([
      "--graph", "g.json", "--repo", "/r", "--port", "8080",
      "--model", "m", "--max-turns", "9", "--cost-ceiling", "1.25", "--memory", "mem.db",
    ]);
    expect(a).toEqual({
      graph: "g.json", repo: "/r", port: 8080,
      model: "m", maxTurns: 9, costCeiling: 1.25, memory: "mem.db",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent-team/host-web -- tests/cli-args.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/host-web/src/cli-args.ts`**

```ts
export interface CliArgs {
  graph: string;
  repo: string;
  port: number;
  model: string;
  maxTurns: number;
  costCeiling?: number;
  memory?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const getOpt = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const graph = getOpt("--graph");
  if (graph === undefined) throw new Error("--graph <file.json> is required");
  const ceilingRaw = getOpt("--cost-ceiling");
  return {
    graph,
    repo: getOpt("--repo") ?? process.cwd(),
    port: Number(getOpt("--port") ?? "7340"),
    model: getOpt("--model") ?? "claude-opus-4-8",
    maxTurns: Number(getOpt("--max-turns") ?? "50"),
    costCeiling: ceilingRaw !== undefined ? Number(ceilingRaw) : undefined,
    memory: getOpt("--memory"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent-team/host-web -- tests/cli-args.test.ts`
Expected: PASS.

- [ ] **Step 5: Create `packages/host-web/src/cli.ts`** (entry — no unit test; exercised by LIVE-SMOKE)

```ts
#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { stdout } from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { TaskGraph } from "@agent-team/core";
import type { BusEvent, TaskNode } from "@agent-team/core";
import type { QueryFn } from "@agent-team/adapters-claude";
import { parseArgs } from "./cli-args.js";
import { composeWeb } from "./compose.js";

async function ensureIntegrationBranch(repo: string): Promise<void> {
  const { NodeGitRunner } = await import("@agent-team/core/node");
  const git = new NodeGitRunner();
  const exists = await git.run(["rev-parse", "--verify", "agentteam/integration"], repo);
  if (exists.code !== 0) await git.run(["branch", "agentteam/integration"], repo);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await ensureIntegrationBranch(args.repo);
  const graph = new TaskGraph(JSON.parse(readFileSync(args.graph, "utf8")) as TaskNode[]);

  const host = await composeWeb({
    repoRoot: args.repo,
    graph,
    query: query as unknown as QueryFn,
    model: args.model,
    maxTurns: args.maxTurns,
    permTimeoutMs: 60_000,
    costCeilingUsd: args.costCeiling,
    memoryDb: args.memory,
    port: args.port,
  });

  stdout.write(`Control Room: http://127.0.0.1:${host.port()}/\n`);
  host.bus.subscribe((e: BusEvent) => {
    if (e.kind === "done") stdout.write(`  ✓ ${e.from}: ${e.summary}\n`);
    else if (e.kind === "error") stdout.write(`  ✗ ${e.from}: ${e.message}\n`);
  });

  const result = await host.run();
  stdout.write(`\nrun settled: ${result.status}\n`);
  stdout.write(`completed: ${result.completed.join(", ") || "(none)"}\n`);
  stdout.write(`blocked: ${result.blocked.join(", ") || "(none)"}\n`);
  stdout.write(`total cost: $${host.ledger.total().toFixed(4)}\n`);
  stdout.write(`server stays up for gates history & proposal review — Ctrl+C to exit\n`);
  // Intentionally no process.exit(): the http server keeps the loop alive for review.
}

main().catch((err) => {
  stdout.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 6: Build + full package test**

Run: `npm run build -w @agent-team/host-web` then `npm run test -w @agent-team/host-web`
Expected: build exit 0 (dist/cli.js exists); all green.

- [ ] **Step 7: Commit**

```bash
git add packages/host-web/src/cli-args.ts packages/host-web/src/cli.ts packages/host-web/tests/cli-args.test.ts
git commit -m "feat(host-web): agent-team-web CLI (TDD on arg parsing)"
```

---

### Task 9: UI scaffold + pure virtualizer

**Files:**
- Create: `packages/host-web/vite.config.ts`
- Create: `packages/host-web/tsconfig.ui.json`
- Create: `packages/host-web/ui/src/virtualizer.ts`
- Test: `packages/host-web/tests/virtualizer.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/host-web/tests/virtualizer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  makeGeometry, appendRows, resetRows, totalHeight, firstVisible, windowFor, isAtBottom,
} from "../ui/src/virtualizer.js";

describe("feed virtualizer math", () => {
  it("appendRows accumulates offsets with row padding", () => {
    const g = makeGeometry(6);
    appendRows(g, [20, 40, 20]);
    expect(g.offsets).toEqual([0, 26, 72, 98]);
    expect(totalHeight(g)).toBe(98);
  });

  it("firstVisible binary-searches the offset table", () => {
    const g = makeGeometry(0);
    appendRows(g, [10, 10, 10, 10]); // offsets 0,10,20,30,40
    expect(firstVisible(g, 0)).toBe(0);
    expect(firstVisible(g, 9.9)).toBe(0);
    expect(firstVisible(g, 10)).toBe(1);
    expect(firstVisible(g, 35)).toBe(3);
  });

  it("windowFor clamps overscan to the row range", () => {
    const g = makeGeometry(0);
    appendRows(g, Array.from({ length: 100 }, () => 10)); // 1000 tall
    const w = windowFor(g, 500, 100, 5);
    expect(w.i0).toBe(45); // firstVisible(500)=50, minus overscan
    expect(w.i1).toBeGreaterThanOrEqual(60); // covers viewport bottom + overscan
    expect(windowFor(g, 0, 100, 5).i0).toBe(0);
    expect(windowFor(g, 990, 100, 5).i1).toBe(99);
    expect(windowFor(makeGeometry(0), 0, 100).i1).toBe(-1); // empty feed
  });

  it("isAtBottom respects slack and resetRows rebuilds in place", () => {
    const g = makeGeometry(0);
    appendRows(g, [100, 100]);
    expect(isAtBottom(g, 100, 100)).toBe(true);
    expect(isAtBottom(g, 50, 100)).toBe(false);
    resetRows(g, [10, 10]);
    expect(g.offsets).toEqual([0, 10, 20]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @agent-team/host-web -- tests/virtualizer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `packages/host-web/ui/src/virtualizer.ts`**

```ts
/** Pure feed-window math (offsets, window, stick-to-bottom). No DOM, node-testable. */
export interface FeedGeometry {
  heights: number[];
  /** offsets[i] = content top of row i; offsets[n] = total content height. */
  offsets: number[];
  rowPad: number;
}

export function makeGeometry(rowPad: number): FeedGeometry {
  return { heights: [], offsets: [0], rowPad };
}

export function appendRows(g: FeedGeometry, newHeights: number[]): void {
  for (const h of newHeights) {
    g.heights.push(h);
    g.offsets.push(g.offsets[g.offsets.length - 1]! + h + g.rowPad);
  }
}

/** Rebuild all rows in place (container resize re-measure). */
export function resetRows(g: FeedGeometry, heights: number[]): void {
  g.heights.length = 0;
  g.offsets.length = 1;
  appendRows(g, heights);
}

export function totalHeight(g: FeedGeometry): number {
  return g.offsets[g.offsets.length - 1]!;
}

export function firstVisible(g: FeedGeometry, scrollTop: number): number {
  let lo = 0;
  let hi = g.heights.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (g.offsets[mid + 1]! <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function windowFor(
  g: FeedGeometry,
  scrollTop: number,
  viewport: number,
  overscan = 5,
): { i0: number; i1: number } {
  const n = g.heights.length;
  if (n === 0) return { i0: 0, i1: -1 };
  const i0 = Math.max(0, firstVisible(g, scrollTop) - overscan);
  let i1 = i0;
  const bottom = scrollTop + viewport;
  while (i1 < n && g.offsets[i1]! < bottom) i1++;
  return { i0, i1: Math.min(n - 1, i1 + overscan) };
}

/** Sticky iff scrolled to (near) the bottom; scrolling up un-sticks. */
export function isAtBottom(g: FeedGeometry, scrollTop: number, viewport: number, slack = 4): boolean {
  return scrollTop + viewport >= totalHeight(g) - slack;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w @agent-team/host-web -- tests/virtualizer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Create `packages/host-web/vite.config.ts`**

```ts
import { defineConfig } from "vite";

export default defineConfig({
  root: "ui",
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
});
```

- [ ] **Step 6: Create `packages/host-web/tsconfig.ui.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["ui/src/**/*.ts", "src/protocol.ts"]
}
```

- [ ] **Step 7: Commit**

```bash
git add packages/host-web/vite.config.ts packages/host-web/tsconfig.ui.json packages/host-web/ui/src/virtualizer.ts packages/host-web/tests/virtualizer.test.ts
git commit -m "feat(host-web): UI scaffold + pure feed virtualizer (TDD)"
```

---

### Task 10: UI panes (feed / gates / proposals / ws client)

**Files:**
- Create: `packages/host-web/ui/index.html`
- Create: `packages/host-web/ui/src/style.css`
- Create: `packages/host-web/ui/src/main.ts`
- Create: `packages/host-web/ui/src/feed.ts`
- Create: `packages/host-web/ui/src/gates.ts`
- Create: `packages/host-web/ui/src/proposals.ts`

No unit tests here (DOM + pretext need a browser); the logic that CAN be node-tested already lives in `virtualizer.ts`. Verification = `typecheck:ui` + `build:ui` + Task 11's live smoke.

- [ ] **Step 1: Create `packages/host-web/ui/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Team — Control Room</title>
  <link rel="stylesheet" href="./src/style.css" />
</head>
<body>
  <div id="connbar" class="reconnecting">connecting…</div>
  <main>
    <section id="left">
      <div id="gates"></div>
      <div id="feed"><div id="spacer"></div></div>
    </section>
    <aside id="proposals">
      <header>
        <h2>Proposals</h2>
        <button id="proposals-refresh" type="button">Refresh</button>
      </header>
      <div id="proposal-list"></div>
      <pre id="proposal-diff" hidden></pre>
    </aside>
  </main>
  <script type="module" src="./src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Create `packages/host-web/ui/src/style.css`**

```css
:root {
  --bg: #1e1e1e; --bg-alt: #252526; --fg: #cccccc; --accent: #4ec9b0;
  --warn: #f44747; --ok: #6a9955; --border: #333333;
  --feed-font: 14px "Segoe UI", system-ui, sans-serif; --feed-line: 20px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13px "Segoe UI", system-ui, sans-serif; height: 100vh; display: flex; flex-direction: column; }
#connbar { padding: 2px 10px; font-size: 11px; flex: none; }
#connbar.connected { background: #143d2e; color: var(--ok); }
#connbar.reconnecting { background: #4d3800; color: #e5c07b; }
#connbar.gapped { background: #4a1e1e; color: var(--warn); }
main { flex: 1; display: flex; min-height: 0; }
#left { flex: 1; display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--border); }
#gates { flex: none; }
.gate { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #4d2b00; border-bottom: 2px solid var(--warn); }
.gate .cat { color: var(--warn); font-weight: 700; text-transform: uppercase; font-size: 11px; }
.gate .summary { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gate button { padding: 4px 14px; cursor: pointer; }
#feed { flex: 1; overflow-y: auto; position: relative; }
#spacer { position: absolute; top: 0; left: 0; width: 1px; }
.row { position: absolute; left: 0; right: 0; padding: 0 16px; font: var(--feed-font); line-height: var(--feed-line); overflow: hidden; }
.row.alt { background: var(--bg-alt); }
.row.kind-error { color: var(--warn); }
.row.kind-done { color: var(--ok); }
.divider { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--warn); color: var(--warn); font-size: 11px; padding: 2px 16px; }
#proposals { width: 380px; flex: none; display: flex; flex-direction: column; min-height: 0; }
#proposals header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border); }
#proposals h2 { margin: 0; font-size: 14px; color: var(--accent); }
#proposal-list { overflow-y: auto; flex: none; max-height: 45%; }
.proposal { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.proposal .branch { font-family: Consolas, monospace; font-size: 12px; color: var(--accent); cursor: pointer; }
.proposal .finding { margin: 4px 0; }
.proposal .actions button { margin-right: 6px; padding: 2px 10px; cursor: pointer; }
.proposal .outcome { font-size: 11px; margin-top: 4px; }
.proposal .outcome.ok { color: var(--ok); }
.proposal .outcome.bad { color: var(--warn); }
#proposal-diff { flex: 1; overflow: auto; margin: 0; padding: 8px 12px; font: 12px Consolas, monospace; background: #161616; border-top: 1px solid var(--border); }
```

- [ ] **Step 3: Create `packages/host-web/ui/src/feed.ts`** (pretext virtualized feed — the spike pattern)

```ts
import { prepare, layout } from "@chenglou/pretext";
import type { PreparedText } from "@chenglou/pretext";
import type { BusEvent } from "@agent-team/core";
import {
  makeGeometry, appendRows, resetRows, totalHeight, windowFor, isAtBottom,
} from "./virtualizer.js";

const FONT = '14px "Segoe UI"';
const LINE_HEIGHT = 20;
const ROW_PAD = 4;

function eventText(e: BusEvent): string {
  switch (e.kind) {
    case "message": return `${e.from}: ${e.text}`;
    case "tool_call": return `${e.from} → ${e.name}`;
    case "file_change": return `~ ${e.path}  (${e.from})`;
    case "action_request": return `? ${e.from} [${e.category}] ${e.summary}`;
    case "done": return `✓ ${e.from}: ${e.summary}`;
    case "error": return `✗ ${e.from}: ${e.message}`;
    default: return JSON.stringify(e);
  }
}

export class FeedPane {
  readonly #el: HTMLElement;
  readonly #spacer: HTMLElement;
  readonly #texts: string[] = [];
  readonly #kinds: string[] = [];
  readonly #prepared: PreparedText[] = [];
  readonly #geometry = makeGeometry(ROW_PAD);
  readonly #live = new Map<number, HTMLElement>();
  #stick = true;
  #dividerAt: number | null = null; // row index after which a "missed events" divider renders

  constructor(el: HTMLElement) {
    this.#el = el;
    this.#spacer = el.querySelector("#spacer") as HTMLElement;
    el.addEventListener("scroll", () => {
      this.#stick = isAtBottom(this.#geometry, el.scrollTop, el.clientHeight);
      this.#render();
    });
    new ResizeObserver(() => this.#relayout()).observe(el);
  }

  append(event: BusEvent): void {
    const text = eventText(event);
    const prepared = prepare(text, FONT); // prepare once per event; layout is the cheap call
    this.#texts.push(text);
    this.#kinds.push(event.kind);
    this.#prepared.push(prepared);
    appendRows(this.#geometry, [layout(prepared, this.#width(), LINE_HEIGHT).height]);
    this.#spacer.style.height = `${totalHeight(this.#geometry)}px`;
    if (this.#stick) this.#el.scrollTop = totalHeight(this.#geometry);
    this.#render();
  }

  /** Resume gap fell out of the ring buffer — mark the seam in the feed. */
  markGap(): void {
    this.#dividerAt = this.#texts.length - 1;
    this.#render();
  }

  #width(): number {
    return Math.max(50, this.#el.clientWidth - 32);
  }

  #relayout(): void {
    const w = this.#width();
    resetRows(this.#geometry, this.#prepared.map((p) => layout(p, w, LINE_HEIGHT).height));
    this.#spacer.style.height = `${totalHeight(this.#geometry)}px`;
    for (const [, el] of this.#live) el.remove();
    this.#live.clear();
    if (this.#stick) this.#el.scrollTop = totalHeight(this.#geometry);
    this.#render();
  }

  #render(): void {
    const { i0, i1 } = windowFor(this.#geometry, this.#el.scrollTop, this.#el.clientHeight);
    for (const [i, el] of this.#live) {
      if (i < i0 || i > i1) {
        el.remove();
        this.#live.delete(i);
      }
    }
    for (let i = i0; i <= i1; i++) {
      const existing = this.#live.get(i);
      if (existing) {
        existing.style.top = `${this.#geometry.offsets[i]}px`;
        continue;
      }
      const row = document.createElement("div");
      row.className = `row kind-${this.#kinds[i]}${i % 2 ? " alt" : ""}`;
      row.style.top = `${this.#geometry.offsets[i]}px`;
      row.style.height = `${this.#geometry.heights[i]}px`;
      row.textContent = this.#texts[i]!;
      if (this.#dividerAt === i) {
        const div = document.createElement("div");
        div.className = "divider";
        div.textContent = "⚠ missed events (ring buffer overflow)";
        div.style.top = `${this.#geometry.offsets[i]}px`;
        this.#spacer.after(div);
      }
      this.#spacer.after(row);
      this.#live.set(i, row);
    }
  }
}
```

- [ ] **Step 4: Create `packages/host-web/ui/src/gates.ts`**

```ts
import type { RequestCategory } from "@agent-team/core";

export class GatesPane {
  readonly #el: HTMLElement;
  readonly #send: (cmd: { type: "allow" | "deny"; requestId: string }) => void;
  readonly #rows = new Map<string, HTMLElement>();

  constructor(el: HTMLElement, send: (cmd: { type: "allow" | "deny"; requestId: string }) => void) {
    this.#el = el;
    this.#send = send;
  }

  add(gate: { requestId: string; category: RequestCategory; summary: string }): void {
    if (this.#rows.has(gate.requestId)) return;
    const row = document.createElement("div");
    row.className = "gate";
    const cat = document.createElement("span");
    cat.className = "cat";
    cat.textContent = gate.category;
    const summary = document.createElement("span");
    summary.className = "summary";
    summary.textContent = gate.summary;
    const allow = document.createElement("button");
    allow.textContent = "Allow";
    allow.onclick = () => this.#send({ type: "allow", requestId: gate.requestId });
    const deny = document.createElement("button");
    deny.textContent = "Deny";
    deny.onclick = () => this.#send({ type: "deny", requestId: gate.requestId });
    row.append(cat, summary, allow, deny);
    this.#el.appendChild(row);
    this.#rows.set(gate.requestId, row);
  }

  /** gate_resolved covers multi-tab races: whoever resolves, every tab clears. */
  resolve(requestId: string): void {
    this.#rows.get(requestId)?.remove();
    this.#rows.delete(requestId);
  }
}
```

- [ ] **Step 5: Create `packages/host-web/ui/src/proposals.ts`**

```ts
import type { AmbientProposal } from "@agent-team/core";
import type { ClientCommand } from "../../src/protocol.js";

export class ProposalsPane {
  readonly #list: HTMLElement;
  readonly #diff: HTMLPreElement;
  readonly #send: (cmd: ClientCommand) => void;
  readonly #outcomes = new Map<string, { text: string; ok: boolean }>();

  constructor(root: HTMLElement, send: (cmd: ClientCommand) => void) {
    this.#list = root.querySelector("#proposal-list") as HTMLElement;
    this.#diff = root.querySelector("#proposal-diff") as HTMLPreElement;
    this.#send = send;
    (root.querySelector("#proposals-refresh") as HTMLButtonElement).onclick = () =>
      this.#send({ type: "proposal_refresh" });
  }

  render(items: AmbientProposal[]): void {
    this.#list.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "proposal";
      empty.textContent = "no pending proposals";
      this.#list.appendChild(empty);
      return;
    }
    for (const p of items) {
      const row = document.createElement("div");
      row.className = "proposal";
      const branch = document.createElement("div");
      branch.className = "branch";
      branch.textContent = `${p.branch} (${p.commitCount} commit${p.commitCount === 1 ? "" : "s"})`;
      branch.onclick = () => this.#send({ type: "proposal_show", branch: p.branch });
      const finding = document.createElement("div");
      finding.className = "finding";
      finding.textContent = p.finding || "(no finding trailer)";
      const actions = document.createElement("div");
      actions.className = "actions";
      const accept = document.createElement("button");
      accept.textContent = "Accept";
      accept.onclick = () => this.#send({ type: "proposal_accept", branch: p.branch });
      const reject = document.createElement("button");
      reject.textContent = "Reject";
      reject.onclick = () => this.#send({ type: "proposal_reject", branch: p.branch });
      actions.append(accept, reject);
      row.append(branch, finding, actions);
      const prior = this.#outcomes.get(p.branch);
      if (prior) row.appendChild(this.#outcomeEl(prior));
      this.#list.appendChild(row);
    }
  }

  showDiff(branch: string, diff: string): void {
    this.#diff.hidden = false;
    this.#diff.textContent = `# ${branch}\n${diff}`;
  }

  outcome(branch: string, outcome: { status: string; files?: string[] }): void {
    const ok = outcome.status === "merged" || outcome.status === "rejected";
    const text =
      outcome.status === "conflict"
        ? `conflict: ${(outcome.files ?? []).join(", ")} — branch left intact`
        : outcome.status;
    this.#outcomes.set(branch, { text, ok });
    const note = document.createElement("div");
    note.append(this.#outcomeEl({ text, ok }));
    this.#list.prepend(note); // visible even after the row disappears from a refreshed list
  }

  #outcomeEl(o: { text: string; ok: boolean }): HTMLElement {
    const el = document.createElement("div");
    el.className = `outcome ${o.ok ? "ok" : "bad"}`;
    el.textContent = o.text;
    return el;
  }
}
```

- [ ] **Step 6: Create `packages/host-web/ui/src/main.ts`** (ws client: reconnect + resume + routing)

```ts
import type { ServerEnvelope, ClientCommand } from "../../src/protocol.js";
import { FeedPane } from "./feed.js";
import { GatesPane } from "./gates.js";
import { ProposalsPane } from "./proposals.js";

const connbar = document.getElementById("connbar")!;
const feed = new FeedPane(document.getElementById("feed")!);
const gates = new GatesPane(document.getElementById("gates")!, (cmd) => send(cmd));
const proposals = new ProposalsPane(document.getElementById("proposals")!, (cmd) => send(cmd));

let ws: WebSocket | null = null;
let lastSeq = 0;
let backoffMs = 500;

function send(cmd: ClientCommand): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
}

function setConn(state: "connected" | "reconnecting" | "gapped", text: string): void {
  connbar.className = state;
  connbar.textContent = text;
}

function onEnvelope(env: ServerEnvelope): void {
  if (env.seq > 0) lastSeq = env.seq;
  switch (env.type) {
    case "hello":
      if (env.gapped) {
        feed.markGap();
        setConn("gapped", `reconnected — missed events (server seq ${env.latestSeq})`);
      } else {
        setConn("connected", `connected — run ${env.runState}`);
      }
      return;
    case "event":
      feed.append(env.payload);
      return;
    case "gate":
      gates.add(env);
      return;
    case "gate_resolved":
      gates.resolve(env.requestId);
      return;
    case "proposals":
      proposals.render(env.items);
      return;
    case "proposal_diff":
      proposals.showDiff(env.branch, env.diff);
      return;
    case "proposal_outcome":
      proposals.outcome(env.branch, env.outcome as { status: string; files?: string[] });
      return;
  }
}

function connect(): void {
  ws = new WebSocket(`ws://${location.host}/`);
  ws.onopen = () => {
    backoffMs = 500;
    setConn("connected", "connected");
    send({ type: "resume", afterSeq: lastSeq }); // afterSeq 0 on first connect = full backfill
  };
  ws.onmessage = (e) => onEnvelope(JSON.parse(String(e.data)) as ServerEnvelope);
  ws.onclose = () => {
    setConn("reconnecting", `reconnecting in ${(backoffMs / 1000).toFixed(1)}s…`);
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 8_000);
  };
  ws.onerror = () => ws?.close();
}

connect();
```

- [ ] **Step 7: Typecheck + build the UI**

Run: `npm run typecheck:ui -w @agent-team/host-web`
Expected: exit 0.

Run: `npm run build:ui -w @agent-team/host-web`
Expected: exit 0; `packages/host-web/ui/dist/index.html` + hashed assets exist. (`@agent-team/core` imports in UI files are type-only ⇒ erased at build; the bundle contains pretext only.)

- [ ] **Step 8: Run the full package suite once more**

Run: `npm run test -w @agent-team/host-web`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add packages/host-web/ui packages/host-web/vite.config.ts
git commit -m "feat(host-web): Control Room UI — pretext feed, gate inbox, proposals pane"
```

(If `vite.config.ts` was already committed in Task 9, git will simply skip it.)

---### Task 11: LIVE-SMOKE doc + screenshot script + workspace gate

**Files:**
- Create: `packages/host-web/LIVE-SMOKE.md`
- Create: `packages/host-web/scripts/shot.mjs`

- [ ] **Step 1: Create `packages/host-web/LIVE-SMOKE.md`**

```markdown
# host-web live smoke (manual, NOT CI)

Prereqs: `npm run build && npm run build:ui -w @agent-team/host-web`; Claude Code
CLI OAuth creds present (`~/.claude/.credentials.json`); a THROWAWAY git repo
(host-web is not OS-sandboxed — same caveat as B1).

1. Make a throwaway repo:
   `git init -b main /tmp/hw-smoke && cd /tmp/hw-smoke && git commit --allow-empty -m base`
2. Graph file `g.json`:
   `[{ "id": "n1", "role": "coder", "goal": "create hello.txt containing 'hi', then run: rm -rf ./scratch", "dependsOn": [] }]`
3. Run: `node packages/host-web/dist/cli.js --graph g.json --repo /tmp/hw-smoke --model claude-haiku-4-5-20251001`
4. Open the printed URL. VERIFY:
   - [ ] conn bar green "connected"
   - [ ] feed streams events live (tool_call / file_change rows)
   - [ ] the `rm -rf` surfaces as a DESTRUCTIVE gate; click Allow; run completes
   - [ ] `git show agentteam/integration:hello.txt` prints "hi"
   - [ ] refresh the page mid-run → feed backfills via resume (no duplicates)
   - [ ] close ALL tabs while a gate is pending → after ~5s the CLI shows the deny
   - [ ] stage a proposal branch (see tests/compose-web.test.ts stageProposal) →
         Refresh lists it; diff shows; Accept merges onto HEAD
5. Scroll feel: with thousands of events, scrolling stays smooth and the DOM
   holds ~30 rows (inspect element count under #feed).
```

- [ ] **Step 1b: Create `packages/host-web/scripts/shot.mjs`** (screenshot an already-running Control Room — the spike's shot.mjs pattern; used during live smoke, never CI)

```js
// Usage: node scripts/shot.mjs [url]   (default http://127.0.0.1:7340/)
// Screenshots the live Control Room to control-room.png next to this script.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const url = process.argv[2] ?? "http://127.0.0.1:7340/";
let browser;
for (const channel of ["chrome", "msedge", undefined]) {
  try {
    browser = await chromium.launch({ channel, headless: true });
    break;
  } catch {
    /* try next channel */
  }
}
if (!browser) {
  console.error("no chromium-family browser found");
  process.exit(1);
}
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(url);
await page.waitForSelector("#connbar.connected", { timeout: 15_000 });
await page.waitForTimeout(500); // let the feed settle
const out = fileURLToPath(new URL("./control-room.png", import.meta.url));
await page.screenshot({ path: out });
console.log(`saved ${out}`);
await browser.close();
```

- [ ] **Step 2: Full workspace gate**

Run: `npm run build`
Expected: exit 0 across all six packages.

Run: `npm run test`
Expected: ALL suites green; total count > 181 (core 105 / adapters-claude 27 / adapters-deepseek 19 / host-headless 20 / host-vscode 10 / host-web ~24).

- [ ] **Step 3: Zero-diff-outside check**

Run: `git status --porcelain`
Expected: NOTHING under `packages/core`, `packages/adapters-*`, `packages/host-headless`, `packages/host-vscode`. Only host-web files, root `package.json`, root `package-lock.json` (all committed by now), and the pre-existing untracked stragglers.

- [ ] **Step 4: Commit**

```bash
git add packages/host-web/LIVE-SMOKE.md packages/host-web/scripts/shot.mjs
git commit -m "docs(host-web): live smoke checklist + screenshot script"
```

---

## Plan self-review notes (already applied)

- Spec §4 `proposal_diff` is a DIRECT envelope (seq 0) in this plan, not broadcast — the spec table lists it server→browser without distinguishing; direct-to-requester is the correct reading (two tabs shouldn't fight over one diff view).
- Spec §6 serialization lives in `ProposalsService.#serialize`; reads pass through unserialized by design.
- `BudgetExceededAdapter` duplication is a plan-time decision (spec forbids the host-headless import but mandates identical ceiling semantics) — documented in the file header and plan header.
- The UI's first-connect `resume {afterSeq: 0}` doubles as feed backfill; spec calls this out only for reconnect, but the same mechanism covers both — no extra protocol needed.
```
