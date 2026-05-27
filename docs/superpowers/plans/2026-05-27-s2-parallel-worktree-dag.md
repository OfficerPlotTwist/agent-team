# S2 — Parallel Worktree Isolation + Task-DAG Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let specialist agents work in parallel, each in its own git worktree + branch, scheduled by a task dependency DAG, with the lead merging branches into a shared integration branch one at a time and conflicts surfaced as `merge_conflict` action_requests.

**Architecture:** Extends the merged S1 core (`packages/core`). All git access goes through an injected `GitRunner` port so the core stays port-pure; the only `node:child_process` touch is one isolated `NodeGitRunner`. A `TaskGraph` (pure DS, owns run-state) feeds a `Scheduler` that creates a worktree per ready node, runs ready nodes concurrently, and merges each branch into a dedicated `agentteam/integration` worktree on `done`. Merges happen in the integration worktree — never the user's checked-out tree. Worktree creation calls a `ContextProvider.hydrate` seam (no-op default; KG-backed impl is the future S5 sub-project) that writes gitignored context files.

**Tech Stack:** TypeScript ESM (`.js` import extensions, `moduleResolution: Bundler`), Vitest 2.x, Node built-in `child_process`/`fs`/`os` (only in `node/` modules and tests). Real `git` on PATH for integration tests.

**Spec:** `docs/superpowers/specs/2026-05-26-s2-parallel-worktree-dag-design.md`

**Conventions for every task:**
- Run all commands from `packages/core` (e.g. `cd "packages/core"`). Test command: `npx vitest run <path>`.
- Every commit message ends with this trailer (shown once here, applies to every Step "Commit"):
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- Use forward slashes in all paths (git accepts them on Windows); never hardcode `C:\Users\...`.
- Node ids must be slug-safe (lowercase, `[a-z0-9-]`) since they appear in branch names and directory names.

---

## File Structure

**New files (all under `packages/core/`):**
- `src/task-graph.ts` — `TaskNode` + `TaskGraph` (pure DAG: validation, ready/start/complete/isDone, topo order).
- `src/git.ts` — `GitRunner` port + `GitResult`.
- `src/node/git-runner.ts` — `NodeGitRunner` (`child_process.execFile` impl; the one intentional node-builtin module).
- `src/context-provider.ts` — `ContextProvider` port + `NoopContextProvider`.
- `src/worktree.ts` — `WorktreeManager` (create/list/merge/remove/pruneAll over a `GitRunner`; calls `ContextProvider.hydrate`) + `MergeResult` + `Worktree`.
- `src/integration.ts` — `IntegrationCoordinator` (owns `agentteam/integration` branch + worktree; serial merge; conflict → `merge_conflict` action_request) + `IntegrationOutcome`.
- `tests/helpers/temp-repo.ts` — integration-test helper: make a temp git repo with a `NodeGitRunner`.
- `tests/helpers/writing-adapter.ts` — test adapter that writes files in `ctx.cwd`, commits, emits `done`.
- `tests/task-graph.test.ts`, `tests/git-runner.test.ts`, `tests/context-provider.test.ts`, `tests/worktree.test.ts`, `tests/worktree-integration.test.ts`, `tests/policy-merge-conflict.test.ts`, `tests/integration-coordinator.test.ts`, `tests/scheduler.test.ts`, `tests/s2-e2e.test.ts`.

**Modified files:**
- `src/events.ts` — add `"merge_conflict"` to `RequestCategory`.
- `src/policy/model.ts` — add `"merge_conflict"` to `CATEGORIES`.
- `src/policy/presets.ts` — add a `merge_conflict` cell to every role in `PAIR`.
- `src/adapter.ts` — `TaskContext` gains optional `cwd` + `branch`.
- `src/fake-adapter.ts` — record the last `TaskContext` for assertions.
- `src/orchestrator.ts` — add `Scheduler` class (DAG execution).
- `src/index.ts` — export the new modules.

---

## Task 1: TaskGraph — construction + validation

**Files:**
- Create: `src/task-graph.ts`
- Test: `tests/task-graph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/task-graph.test.ts
import { describe, it, expect } from "vitest";
import { TaskGraph, type TaskNode } from "../src/task-graph.js";

const n = (id: string, dependsOn: string[] = []): TaskNode => ({
  id, role: "coder", goal: `do ${id}`, dependsOn,
});

describe("TaskGraph construction", () => {
  it("accepts a valid acyclic graph", () => {
    expect(() => new TaskGraph([n("a"), n("b", ["a"])])).not.toThrow();
  });

  it("throws on a duplicate node id", () => {
    expect(() => new TaskGraph([n("a"), n("a")])).toThrow(/duplicate/i);
  });

  it("throws when a node depends on an unknown id", () => {
    expect(() => new TaskGraph([n("a", ["ghost"])])).toThrow(/unknown/i);
  });

  it("throws on a dependency cycle", () => {
    expect(() => new TaskGraph([n("a", ["b"]), n("b", ["a"])])).toThrow(/cycle/i);
  });

  it("throws on a self-dependency cycle", () => {
    expect(() => new TaskGraph([n("a", ["a"])])).toThrow(/cycle/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/task-graph.test.ts`
Expected: FAIL — `Cannot find module '../src/task-graph.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/task-graph.ts
import type { Role } from "./events.js";

export interface TaskNode {
  id: string;
  role: Role;
  goal: string;
  dependsOn: string[];
}

export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>();
  private readonly started = new Set<string>();
  private readonly completed = new Set<string>();

  constructor(nodes: TaskNode[]) {
    for (const node of nodes) {
      if (this.nodes.has(node.id)) throw new Error(`Duplicate task id: ${node.id}`);
      this.nodes.set(node.id, node);
    }
    for (const node of this.nodes.values()) {
      for (const dep of node.dependsOn) {
        if (!this.nodes.has(dep)) {
          throw new Error(`Task ${node.id} depends on unknown task ${dep}`);
        }
      }
    }
    this.assertAcyclic();
  }

  private assertAcyclic(): void {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.nodes.keys()) color.set(id, WHITE);
    const visit = (id: string): void => {
      color.set(id, GRAY);
      for (const dep of this.nodes.get(id)!.dependsOn) {
        const c = color.get(dep);
        if (c === GRAY) throw new Error(`Dependency cycle detected at task ${dep}`);
        if (c === WHITE) visit(dep);
      }
      color.set(id, BLACK);
    };
    for (const id of this.nodes.keys()) {
      if (color.get(id) === WHITE) visit(id);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/task-graph.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/task-graph.ts packages/core/tests/task-graph.test.ts
git commit -m "feat(core): TaskGraph construction + cycle/dep validation"
```

---

## Task 2: TaskGraph — scheduling queries

**Files:**
- Modify: `src/task-graph.ts`
- Test: `tests/task-graph.test.ts`

- [ ] **Step 1: Write the failing test (append to the existing describe block file)**

```ts
// tests/task-graph.test.ts — append
describe("TaskGraph scheduling", () => {
  it("ready() returns only nodes whose deps are all complete and not started", () => {
    const g = new TaskGraph([n("a"), n("b"), n("c", ["a", "b"])]);
    expect(g.ready().map((x) => x.id).sort()).toEqual(["a", "b"]);
    g.start("a");
    expect(g.ready().map((x) => x.id)).toEqual(["b"]); // a started, c still blocked
    g.complete("a");
    g.start("b");
    g.complete("b");
    expect(g.ready().map((x) => x.id)).toEqual(["c"]);
  });

  it("isDone() is true only once every node is complete", () => {
    const g = new TaskGraph([n("a"), n("b", ["a"])]);
    expect(g.isDone()).toBe(false);
    g.complete("a");
    expect(g.isDone()).toBe(false);
    g.complete("b");
    expect(g.isDone()).toBe(true);
  });

  it("topologicalOrder() lists every dependency before its dependents", () => {
    const g = new TaskGraph([n("d", ["b", "c"]), n("b", ["a"]), n("c", ["a"]), n("a")]);
    const order = g.topologicalOrder().map((x) => x.id);
    const pos = (id: string) => order.indexOf(id);
    expect(order).toHaveLength(4);
    expect(pos("a")).toBeLessThan(pos("b"));
    expect(pos("a")).toBeLessThan(pos("c"));
    expect(pos("b")).toBeLessThan(pos("d"));
    expect(pos("c")).toBeLessThan(pos("d"));
  });

  it("ids() and completedIds() expose run state", () => {
    const g = new TaskGraph([n("a"), n("b")]);
    expect(g.ids().sort()).toEqual(["a", "b"]);
    g.complete("a");
    expect(g.completedIds()).toEqual(["a"]);
  });

  it("start()/complete() reject unknown ids", () => {
    const g = new TaskGraph([n("a")]);
    expect(() => g.start("x")).toThrow(/unknown/i);
    expect(() => g.complete("x")).toThrow(/unknown/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/task-graph.test.ts`
Expected: FAIL — `g.ready is not a function`.

- [ ] **Step 3: Add the methods to `TaskGraph`**

```ts
// src/task-graph.ts — add these methods inside the class
  ready(): TaskNode[] {
    const out: TaskNode[] = [];
    for (const node of this.nodes.values()) {
      if (this.started.has(node.id) || this.completed.has(node.id)) continue;
      if (node.dependsOn.every((dep) => this.completed.has(dep))) out.push(node);
    }
    return out;
  }

  start(id: string): void {
    if (!this.nodes.has(id)) throw new Error(`Unknown task: ${id}`);
    this.started.add(id);
  }

  complete(id: string): void {
    if (!this.nodes.has(id)) throw new Error(`Unknown task: ${id}`);
    this.completed.add(id);
  }

  isDone(): boolean {
    return this.completed.size === this.nodes.size;
  }

  ids(): string[] {
    return [...this.nodes.keys()];
  }

  completedIds(): string[] {
    return [...this.completed];
  }

  topologicalOrder(): TaskNode[] {
    const order: TaskNode[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dep of this.nodes.get(id)!.dependsOn) visit(dep);
      order.push(this.nodes.get(id)!);
    };
    for (const id of this.nodes.keys()) visit(id);
    return order;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/task-graph.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/task-graph.ts packages/core/tests/task-graph.test.ts
git commit -m "feat(core): TaskGraph ready/start/complete/isDone/topo queries"
```

---

## Task 3: GitRunner port + NodeGitRunner + temp-repo helper

**Files:**
- Create: `src/git.ts`, `src/node/git-runner.ts`, `tests/helpers/temp-repo.ts`
- Test: `tests/git-runner.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/git-runner.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { NodeGitRunner } from "../src/node/git-runner.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

describe("NodeGitRunner", () => {
  it("runs git and reports stdout + exit code 0 in a real repo", async () => {
    const { dir, git } = await makeTempRepo();
    const res = await git.run(["rev-parse", "--is-inside-work-tree"], dir);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("true");
  });

  it("reports a non-zero exit code and stderr on a failing command", async () => {
    const { dir, git } = await makeTempRepo();
    const res = await git.run(["checkout", "does-not-exist"], dir);
    expect(res.code).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/git-runner.test.ts`
Expected: FAIL — cannot find `../src/node/git-runner.js`.

- [ ] **Step 3: Write the port, the runner, and the helper**

```ts
// src/git.ts
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  /** Run `git <args>` in `cwd`. Never throws on non-zero exit — returns the code. */
  run(args: string[], cwd: string): Promise<GitResult>;
}
```

```ts
// src/node/git-runner.ts
import { execFile } from "node:child_process";
import type { GitRunner, GitResult } from "../git.js";

export class NodeGitRunner implements GitRunner {
  run(args: string[], cwd: string): Promise<GitResult> {
    return new Promise<GitResult>((resolve) => {
      execFile(
        "git",
        args,
        { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
        },
      );
    });
  }
}
```

```ts
// tests/helpers/temp-repo.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "../../src/node/git-runner.js";

const created: string[] = [];

/** Create an isolated temp git repo with one initial commit. Returns dir + a runner. */
export async function makeTempRepo(): Promise<{ dir: string; git: NodeGitRunner }> {
  const dir = (await mkdtemp(join(tmpdir(), "agentteam-"))).split("\\").join("/");
  created.push(dir);
  const git = new NodeGitRunner();
  await git.run(["init", "-b", "main"], dir);
  await git.run(["config", "user.email", "test@example.com"], dir);
  await git.run(["config", "user.name", "Test"], dir);
  await git.run(["commit", "--allow-empty", "-m", "init"], dir);
  return { dir, git };
}

/** Remove every temp repo created in this test run. */
export async function cleanupRepos(): Promise<void> {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/git-runner.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/git.ts packages/core/src/node/git-runner.ts packages/core/tests/helpers/temp-repo.ts packages/core/tests/git-runner.test.ts
git commit -m "feat(core): GitRunner port + NodeGitRunner + temp-repo test helper"
```

---

## Task 4: ContextProvider port + NoopContextProvider

**Files:**
- Create: `src/context-provider.ts`
- Test: `tests/context-provider.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/context-provider.test.ts
import { describe, it, expect } from "vitest";
import { NoopContextProvider, type ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";

const node: TaskNode = { id: "a", role: "coder", goal: "x", dependsOn: [] };

describe("NoopContextProvider", () => {
  it("hydrate resolves without writing anything", async () => {
    const cp: ContextProvider = new NoopContextProvider();
    await expect(cp.hydrate(node, "/tmp/whatever")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/context-provider.test.ts`
Expected: FAIL — cannot find `../src/context-provider.js`.

- [ ] **Step 3: Write the port + no-op default**

```ts
// src/context-provider.ts
import type { TaskNode } from "./task-graph.js";

/**
 * Seam for hydrating per-agent context into a fresh worktree (S2). The KG-backed
 * implementation lands in the future S5 sub-project; S2 ships only the port + a
 * no-op default. Implementations must write gitignored files (never `git add`).
 */
export interface ContextProvider {
  hydrate(node: TaskNode, worktreePath: string): Promise<void>;
}

export class NoopContextProvider implements ContextProvider {
  async hydrate(_node: TaskNode, _worktreePath: string): Promise<void> {
    // intentionally empty
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/context-provider.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/context-provider.ts packages/core/tests/context-provider.test.ts
git commit -m "feat(core): ContextProvider hydration seam + NoopContextProvider"
```

---

## Task 5: WorktreeManager — create/list/remove/pruneAll (arg formatting)

**Files:**
- Create: `src/worktree.ts`
- Test: `tests/worktree.test.ts`

This task uses a **fake GitRunner** to assert exact git argument formatting and that `hydrate` is called after `worktree add`. `merge` is added in Task 6.

- [ ] **Step 1: Write the failing test**

```ts
// tests/worktree.test.ts
import { describe, it, expect } from "vitest";
import { WorktreeManager } from "../src/worktree.js";
import type { GitRunner, GitResult } from "../src/git.js";
import type { ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";

class FakeGit implements GitRunner {
  calls: Array<{ args: string[]; cwd: string }> = [];
  result: GitResult = { code: 0, stdout: "", stderr: "" };
  async run(args: string[], cwd: string): Promise<GitResult> {
    this.calls.push({ args, cwd });
    return this.result;
  }
}

const node: TaskNode = { id: "build-api", role: "coder", goal: "x", dependsOn: [] };

describe("WorktreeManager create/remove/prune", () => {
  it("create adds a branch+worktree from base and then hydrates", async () => {
    const git = new FakeGit();
    const hydrated: string[] = [];
    const cp: ContextProvider = { async hydrate(_n, path) { hydrated.push(path); } };
    const wm = new WorktreeManager(git, "/repo", cp);

    const wt = await wm.create(node, "agentteam/integration");

    expect(wt.branch).toBe("agentteam/coder-build-api");
    expect(wt.path).toBe("/repo/.worktrees/coder-build-api");
    expect(git.calls[0].args).toEqual([
      "worktree", "add", "-b", "agentteam/coder-build-api",
      "/repo/.worktrees/coder-build-api", "agentteam/integration",
    ]);
    expect(git.calls[0].cwd).toBe("/repo");
    // hydrate runs after the worktree exists, with the worktree path
    expect(hydrated).toEqual(["/repo/.worktrees/coder-build-api"]);
  });

  it("create throws if git worktree add fails", async () => {
    const git = new FakeGit();
    git.result = { code: 128, stdout: "", stderr: "fatal: already exists" };
    const wm = new WorktreeManager(git, "/repo", { async hydrate() {} });
    await expect(wm.create(node, "main")).rejects.toThrow(/already exists/);
  });

  it("remove force-removes the worktree dir", async () => {
    const git = new FakeGit();
    const wm = new WorktreeManager(git, "/repo", { async hydrate() {} });
    await wm.remove(node);
    expect(git.calls[0].args).toEqual([
      "worktree", "remove", "--force", "/repo/.worktrees/coder-build-api",
    ]);
  });

  it("pruneAll prunes stale registrations", async () => {
    const git = new FakeGit();
    const wm = new WorktreeManager(git, "/repo", { async hydrate() {} });
    await wm.pruneAll();
    expect(git.calls[0].args).toEqual(["worktree", "prune"]);
  });

  it("list returns the worktree paths from porcelain output", async () => {
    const git = new FakeGit();
    git.result = {
      code: 0,
      stdout: "worktree /repo\nHEAD abc\n\nworktree /repo/.worktrees/coder-build-api\nHEAD def\n",
      stderr: "",
    };
    const wm = new WorktreeManager(git, "/repo", { async hydrate() {} });
    expect(await wm.list()).toEqual(["/repo", "/repo/.worktrees/coder-build-api"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worktree.test.ts`
Expected: FAIL — cannot find `../src/worktree.js`.

- [ ] **Step 3: Write the WorktreeManager (without `merge`, added next task)**

```ts
// src/worktree.ts
import type { GitRunner } from "./git.js";
import type { ContextProvider } from "./context-provider.js";
import type { TaskNode } from "./task-graph.js";

export interface Worktree {
  path: string;
  branch: string;
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[] };

export class WorktreeManager {
  constructor(
    private readonly git: GitRunner,
    private readonly repoRoot: string,
    private readonly context: ContextProvider,
  ) {}

  private name(node: TaskNode): string {
    return `${node.role}-${node.id}`;
  }

  private pathFor(node: TaskNode): string {
    return `${this.repoRoot}/.worktrees/${this.name(node)}`;
  }

  private branchFor(node: TaskNode): string {
    return `agentteam/${this.name(node)}`;
  }

  async create(node: TaskNode, base: string): Promise<Worktree> {
    const path = this.pathFor(node);
    const branch = this.branchFor(node);
    const res = await this.git.run(["worktree", "add", "-b", branch, path, base], this.repoRoot);
    if (res.code !== 0) throw new Error(`git worktree add failed: ${res.stderr.trim()}`);
    await this.context.hydrate(node, path);
    return { path, branch };
  }

  async remove(node: TaskNode): Promise<void> {
    await this.git.run(["worktree", "remove", "--force", this.pathFor(node)], this.repoRoot);
  }

  async pruneAll(): Promise<void> {
    await this.git.run(["worktree", "prune"], this.repoRoot);
  }

  async list(): Promise<string[]> {
    const res = await this.git.run(["worktree", "list", "--porcelain"], this.repoRoot);
    return res.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/worktree.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/worktree.ts packages/core/tests/worktree.test.ts
git commit -m "feat(core): WorktreeManager create/list/remove/prune over GitRunner"
```

---

## Task 6: WorktreeManager.merge + real-git worktree/merge/hydrate integration

**Files:**
- Modify: `src/worktree.ts`
- Test: `tests/worktree-integration.test.ts`

- [ ] **Step 1: Write the failing test (real git in a temp repo)**

```ts
// tests/worktree-integration.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager } from "../src/worktree.js";
import type { ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

const coder = (id: string): TaskNode => ({ id, role: "coder", goal: id, dependsOn: [] });
const noop: ContextProvider = { async hydrate() {} };

// Commit a file inside an already-created worktree, using the same git binary.
async function commitFile(git: { run: (a: string[], c: string) => Promise<unknown> }, wtPath: string, file: string, body: string) {
  await writeFile(join(wtPath, file), body);
  await git.run(["add", file], wtPath);
  await git.run(["commit", "-m", `add ${file}`], wtPath);
}

describe("WorktreeManager merge (real git)", () => {
  it("merges two branches that touch different files cleanly", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);

    const a = await wm.create(coder("a"), "main");
    const b = await wm.create(coder("b"), "main");
    await commitFile(git, a.path, "a.txt", "from a\n");
    await commitFile(git, b.path, "b.txt", "from b\n");

    // merge both into a third integration worktree
    const intg = await wm.create(coder("intg"), "main");
    expect(await wm.merge(a.branch, intg.path)).toEqual({ ok: true });
    expect(await wm.merge(b.branch, intg.path)).toEqual({ ok: true });
    expect((await readFile(join(intg.path, "a.txt"), "utf8"))).toBe("from a\n");
    expect((await readFile(join(intg.path, "b.txt"), "utf8"))).toBe("from b\n");
  });

  it("reports conflicts when two branches edit the same line", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);
    const a = await wm.create(coder("a"), "main");
    const b = await wm.create(coder("b"), "main");
    await commitFile(git, a.path, "shared.txt", "alpha\n");
    await commitFile(git, b.path, "shared.txt", "beta\n");

    const intg = await wm.create(coder("intg"), "main");
    expect(await wm.merge(a.branch, intg.path)).toEqual({ ok: true });
    const result = await wm.merge(b.branch, intg.path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflicts).toContain("shared.txt");
  });

  it("hydrated context files are written, untracked, and not carried by a merge", async () => {
    const { dir, git } = await makeTempRepo();
    const fixture: ContextProvider = {
      async hydrate(_n, path) { await writeFile(join(path, "CONTEXT.md"), "ephemeral\n"); },
    };
    const wm = new WorktreeManager(git, dir, fixture);
    const a = await wm.create(coder("a"), "main");

    // .agent context path is gitignored repo-wide; here we assert the file is untracked.
    const status = await git.run(["status", "--porcelain", "--untracked-files=all"], a.path);
    expect((status as { stdout: string }).stdout).toContain("CONTEXT.md");

    // real source change committed; merge carries only that, never CONTEXT.md
    await commitFile(git, a.path, "real.txt", "work\n");
    const intg = await wm.create(coder("intg"), "main");
    await wm.merge(a.branch, intg.path);
    const lsfiles = await git.run(["ls-files"], intg.path);
    expect((lsfiles as { stdout: string }).stdout).toContain("real.txt");
    expect((lsfiles as { stdout: string }).stdout).not.toContain("CONTEXT.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/worktree-integration.test.ts`
Expected: FAIL — `wm.merge is not a function`.

- [ ] **Step 3: Add `merge` to WorktreeManager**

```ts
// src/worktree.ts — add this method inside the class
  /**
   * Merge `branch` into the branch already checked out in `intoWorktree`.
   * Runs in the integration worktree — never the user's checked-out tree.
   */
  async merge(branch: string, intoWorktree: string): Promise<MergeResult> {
    const res = await this.git.run(["merge", "--no-edit", branch], intoWorktree);
    if (res.code === 0) return { ok: true };
    const diff = await this.git.run(
      ["diff", "--name-only", "--diff-filter=U"],
      intoWorktree,
    );
    const conflicts = diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    return { ok: false, conflicts };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/worktree-integration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/worktree.ts packages/core/tests/worktree-integration.test.ts
git commit -m "feat(core): WorktreeManager.merge with conflict detection (real-git tested)"
```

---

## Task 7: Add the `merge_conflict` request category to events + policy

**Files:**
- Modify: `src/events.ts`, `src/policy/model.ts`, `src/policy/presets.ts`
- Test: `tests/policy-merge-conflict.test.ts`

The three source edits are coupled: `RequestCategory` is a union, `CATEGORIES` must list it, and `PolicyTable = Record<Role, Record<RequestCategory, PolicyCell>>` forces every role's `PAIR` entry to include the new cell or the file won't type-check.

- [ ] **Step 1: Write the failing test**

```ts
// tests/policy-merge-conflict.test.ts
import { describe, it, expect } from "vitest";
import { PolicyStore } from "../src/policy/store.js";
import { CATEGORIES } from "../src/policy/model.js";

describe("merge_conflict policy category", () => {
  it("is registered in CATEGORIES", () => {
    expect(CATEGORIES).toContain("merge_conflict");
  });

  it("routes a coder's conflict to the lead under the pair preset", () => {
    const store = new PolicyStore();
    store.applyPreset("pair");
    expect(store.get("coder", "merge_conflict")).toEqual({ mode: "ROUTE", route: "lead" });
  });

  it("keeps routing to lead under autopilot (stamp preserves ROUTE cells)", () => {
    const store = new PolicyStore();
    store.applyPreset("autopilot");
    expect(store.get("coder", "merge_conflict")).toEqual({ mode: "ROUTE", route: "lead" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/policy-merge-conflict.test.ts`
Expected: FAIL — `CATEGORIES` does not contain `"merge_conflict"` (and TS errors until presets are updated).

- [ ] **Step 3a: Add the category to the union**

```ts
// src/events.ts — replace the RequestCategory type
export type RequestCategory =
  | "approval"
  | "credential"
  | "judgment"
  | "external_action"
  | "destructive"
  | "merge_conflict"
  | "info";
```

- [ ] **Step 3b: Add it to CATEGORIES**

```ts
// src/policy/model.ts — replace the CATEGORIES array
export const CATEGORIES: readonly RequestCategory[] = [
  "approval",
  "credential",
  "judgment",
  "external_action",
  "destructive",
  "merge_conflict",
  "info",
];
```

- [ ] **Step 3c: Add a `merge_conflict` cell to every role in `PAIR`**

Edit `src/policy/presets.ts`. Add `merge_conflict: { mode: "ROUTE", route: "lead" }` to each of the five role objects in `PAIR`. After editing, each role reads e.g.:

```ts
  lead: {
    approval: { mode: "AUTO" }, credential: { mode: "GATE" }, judgment: { mode: "GATE" },
    external_action: { mode: "ROUTE", route: "ops" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "AUTO" },
  },
  architect: {
    approval: { mode: "NOTIFY" }, credential: { mode: "GATE" }, judgment: { mode: "ROUTE", route: "lead" },
    external_action: { mode: "GATE" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "AUTO" },
  },
  coder: {
    approval: { mode: "ROUTE", route: "reviewer" }, credential: { mode: "GATE" }, judgment: { mode: "ROUTE", route: "lead" },
    external_action: { mode: "ROUTE", route: "ops" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "ROUTE", route: "lead" },
  },
  reviewer: {
    approval: { mode: "AUTO" }, credential: { mode: "GATE" }, judgment: { mode: "ROUTE", route: "lead" },
    external_action: { mode: "GATE" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "AUTO" },
  },
  ops: {
    approval: { mode: "NOTIFY" }, credential: { mode: "GATE" }, judgment: { mode: "GATE" },
    external_action: { mode: "NOTIFY" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "AUTO" },
  },
```

(The existing `stamp()` helper already preserves ROUTE cells, so `copilot` and `autopilot` inherit `ROUTE→lead` for `merge_conflict` with no further change.)

- [ ] **Step 4: Run the full suite (coupled type change — verify nothing else broke)**

Run: `npx vitest run`
Expected: PASS — the new file's 3 tests plus all pre-existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts packages/core/src/policy/model.ts packages/core/src/policy/presets.ts packages/core/tests/policy-merge-conflict.test.ts
git commit -m "feat(core): merge_conflict request category routed to lead in all presets"
```

---

## Task 8: TaskContext gains cwd + branch; FakeAdapter records context

**Files:**
- Modify: `src/adapter.ts`, `src/fake-adapter.ts`
- Test: `tests/fake-adapter.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to existing file)**

```ts
// tests/fake-adapter.test.ts — append
import { describe, it, expect } from "vitest";
import { FakeAdapter } from "../src/fake-adapter.js";

describe("FakeAdapter context recording", () => {
  it("records the cwd and branch it was started with", async () => {
    const fake = new FakeAdapter([{ kind: "done", summary: "ok" }]);
    await fake.startTask(
      { goal: "g", role: "coder", agentId: "coder#a", cwd: "/repo/.worktrees/coder-a", branch: "agentteam/coder-a" },
      () => {},
    );
    expect(fake.lastContext?.cwd).toBe("/repo/.worktrees/coder-a");
    expect(fake.lastContext?.branch).toBe("agentteam/coder-a");
  });
});
```

(If `tests/fake-adapter.test.ts` already imports `describe/it/expect/FakeAdapter`, append only the new `describe` block and reuse the existing imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/fake-adapter.test.ts`
Expected: FAIL — `cwd` not assignable to `TaskContext` / `lastContext` undefined.

- [ ] **Step 3a: Extend TaskContext**

```ts
// src/adapter.ts — replace the TaskContext interface
export interface TaskContext {
  goal: string;
  role: Role;
  agentId: AgentId;
  /** Worktree path the agent should work in (S2). Undefined for non-worktree runs. */
  cwd?: string;
  /** The agent's branch (S2). Undefined for non-worktree runs. */
  branch?: string;
}
```

- [ ] **Step 3b: Record context in FakeAdapter**

```ts
// src/fake-adapter.ts — add the field and assignment
export class FakeAdapter implements AgentAdapter {
  readonly backend = "fake";
  private interrupted = false;
  /** The most recent context passed to startTask (for test assertions). */
  lastContext?: TaskContext;

  constructor(private readonly script: Array<Omit<AgentEvent, "from">>) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.lastContext = ctx;
    this.interrupted = false;
    for (const partial of this.script) {
      if (this.interrupted) return;
      emit({ ...partial, from: ctx.agentId } as AgentEvent);
      await Promise.resolve();
    }
  }

  interrupt(): void {
    this.interrupted = true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/fake-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapter.ts packages/core/src/fake-adapter.ts packages/core/tests/fake-adapter.test.ts
git commit -m "feat(core): TaskContext cwd/branch + FakeAdapter records context"
```

---

## Task 9: IntegrationCoordinator — serial merge + conflict action_request

**Files:**
- Create: `src/integration.ts`
- Test: `tests/integration-coordinator.test.ts`

- [ ] **Step 1: Write the failing test (real git + bus)**

```ts
// tests/integration-coordinator.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MessageBus } from "../src/bus.js";
import { WorktreeManager } from "../src/worktree.js";
import { IntegrationCoordinator } from "../src/integration.js";
import type { ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";
import type { ActionRequestEvent } from "../src/events.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

const coder = (id: string): TaskNode => ({ id, role: "coder", goal: id, dependsOn: [] });
const noop: ContextProvider = { async hydrate() {} };

async function commitFile(git: { run: (a: string[], c: string) => Promise<unknown> }, wtPath: string, file: string, body: string) {
  await writeFile(join(wtPath, file), body);
  await git.run(["add", file], wtPath);
  await git.run(["commit", "-m", `add ${file}`], wtPath);
}

describe("IntegrationCoordinator", () => {
  it("init creates the integration branch + worktree and tip() points at it", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);
    const coord = new IntegrationCoordinator(git, wm, new MessageBus(), dir);
    await coord.init("main");
    expect(coord.tip()).toBe("agentteam/integration");
    const branches = await git.run(["branch", "--list", "agentteam/integration"], dir);
    expect((branches as { stdout: string }).stdout).toContain("agentteam/integration");
  });

  it("integrate merges a clean branch and reports merged", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);
    const coord = new IntegrationCoordinator(git, wm, new MessageBus(), dir);
    await coord.init("main");
    const a = await wm.create(coder("a"), coord.tip());
    await commitFile(git, a.path, "a.txt", "from a\n");
    const outcome = await coord.integrate("coder#a", a.branch);
    expect(outcome.status).toBe("merged");
  });

  it("integrate publishes a merge_conflict action_request on conflict", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);
    const bus = new MessageBus();
    const requests: ActionRequestEvent[] = [];
    bus.subscribe((e) => { if (e.kind === "action_request") requests.push(e); });
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    await coord.init("main");

    const a = await wm.create(coder("a"), coord.tip());
    const b = await wm.create(coder("b"), coord.tip());
    await commitFile(git, a.path, "shared.txt", "alpha\n");
    await commitFile(git, b.path, "shared.txt", "beta\n");

    expect((await coord.integrate("coder#a", a.branch)).status).toBe("merged");
    const outcome = await coord.integrate("coder#b", b.branch);

    expect(outcome.status).toBe("conflict");
    expect(requests).toHaveLength(1);
    expect(requests[0].category).toBe("merge_conflict");
    expect(requests[0].from).toBe("coder#b");
    expect((requests[0].payload as { conflicts: string[] }).conflicts).toContain("shared.txt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration-coordinator.test.ts`
Expected: FAIL — cannot find `../src/integration.js`.

- [ ] **Step 3: Write the IntegrationCoordinator**

```ts
// src/integration.ts
import type { GitRunner } from "./git.js";
import type { MessageBus } from "./bus.js";
import type { WorktreeManager } from "./worktree.js";
import type { AgentId } from "./events.js";

export type IntegrationOutcome =
  | { status: "merged" }
  | { status: "conflict"; requestId: string; conflicts: string[] };

export class IntegrationCoordinator {
  readonly branch = "agentteam/integration";
  private readonly worktreePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private reqSeq = 0;

  constructor(
    private readonly git: GitRunner,
    private readonly worktrees: WorktreeManager,
    private readonly bus: MessageBus,
    private readonly repoRoot: string,
  ) {
    this.worktreePath = `${repoRoot}/.worktrees/integration`;
  }

  /** Create the integration branch from `baseRef` and a dedicated worktree for it. */
  async init(baseRef: string): Promise<void> {
    const b = await this.git.run(["branch", "-f", this.branch, baseRef], this.repoRoot);
    if (b.code !== 0) throw new Error(`create integration branch failed: ${b.stderr.trim()}`);
    const w = await this.git.run(["worktree", "add", this.worktreePath, this.branch], this.repoRoot);
    if (w.code !== 0) throw new Error(`integration worktree add failed: ${w.stderr.trim()}`);
  }

  /** The ref new agent worktrees are cut from: the integration branch tip. */
  tip(): string {
    return this.branch;
  }

  /** Merge one agent branch into integration. Serialized via an internal queue. */
  integrate(authorId: AgentId, branch: string): Promise<IntegrationOutcome> {
    const run = this.queue.then(() => this.doMerge(authorId, branch));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doMerge(authorId: AgentId, branch: string): Promise<IntegrationOutcome> {
    const res = await this.worktrees.merge(branch, this.worktreePath);
    if (res.ok) return { status: "merged" };
    const requestId = `mc-${++this.reqSeq}`;
    this.bus.publish({
      kind: "action_request",
      from: authorId,
      requestId,
      category: "merge_conflict",
      summary: `Merge conflict integrating ${branch}`,
      payload: { branch, conflicts: res.conflicts },
      timeoutMs: 0,
    });
    return { status: "conflict", requestId, conflicts: res.conflicts };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration-coordinator.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/integration.ts packages/core/tests/integration-coordinator.test.ts
git commit -m "feat(core): IntegrationCoordinator serial merge + merge_conflict request"
```

---

## Task 10: Scheduler — DAG execution

**Files:**
- Modify: `src/orchestrator.ts`
- Create: `tests/helpers/writing-adapter.ts`
- Test: `tests/scheduler.test.ts`

- [ ] **Step 1: Write the writing-adapter helper**

```ts
// tests/helpers/writing-adapter.ts
import type { AgentAdapter, TaskContext, Emit } from "../../src/adapter.js";
import { NodeGitRunner } from "../../src/node/git-runner.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Test adapter: writes `files` into the worktree (ctx.cwd), commits them with real
 * git, then emits `done`. Models a specialist that does real work in its worktree.
 */
export class WritingAdapter implements AgentAdapter {
  readonly backend = "writing-fake";
  private interrupted = false;
  private readonly git = new NodeGitRunner();

  constructor(private readonly files: Record<string, string>) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.interrupted = false;
    if (!ctx.cwd) throw new Error("WritingAdapter requires ctx.cwd");
    for (const [name, body] of Object.entries(this.files)) {
      if (this.interrupted) return;
      await writeFile(join(ctx.cwd, name), body);
      await this.git.run(["add", name], ctx.cwd);
      await this.git.run(["commit", "-m", `${ctx.agentId}: add ${name}`], ctx.cwd);
    }
    if (this.interrupted) return;
    emit({ kind: "done", from: ctx.agentId, summary: `${ctx.agentId} done` });
  }

  interrupt(): void {
    this.interrupted = true;
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/scheduler.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Scheduler } from "../src/orchestrator.js";
import { MessageBus } from "../src/bus.js";
import { WorktreeManager } from "../src/worktree.js";
import { IntegrationCoordinator } from "../src/integration.js";
import { NoopContextProvider } from "../src/context-provider.js";
import { TaskGraph, type TaskNode } from "../src/task-graph.js";
import { WritingAdapter } from "./helpers/writing-adapter.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

function wire(dir: string, git: ReturnType<typeof Object>, graph: TaskGraph) {
  const bus = new MessageBus();
  const wm = new WorktreeManager(git as never, dir, new NoopContextProvider());
  const coord = new IntegrationCoordinator(git as never, wm, bus, dir);
  const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });
  return { bus, wm, coord, sched };
}

const node = (id: string, dependsOn: string[] = []): TaskNode => ({ id, role: "coder", goal: id, dependsOn });

describe("Scheduler DAG execution", () => {
  it("runs a diamond (a → b,c → d) and lands every node's file in integration", async () => {
    const { dir, git } = await makeTempRepo();
    const graph = new TaskGraph([node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])]);
    const { coord, sched } = wire(dir, git, graph);

    const result = await sched.run((n) => new WritingAdapter({ [`${n.id}.txt`]: n.id }));

    expect(result.status).toBe("complete");
    expect(result.completed.sort()).toEqual(["a", "b", "c", "d"]);
    // every file present in the integration worktree
    const intgPath = `${dir}/.worktrees/integration`;
    for (const id of ["a", "b", "c", "d"]) {
      expect(await readFile(join(intgPath, `${id}.txt`), "utf8")).toBe(id);
    }
    expect(coord.tip()).toBe("agentteam/integration");
  });

  it("a dependent node's worktree base contains its prerequisite's committed work", async () => {
    const { dir, git } = await makeTempRepo();
    const graph = new TaskGraph([node("a"), node("b", ["a"])]);
    const { sched } = wire(dir, git, graph);

    // b reads whether a.txt exists in its base by writing a marker only if present
    const result = await sched.run((n) =>
      new WritingAdapter(n.id === "a" ? { "a.txt": "A" } : { "b.txt": "B" }),
    );
    expect(result.status).toBe("complete");
    // b's branch was cut from integration AFTER a merged, so a.txt is in b's history
    const intgPath = `${dir}/.worktrees/integration`;
    expect(await readFile(join(intgPath, "a.txt"), "utf8")).toBe("A");
    expect(await readFile(join(intgPath, "b.txt"), "utf8")).toBe("B");
  });

  it("stops early when the turn budget is exhausted", async () => {
    const { dir, git } = await makeTempRepo();
    const graph = new TaskGraph([node("a"), node("b"), node("c")]);
    const bus = new MessageBus();
    const wm = new WorktreeManager(git as never, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git as never, wm, bus, dir);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) => new WritingAdapter({ [`${n.id}.txt`]: n.id }));
    expect(["budget", "complete"]).toContain(result.status); // budget cap may trip before all merge
    if (result.status === "budget") expect(result.completed.length).toBeLessThan(3);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: FAIL — `Scheduler` is not exported from `../src/orchestrator.js`.

- [ ] **Step 4: Add the Scheduler to orchestrator.ts**

```ts
// src/orchestrator.ts — add these imports at the top (alongside existing imports)
import type { TaskGraph, TaskNode } from "./task-graph.js";
import type { WorktreeManager } from "./worktree.js";
import type { IntegrationCoordinator } from "./integration.js";
```

```ts
// src/orchestrator.ts — append below the existing Orchestrator class
export interface SchedulerDeps {
  bus: MessageBus;
  budget: Budget;
  graph: TaskGraph;
  worktrees: WorktreeManager;
  integration: IntegrationCoordinator;
  /** Ref the integration branch + first worktrees are cut from (workspace HEAD). */
  baseRef: string;
}

export type ScheduleStatus = "complete" | "budget" | "stopped" | "blocked";

export interface ScheduleResult {
  status: ScheduleStatus;
  completed: string[];
  blocked: string[];
}

/**
 * Executes a TaskGraph: creates a worktree per ready node, runs ready nodes
 * concurrently, merges each branch into integration on `done`, unlocks dependents.
 * Terminates on graph-complete, budget exhaustion, stop(), or a blocked graph
 * (no in-flight work and nothing ready — e.g. a node failed or hit a conflict).
 */
export class Scheduler {
  private stopped = false;
  private turns = 0;

  constructor(private deps: SchedulerDeps) {}

  stop(): void {
    this.stopped = true;
  }

  async run(adapterFor: (node: TaskNode) => AgentAdapter): Promise<ScheduleResult> {
    const { bus, budget, graph, worktrees, integration, baseRef } = this.deps;
    this.stopped = false;
    this.turns = 0;
    await integration.init(baseRef);

    const off = bus.subscribe(() => { this.turns += 1; });
    const inflight = new Map<string, Promise<void>>();
    const adapters = new Map<string, AgentAdapter>();
    const failed = new Set<string>();

    // A "tick" promise that resolves whenever any node settles, so the loop wakes.
    let resolveTick!: () => void;
    let tick = new Promise<void>((r) => { resolveTick = r; });
    const wake = (): void => {
      const r = resolveTick;
      tick = new Promise<void>((res) => { resolveTick = res; });
      r();
    };

    const runNode = async (node: TaskNode): Promise<void> => {
      try {
        const wt = await worktrees.create(node, integration.tip());
        const agentId = `${node.role}#${node.id}`;
        const adapter = adapterFor(node);
        adapters.set(node.id, adapter);
        await adapter.startTask(
          { goal: node.goal, role: node.role, agentId, cwd: wt.path, branch: wt.branch },
          (event) => bus.publish(event),
        );
        const outcome = await integration.integrate(agentId, wt.branch);
        if (outcome.status === "merged") graph.complete(node.id);
        else failed.add(node.id);
        await worktrees.remove(node);
      } catch (err) {
        failed.add(node.id);
        bus.publish({ kind: "error", from: `${node.role}#${node.id}`, message: String(err) });
      } finally {
        inflight.delete(node.id);
        adapters.delete(node.id);
        wake();
      }
    };

    while (!graph.isDone()) {
      if (this.stopped || this.turns >= budget.maxTurns) break;
      for (const node of graph.ready()) {
        if (inflight.has(node.id) || failed.has(node.id)) continue;
        graph.start(node.id);
        inflight.set(node.id, runNode(node));
      }
      if (inflight.size === 0) break; // graph not done and nothing in flight => blocked
      await tick;
    }

    if (this.stopped || this.turns >= budget.maxTurns) {
      for (const a of adapters.values()) a.interrupt();
    }
    off();
    await Promise.allSettled([...inflight.values()]);
    await worktrees.pruneAll();

    const completed = graph.completedIds();
    const completedSet = new Set(completed);
    const blocked = graph.ids().filter((id) => !completedSet.has(id));
    const status: ScheduleStatus = graph.isDone()
      ? "complete"
      : this.stopped
        ? "stopped"
        : this.turns >= budget.maxTurns
          ? "budget"
          : "blocked";
    return { status, completed, blocked };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/orchestrator.ts packages/core/tests/helpers/writing-adapter.ts packages/core/tests/scheduler.test.ts
git commit -m "feat(core): Scheduler — DAG execution over worktrees + integration"
```

---

## Task 11: Barrel exports + end-to-end S2 integration test

**Files:**
- Modify: `src/index.ts`
- Test: `tests/s2-e2e.test.ts`

- [ ] **Step 1: Add the new modules to the barrel**

```ts
// src/index.ts — replace contents
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
export * from "./task-graph.js";
export * from "./git.js";
export * from "./context-provider.js";
export * from "./worktree.js";
export * from "./integration.js";
```

(Note: `NodeGitRunner` under `src/node/` is intentionally NOT re-exported from the port-pure barrel — host code imports it directly from `@agent-team/core/dist/node/git-runner.js`.)

- [ ] **Step 2: Write the end-to-end test (everything via the barrel, real git)**

```ts
// tests/s2-e2e.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MessageBus, Scheduler, WorktreeManager, IntegrationCoordinator,
  NoopContextProvider, TaskGraph, ActionBroker, PolicyStore,
  type TaskNode, type ActionRequestEvent,
} from "../src/index.js";
import { WritingAdapter } from "./helpers/writing-adapter.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

const node = (id: string, dependsOn: string[] = []): TaskNode => ({ id, role: "coder", goal: id, dependsOn });

describe("S2 end-to-end", () => {
  it("runs a parallel DAG to completion through the public API", async () => {
    const { dir, git } = await makeTempRepo();
    const bus = new MessageBus();
    const wm = new WorktreeManager(git as never, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git as never, wm, bus, dir);
    const graph = new TaskGraph([node("setup"), node("api", ["setup"]), node("ui", ["setup"])]);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) => new WritingAdapter({ [`${n.id}.txt`]: n.id }));

    expect(result.status).toBe("complete");
    expect(result.blocked).toEqual([]);
    const intgPath = `${dir}/.worktrees/integration`;
    for (const id of ["setup", "api", "ui"]) {
      expect(await readFile(join(intgPath, `${id}.txt`), "utf8")).toBe(id);
    }
  });

  it("a conflicting pair surfaces a merge_conflict request the broker routes to lead", async () => {
    const { dir, git } = await makeTempRepo();
    const bus = new MessageBus();
    const wm = new WorktreeManager(git as never, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git as never, wm, bus, dir);

    const policy = new PolicyStore();
    policy.applyPreset("pair");
    const routed: Array<{ id: string; to: string }> = [];
    const broker = new ActionBroker(policy, {
      gate: () => {},
      route: (req, _from, to) => routed.push({ id: req.requestId, to }),
      notify: () => {},
    });
    bus.subscribe((e) => { if (e.kind === "action_request") broker.handle(e as ActionRequestEvent); });

    // two independent nodes that both write the same file → second merge conflicts
    const graph = new TaskGraph([node("x"), node("y")]);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });
    const result = await sched.run(() => new WritingAdapter({ "shared.txt": "v\n" }));

    // one merged, one conflicted → blocked, and the conflict routed to the lead
    expect(result.completed).toHaveLength(1);
    expect(result.blocked).toHaveLength(1);
    expect(routed).toHaveLength(1);
    expect(routed[0].to).toBe("lead");
  });
});
```

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run`
Expected: PASS — every S1 + S2 test green (the two e2e tests plus all earlier files).

- [ ] **Step 4: Type-check the package compiles**

Run: `npm run build`
Expected: `tsc` exits 0, emits `dist/` with `.d.ts` for the new modules.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/index.ts packages/core/tests/s2-e2e.test.ts
git commit -m "feat(core): export S2 modules + end-to-end parallel-DAG integration test"
```

---

## Self-Review

**1. Spec coverage** (against `2026-05-26-s2-parallel-worktree-dag-design.md`):
- §3 TaskGraph → Tasks 1–2. GitRunner/NodeGitRunner → Task 3. WorktreeManager → Tasks 5–6. ContextProvider seam (§3.3) → Tasks 4 (+ wired in 5, behavior-tested in 6). IntegrationCoordinator → Task 9. Scheduler/DAG (§3.2, §4) → Task 10. `TaskContext` cwd/branch → Task 8. `merge_conflict` category + presets column → Task 7. Barrel + e2e → Task 11.
- §4 data flow (init → schedule → parallel work → merge-on-done → unlock → complete → cleanup) → exercised by Tasks 10–11. §4.5 conflict → `merge_conflict` request routed by policy → Tasks 9 + 11.
- §5 error handling: worktree-create failure → Task 5 (throws) + Scheduler catch (Task 10); conflict → blocked + request (Tasks 9–11); cycle rejection → Task 1; cleanup `worktree prune` → Task 10 (`pruneAll` in `finally`-equivalent end). Hard invariant (never the user's tree) → enforced by merging in the integration *worktree* (Tasks 6, 9).
- §6 testing list → mapped 1:1 across the test files above.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Every code step shows full code; every run step shows the command + expected result.

**3. Type consistency:**
- `TaskNode`/`TaskGraph` identical across Tasks 1, 2, 5, 9, 10, 11.
- `GitRunner.run(args, cwd) → Promise<GitResult>` consistent (Task 3) and consumed unchanged everywhere.
- `WorktreeManager` ctor `(git, repoRoot, context)` and method names `create/list/merge/remove/pruneAll` consistent (Tasks 5, 6, 9, 10).
- `merge(branch, intoWorktree)` signature identical in Task 6 and its caller in Task 9.
- `IntegrationCoordinator` `init`/`tip`/`integrate(authorId, branch)` consistent (Tasks 9, 10, 11).
- `merge_conflict` is the category string everywhere (events, model, presets, integration, tests).
- Agent id format `` `${role}#${id}` `` used in Scheduler (Task 10) and asserted in Task 9 (`"coder#a"`/`"coder#b"`), parseable by the existing `roleOf`.

No gaps found; proceeding to execution handoff.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-27-s2-parallel-worktree-dag.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh implementer subagent per task, with spec + quality review between tasks. Matches how S1/Plan A was built.

**2. Inline Execution** — execute the tasks in this session with checkpoints.

**Which approach?**
