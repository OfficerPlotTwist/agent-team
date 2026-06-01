# S5 — Shared Memory (closed-loop semantic retrieval) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents both record their conclusions into one embedded sqlite-vec store and automatically receive the top-k most relevant prior conclusions as gitignored context files through the existing `ContextProvider.hydrate` seam — a closed shared-memory loop with zero Scheduler/bus/worktree runtime changes.

**Architecture:** A `SqliteVecContextProvider` (under `src/node/`, native deps) implements **two ports**: the existing `ContextProvider.hydrate` (read → write `.agent-team/memory-<id>.md` files) and a new `DecisionRecorder.record` (write a row + embedding). The host wires capture as a bus subscriber on `done` events (it recovers the `TaskNode` from `event.from === \`${role}#${id}\`` via a new `TaskGraph.get(id)` accessor) and stacks the memory provider beside the existing `TextContextProvider` via a small pure `CompositeContextProvider`. Retrieval is **cross-run-deterministic** (run N+1 sees run N); intra-run sibling propagation is best-effort.

**Tech Stack:** TypeScript ESM (NodeNext), `vitest` v2, `@agent-team/core` (pure barrel + `/node` subpath), `better-sqlite3` + `sqlite-vec` (verified v0.1.9; `sqliteVec.load(db)`, `vec0(embedding float[N])`, bind `Float32Array` directly, KNN via `WHERE embedding MATCH ? ORDER BY distance LIMIT ?`, `db.pragma("journal_mode = WAL")`), `NodeGitRunner` over real temp repos.

---

## Spec → plan refinements (read before Task 1)

These adjust the spec (`docs/superpowers/specs/2026-06-01-s5-shared-memory-design.md`) where grounding the code surfaced reality. Behavior matches the spec's intent; details differ:

1. **Compose injects `TextContextProvider`, not `NoopContextProvider`** (`compose.ts:99`). So memory is **added alongside** editor-context via a new pure `CompositeContextProvider`, not swapped in. (Spec §5/§9 said "swap Noop".)
2. **`RecordedDecision` gains `createdAt: string`** (host supplies ISO-8601; keeps the provider clock-free/deterministic, per spec §5). The recorder/types are **co-located** in the provider file (spec §4.2 allowed this).
3. **`TaskGraph.get(id)` accessor added** (pure, read-only) — needed to recover `goal` from a `done` event's AgentId. `role` is free (`from.split("#")[0]`); `goal` is not encoded, so the host looks the node up. This is additive; no runtime behavior changes (same discipline as S4's `IntegrationLike`).
4. **Retrieval guarantee is cross-run.** `record()` is async; bus subscribers are fire-and-forget, so a later sibling in the *same* graph may create its worktree before a prior node's record settles. The deterministic, tested guarantee is cross-run (separate `composeHeadless` invocations sharing one WAL db). Intra-run sequential propagation works opportunistically (synchronous HashEmbedder) but is not asserted.
5. **The shipped offline embedder is `HashEmbedder`** (pure `src/embedder.ts`), wired as the host default so `--memory` runs end-to-end with no network. Real embedders swap in via the `Embedder` port. (Spec called the hash embedder a "test fixture"; promoting it to a shipped pure module lets the CLI use it.)
6. **KNN query uses a subquery+join** (robust across sqlite-vec versions): KNN on the vec table in a subquery, then join `decisions` by rowid.

---

## File Map

| File | Responsibility |
|---|---|
| `packages/core/src/embedder.ts` | NEW — `Embedder` port (pure type) + `HashEmbedder` (pure, deterministic, shipped) |
| `packages/core/src/composite-context-provider.ts` | NEW — `CompositeContextProvider` (pure; fans `hydrate` to N providers) |
| `packages/core/src/task-graph.ts` | MODIFY — add `get(id): TaskNode \| undefined` |
| `packages/core/src/index.ts` | MODIFY — export `embedder.js` + `composite-context-provider.js` |
| `packages/core/src/node/sqlite-vec-context-provider.ts` | NEW — `RecordedDecision`, `DecisionRecorder`, `SqliteVecContextProvider` (impl both ports) |
| `packages/core/src/node/index.ts` | MODIFY — export `sqlite-vec-context-provider.js` |
| `packages/core/package.json` | MODIFY — add `dependencies` (`better-sqlite3`, `sqlite-vec`) + devDep `@types/better-sqlite3` |
| `packages/core/tests/embedder.test.ts` | NEW |
| `packages/core/tests/composite-context-provider.test.ts` | NEW |
| `packages/core/tests/task-graph.test.ts` | MODIFY or NEW — `get(id)` cases |
| `packages/core/tests/sqlite-vec-context-provider.test.ts` | NEW — record→hydrate round-trip + empty-store no-op |
| `packages/host-headless/src/compose.ts` | MODIFY — `memoryDb?`/`embedder?` options; composite + record subscriber; `close()` |
| `packages/host-headless/src/cli.ts` | MODIFY — parse `--memory <db>` |
| `packages/host-headless/tests/memory-loop.test.ts` | NEW — cross-run closed loop (record then retrieve) |

**Baseline:** 160 tests green on `master` (`4b1e7dd`). Gate: build exit 0, full suite green and > 160. Core barrel stays port-pure (no `node:*`/`better-sqlite3` in `dist/index.js`; provider only under `dist/node/`).

> **Repo git quirk (applies to every commit):** the git root is the parent `C:\Users\nik\Documents\AI`; the project is the gitignored subpath `vsCode Fork/`. Stage NEW files with `git add -f "vsCode Fork/<path>"`. Never `git add -A`. Run `npm` from `C:\Users\nik\Documents\AI\vsCode Fork`. Ignore `core.autocrlf` status flicker; verify with `git -c core.autocrlf=false status`.

---

## Task 1: `Embedder` port + `HashEmbedder` (pure, shipped)

**Files:**
- Create: `packages/core/src/embedder.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/tests/embedder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/embedder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HashEmbedder } from "../src/embedder.js";

function l2(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

describe("HashEmbedder", () => {
  it("is deterministic and respects dim", async () => {
    const e = new HashEmbedder(64);
    expect(e.dim).toBe(64);
    const a = await e.embed("fix the login auth flow");
    const b = await e.embed("fix the login auth flow");
    expect(a.length).toBe(64);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("places token-overlapping texts nearer than disjoint ones", async () => {
    const e = new HashEmbedder(64);
    const q = await e.embed("login authentication session token");
    const near = await e.embed("authentication login user token");
    const far = await e.embed("css gradient button styling layout");
    expect(l2(q, near)).toBeLessThan(l2(q, far));
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/core -- embedder`
Expected: FAIL with `Cannot find module '../src/embedder.js'`

- [ ] **Step 3: Write `packages/core/src/embedder.ts`**

```ts
/** Turns text into a fixed-dim vector. Real models are async + network-bound;
 *  the provider depends only on this port and never picks a model itself. */
export interface Embedder {
  embed(text: string): Promise<Float32Array>;
  readonly dim: number;
}

/**
 * Deterministic, network-free embedder for offline v1 + tests. Hashes
 * whitespace tokens into a fixed-dim bag-of-words vector (FNV-1a), L2-normalized
 * so vec0's L2 distance tracks cosine similarity. NOT semantically strong — it
 * proves the retrieval seam; swap a real embedder in via the Embedder port with
 * no provider change.
 */
export class HashEmbedder implements Embedder {
  readonly dim: number;
  constructor(dim = 64) {
    this.dim = dim;
  }

  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    for (const tok of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      let h = 2166136261;
      for (let i = 0; i < tok.length; i++) {
        h ^= tok.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      v[(h >>> 0) % this.dim] += 1;
    }
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < this.dim; i++) v[i] /= norm;
    return v;
  }
}
```

- [ ] **Step 4: Export from the pure barrel**

In `packages/core/src/index.ts`, add (near the other `export *` lines):

```ts
export * from "./embedder.js";
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npm run test -w @agent-team/core -- embedder`
Expected: PASS (2 tests).

- [ ] **Step 6: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/embedder.ts" \
            "vsCode Fork/packages/core/src/index.ts" \
            "vsCode Fork/packages/core/tests/embedder.test.ts"
git commit -m "feat(core): Embedder port + deterministic HashEmbedder"
```

---

## Task 2: `TaskGraph.get(id)` accessor

**Files:**
- Modify: `packages/core/src/task-graph.ts`
- Modify/Create: `packages/core/tests/task-graph.test.ts`

- [ ] **Step 1: Write the failing test**

If `packages/core/tests/task-graph.test.ts` exists, append this `describe`; otherwise create the file with this content:

```ts
import { describe, it, expect } from "vitest";
import { TaskGraph } from "../src/task-graph.js";

describe("TaskGraph.get", () => {
  it("returns the node by id and undefined for unknown ids", () => {
    const g = new TaskGraph([
      { id: "a", role: "coder", goal: "build the thing", dependsOn: [] },
      { id: "b", role: "reviewer", goal: "review the thing", dependsOn: ["a"] },
    ]);
    expect(g.get("a")?.goal).toBe("build the thing");
    expect(g.get("b")?.role).toBe("reviewer");
    expect(g.get("missing")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/core -- task-graph`
Expected: FAIL — `g.get is not a function`.

- [ ] **Step 3: Add the accessor**

In `packages/core/src/task-graph.ts`, add this method to the `TaskGraph` class (e.g. right after `ids()`):

```ts
  /** Look up a node by id (read-only; undefined if absent). */
  get(id: string): TaskNode | undefined {
    return this.nodes.get(id);
  }
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm run test -w @agent-team/core -- task-graph`
Expected: PASS.

- [ ] **Step 5: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/task-graph.ts" \
            "vsCode Fork/packages/core/tests/task-graph.test.ts"
git commit -m "feat(core): TaskGraph.get(id) read-only node accessor"
```

---

## Task 3: `CompositeContextProvider` (pure)

**Files:**
- Create: `packages/core/src/composite-context-provider.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/tests/composite-context-provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/composite-context-provider.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CompositeContextProvider } from "../src/composite-context-provider.js";
import type { ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";

const node: TaskNode = { id: "n1", role: "coder", goal: "g", dependsOn: [] };

describe("CompositeContextProvider", () => {
  it("calls every provider's hydrate, in order, with the same args", async () => {
    const calls: string[] = [];
    const make = (tag: string): ContextProvider => ({
      async hydrate(n, wt) {
        calls.push(`${tag}:${n.id}:${wt}`);
      },
    });
    const composite = new CompositeContextProvider([make("A"), make("B")]);
    await composite.hydrate(node, "/tmp/wt");
    expect(calls).toEqual(["A:n1:/tmp/wt", "B:n1:/tmp/wt"]);
  });

  it("no providers ⇒ no-op", async () => {
    const composite = new CompositeContextProvider([]);
    await expect(composite.hydrate(node, "/tmp/wt")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/core -- composite-context-provider`
Expected: FAIL with `Cannot find module '../src/composite-context-provider.js'`

- [ ] **Step 3: Write `packages/core/src/composite-context-provider.ts`**

```ts
import type { ContextProvider } from "./context-provider.js";
import type { TaskNode } from "./task-graph.js";
import type { ContextEnvelope, ContextModality } from "./context-envelope.js";

/**
 * Fans a single hydrate call out to several providers in sequence, so an agent
 * can receive editor-context AND shared-memory files in the same worktree.
 * Pure — depends only on the ContextProvider interface.
 */
export class CompositeContextProvider implements ContextProvider {
  constructor(private readonly providers: ContextProvider[]) {}

  async hydrate(
    node: TaskNode,
    worktreePath: string,
    envelope?: ContextEnvelope,
    modality?: ContextModality,
  ): Promise<void> {
    for (const p of this.providers) {
      await p.hydrate(node, worktreePath, envelope, modality);
    }
  }
}
```

- [ ] **Step 4: Export from the pure barrel**

In `packages/core/src/index.ts`, add:

```ts
export * from "./composite-context-provider.js";
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npm run test -w @agent-team/core -- composite-context-provider`
Expected: PASS (2 tests).

- [ ] **Step 6: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/composite-context-provider.ts" \
            "vsCode Fork/packages/core/src/index.ts" \
            "vsCode Fork/packages/core/tests/composite-context-provider.test.ts"
git commit -m "feat(core): CompositeContextProvider fans hydrate to N providers"
```

---

## Task 4: `SqliteVecContextProvider` (both ports) + deps

**Files:**
- Modify: `packages/core/package.json`
- Create: `packages/core/src/node/sqlite-vec-context-provider.ts`
- Modify: `packages/core/src/node/index.ts`
- Create: `packages/core/tests/sqlite-vec-context-provider.test.ts`

- [ ] **Step 1: Add deps and install**

In `packages/core/package.json`, add a new top-level `"dependencies"` block (there is none yet — place it before `"devDependencies"`):

```json
  "dependencies": {
    "better-sqlite3": "^12.2.0",
    "sqlite-vec": "^0.1.9"
  },
```

And add to `"devDependencies"`:

```json
    "@types/better-sqlite3": "^7.6.11",
```

Run (from `C:\Users\nik\Documents\AI\vsCode Fork`): `npm install`
Expected: exit 0; `better-sqlite3` resolves a prebuilt binary for this Node/win32-x64 (no compiler needed) and `sqlite-vec` downloads its win32-x64 prebuilt loadable extension. If `better-sqlite3` falls through to a source build and fails, that's the only realistic install snag — report it (needs VS Build Tools + Python); do NOT hand-edit native build files.

- [ ] **Step 2: Write the failing round-trip test**

Create `packages/core/tests/sqlite-vec-context-provider.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVecContextProvider } from "../src/node/sqlite-vec-context-provider.js";
import { HashEmbedder } from "../src/embedder.js";
import type { TaskNode } from "../src/task-graph.js";

const node = (goal: string): TaskNode => ({ id: "qnode", role: "coder", goal, dependsOn: [] });

describe("SqliteVecContextProvider (offline)", () => {
  let dir: string;
  let dbPath: string;
  let wt: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "s5-mem-")).split("\\").join("/");
    dbPath = join(dir, "memory.db");
    wt = join(dir, "wt");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records decisions and hydrates the closest as a gitignored file", async () => {
    const p = new SqliteVecContextProvider({ dbPath, embedder: new HashEmbedder(64), k: 1 });
    await p.record({ id: "auth1", role: "coder", goal: "implement login authentication", summary: "added JWT auth", createdAt: "2026-06-01T00:00:00Z" });
    await p.record({ id: "css1", role: "coder", goal: "style the landing page", summary: "tuned the gradient", createdAt: "2026-06-01T00:01:00Z" });

    await p.hydrate(node("fix the login authentication bug"), wt);

    const authFile = join(wt, ".agent-team", "memory-auth1.md");
    const cssFile = join(wt, ".agent-team", "memory-css1.md");
    expect(existsSync(authFile)).toBe(true);
    expect(readFileSync(authFile, "utf8")).toContain("added JWT auth");
    // k=1 ⇒ only the closest hit is written, not the unrelated css decision.
    expect(existsSync(cssFile)).toBe(false);
    p.close();
  });

  it("empty store ⇒ hydrate writes nothing", async () => {
    const p = new SqliteVecContextProvider({ dbPath, embedder: new HashEmbedder(64) });
    await p.hydrate(node("anything"), wt);
    expect(existsSync(join(wt, ".agent-team"))).toBe(false);
    p.close();
  });
});
```

- [ ] **Step 3: Run the test — expect failure**

Run: `npm run test -w @agent-team/core -- sqlite-vec-context-provider`
Expected: FAIL with `Cannot find module '../src/node/sqlite-vec-context-provider.js'`

- [ ] **Step 4: Write `packages/core/src/node/sqlite-vec-context-provider.ts`**

```ts
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextProvider } from "../context-provider.js";
import type { ContextEnvelope, ContextModality } from "../context-envelope.js";
import type { TaskNode } from "../task-graph.js";
import type { Role } from "../events.js";
import type { Embedder } from "../embedder.js";

const CTX_DIR = ".agent-team";

/** One captured agent conclusion. `createdAt` is host-supplied (ISO-8601). */
export interface RecordedDecision {
  id: string;
  role: Role;
  goal: string;
  summary: string;
  createdAt: string;
}

/** Write side of shared memory. Kept separate from ContextProvider so the read
 *  seam (hydrate) stays clean and Noop/Text providers need no no-op write. */
export interface DecisionRecorder {
  record(decision: RecordedDecision): Promise<void>;
}

export interface SqliteVecOptions {
  dbPath: string;
  embedder: Embedder;
  k?: number;
}

interface Hit {
  node_id: string;
  role: string;
  goal: string;
  summary: string;
}

/**
 * sqlite-vec-backed shared memory. Implements BOTH ports over one db file:
 *  - record(): embed goal+summary, INSERT a decisions row + its vec0 embedding.
 *  - hydrate(): embed the node's goal, KNN top-k, write each hit as a gitignored
 *    `.agent-team/memory-<node_id>.md` into the worktree (never git add).
 * WAL mode lets parallel worktree readers coexist with the single writer.
 * Native (better-sqlite3) ⇒ lives under src/node/, exported via @agent-team/core/node only.
 */
export class SqliteVecContextProvider implements ContextProvider, DecisionRecorder {
  private readonly db: Database.Database;
  private readonly embedder: Embedder;
  private readonly k: number;

  constructor(opts: SqliteVecOptions) {
    this.embedder = opts.embedder;
    this.k = opts.k ?? 5;
    this.db = new Database(opts.dbPath);
    this.db.pragma("journal_mode = WAL");
    sqliteVec.load(this.db); // throws fast if the extension can't load
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        rowid      INTEGER PRIMARY KEY,
        node_id    TEXT NOT NULL,
        role       TEXT NOT NULL,
        goal       TEXT NOT NULL,
        summary    TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_decisions USING vec0(embedding float[${this.embedder.dim}]);`,
    );
  }

  async record(d: RecordedDecision): Promise<void> {
    try {
      const vec = await this.embedder.embed(`${d.goal}\n${d.summary}`);
      const info = this.db
        .prepare(
          "INSERT INTO decisions(node_id, role, goal, summary, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(d.id, d.role, d.goal, d.summary, d.createdAt);
      this.db
        .prepare("INSERT INTO vec_decisions(rowid, embedding) VALUES (?, ?)")
        .run(info.lastInsertRowid, vec);
    } catch {
      // persisting one memory must never crash a completed run
    }
  }

  async hydrate(
    node: TaskNode,
    worktreePath: string,
    _envelope?: ContextEnvelope,
    _modality?: ContextModality,
  ): Promise<void> {
    let hits: Hit[] = [];
    try {
      const q = await this.embedder.embed(node.goal);
      hits = this.db
        .prepare(
          `SELECT d.node_id, d.role, d.goal, d.summary
             FROM (
               SELECT rowid, distance FROM vec_decisions
               WHERE embedding MATCH ? ORDER BY distance LIMIT ?
             ) v
             JOIN decisions d ON d.rowid = v.rowid
             ORDER BY v.distance`,
        )
        .all(q, this.k) as Hit[];
    } catch {
      return; // no memory is non-fatal to the agent run
    }
    if (hits.length === 0) return;
    const dir = join(worktreePath, CTX_DIR);
    await mkdir(dir, { recursive: true });
    for (const h of hits) {
      const md = `# Prior decision (${h.role} · ${h.node_id})\n\n**Goal:** ${h.goal}\n\n**Outcome:** ${h.summary}\n`;
      await writeFile(join(dir, `memory-${h.node_id}.md`), md, "utf8");
    }
  }

  /** Release the db handle (Windows locks the file otherwise). */
  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 5: Export from the node barrel**

In `packages/core/src/node/index.ts`, add:

```ts
export * from "./sqlite-vec-context-provider.js";
```

- [ ] **Step 6: Run the test — expect pass**

Run: `npm run test -w @agent-team/core -- sqlite-vec-context-provider`
Expected: PASS (2 tests). If the KNN subquery errors on the installed sqlite-vec version, the fallback is the `k = ?` constraint form (`WHERE embedding MATCH ? AND k = ?`) — but the subquery+`LIMIT` form is correct for v0.1.9.

- [ ] **Step 7: Build core + port-purity guard**

Run: `npm run build -w @agent-team/core`
Expected: exit 0.

Run: `grep -n "better-sqlite3\|node:" packages/core/dist/index.js`
Expected: no output (the native provider is only under `dist/node/`, never the pure barrel).

- [ ] **Step 8: Commit**

```bash
git add -f "vsCode Fork/packages/core/package.json" \
            "vsCode Fork/package-lock.json" \
            "vsCode Fork/packages/core/src/node/sqlite-vec-context-provider.ts" \
            "vsCode Fork/packages/core/src/node/index.ts" \
            "vsCode Fork/packages/core/tests/sqlite-vec-context-provider.test.ts"
git commit -m "feat(core): SqliteVecContextProvider — record + hydrate over sqlite-vec"
```

---

## Task 5: Host wiring — `--memory` flag + record subscriber

**Files:**
- Modify: `packages/host-headless/src/compose.ts`
- Modify: `packages/host-headless/src/cli.ts`
- Create: `packages/host-headless/tests/memory-loop.test.ts`

This wires the closed loop: when `memoryDb` is set, `composeHeadless` stacks a `SqliteVecContextProvider` beside `TextContextProvider` (read) and subscribes to `done` events to `record()` (write), recovering the node's `goal` via `graph.get(id)`.

- [ ] **Step 1: Write the failing cross-run test**

Create `packages/host-headless/tests/memory-loop.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import { TaskGraph } from "@agent-team/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeHeadless } from "../src/compose.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("shared-memory closed loop (cross-run, offline)", () => {
  let repo: string;
  let dbDir: string;
  let dbPath: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s5-repo-")).split("\\").join("/");
    dbDir = mkdtempSync(join(tmpdir(), "s5-db-")).split("\\").join("/");
    dbPath = join(dbDir, "memory.db");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "seed"], repo);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("run 1 records a decision; run 2 retrieves it into the next agent's worktree", async () => {
    // --- Run 1: node "auth" concludes; host records its done summary ---
    const q1: QueryFn = async function* () {
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "added JWT login authentication", total_cost_usd: 0.01 });
    };
    const run1 = composeHeadless({
      repoRoot: repo,
      graph: new TaskGraph([{ id: "auth", role: "coder", goal: "implement login authentication", dependsOn: [] }]),
      query: q1, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000, git, memoryDb: dbPath,
    });
    await run1.run();
    run1.close();

    // --- Run 2: a later agent whose goal is near "auth" reads its memory file ---
    let seenMemory = "";
    const q2: QueryFn = async function* ({ options }) {
      const cwd = options.cwd as string;
      const f = join(cwd, ".agent-team", "memory-auth.md");
      seenMemory = existsSync(f) ? readFileSync(f, "utf8") : "";
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01 });
    };
    const run2 = composeHeadless({
      repoRoot: repo,
      graph: new TaskGraph([{ id: "fixauth", role: "coder", goal: "fix the login authentication bug", dependsOn: [] }]),
      query: q2, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000, git, memoryDb: dbPath,
    });
    await run2.run();
    run2.close();

    expect(seenMemory).toContain("added JWT login authentication");
    expect(seenMemory).toContain("implement login authentication"); // the recorded goal
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/host-headless -- memory-loop`
Expected: FAIL — `memoryDb` not accepted / `run.close is not a function`.

- [ ] **Step 3: Wire `compose.ts`**

In `packages/host-headless/src/compose.ts`:

(a) Add imports (alongside the existing `@agent-team/core` / `@agent-team/core/node` imports):

```ts
import { CompositeContextProvider, HashEmbedder } from "@agent-team/core";
import type { ContextProvider, Embedder } from "@agent-team/core";
import { SqliteVecContextProvider } from "@agent-team/core/node";
import type { DecisionRecorder } from "@agent-team/core/node";
```

> `DecisionRecorder` is co-located with the provider in Task 4, so it lives on the `@agent-team/core/node` subpath (NOT the pure barrel). `Embedder`/`HashEmbedder`/`CompositeContextProvider`/`ContextProvider` are on the pure barrel. If `BusEvent`/`TaskNode` aren't already imported in `compose.ts`, they're on the pure barrel too.

(b) Add two optional fields to the `ComposeOptions` interface:

```ts
  /** Path to the shared-memory sqlite-vec db. Absent ⇒ no shared memory (today's behavior). */
  memoryDb?: string;
  /** Embedder for shared memory. Defaults to HashEmbedder (offline). */
  embedder?: Embedder;
```

(c) Add `close(): void;` to the `ComposedHost` interface.

(d) Replace the existing provider/worktree construction (the `const worktrees = new WorktreeManager(... new TextContextProvider() ...)` block at ~`compose.ts:96-104`) with:

```ts
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

  const contextModalities = ["text"] as const;
  const worktrees = new WorktreeManager(
    git,
    opts.repoRoot,
    contextProvider,
    () => ({
      envelope: opts.editorState ? { editor: opts.editorState } : undefined,
      modality: pickModality(contextModalities),
    }),
  );
```

(e) After the `bus` is created and the graph is available, add the capture subscriber (place it near the other `bus.subscribe` wiring):

```ts
  if (recorder) {
    const rec = recorder;
    bus.subscribe((e: BusEvent) => {
      if (e.kind !== "done") return;
      const id = e.from.slice(e.from.indexOf("#") + 1); // from === `${role}#${id}`
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
```

(f) In the returned `ComposedHost` object, add `close`:

```ts
    close: () => memory?.close(),
```

> If `BusEvent` is not already imported in `compose.ts`, add it to the `import type { ... } from "@agent-team/core"` list.

- [ ] **Step 4: Wire `cli.ts`**

In `packages/host-headless/src/cli.ts`:

(a) Add `memory?: string;` to the `Args` interface.

(b) In `parseArgs`'s return object, add:

```ts
    memory: getOpt("--memory"),
```

(c) In the `composeHeadless({ ... })` call, add:

```ts
    memoryDb: args.memory,
```

(d) After the run completes (after the `await host.run()` line, before the process exits), add:

```ts
  host.close();
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npm run test -w @agent-team/host-headless -- memory-loop`
Expected: PASS (1 test).

- [ ] **Step 6: Build host-headless — expect clean**

Run: `npm run build -w @agent-team/host-headless`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -f "vsCode Fork/packages/host-headless/src/compose.ts" \
            "vsCode Fork/packages/host-headless/src/cli.ts" \
            "vsCode Fork/packages/host-headless/tests/memory-loop.test.ts"
git commit -m "feat(host-headless): --memory shared-memory loop (record on done, hydrate on create)"
```

---

## Task 6: Full-suite verification + done-criteria

**Files:** none (verification only)

- [ ] **Step 1: Clean full workspace build**

Run (from `C:\Users\nik\Documents\AI\vsCode Fork`): `npm run build`
Expected: exit 0 — core → adapters → hosts.

- [ ] **Step 2: Full workspace test suite**

Run: `npm run test`
Expected: all packages green, strictly above the 160 baseline. New tests: core +~5 (embedder 2, task-graph 1, composite 2, sqlite provider 2 → ~7) and host-headless +1 ⇒ total ~168. Hard requirement: green and > 160.

- [ ] **Step 3: Port-purity guard**

Run: `grep -n "better-sqlite3\|sqlite-vec\|node:" packages/core/dist/index.js`
Expected: no output. The native provider is reachable only via `@agent-team/core/node`.

- [ ] **Step 4: Zero-core-runtime-change confirmation**

Confirm the only `packages/core/src` edits are additive: new `embedder.ts`, new `composite-context-provider.ts`, new `node/sqlite-vec-context-provider.ts`, the `node/index.ts` + `index.ts` export lines, and the single `TaskGraph.get(id)` accessor. The Scheduler (`orchestrator.ts`), `bus.ts`, `worktree.ts`, and `integration.ts` runtime are untouched.

Run: `git -c core.autocrlf=false diff --stat 4b1e7dd..HEAD -- "vsCode Fork/packages/core/src/orchestrator.ts" "vsCode Fork/packages/core/src/bus.ts" "vsCode Fork/packages/core/src/worktree.ts"`
Expected: no output (no changes to those files).

- [ ] **Step 5: Closed-loop invariant — confirm covered**

Confirm `memory-loop.test.ts` asserts run 2's agent saw run 1's recorded summary AND goal in its worktree's `.agent-team/memory-auth.md`. If Step 2 passed, this is covered.

---

## Done-criteria

- `npm run build` exits 0 (workspace order core → adapters → hosts).
- `npm run test` fully green, strictly more than the 160 baseline.
- `core` stays port-pure: `dist/index.js` has no `better-sqlite3`/`sqlite-vec`/`node:*`; the native provider lives only under `dist/node/`.
- The Scheduler run-logic, bus, worktree, and integration are unchanged — the only core edits are additive types/classes + the `TaskGraph.get(id)` accessor.
- The closed loop holds: `--memory <db>` records each agent's `done` summary (with recovered role+goal) and hydrates the top-k prior decisions as `.agent-team/memory-<id>.md` files into later agents' worktrees; cross-run sharing is deterministic.
- `--memory` absent ⇒ host-headless behaves exactly as today (Text provider only, no recorder).

---

## Self-review notes (spec §-by-§ coverage)

- Spec §3 two-ports/one-impl/host-wired-capture → Tasks 4 (impl both ports) + 5 (host subscriber). §4 interfaces (`ContextProvider` unchanged, `DecisionRecorder`/`RecordedDecision`, `Embedder`) → Tasks 1, 4. §5 data model (decisions + vec_decisions, embed goal+summary, append-only, host `created_at`) → Task 4. §6 flows (record on done, hydrate on create, KNN) → Tasks 4, 5; §6.3 ordering/self-retrieval honored via cross-run guarantee (refinement #4). §7 error handling (load fail-fast, embed swallow-skip in hydrate, swallow-log in record, WAL, dim-mismatch surfaced by sqlite-vec) → Task 4. §8 scope fence (no ambient_report capture, no graph, no real embedder, no host-vscode) — none implemented. §9 file map + port-purity placement under src/node/ → Tasks 4, 6. §10 AgentId→node correlation resolved YES via `TaskGraph.get(id)` (refinement #3) → Tasks 2, 5. §11 acceptance → Task 6.
- Composite provider (refinement #1) is the one structure not in the spec's file map; it exists because compose injects Text, not Noop — covered by Task 3.
