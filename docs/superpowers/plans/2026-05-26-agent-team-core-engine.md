# Agent-Team Core Engine — Implementation Plan (Plan A of S1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provider-agnostic, headless agent-team engine — normalized events, message bus, policy/broker, diff store, and orchestrator — fully driven and proven by a fake backend, with no VS Code dependency.

**Architecture:** A standalone TypeScript library (`packages/core`). Specialist agents are `AgentAdapter` implementations that emit a small **normalized event vocabulary**. A `MessageBus` carries events; an `ActionBroker` resolves `action_request` events against a per-agent×per-category `PolicyStore`; a `DiffStore` stages proposed file changes behind an injected applier port; an `Orchestrator` runs a team to termination under a turn budget. Everything is exercised with a `FakeAdapter`, so the whole engine is unit-testable offline. VS Code, Claude, and CodeWhale are layered on in Plan B.

**Tech Stack:** TypeScript (ESM, `strict`), Vitest, Node ≥ 20. Zero runtime dependencies in the core.

---

## File Structure

```
packages/core/
  package.json
  tsconfig.json
  vitest.config.ts
  src/
    events.ts          — normalized event types, AgentId/Role helpers
    bus.ts             — MessageBus: publish/subscribe, addressing, cycle detection
    adapter.ts         — AgentAdapter interface + TaskContext
    fake-adapter.ts    — FakeAdapter (scriptable) for deterministic tests
    policy/
      model.ts         — HandlingMode, PolicyCell, PolicyTable, categories
      presets.ts       — Co-pilot/Pair/Autopilot tables + hard rules
      store.ts         — PolicyStore (applyPreset/get/setCell, hard-rule enforcement)
    broker.ts          — ActionBroker (classify lookup → GATE/ROUTE/NOTIFY/AUTO)
    diff-store.ts      — DiffStore + DiffApplier port
    orchestrator.ts    — Orchestrator (spawn team, budget, termination)
    index.ts           — public exports
  tests/
    bus.test.ts
    fake-adapter.test.ts
    adapter-conformance.test.ts
    policy.test.ts
    broker.test.ts
    diff-store.test.ts
    orchestrator.test.ts
    integration.test.ts
```

One responsibility per file. The engine never imports `vscode`; the only seam to the outside world is the `DiffApplier` port and the adapters themselves.

---

## Task 0: Scaffold the core package

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@agent-team/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create a placeholder `src/index.ts`**

```ts
export const CORE_VERSION = "0.0.0";
```

- [ ] **Step 5: Install and verify the toolchain**

Run: `cd packages/core && npm install && npm run build && npm test`
Expected: install succeeds; `tsc` produces `dist/`; vitest reports `No test files found` (exit 0) — confirms the harness runs.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "chore(core): scaffold TypeScript + vitest package"
```

---

## Task 1: Normalized event vocabulary

**Files:**
- Create: `packages/core/src/events.ts`
- Test: `packages/core/tests/fake-adapter.test.ts` (created in Task 3; events themselves are type-only, validated by compilation + the helper test below)

- [ ] **Step 1: Write the failing test for the `roleOf` helper**

Create `packages/core/tests/events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { roleOf, makeAgentId } from "../src/events.js";

describe("agent id helpers", () => {
  it("derives role from an agent id", () => {
    expect(roleOf("coder#1")).toBe("coder");
    expect(roleOf("lead#0")).toBe("lead");
  });

  it("builds an agent id from role + index", () => {
    expect(makeAgentId("reviewer", 2)).toBe("reviewer#2");
  });

  it("throws on a malformed id", () => {
    expect(() => roleOf("nonsense")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/events.test.ts`
Expected: FAIL — cannot find module `../src/events.js`.

- [ ] **Step 3: Write `src/events.ts`**

```ts
export type Role = "lead" | "architect" | "coder" | "reviewer" | "ops";

/** Instance id, always formatted `${role}#${index}`, e.g. "coder#1". */
export type AgentId = string;

export type Target = Role | AgentId | "all";

export type RequestCategory =
  | "approval"
  | "credential"
  | "judgment"
  | "external_action"
  | "destructive"
  | "info";

export interface MessageEvent {
  kind: "message";
  from: AgentId;
  to: Target;
  text: string;
  /** seq of the bus event this message responds to (for cycle detection). */
  causedBy?: number;
}

export interface ToolCallEvent {
  kind: "tool_call";
  from: AgentId;
  name: string;
  args: unknown;
}

export interface FileChangeEvent {
  kind: "file_change";
  from: AgentId;
  proposalId: string;
  path: string;
  /** Unified diff text. */
  diff: string;
}

export interface ActionRequestEvent {
  kind: "action_request";
  from: AgentId;
  requestId: string;
  category: RequestCategory;
  summary: string;
  payload?: unknown;
  timeoutMs: number;
}

export interface DoneEvent {
  kind: "done";
  from: AgentId;
  summary: string;
}

export interface ErrorEvent {
  kind: "error";
  from: AgentId;
  message: string;
}

export type AgentEvent =
  | MessageEvent
  | ToolCallEvent
  | FileChangeEvent
  | ActionRequestEvent
  | DoneEvent
  | ErrorEvent;

/** Transport metadata stamped by the bus on publish. */
export interface EventMeta {
  seq: number;
  ts: number;
}

export type BusEvent = AgentEvent & EventMeta;

const ROLES: readonly Role[] = ["lead", "architect", "coder", "reviewer", "ops"];

export function makeAgentId(role: Role, index: number): AgentId {
  return `${role}#${index}`;
}

export function roleOf(id: AgentId): Role {
  const role = id.split("#")[0];
  if (!ROLES.includes(role as Role)) {
    throw new Error(`Cannot derive role from agent id: ${id}`);
  }
  return role as Role;
}

/** True if an event addressed with `to` should be delivered to `recipient`. */
export function addressedTo(to: Target, recipientId: AgentId): boolean {
  if (to === "all") return true;
  if (to === recipientId) return true;
  return to === roleOf(recipientId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/events.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts packages/core/tests/events.test.ts
git commit -m "feat(core): normalized event vocabulary + agent id helpers"
```

---

## Task 2: Message Bus

**Files:**
- Create: `packages/core/src/bus.ts`
- Test: `packages/core/tests/bus.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/bus.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { MessageBus } from "../src/bus.js";
import type { MessageEvent } from "../src/events.js";

function msg(from: string, to: string, text: string, causedBy?: number): MessageEvent {
  return { kind: "message", from, to, text, ...(causedBy !== undefined ? { causedBy } : {}) };
}

describe("MessageBus", () => {
  it("stamps monotonically increasing seq and a timestamp", () => {
    const bus = new MessageBus();
    const a = bus.publish(msg("lead#0", "all", "hi"));
    const b = bus.publish(msg("lead#0", "all", "again"));
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(typeof a.ts).toBe("number");
  });

  it("delivers every published event to subscribers", () => {
    const bus = new MessageBus();
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.seq));
    bus.publish(msg("lead#0", "all", "one"));
    bus.publish(msg("lead#0", "all", "two"));
    expect(seen).toEqual([0, 1]);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new MessageBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    bus.publish(msg("lead#0", "all", "one"));
    off();
    bus.publish(msg("lead#0", "all", "two"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("detects a causal cycle when a role recurs past the limit", () => {
    const bus = new MessageBus({ maxChainRepeats: 2 });
    const onCycle = vi.fn();
    bus.onCycle(onCycle);
    // coder -> reviewer -> coder -> reviewer -> coder (coder appears 3x)
    const e0 = bus.publish(msg("coder#1", "reviewer", "check this"));
    const e1 = bus.publish(msg("reviewer#1", "coder", "question", e0.seq));
    const e2 = bus.publish(msg("coder#1", "reviewer", "answer", e1.seq));
    const e3 = bus.publish(msg("reviewer#1", "coder", "another q", e2.seq));
    bus.publish(msg("coder#1", "reviewer", "answer2", e3.seq));
    expect(onCycle).toHaveBeenCalledTimes(1);
  });

  it("does not flag short chains as cycles", () => {
    const bus = new MessageBus({ maxChainRepeats: 2 });
    const onCycle = vi.fn();
    bus.onCycle(onCycle);
    const e0 = bus.publish(msg("coder#1", "reviewer", "check"));
    bus.publish(msg("reviewer#1", "coder", "ok", e0.seq));
    expect(onCycle).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/bus.test.ts`
Expected: FAIL — cannot find module `../src/bus.js`.

- [ ] **Step 3: Write `src/bus.ts`**

```ts
import type { AgentEvent, BusEvent, MessageEvent } from "./events.js";
import { roleOf } from "./events.js";

export interface BusOptions {
  /** Max times one role may recur in a single causal chain before a cycle is flagged. */
  maxChainRepeats?: number;
}

export interface CycleInfo {
  event: BusEvent;
  role: string;
  count: number;
}

type Subscriber = (e: BusEvent) => void;
type CycleListener = (info: CycleInfo) => void;

export class MessageBus {
  private seq = 0;
  private subscribers = new Set<Subscriber>();
  private cycleListeners = new Set<CycleListener>();
  private bySeq = new Map<number, BusEvent>();
  private readonly maxChainRepeats: number;

  constructor(opts: BusOptions = {}) {
    this.maxChainRepeats = opts.maxChainRepeats ?? 4;
  }

  publish(event: AgentEvent): BusEvent {
    const stamped: BusEvent = { ...event, seq: this.seq++, ts: Date.now() };
    this.bySeq.set(stamped.seq, stamped);
    if (stamped.kind === "message") {
      this.checkCycle(stamped);
    }
    for (const sub of this.subscribers) sub(stamped);
    return stamped;
  }

  subscribe(handler: Subscriber): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  onCycle(listener: CycleListener): () => void {
    this.cycleListeners.add(listener);
    return () => this.cycleListeners.delete(listener);
  }

  private checkCycle(event: BusEvent & MessageEvent): void {
    const counts = new Map<string, number>();
    let cursor: (BusEvent & MessageEvent) | undefined = event;
    while (cursor) {
      const role = roleOf(cursor.from);
      const next = (counts.get(role) ?? 0) + 1;
      counts.set(role, next);
      if (next > this.maxChainRepeats) {
        for (const l of this.cycleListeners) l({ event, role, count: next });
        return;
      }
      const parentSeq = cursor.causedBy;
      const parent = parentSeq !== undefined ? this.bySeq.get(parentSeq) : undefined;
      cursor = parent && parent.kind === "message" ? (parent as BusEvent & MessageEvent) : undefined;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/bus.test.ts`
Expected: PASS (5 tests). Note: the test constructs the bus with `maxChainRepeats: 2`, so a role appearing 3× trips the cycle.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bus.ts packages/core/tests/bus.test.ts
git commit -m "feat(core): message bus with seq stamping + causal cycle detection"
```

---

## Task 3: Agent Adapter interface + FakeAdapter

**Files:**
- Create: `packages/core/src/adapter.ts`
- Create: `packages/core/src/fake-adapter.ts`
- Test: `packages/core/tests/fake-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/fake-adapter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeAdapter } from "../src/fake-adapter.js";
import type { AgentEvent } from "../src/events.js";

describe("FakeAdapter", () => {
  it("emits its scripted events with `from` set to the agent id, ending in done", async () => {
    const adapter = new FakeAdapter([
      { kind: "message", to: "all", text: "starting" },
      { kind: "done", summary: "finished" },
    ]);
    const out: AgentEvent[] = [];
    await adapter.startTask({ goal: "g", role: "coder", agentId: "coder#1" }, (e) => out.push(e));
    expect(out.map((e) => e.kind)).toEqual(["message", "done"]);
    expect(out.every((e) => e.from === "coder#1")).toBe(true);
  });

  it("stops emitting after interrupt", async () => {
    const adapter = new FakeAdapter([
      { kind: "message", to: "all", text: "one" },
      { kind: "message", to: "all", text: "two" },
      { kind: "done", summary: "done" },
    ]);
    const out: AgentEvent[] = [];
    const p = adapter.startTask({ goal: "g", role: "coder", agentId: "coder#1" }, (e) => {
      out.push(e);
      if (out.length === 1) adapter.interrupt();
    });
    await p;
    expect(out.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/fake-adapter.test.ts`
Expected: FAIL — cannot find module `../src/fake-adapter.js`.

- [ ] **Step 3: Write `src/adapter.ts`**

```ts
import type { AgentEvent, Role, AgentId } from "./events.js";

export interface TaskContext {
  goal: string;
  role: Role;
  agentId: AgentId;
}

export type Emit = (event: AgentEvent) => void;

export interface AgentAdapter {
  /** Backend identifier, e.g. "fake" | "claude" | "codewhale". */
  readonly backend: string;
  /** Run one task to completion; resolves after the adapter emits a terminal event or is interrupted. */
  startTask(ctx: TaskContext, emit: Emit): Promise<void>;
  /** Cancel the in-flight task. */
  interrupt(): void;
}
```

- [ ] **Step 4: Write `src/fake-adapter.ts`**

```ts
import type { AgentAdapter, TaskContext, Emit } from "./adapter.js";
import type { AgentEvent } from "./events.js";

export class FakeAdapter implements AgentAdapter {
  readonly backend = "fake";
  private interrupted = false;

  constructor(private readonly script: Array<Omit<AgentEvent, "from">>) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.interrupted = false;
    for (const partial of this.script) {
      if (this.interrupted) return;
      emit({ ...partial, from: ctx.agentId } as AgentEvent);
      // Yield to the microtask queue so interrupt() set inside emit() takes effect.
      await Promise.resolve();
    }
  }

  interrupt(): void {
    this.interrupted = true;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/fake-adapter.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/adapter.ts packages/core/src/fake-adapter.ts packages/core/tests/fake-adapter.test.ts
git commit -m "feat(core): AgentAdapter interface + scriptable FakeAdapter"
```

---

## Task 4: Adapter conformance suite

**Files:**
- Create: `packages/core/tests/adapter-conformance.ts` (reusable suite)
- Create: `packages/core/tests/adapter-conformance.test.ts` (runs it against FakeAdapter)

This suite is exported so Plan B can run the *same* assertions against the Claude and CodeWhale adapters.

- [ ] **Step 1: Write the reusable conformance suite**

Create `packages/core/tests/adapter-conformance.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { AgentAdapter } from "../src/adapter.js";
import type { AgentEvent } from "../src/events.js";

/**
 * Runs the shared adapter contract. `makeAdapter` must return an adapter that,
 * given the goal "emit one message then finish", emits exactly a `message`
 * followed by a `done`.
 */
export function runAdapterConformance(name: string, makeAdapter: () => AgentAdapter): void {
  describe(`AgentAdapter conformance: ${name}`, () => {
    it("exposes a non-empty backend id", () => {
      expect(makeAdapter().backend.length).toBeGreaterThan(0);
    });

    it("stamps every event's `from` with the context agentId", async () => {
      const out: AgentEvent[] = [];
      await makeAdapter().startTask(
        { goal: "emit one message then finish", role: "coder", agentId: "coder#7" },
        (e) => out.push(e),
      );
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((e) => e.from === "coder#7")).toBe(true);
    });

    it("terminates with a `done` (or `error`) event", async () => {
      const out: AgentEvent[] = [];
      await makeAdapter().startTask(
        { goal: "emit one message then finish", role: "coder", agentId: "coder#7" },
        (e) => out.push(e),
      );
      const last = out[out.length - 1];
      expect(["done", "error"]).toContain(last.kind);
    });
  });
}
```

- [ ] **Step 2: Write the test that runs the suite against FakeAdapter**

Create `packages/core/tests/adapter-conformance.test.ts`:

```ts
import { runAdapterConformance } from "./adapter-conformance.js";
import { FakeAdapter } from "../src/fake-adapter.js";

runAdapterConformance("FakeAdapter", () =>
  new FakeAdapter([
    { kind: "message", to: "all", text: "working" },
    { kind: "done", summary: "finished" },
  ]),
);
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/adapter-conformance.test.ts`
Expected: PASS (3 tests). (The suite has no failing-first phase of its own — it is validated by passing against the already-built FakeAdapter.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/tests/adapter-conformance.ts packages/core/tests/adapter-conformance.test.ts
git commit -m "test(core): reusable adapter conformance suite (FakeAdapter passes)"
```

---

## Task 5: Policy model, presets, and store

**Files:**
- Create: `packages/core/src/policy/model.ts`
- Create: `packages/core/src/policy/presets.ts`
- Create: `packages/core/src/policy/store.ts`
- Test: `packages/core/tests/policy.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PolicyStore } from "../src/policy/store.js";

describe("PolicyStore", () => {
  it("applies the Pair preset (coder approval routes to reviewer)", () => {
    const store = new PolicyStore();
    store.applyPreset("pair");
    expect(store.get("coder", "approval")).toEqual({ mode: "ROUTE", route: "reviewer" });
  });

  it("Pair preset routes coder external_action to ops but lets ops notify", () => {
    const store = new PolicyStore();
    store.applyPreset("pair");
    expect(store.get("coder", "external_action")).toEqual({ mode: "ROUTE", route: "ops" });
    expect(store.get("ops", "external_action")).toEqual({ mode: "NOTIFY" });
  });

  it("hard rule: credential + destructive stay GATE even on Autopilot", () => {
    const store = new PolicyStore();
    store.applyPreset("autopilot");
    expect(store.get("coder", "credential").mode).toBe("GATE");
    expect(store.get("coder", "destructive").mode).toBe("GATE");
  });

  it("setCell overrides a single cell but cannot un-GATE a hard-rule category unless forced", () => {
    const store = new PolicyStore();
    store.applyPreset("pair");
    store.setCell("coder", "destructive", { mode: "AUTO" });
    expect(store.get("coder", "destructive").mode).toBe("GATE"); // still gated
    store.setCell("coder", "destructive", { mode: "AUTO" }, { force: true });
    expect(store.get("coder", "destructive").mode).toBe("AUTO"); // forced through
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/policy.test.ts`
Expected: FAIL — cannot find module `../src/policy/store.js`.

- [ ] **Step 3: Write `src/policy/model.ts`**

```ts
import type { Role, RequestCategory } from "../events.js";

export type HandlingMode = "GATE" | "ROUTE" | "NOTIFY" | "AUTO";

export interface PolicyCell {
  mode: HandlingMode;
  /** Required when mode === "ROUTE": the role that fulfills the request. */
  route?: Role;
}

export type PolicyTable = Record<Role, Record<RequestCategory, PolicyCell>>;

export const CATEGORIES: readonly RequestCategory[] = [
  "approval",
  "credential",
  "judgment",
  "external_action",
  "destructive",
  "info",
];

/** Categories that are pinned to GATE and only changeable with an explicit force. */
export const HARD_RULE_CATEGORIES: readonly RequestCategory[] = ["credential", "destructive"];
```

- [ ] **Step 4: Write `src/policy/presets.ts`**

```ts
import type { PolicyTable } from "./model.js";

export type PresetName = "copilot" | "pair" | "autopilot";

/** The "Pair" preset — gate only risky things. Mirrors the spec's worked table. */
const PAIR: PolicyTable = {
  lead: {
    approval: { mode: "AUTO" }, credential: { mode: "GATE" }, judgment: { mode: "GATE" },
    external_action: { mode: "ROUTE", route: "ops" }, destructive: { mode: "GATE" }, info: { mode: "AUTO" },
  },
  architect: {
    approval: { mode: "NOTIFY" }, credential: { mode: "GATE" }, judgment: { mode: "ROUTE", route: "lead" },
    external_action: { mode: "GATE" }, destructive: { mode: "GATE" }, info: { mode: "AUTO" },
  },
  coder: {
    approval: { mode: "ROUTE", route: "reviewer" }, credential: { mode: "GATE" }, judgment: { mode: "ROUTE", route: "lead" },
    external_action: { mode: "ROUTE", route: "ops" }, destructive: { mode: "GATE" }, info: { mode: "ROUTE", route: "lead" },
  },
  reviewer: {
    approval: { mode: "AUTO" }, credential: { mode: "GATE" }, judgment: { mode: "ROUTE", route: "lead" },
    external_action: { mode: "GATE" }, destructive: { mode: "GATE" }, info: { mode: "AUTO" },
  },
  ops: {
    approval: { mode: "NOTIFY" }, credential: { mode: "GATE" }, judgment: { mode: "GATE" },
    external_action: { mode: "NOTIFY" }, destructive: { mode: "GATE" }, info: { mode: "AUTO" },
  },
};

/** Helper: clone PAIR and rewrite every non-hard-rule cell to a single mode. */
function stamp(base: PolicyTable, mode: "GATE" | "NOTIFY"): PolicyTable {
  const out = structuredClone(base);
  for (const role of Object.keys(out) as (keyof PolicyTable)[]) {
    for (const cat of Object.keys(out[role]) as (keyof PolicyTable["lead"])[]) {
      if (cat === "credential" || cat === "destructive") continue; // hard rules handled by store
      // Preserve ROUTE targets; only shift mode for non-routed cells.
      if (out[role][cat].mode !== "ROUTE") out[role][cat] = { mode };
    }
  }
  return out;
}

export const PRESETS: Record<PresetName, PolicyTable> = {
  pair: PAIR,
  copilot: stamp(PAIR, "GATE"),
  autopilot: stamp(PAIR, "NOTIFY"),
};
```

- [ ] **Step 5: Write `src/policy/store.ts`**

```ts
import type { Role, RequestCategory } from "../events.js";
import { HARD_RULE_CATEGORIES, type PolicyCell, type PolicyTable } from "./model.js";
import { PRESETS, type PresetName } from "./presets.js";

export class PolicyStore {
  private table: PolicyTable | null = null;
  private forced = new Set<string>(); // `${role}:${category}` cells that bypass hard rules

  applyPreset(name: PresetName): void {
    this.table = structuredClone(PRESETS[name]);
    this.forced.clear();
  }

  setCell(role: Role, category: RequestCategory, cell: PolicyCell, opts: { force?: boolean } = {}): void {
    this.require();
    this.table![role][category] = cell;
    if (opts.force) this.forced.add(`${role}:${category}`);
    else this.forced.delete(`${role}:${category}`);
  }

  get(role: Role, category: RequestCategory): PolicyCell {
    this.require();
    const cell = this.table![role][category];
    const isHard = HARD_RULE_CATEGORIES.includes(category);
    if (isHard && !this.forced.has(`${role}:${category}`)) {
      return { mode: "GATE" };
    }
    return cell;
  }

  private require(): void {
    if (!this.table) throw new Error("PolicyStore: applyPreset() must be called first");
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/policy.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/policy packages/core/tests/policy.test.ts
git commit -m "feat(core): policy model, presets, and hard-rule-enforcing store"
```

---

## Task 6: Action Broker

**Files:**
- Create: `packages/core/src/broker.ts`
- Test: `packages/core/tests/broker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/broker.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ActionBroker } from "../src/broker.js";
import { PolicyStore } from "../src/policy/store.js";
import type { ActionRequestEvent } from "../src/events.js";

function req(from: string, category: ActionRequestEvent["category"]): ActionRequestEvent {
  return { kind: "action_request", from, requestId: "r1", category, summary: "do it", timeoutMs: 1000 };
}

function makeBroker() {
  const store = new PolicyStore();
  store.applyPreset("pair");
  const gate = vi.fn();
  const route = vi.fn();
  const notify = vi.fn();
  const broker = new ActionBroker(store, { gate, route, notify });
  return { broker, gate, route, notify };
}

describe("ActionBroker", () => {
  it("routes a coder approval request to the reviewer", () => {
    const { broker, route } = makeBroker();
    const res = broker.handle(req("coder#1", "approval"));
    expect(res).toEqual({ mode: "ROUTE", route: "reviewer", requestId: "r1" });
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r1" }), "coder#1", "reviewer");
  });

  it("gates a coder destructive request (hard rule)", () => {
    const { broker, gate } = makeBroker();
    const res = broker.handle(req("coder#1", "destructive"));
    expect(res.mode).toBe("GATE");
    expect(gate).toHaveBeenCalledOnce();
  });

  it("notifies on an ops external_action", () => {
    const { broker, notify } = makeBroker();
    const res = broker.handle(req("ops#1", "external_action"));
    expect(res.mode).toBe("NOTIFY");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("AUTO performs no side effect", () => {
    const { broker, gate, route, notify } = makeBroker();
    const res = broker.handle(req("lead#0", "info"));
    expect(res.mode).toBe("AUTO");
    expect(gate).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/broker.test.ts`
Expected: FAIL — cannot find module `../src/broker.js`.

- [ ] **Step 3: Write `src/broker.ts`**

```ts
import type { ActionRequestEvent, AgentId, Role } from "./events.js";
import { roleOf } from "./events.js";
import type { HandlingMode } from "./policy/model.js";
import type { PolicyStore } from "./policy/store.js";

export interface BrokerHandlers {
  gate: (req: ActionRequestEvent, from: AgentId) => void;
  route: (req: ActionRequestEvent, from: AgentId, to: Role) => void;
  notify: (req: ActionRequestEvent, from: AgentId) => void;
}

export interface ActionResolution {
  mode: HandlingMode;
  route?: Role;
  requestId: string;
}

export class ActionBroker {
  constructor(private store: PolicyStore, private handlers: BrokerHandlers) {}

  handle(req: ActionRequestEvent): ActionResolution {
    const role = roleOf(req.from);
    const cell = this.store.get(role, req.category);
    switch (cell.mode) {
      case "GATE":
        this.handlers.gate(req, req.from);
        return { mode: "GATE", requestId: req.requestId };
      case "ROUTE":
        if (!cell.route) throw new Error(`ROUTE cell for ${role}/${req.category} has no route target`);
        this.handlers.route(req, req.from, cell.route);
        return { mode: "ROUTE", route: cell.route, requestId: req.requestId };
      case "NOTIFY":
        this.handlers.notify(req, req.from);
        return { mode: "NOTIFY", requestId: req.requestId };
      case "AUTO":
        return { mode: "AUTO", requestId: req.requestId };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/broker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/broker.ts packages/core/tests/broker.test.ts
git commit -m "feat(core): action broker resolving requests against policy"
```

---

## Task 7: Diff Store

**Files:**
- Create: `packages/core/src/diff-store.ts`
- Test: `packages/core/tests/diff-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/diff-store.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { DiffStore } from "../src/diff-store.js";
import type { FileChangeEvent } from "../src/events.js";

function change(proposalId: string, path: string): FileChangeEvent {
  return { kind: "file_change", from: "coder#1", proposalId, path, diff: `--- ${path}\n+++ ${path}\n` };
}

describe("DiffStore", () => {
  it("stages a proposal as pending", () => {
    const store = new DiffStore({ apply: vi.fn() });
    const p = store.stage(change("p1", "a.ts"));
    expect(p.status).toBe("pending");
    expect(store.list("pending")).toHaveLength(1);
  });

  it("approve applies via the applier and marks applied", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const store = new DiffStore({ apply });
    store.stage(change("p1", "a.ts"));
    const applied = await store.approve("p1");
    expect(apply).toHaveBeenCalledWith("a.ts", expect.stringContaining("a.ts"));
    expect(applied.status).toBe("applied");
    expect(store.list("pending")).toHaveLength(0);
  });

  it("reject marks rejected and never calls the applier", () => {
    const apply = vi.fn();
    const store = new DiffStore({ apply });
    store.stage(change("p1", "a.ts"));
    const rejected = store.reject("p1");
    expect(rejected.status).toBe("rejected");
    expect(apply).not.toHaveBeenCalled();
  });

  it("approve on an unknown id throws", async () => {
    const store = new DiffStore({ apply: vi.fn() });
    await expect(store.approve("nope")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/diff-store.test.ts`
Expected: FAIL — cannot find module `../src/diff-store.js`.

- [ ] **Step 3: Write `src/diff-store.ts`**

```ts
import type { AgentId, FileChangeEvent } from "./events.js";

/** Port implemented by the host (Plan B wires this to VS Code's edit API). */
export interface DiffApplier {
  apply(path: string, diff: string): Promise<void>;
}

export type ProposalStatus = "pending" | "applied" | "rejected";

export interface Proposal {
  proposalId: string;
  path: string;
  diff: string;
  from: AgentId;
  status: ProposalStatus;
}

export class DiffStore {
  private proposals = new Map<string, Proposal>();

  constructor(private applier: DiffApplier) {}

  stage(e: FileChangeEvent): Proposal {
    const p: Proposal = {
      proposalId: e.proposalId,
      path: e.path,
      diff: e.diff,
      from: e.from,
      status: "pending",
    };
    this.proposals.set(p.proposalId, p);
    return p;
  }

  list(status?: ProposalStatus): Proposal[] {
    const all = [...this.proposals.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  async approve(proposalId: string): Promise<Proposal> {
    const p = this.mustGet(proposalId);
    await this.applier.apply(p.path, p.diff);
    p.status = "applied";
    return p;
  }

  reject(proposalId: string): Proposal {
    const p = this.mustGet(proposalId);
    p.status = "rejected";
    return p;
  }

  private mustGet(proposalId: string): Proposal {
    const p = this.proposals.get(proposalId);
    if (!p) throw new Error(`No proposal with id ${proposalId}`);
    return p;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/diff-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/diff-store.ts packages/core/tests/diff-store.test.ts
git commit -m "feat(core): diff store with injected applier port"
```

---

## Task 8: Orchestrator

**Files:**
- Create: `packages/core/src/orchestrator.ts`
- Test: `packages/core/tests/orchestrator.test.ts`

The Orchestrator wires each specialist's adapter `emit` into the bus (stamping `from`), runs them, and resolves when the **lead** emits `done`, the **turn budget** is exhausted, or `stop()` is called. "Turn" = one published bus event (simple, deterministic).

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/orchestrator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { MessageBus } from "../src/bus.js";
import { FakeAdapter } from "../src/fake-adapter.js";

describe("Orchestrator", () => {
  it("terminates with status 'done' when the lead emits done", async () => {
    const bus = new MessageBus();
    const orch = new Orchestrator({ bus, budget: { maxTurns: 100 } });
    const result = await orch.run("ship it", [
      { role: "lead", adapter: new FakeAdapter([
        { kind: "message", to: "all", text: "plan" },
        { kind: "done", summary: "goal met" },
      ]) },
    ]);
    expect(result.status).toBe("done");
    expect(result.summary).toBe("goal met");
  });

  it("terminates with status 'budget' when maxTurns is hit before done", async () => {
    const bus = new MessageBus();
    const orch = new Orchestrator({ bus, budget: { maxTurns: 2 } });
    const result = await orch.run("ship it", [
      { role: "lead", adapter: new FakeAdapter([
        { kind: "message", to: "all", text: "1" },
        { kind: "message", to: "all", text: "2" },
        { kind: "message", to: "all", text: "3" },
        { kind: "done", summary: "should not reach" },
      ]) },
    ]);
    expect(result.status).toBe("budget");
  });

  it("publishes every specialist event onto the bus with stamped from", async () => {
    const bus = new MessageBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(`${e.from}:${e.kind}`));
    const orch = new Orchestrator({ bus, budget: { maxTurns: 100 } });
    await orch.run("g", [
      { role: "lead", adapter: new FakeAdapter([{ kind: "done", summary: "ok" }]) },
      { role: "coder", adapter: new FakeAdapter([{ kind: "message", to: "lead", text: "hi" }]) },
    ]);
    expect(seen).toContain("coder#1:message");
    expect(seen).toContain("lead#0:done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/orchestrator.test.ts`
Expected: FAIL — cannot find module `../src/orchestrator.js`.

- [ ] **Step 3: Write `src/orchestrator.ts`**

```ts
import type { AgentAdapter } from "./adapter.js";
import type { Role } from "./events.js";
import { makeAgentId } from "./events.js";
import { MessageBus } from "./bus.js";

export interface SpecialistSpec {
  role: Role;
  adapter: AgentAdapter;
}

export interface Budget {
  maxTurns: number;
}

export interface OrchestratorDeps {
  bus: MessageBus;
  budget: Budget;
}

export type RunStatus = "done" | "budget" | "stopped";

export interface RunResult {
  status: RunStatus;
  summary: string;
}

export class Orchestrator {
  private stopped = false;
  private turns = 0;

  constructor(private deps: OrchestratorDeps) {}

  stop(): void {
    this.stopped = true;
  }

  async run(goal: string, team: SpecialistSpec[]): Promise<RunResult> {
    this.stopped = false;
    this.turns = 0;

    const adapters = team.map((s) => s.adapter);
    let terminal: RunResult | null = null;

    // Record the first terminal condition. Budget/stop interrupt all agents to
    // halt runaway work; a lead `done` is allowed to let in-flight finite work
    // drain (so cross-agent event ordering does not race the resolution).
    const recordTerminal = (result: RunResult, interrupt: boolean) => {
      if (terminal) return;
      terminal = result;
      if (interrupt) for (const a of adapters) a.interrupt();
    };

    const off = this.deps.bus.subscribe((e) => {
      this.turns += 1;
      if (this.stopped) {
        recordTerminal({ status: "stopped", summary: "stopped by user" }, true);
      } else if (this.turns >= this.deps.budget.maxTurns) {
        recordTerminal({ status: "budget", summary: `turn budget ${this.deps.budget.maxTurns} reached` }, true);
      } else if (e.kind === "done" && e.from === makeAgentId("lead", 0)) {
        recordTerminal({ status: "done", summary: e.summary }, false);
      }
    });

    // Assign instance ids (one per role for S1) and start every adapter before
    // any termination is processed, then await them all.
    const counts: Partial<Record<Role, number>> = {};
    const tasks = team.map((s) => {
      const index = counts[s.role] ?? 0;
      counts[s.role] = index + 1;
      const agentId = makeAgentId(s.role, index);
      return s.adapter.startTask({ goal, role: s.role, agentId }, (event) => {
        this.deps.bus.publish(event);
      });
    });

    await Promise.all(tasks);
    off();
    return terminal ?? { status: this.stopped ? "stopped" : "done", summary: "all agents completed" };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && npx vitest run tests/orchestrator.test.ts`
Expected: PASS (3 tests). Notes: (a) in the budget test the lead emits 3 messages before `done`; with `maxTurns: 2` the run records `budget` on the 2nd published event and interrupts the lingering adapter, so `done` is never reached. (b) A lead `done` does not interrupt other agents — their finite scripts drain — so the "publishes every specialist event" test sees `coder#1:message` regardless of cross-agent scheduling order.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/orchestrator.ts packages/core/tests/orchestrator.test.ts
git commit -m "feat(core): orchestrator with turn budget + termination"
```

---

## Task 9: Public exports + headless integration smoke test

**Files:**
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/core/tests/integration.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  MessageBus, Orchestrator, ActionBroker, PolicyStore, DiffStore, FakeAdapter,
} from "../src/index.js";
import type { ActionRequestEvent, FileChangeEvent } from "../src/index.js";

describe("headless team integration", () => {
  it("runs a fake team: coder proposes a diff, requests approval (routed), lead finishes", async () => {
    const bus = new MessageBus();

    const policy = new PolicyStore();
    policy.applyPreset("pair");
    const route = vi.fn();
    const broker = new ActionBroker(policy, { gate: vi.fn(), route, notify: vi.fn() });

    const diffs = new DiffStore({ apply: vi.fn().mockResolvedValue(undefined) });

    // Wire the bus into broker + diff store.
    bus.subscribe((e) => {
      if (e.kind === "action_request") broker.handle(e as ActionRequestEvent);
      if (e.kind === "file_change") diffs.stage(e as FileChangeEvent);
    });

    const orch = new Orchestrator({ bus, budget: { maxTurns: 100 } });
    const result = await orch.run("add a function", [
      { role: "coder", adapter: new FakeAdapter([
        { kind: "file_change", proposalId: "p1", path: "src/x.ts", diff: "--- src/x.ts\n+++ src/x.ts\n" },
        { kind: "action_request", requestId: "r1", category: "approval", summary: "review my diff", timeoutMs: 1000 },
      ]) },
      { role: "lead", adapter: new FakeAdapter([
        { kind: "done", summary: "integrated" },
      ]) },
    ]);

    expect(result.status).toBe("done");
    expect(diffs.list("pending")).toHaveLength(1);
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r1" }), "coder#1", "reviewer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/integration.test.ts`
Expected: FAIL — `index.js` does not export `MessageBus`/`Orchestrator`/etc.

- [ ] **Step 3: Write `src/index.ts`**

```ts
export * from "./events.js";
export * from "./bus.js";
export * from "./adapter.js";
export * from "./fake-adapter.js";
export * from "./policy/model.js";
export * from "./policy/presets.js";
export * from "./policy/store.js";
export * from "./broker.js";
export * from "./diff-store.js";
export * from "./orchestrator.js";
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `cd packages/core && npm run build && npm test`
Expected: `tsc` succeeds with no errors; vitest reports all suites passing (events, bus, fake-adapter, adapter-conformance, policy, broker, diff-store, orchestrator, integration).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/tests/integration.test.ts
git commit -m "feat(core): public exports + headless team integration test"
```

---

## Done — what Plan A delivers

A standalone, fully-tested headless engine: normalized events, a bus with cycle detection, a scriptable fake backend + reusable adapter conformance suite, the policy/preset/hard-rule model, the action broker, the diff store, and the orchestrator with budget-based termination — all provable with `npm test`, zero VS Code dependency.

**Plan B (next) will:** scaffold the VS Code extension, implement the Claude (Agent SDK) and CodeWhale (sidecar HTTP/SSE) adapters against the conformance suite, wire a `DiffApplier` to VS Code's edit API, build the "Control Room" webview (goal input, roster/status, bus feed, action inbox, diff review, Involvement Dial), implement the broker's `gate`/`route`/`notify` handlers plus **per-request `timeoutMs` escalation** (timeout → escalate to lead → GATE to user; the deadlock half not covered by the bus's cycle detection), and run the E2E smoke goal through both real backends.

**Explicitly NOT in Plan A** (deferred to Plan B so nothing is silently dropped): the concrete broker handlers, timeout-based deadlock escalation, adapter/sidecar crash-restart, token-based budget (Plan A counts turns), and per-token budget guardrail NOTIFY.
