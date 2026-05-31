# S4 — Ambient Agents (on-commit reactions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A background agent reacts to each git commit by staging a proposed diff on its own branch and posting a finding to the bus feed — never merging — implemented as a one-node Scheduler run with the merge step swapped out.

**Architecture:** Reuse the S2 `Scheduler` / `WorktreeManager` / `MessageBus` **untouched at runtime**. Add a pure `AmbientIntegration` collaborator whose `integrate()` reports `merged` without merging and whose `tip()` returns the reviewed commit SHA (so the agent worktree is cut straight from your commit). A host-headless `CommitWatcher` turns `.git/logs/HEAD` movement into a normalized `AmbientTrigger`; a `composeAmbient` driver maps each trigger to one Scheduler run and emits an `ambient_report` event. One type-only edit widens `SchedulerDeps.integration` to an interface so `AmbientIntegration` is accepted.

**Tech Stack:** TypeScript ESM (NodeNext), `vitest` v2, `@agent-team/core` (pure barrel + `/node` subpath), `@agent-team/adapters-claude` (`ClaudeAdapter` + scripted `QueryFn` in tests), `NodeGitRunner` over real temp repos.

---

## Spec deviation (read before Task 1)

The spec (§3.2) places `AmbientTrigger` in `ambient.ts`. This plan puts **`AmbientTrigger` and `AmbientReportEvent` in `events.ts`** instead, and keeps only the `AmbientIntegration` *class* in `ambient.ts`. Reason: `AmbientReportEvent.trigger` is an `AmbientTrigger`, and `AmbientReportEvent` must join the `AgentEvent` union in `events.ts`. If `AmbientTrigger` lived in `ambient.ts`, then `events.ts → ambient.ts → integration.ts → events.ts` would form an import cycle. Putting both event-adjacent types in `events.ts` yields a clean linear graph: `ambient.ts → integration.ts → events.ts`. Behavior is identical; only file placement differs.

---

## File Map

| File | Responsibility |
|---|---|
| `packages/core/src/events.ts` | MODIFY — add `AmbientTrigger`, `AmbientReportEvent`; add `AmbientReportEvent` to the `AgentEvent` union |
| `packages/core/src/integration.ts` | MODIFY — extract `IntegrationLike` interface; `IntegrationCoordinator implements IntegrationLike` |
| `packages/core/src/ambient.ts` | NEW — `AmbientIntegration` (stage-only collaborator) |
| `packages/core/src/orchestrator.ts` | MODIFY — `SchedulerDeps.integration` type `IntegrationCoordinator` → `IntegrationLike` (type-only) |
| `packages/core/src/index.ts` | MODIFY — `export * from "./ambient.js"` |
| `packages/core/tests/ambient.test.ts` | NEW — `AmbientIntegration` unit + `ambient_report` bus round-trip |
| `packages/host-headless/src/commit-watcher.ts` | NEW — watch `.git/logs/HEAD`, derive scope, emit `AmbientTrigger` |
| `packages/host-headless/src/compose-ambient.ts` | NEW — one-node Scheduler run per trigger; emit `ambient_report` |
| `packages/host-headless/src/cli-ambient.ts` | NEW — `agent-team-ambient` CLI (watch or `--once <sha>`) |
| `packages/host-headless/package.json` | MODIFY — add `agent-team-ambient` bin |
| `packages/host-headless/tests/commit-watcher.test.ts` | NEW — fires once per new commit with correct scope; dedup; seed not fired |
| `packages/host-headless/tests/compose-ambient.test.ts` | NEW — offline: report+diff emitted, base not advanced, proposal branch present |

**Baseline:** 152 tests green on `master` (`b2b86a5`). Gate: build exit 0, full suite green and > 152.

---

## Task 1: Core value types — `AmbientTrigger` + `ambient_report` event

**Files:**
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/index.ts` (no change needed — `events.js` already exported; verify only)

- [ ] **Step 1: Add the types to `events.ts`**

In `packages/core/src/events.ts`, add after the `ErrorEvent` interface (before the `AgentEvent` union):

```ts
/** Why an ambient reaction fired. `commit` is the only reason this milestone. */
export interface AmbientTrigger {
  reason: "commit";
  /** The reviewed commit. */
  commitSha: string;
  /** Repo-relative changed files in that commit. */
  scope: string[];
}

/**
 * An ambient agent's finding header. Proposed code changes do NOT ride this
 * event — they flow as `file_change` events during the run. `branch` is the
 * proposal branch, present iff a diff was staged.
 */
export interface AmbientReportEvent {
  kind: "ambient_report";
  from: AgentId;
  trigger: AmbientTrigger;
  summary: string;
  branch?: string;
}
```

- [ ] **Step 2: Add `AmbientReportEvent` to the union**

In the same file, change the `AgentEvent` union to include it:

```ts
export type AgentEvent =
  | MessageEvent
  | ToolCallEvent
  | FileChangeEvent
  | ActionRequestEvent
  | DoneEvent
  | ErrorEvent
  | AmbientReportEvent;
```

- [ ] **Step 3: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0. (`AmbientTrigger`/`AmbientReportEvent` are exported via the existing `export * from "./events.js"` in the barrel.)

- [ ] **Step 4: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/events.ts"
git commit -m "feat(core): AmbientTrigger + ambient_report event in the AgentEvent union"
```

---

## Task 2: `IntegrationLike` interface + widen Scheduler

**Files:**
- Modify: `packages/core/src/integration.ts`
- Modify: `packages/core/src/orchestrator.ts`

This extracts the three methods the Scheduler calls on its integration collaborator into an interface, so a stage-only implementation can be substituted. No runtime behavior changes — `IntegrationCoordinator` already has exactly these methods.

- [ ] **Step 1: Add `IntegrationLike` to `integration.ts`**

In `packages/core/src/integration.ts`, add after the `IntegrationOutcome` type (before the class):

```ts
/**
 * The surface the Scheduler depends on. `IntegrationCoordinator` is the real
 * (merging) implementation; `AmbientIntegration` is a stage-only one.
 */
export interface IntegrationLike {
  init(baseRef: string): Promise<void>;
  tip(): string;
  integrate(authorId: AgentId, branch: string): Promise<IntegrationOutcome>;
}
```

- [ ] **Step 2: Declare the class implements it**

In the same file, change the class declaration:

```ts
export class IntegrationCoordinator implements IntegrationLike {
```

- [ ] **Step 3: Widen the Scheduler dependency type**

In `packages/core/src/orchestrator.ts`, change the integration import and the `SchedulerDeps` field. The import currently reads `import type { IntegrationCoordinator } from "./integration.js";` — change it to:

```ts
import type { IntegrationLike } from "./integration.js";
```

Then in the `SchedulerDeps` interface, change:

```ts
  integration: IntegrationLike;
```

(The Scheduler body uses only `integration.init`, `integration.tip()`, and `integration.integrate(...)` — all on the interface — so no other change is needed.)

- [ ] **Step 4: Build core + run the existing scheduler/integration suites — expect pass**

Run: `npm run build -w @agent-team/core`
Expected: exit 0 (existing `composeHeadless`/`composeVscode` pass a real `IntegrationCoordinator`, which satisfies `IntegrationLike`).

Run: `npm run test -w @agent-team/core -- integration scheduler`
Expected: PASS (no behavior changed; the widening is type-only).

- [ ] **Step 5: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/integration.ts" \
            "vsCode Fork/packages/core/src/orchestrator.ts"
git commit -m "feat(core): extract IntegrationLike; Scheduler depends on the interface"
```

---

## Task 3: `AmbientIntegration` (stage-only collaborator)

**Files:**
- Create: `packages/core/src/ambient.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/tests/ambient.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/ambient.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { AmbientIntegration } from "../src/ambient.js";
import { MessageBus } from "../src/bus.js";
import type { AmbientReportEvent, AmbientTrigger, BusEvent } from "../src/events.js";

describe("AmbientIntegration (stage-only)", () => {
  it("init stores the base; tip returns the reviewed SHA verbatim", async () => {
    const ai = new AmbientIntegration();
    await ai.init("abc123");
    expect(ai.tip()).toBe("abc123");
  });

  it("integrate reports merged WITHOUT merging", async () => {
    const ai = new AmbientIntegration();
    await ai.init("abc123");
    const outcome = await ai.integrate("reviewer#abc1234", "agentteam/reviewer-abc1234");
    expect(outcome).toEqual({ status: "merged" });
  });
});

describe("ambient_report event", () => {
  it("publishes through the bus and is seq-stamped", () => {
    const bus = new MessageBus();
    const seen: BusEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const trigger: AmbientTrigger = { reason: "commit", commitSha: "deadbee", scope: ["a.ts"] };
    const ev: AmbientReportEvent = {
      kind: "ambient_report",
      from: "reviewer#deadbee",
      trigger,
      summary: "looks risky",
      branch: "agentteam/reviewer-deadbee",
    };
    const stamped = bus.publish(ev);
    expect(stamped.kind).toBe("ambient_report");
    expect(typeof stamped.seq).toBe("number");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "ambient_report", summary: "looks risky" });
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/core -- ambient`
Expected: FAIL with `Cannot find module '../src/ambient.js'`

- [ ] **Step 3: Write `packages/core/src/ambient.ts`**

```ts
import type { IntegrationLike, IntegrationOutcome } from "./integration.js";
import type { AgentId } from "./events.js";

/**
 * Stage-only IntegrationLike for ambient (background) reactions. Unlike
 * IntegrationCoordinator it creates NO integration branch/worktree and NEVER
 * merges: `tip()` returns the reviewed commit SHA so the agent's worktree is
 * cut straight from the human's commit, and `integrate()` reports `merged`
 * WITHOUT merging so the one-node Scheduler run completes (the Scheduler
 * completes a node iff integrate reports `merged`). The agent's proposal branch
 * persists, unmerged, for a later human promotion step.
 */
export class AmbientIntegration implements IntegrationLike {
  private base = "";

  async init(baseRef: string): Promise<void> {
    this.base = baseRef;
  }

  tip(): string {
    return this.base;
  }

  async integrate(_authorId: AgentId, _branch: string): Promise<IntegrationOutcome> {
    return { status: "merged" }; // report-complete; deliberately does not merge
  }
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/core/src/index.ts`, add after the `export * from "./integration.js";` line:

```ts
export * from "./ambient.js";
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npm run test -w @agent-team/core -- ambient`
Expected: PASS (4 tests).

- [ ] **Step 6: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/ambient.ts" \
            "vsCode Fork/packages/core/src/index.ts" \
            "vsCode Fork/packages/core/tests/ambient.test.ts"
git commit -m "feat(core): AmbientIntegration stage-only collaborator + ambient tests"
```

---

## Task 4: `composeAmbient` driver (one-node Scheduler run per trigger)

**Files:**
- Create: `packages/host-headless/src/compose-ambient.ts`
- Create: `packages/host-headless/tests/compose-ambient.test.ts`

This mirrors `composeHeadless`'s wiring (bus, ledger, pending, autopilot policy, broker) but uses `AmbientIntegration` and a single-node graph built from the trigger, and emits `ambient_report` after the run.

- [ ] **Step 1: Write the failing offline integration test**

Create `packages/host-headless/tests/compose-ambient.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import type { AmbientTrigger, BusEvent } from "@agent-team/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeAmbient } from "../src/compose-ambient.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

async function headSha(git: NodeGitRunner, repo: string): Promise<string> {
  return (await git.run(["rev-parse", "HEAD"], repo)).stdout.trim();
}

describe("composeAmbient (offline)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s4-ambient-"));
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "feat: add x"], repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("stages a proposal + posts ambient_report; base branch NOT advanced", async () => {
    const sha = await headSha(git, repo);
    const sha7 = sha.slice(0, 7);

    const query: QueryFn = async function* ({ options }) {
      const cwd = options.cwd as string;
      writeFileSync(join(cwd, "app.ts"), "export const x = 2; // reviewed\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "tightened x", total_cost_usd: 0.01 });
    };

    const host = composeAmbient({
      repoRoot: repo, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000,
    });

    const reports: BusEvent[] = [];
    const fileChanges: BusEvent[] = [];
    host.bus.subscribe((e) => {
      if (e.kind === "ambient_report") reports.push(e);
      if (e.kind === "file_change") fileChanges.push(e);
    });

    const trigger: AmbientTrigger = { reason: "commit", commitSha: sha, scope: ["app.ts"] };
    const result = await host.fire(trigger);

    expect(result.status).toBe("complete");
    expect(fileChanges.length).toBeGreaterThan(0);
    expect(reports).toHaveLength(1);
    const report = reports[0] as Extract<BusEvent, { kind: "ambient_report" }>;
    expect(report.trigger.commitSha).toBe(sha);
    expect(report.branch).toBe(`agentteam/reviewer-${sha7}`);

    // The proposal commit exists on the agent branch.
    const onBranch = await git.run(["rev-parse", "--verify", `agentteam/reviewer-${sha7}`], repo);
    expect(onBranch.code).toBe(0);

    // The human branch (main) was NOT advanced — never merged.
    expect((await git.run(["rev-parse", "main"], repo)).stdout.trim()).toBe(sha);
  });

  it("no changes ⇒ ambient_report with no branch, no proposal branch created", async () => {
    const sha = await headSha(git, repo);
    const sha7 = sha.slice(0, 7);

    const query: QueryFn = async function* () {
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "looks fine", total_cost_usd: 0.01 });
    };

    const host = composeAmbient({
      repoRoot: repo, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000,
    });
    const reports: Array<Extract<BusEvent, { kind: "ambient_report" }>> = [];
    host.bus.subscribe((e) => { if (e.kind === "ambient_report") reports.push(e); });

    await host.fire({ reason: "commit", commitSha: sha, scope: ["app.ts"] });

    // The load-bearing invariant: no diff ⇒ the report carries NO proposal branch.
    expect(reports).toHaveLength(1);
    expect(reports[0].branch).toBeUndefined();
    // WorktreeManager.create makes the branch via `worktree add -b` BEFORE the agent
    // runs, and remove() keeps the branch — so an empty branch may persist. What must
    // hold is that it carries NO proposal commit: if present, it still points at base.
    const onBranch = await git.run(["rev-parse", "--verify", `agentteam/reviewer-${sha7}`], repo);
    if (onBranch.code === 0) {
      expect(onBranch.stdout.trim()).toBe(sha); // empty branch == base, no proposal commit
    }
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/host-headless -- compose-ambient`
Expected: FAIL with `Cannot find module '../src/compose-ambient.js'`

- [ ] **Step 3: Write `packages/host-headless/src/compose-ambient.ts`**

```ts
import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  NoopContextProvider,
  AmbientIntegration,
  Scheduler,
  TaskGraph,
} from "@agent-team/core";
import type {
  TaskNode,
  GitRunner,
  BusEvent,
  ActionRequestEvent,
  AgentId,
  Role,
  BrokerHandlers,
  AgentAdapter,
  AmbientTrigger,
  ScheduleResult,
} from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import {
  ClaudeAdapter,
  PendingPermissions,
  CostLedger,
  type QueryFn,
} from "@agent-team/adapters-claude";

export interface AmbientOptions {
  repoRoot: string;
  query: QueryFn;
  model: string;
  maxTurns: number;
  permTimeoutMs: number;
  git?: GitRunner;
}

export interface AmbientHost {
  bus: MessageBus;
  ledger: CostLedger;
  /** Run one ambient reaction for a trigger; resolves after the report is posted. */
  fire(trigger: AmbientTrigger): Promise<ScheduleResult>;
}

function reviewGoal(trigger: AmbientTrigger): string {
  const files = trigger.scope.map((f) => `- ${f}`).join("\n");
  return [
    `Review the changes in commit ${trigger.commitSha.slice(0, 7)} touching:`,
    files,
    "Propose concrete improvements by editing these files. If nothing needs changing, make no edits.",
  ].join("\n");
}

export function composeAmbient(opts: AmbientOptions): AmbientHost {
  const git = opts.git ?? new NodeGitRunner();
  const bus = new MessageBus();
  const ledger = new CostLedger();
  const pending = new PendingPermissions();
  const store = new PolicyStore();
  store.applyPreset("autopilot");

  const handlers: BrokerHandlers = {
    gate: (_req: ActionRequestEvent, _from: AgentId) => {},
    route: (_req: ActionRequestEvent, _from: AgentId, _to: Role) => {},
    notify: (_req: ActionRequestEvent, _from: AgentId) => {},
  };
  const broker = new ActionBroker(store, handlers);
  bus.subscribe((e: BusEvent) => {
    if (e.kind !== "action_request") return;
    if (!pending.has(e.requestId)) return;
    const res = broker.handle(e);
    if (res.mode !== "GATE") pending.resolve(e.requestId, { behavior: "allow" });
  });

  const adapterFor = (_node: TaskNode): AgentAdapter =>
    new ClaudeAdapter({
      query: opts.query,
      git,
      pending,
      ledger,
      model: opts.model,
      maxTurns: opts.maxTurns,
      permTimeoutMs: opts.permTimeoutMs,
    });

  async function fire(trigger: AmbientTrigger): Promise<ScheduleResult> {
    const sha7 = trigger.commitSha.slice(0, 7);
    const agentId = `reviewer#${sha7}`;
    const branch = `agentteam/reviewer-${sha7}`;

    let sawFileChange = false;
    let doneSummary = "";
    const off = bus.subscribe((e: BusEvent) => {
      if (e.from !== agentId) return;
      if (e.kind === "file_change") sawFileChange = true;
      if (e.kind === "done") doneSummary = e.summary;
    });

    const graph = new TaskGraph([
      { id: sha7, role: "reviewer", goal: reviewGoal(trigger), dependsOn: [] },
    ]);
    const worktrees = new WorktreeManager(git, opts.repoRoot, new NoopContextProvider());
    const integration = new AmbientIntegration();
    const scheduler = new Scheduler({
      bus,
      budget: { maxTurns: opts.maxTurns },
      graph,
      worktrees,
      integration,
      baseRef: trigger.commitSha,
    });

    const result = await scheduler.run(adapterFor);
    off();

    bus.publish({
      kind: "ambient_report",
      from: agentId,
      trigger,
      summary: doneSummary || `reaction ${result.status}`,
      branch: sawFileChange ? branch : undefined,
    });

    return result;
  }

  return { bus, ledger, fire };
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm run test -w @agent-team/host-headless -- compose-ambient`
Expected: PASS (2 tests). The "no changes" test is written tolerant of the empty branch `WorktreeManager.create` leaves behind (it asserts the *report* carries no branch, and that any persisted branch still points at base) — do NOT change the source to force-delete branches (out of scope).

- [ ] **Step 5: Build host-headless — expect clean**

Run: `npm run build -w @agent-team/host-headless`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/host-headless/src/compose-ambient.ts" \
            "vsCode Fork/packages/host-headless/tests/compose-ambient.test.ts"
git commit -m "feat(host-headless): composeAmbient — one-node Scheduler run per trigger + ambient_report"
```

---

## Task 5: `CommitWatcher` (on-commit trigger source)

**Files:**
- Create: `packages/host-headless/src/commit-watcher.ts`
- Create: `packages/host-headless/tests/commit-watcher.test.ts`

The fs.watch wiring lives in `start()`; the testable logic lives in `check()`, which tests drive directly (avoids fs.watch timing flake).

- [ ] **Step 1: Write the failing test**

Create `packages/host-headless/tests/commit-watcher.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import type { AmbientTrigger } from "@agent-team/core";
import { CommitWatcher } from "../src/commit-watcher.js";

describe("CommitWatcher", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s4-watch-"));
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "seed"], repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("does not fire for the seed commit present at seed()", async () => {
    const fired: AmbientTrigger[] = [];
    const w = new CommitWatcher(git, repo, (t) => fired.push(t));
    await w.seed();
    await w.check();
    expect(fired).toHaveLength(0);
  });

  it("fires once for a new commit with the correct changed-file scope", async () => {
    const fired: AmbientTrigger[] = [];
    const w = new CommitWatcher(git, repo, (t) => fired.push(t));
    await w.seed();

    writeFileSync(join(repo, "feature.ts"), "export const f = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "feat: feature"], repo);

    await w.check();
    expect(fired).toHaveLength(1);
    expect(fired[0].reason).toBe("commit");
    expect(fired[0].scope).toEqual(["feature.ts"]);
    expect(fired[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("dedups: a second check on the same HEAD does not re-fire", async () => {
    const fired: AmbientTrigger[] = [];
    const w = new CommitWatcher(git, repo, (t) => fired.push(t));
    await w.seed();
    writeFileSync(join(repo, "feature.ts"), "export const f = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "feat: feature"], repo);

    await w.check();
    await w.check();
    expect(fired).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/host-headless -- commit-watcher`
Expected: FAIL with `Cannot find module '../src/commit-watcher.js'`

- [ ] **Step 3: Write `packages/host-headless/src/commit-watcher.ts`**

```ts
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { GitRunner, AmbientTrigger } from "@agent-team/core";

export type TriggerHandler = (trigger: AmbientTrigger) => void | Promise<void>;

/**
 * Watches `.git/logs/HEAD`; on movement, derives the new commit's changed-file
 * scope and emits an AmbientTrigger. Dedups by SHA and processes reactions
 * sequentially (one at a time). fs.watch wiring is in start(); the SHA→trigger
 * logic is in check(), driven directly by tests.
 */
export class CommitWatcher {
  private lastSha = "";
  private fsw?: FSWatcher;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly git: GitRunner,
    private readonly repoRoot: string,
    private readonly onTrigger: TriggerHandler,
  ) {}

  /** Record the current HEAD without firing — we react only to NEW commits. */
  async seed(): Promise<void> {
    this.lastSha = await this.headSha();
  }

  /** Begin watching. Call seed() first. */
  start(): void {
    const logPath = join(this.repoRoot, ".git", "logs", "HEAD");
    this.fsw = watch(logPath, () => {
      this.chain = this.chain.then(() => this.check()).catch(() => undefined);
    });
  }

  stop(): void {
    this.fsw?.close();
    this.fsw = undefined;
  }

  /** Read HEAD; if it moved to an unseen SHA, emit a trigger. */
  async check(): Promise<void> {
    const sha = await this.headSha();
    if (!sha || sha === this.lastSha) return;
    this.lastSha = sha;
    const scope = await this.changedFiles(sha);
    await this.onTrigger({ reason: "commit", commitSha: sha, scope });
  }

  private async headSha(): Promise<string> {
    const res = await this.git.run(["rev-parse", "HEAD"], this.repoRoot);
    return res.code === 0 ? res.stdout.trim() : "";
  }

  private async changedFiles(sha: string): Promise<string[]> {
    const res = await this.git.run(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
      this.repoRoot,
    );
    return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm run test -w @agent-team/host-headless -- commit-watcher`
Expected: PASS (3 tests).

- [ ] **Step 5: Build host-headless — expect clean**

Run: `npm run build -w @agent-team/host-headless`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/host-headless/src/commit-watcher.ts" \
            "vsCode Fork/packages/host-headless/tests/commit-watcher.test.ts"
git commit -m "feat(host-headless): CommitWatcher — on-commit AmbientTrigger source"
```

---

## Task 6: `agent-team-ambient` CLI

**Files:**
- Create: `packages/host-headless/src/cli-ambient.ts`
- Modify: `packages/host-headless/package.json`

- [ ] **Step 1: Write `packages/host-headless/src/cli-ambient.ts`**

```ts
#!/usr/bin/env node
import { stdout } from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { NodeGitRunner } from "@agent-team/core/node";
import type { AmbientTrigger, BusEvent } from "@agent-team/core";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeAmbient } from "./compose-ambient.js";
import { CommitWatcher } from "./commit-watcher.js";

interface Args {
  repo: string;
  model: string;
  maxTurns: number;
  once?: string;
}

function parseArgs(argv: string[]): Args {
  const getOpt = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    repo: getOpt("--repo") ?? process.cwd(),
    model: getOpt("--model") ?? "claude-opus-4-8",
    maxTurns: Number(getOpt("--max-turns") ?? "50"),
    once: getOpt("--once"),
  };
}

function printFeed(e: BusEvent): void {
  if (e.kind === "file_change") stdout.write(`  ~ ${e.from} ${e.path}\n`);
  else if (e.kind === "done") stdout.write(`  ✓ ${e.from}: ${e.summary}\n`);
  else if (e.kind === "error") stdout.write(`  ✗ ${e.from}: ${e.message}\n`);
  else if (e.kind === "ambient_report")
    stdout.write(`  ⚑ ${e.from} [${e.trigger.commitSha.slice(0, 7)}] ${e.summary}${e.branch ? ` → ${e.branch}` : ""}\n`);
}

async function changedFiles(git: NodeGitRunner, repo: string, sha: string): Promise<string[]> {
  const res = await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], repo);
  return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const git = new NodeGitRunner();
  const host = composeAmbient({
    repoRoot: args.repo,
    query: query as unknown as QueryFn,
    model: args.model,
    maxTurns: args.maxTurns,
    permTimeoutMs: 60_000,
    git,
  });
  host.bus.subscribe(printFeed);

  if (args.once) {
    const sha = (await git.run(["rev-parse", args.once], args.repo)).stdout.trim();
    const scope = await changedFiles(git, args.repo, sha);
    const trigger: AmbientTrigger = { reason: "commit", commitSha: sha, scope };
    await host.fire(trigger);
    return;
  }

  const watcher = new CommitWatcher(git, args.repo, (t) => host.fire(t));
  await watcher.seed();
  watcher.start();
  stdout.write(`agent-team-ambient watching ${args.repo} — commit to trigger a review (Ctrl-C to stop)\n`);
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => { watcher.stop(); resolve(); });
  });
}

main().catch((err) => {
  stdout.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the bin entry to `package.json`**

In `packages/host-headless/package.json`, change the `bin` block from:

```json
  "bin": {
    "agent-team-run": "./dist/cli.js"
  },
```

to:

```json
  "bin": {
    "agent-team-run": "./dist/cli.js",
    "agent-team-ambient": "./dist/cli-ambient.js"
  },
```

- [ ] **Step 3: Build host-headless — expect clean**

Run: `npm run build -w @agent-team/host-headless`
Expected: exit 0. Confirm `dist/cli-ambient.js` exists.

- [ ] **Step 4: Commit**

```bash
git add -f "vsCode Fork/packages/host-headless/src/cli-ambient.ts" \
            "vsCode Fork/packages/host-headless/package.json"
git commit -m "feat(host-headless): agent-team-ambient CLI (watch or --once)"
```

---

## Task 7: Full-suite verification + done-criteria

**Files:** none (verification only)

- [ ] **Step 1: Clean full workspace build**

Run (from the `vsCode Fork` dir): `npm run build`
Expected: exit 0 — core → adapters → hosts in order.

- [ ] **Step 2: Full workspace test suite**

Run: `npm run test`
Expected: all packages green, strictly above the 152 baseline. New tests:
- core: +4 ambient (2 `AmbientIntegration` + 1 `ambient_report` round-trip + the round-trip's grouping may count as 1 `it` → count is ≥ +3)
- host-headless: +2 compose-ambient, +3 commit-watcher → +5

Total ≈ **160 tests** (was 152). Exact count may vary by `it` grouping; the hard requirement is **green and > 152**.

- [ ] **Step 3: Port-purity guard — barrel must stay pure**

Confirm `packages/core/src/ambient.ts` imports no `node:*` (it imports only `integration.js` + `events.js` types) and the barrel still has no node-only code.

Run: `grep -n "node:" packages/core/src/ambient.ts`
Expected: no output (ambient.ts is pure; `CommitWatcher`'s `node:fs` lives in host-headless, not core).

- [ ] **Step 4: No-merge invariant (the spec's sharpest edge) — confirm covered**

Confirm the `composeAmbient` test asserts BOTH: the proposal commit exists on `agentteam/reviewer-<sha7>` AND `main` still points at the reviewed SHA (never advanced). This is the load-bearing "report+propose, never merge" guarantee. If Step 2 passed, this is covered by Task 4's first test.

- [ ] **Step 5: Final commit (only if Step 2 surfaced a test-count fixup)**

If any assertion needed correcting, commit it:

```bash
git add -f "vsCode Fork/packages/host-headless/tests/compose-ambient.test.ts"
git commit -m "test(s4): finalize ambient suite"
```

Otherwise no commit — Task 7 is verification only.

---

## Done-criteria

- `npm run build` exits 0 (workspace order core → adapters → hosts).
- `npm run test` fully green, strictly more than the 152 baseline.
- `core` stays port-pure: `ambient.ts` has no `node:*`; the live `CommitWatcher` (`node:fs`) lives in host-headless.
- The Scheduler **run-logic, bus, worktree, and task-graph are unchanged** — the only core edits are additive types + a type-only `SchedulerDeps.integration` widening.
- The no-merge invariant holds: an ambient reaction stages a proposal branch and posts `ambient_report`; it never advances the human's branch.
- `agent-team-ambient` builds and exposes both watch and `--once <sha>` modes.

---

## Self-review notes (spec §-by-§ coverage)

- §3.1 `ambient_report` event → Task 1. §3.2 `AmbientTrigger` → Task 1 (placed in `events.ts`, see deviation note). §3.3 `AmbientIntegration` + `IntegrationLike` + type-only Scheduler widening → Tasks 2, 3.
- §4.1 `CommitWatcher` → Task 5. §4.2 `composeAmbient` → Task 4. §4.3 CLI → Task 6.
- §5 data flow (worktree cut from SHA, branch persists, no merge) → Task 4 test. §6 error handling: no-proposal path → Task 4 second test; dedup/seed → Task 5 tests; agent-failure path inherited from Scheduler (unchanged, covered by existing core suite).
- §7 testing → Tasks 3–5 (all offline, temp repos + scripted query). §2.1 port-purity → Task 7 Step 3.
- §8 out-of-scope items (on-save/test-fail, host-vscode panel, auto-merge/broker gating, persisted feed, multi-node) — none implemented; no tasks, by design.
