# S3 — Deep Editor Fusion (Context Input) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the human's live editor state (active file, cursor, selection) flow into each agent's per-node `hydrate` seam as a modality-tagged `ContextEnvelope`, materialized to a gitignored text file today and stubbed (typed `NotImplemented`) for the future visual-primitive path — with zero changes to the Scheduler, bus, or integration.

**Architecture:** `core` gains pure value types (`ContextEnvelope`, `EditorState`, `ContextModality`), pure helpers (`editorPrimitives`, `pickModality`), a widened `ContextProvider.hydrate` signature, and a node-only `TextContextProvider` (lives under `src/node/`, exported via the `@agent-team/core/node` subpath so the main barrel stays port-pure). The envelope reaches `hydrate` through a host-supplied **per-dispatch supplier** wired into `WorktreeManager` (which is the actual caller of `hydrate`) — the Scheduler signature is untouched. `host-vscode` owns the live `vscode.window` event stream via `EditorStateSource`; `host-headless` gets an offline `--editor-state <json>` driver. Every adapter declares `contextModalities = ["text"]`.

**Tech Stack:** TypeScript ESM (NodeNext), `vitest` v2, `@agent-team/core` (port-pure barrel + `/node` subpath), `vscode` API (host-vscode, mocked via `vi.mock` in tests).

---

## Architectural note (read before Task 1)

`hydrate(node, worktreePath)` is **not** called by the host. It is called inside `WorktreeManager.create()` (`packages/core/src/worktree.ts:36`), which the Scheduler drives with only `(node, base)`. The spec (§3.4 / §4.1) describes "the composition root computes the modality and passes both into hydrate," but to honor the locked decision "zero changes to the Scheduler" (§9), the host cannot intercept the hydrate call directly.

**Resolution (the seam this plan threads):** `WorktreeManager` gains an optional fourth constructor arg — an **envelope supplier** `() => { envelope?: ContextEnvelope; modality?: ContextModality }`. `create()` evaluates it per-node (so the host reads the *live* snapshot at dispatch time) and forwards the result to `hydrate(node, path, envelope, modality)`. The host builds the supplier from `editorStateSource.current()` + `pickModality(adapter.contextModalities)`. Absent supplier → `create()` calls `hydrate(node, path)` exactly as today (all existing call sites unchanged). This keeps the live-stream / turn-boundary semantics (§6): the supplier is read once per node at worktree creation, which is that node's hydrate boundary.

This note is reflected in Task 5 (WorktreeManager) and Tasks 8–9 (host wiring).

---

## File Map

| File | Responsibility |
|---|---|
| `packages/core/src/context-envelope.ts` | NEW — `EditorState`, `ContextEnvelope`, `ContextModality`, `Pos`, pure `editorPrimitives()` + `pickModality()` |
| `packages/core/src/adapter.ts` | MODIFY — add `readonly contextModalities` to `AgentAdapter` |
| `packages/core/src/fake-adapter.ts` | MODIFY — `contextModalities = ["text"]` |
| `packages/core/src/context-provider.ts` | MODIFY — widen `hydrate` signature; add `NotImplementedError` |
| `packages/core/src/node/text-context-provider.ts` | NEW — `TextContextProvider` (node:fs/node:path; materializes `text`, stubs non-text) |
| `packages/core/src/worktree.ts` | MODIFY — optional envelope-supplier ctor arg; forward to `hydrate` |
| `packages/core/src/index.ts` | MODIFY — export `context-envelope.js` from the barrel (pure only; `TextContextProvider` stays out) |
| `packages/core/package.json` | MODIFY — add `./node` subpath entry for `text-context-provider` (alongside existing git-runner) |
| `packages/core/tests/context-envelope.test.ts` | NEW — `editorPrimitives` + `pickModality` pure tests |
| `packages/core/tests/text-context-provider.test.ts` | NEW — provider materialization tests (temp-repo helpers) |
| `packages/core/tests/context-provider.test.ts` | MODIFY — Noop satisfies widened interface |
| `packages/core/tests/worktree.test.ts` | MODIFY — supplier forwarded to hydrate |
| `packages/adapters-claude/src/adapter.ts` | MODIFY — `contextModalities = ["text"]` |
| `packages/adapters-deepseek/src/adapter.ts` | MODIFY — `contextModalities = ["text"]` |
| `packages/host-vscode/src/editor-state-source.ts` | NEW — live `vscode.window` snapshot stream |
| `packages/host-vscode/src/compose.ts` | MODIFY — build envelope supplier, pass into WorktreeManager |
| `packages/host-vscode/src/extension.ts` | MODIFY — construct + dispose `EditorStateSource` |
| `packages/host-vscode/tests/editor-state-source.test.ts` | NEW — synthetic vscode events → snapshot + envelope |
| `packages/host-headless/src/cli.ts` | MODIFY — parse `--editor-state <json>` |
| `packages/host-headless/src/compose.ts` | MODIFY — accept optional `editorState`, build supplier |
| `packages/host-headless/tests/editor-state-flag.test.ts` | NEW — flag → text file lands in worktree |

---

## Task 1: Core value types + pure helpers (`context-envelope.ts`)

**Files:**
- Create: `packages/core/src/context-envelope.ts`
- Create: `packages/core/tests/context-envelope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/context-envelope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  editorPrimitives,
  pickModality,
  type EditorState,
} from "../src/context-envelope.js";

describe("editorPrimitives", () => {
  it("maps cursor to point", () => {
    const s: EditorState = { cursor: { line: 3, col: 5 } };
    expect(editorPrimitives(s)).toEqual({ point: { line: 3, col: 5 } });
  });

  it("maps selection to box", () => {
    const s: EditorState = {
      selection: { start: { line: 1, col: 0 }, end: { line: 2, col: 4 } },
    };
    expect(editorPrimitives(s)).toEqual({
      box: { start: { line: 1, col: 0 }, end: { line: 2, col: 4 } },
    });
  });

  it("maps both cursor and selection", () => {
    const s: EditorState = {
      cursor: { line: 9, col: 2 },
      selection: { start: { line: 9, col: 2 }, end: { line: 9, col: 8 } },
    };
    expect(editorPrimitives(s)).toEqual({
      point: { line: 9, col: 2 },
      box: { start: { line: 9, col: 2 }, end: { line: 9, col: 8 } },
    });
  });

  it("returns empty object when neither present", () => {
    expect(editorPrimitives({})).toEqual({});
  });
});

describe("pickModality", () => {
  it("returns text for ['text']", () => {
    expect(pickModality(["text"])).toBe("text");
  });

  it("returns the richest supported modality", () => {
    expect(pickModality(["visual-primitives", "text"])).toBe("visual-primitives");
    expect(pickModality(["text", "image"])).toBe("image");
  });

  it("falls back to text on empty list", () => {
    expect(pickModality([])).toBe("text");
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/core -- context-envelope`
Expected: FAIL with `Cannot find module '../src/context-envelope.js'`

- [ ] **Step 3: Write `packages/core/src/context-envelope.ts`**

```ts
/** 0-based editor coordinates. */
export interface Pos {
  line: number;
  col: number;
}

export interface EditorState {
  /** Repo-relative POSIX path of the active file. Omitted if outside the repo. */
  activeFile?: string;
  /** The POINT primitive (from the human's cursor). */
  cursor?: Pos;
  /** The BOX primitive (from the human's selection; start <= end). */
  selection?: { start: Pos; end: Pos };
}

export interface ContextEnvelope {
  /** Optional; absent = nothing to hydrate. */
  editor?: EditorState;
}

export type ContextModality = "text" | "image" | "visual-primitives";

/** Richness ranking; higher index = richer. Used by pickModality. */
const MODALITY_RANK: readonly ContextModality[] = ["text", "image", "visual-primitives"];

/**
 * Pure projection of an EditorState into primitive geometry. Cursor -> point,
 * selection -> box. Reused verbatim by the future visual-primitives renderer.
 */
export function editorPrimitives(s: EditorState): {
  point?: Pos;
  box?: { start: Pos; end: Pos };
} {
  const out: { point?: Pos; box?: { start: Pos; end: Pos } } = {};
  if (s.cursor) out.point = s.cursor;
  if (s.selection) out.box = s.selection;
  return out;
}

/**
 * Returns the richest modality the adapter declares (text < image <
 * visual-primitives). Empty list falls back to "text".
 */
export function pickModality(
  supported: readonly ContextModality[],
): ContextModality {
  let best: ContextModality = "text";
  let bestRank = -1;
  for (const m of supported) {
    const rank = MODALITY_RANK.indexOf(m);
    if (rank > bestRank) {
      bestRank = rank;
      best = m;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm run test -w @agent-team/core -- context-envelope`
Expected: PASS (10 assertions across 7 tests)

- [ ] **Step 5: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/context-envelope.ts" \
            "vsCode Fork/packages/core/tests/context-envelope.test.ts"
git commit -m "feat(core): ContextEnvelope value types + editorPrimitives/pickModality"
```

---

## Task 2: Export envelope types from the barrel (keep core port-pure)

**Files:**
- Modify: `packages/core/src/index.ts`

The envelope module is pure (no `node:*` imports) so it belongs in the main barrel. `TextContextProvider` (Task 4) is node-only and must NOT be added here.

- [ ] **Step 1: Add the export line**

In `packages/core/src/index.ts`, add after the existing `context-provider.js` line:

```ts
export * from "./context-envelope.js";
```

Resulting region:

```ts
export * from "./context-provider.js";
export * from "./context-envelope.js";
export * from "./worktree.js";
```

- [ ] **Step 2: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0. The barrel now re-exports `EditorState`, `ContextEnvelope`, `ContextModality`, `Pos`, `editorPrimitives`, `pickModality`.

- [ ] **Step 3: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/index.ts"
git commit -m "feat(core): export ContextEnvelope types from barrel"
```

---

## Task 3: Widen the adapter capability + hydrate signature

**Files:**
- Modify: `packages/core/src/adapter.ts`
- Modify: `packages/core/src/fake-adapter.ts`
- Modify: `packages/core/src/context-provider.ts`
- Modify: `packages/core/tests/context-provider.test.ts`

- [ ] **Step 1: Add `contextModalities` to `AgentAdapter`**

In `packages/core/src/adapter.ts`, add the import and the new readonly member:

```ts
import type { AgentEvent, Role, AgentId } from "./events.js";
import type { ContextModality } from "./context-envelope.js";

export interface TaskContext {
  goal: string;
  role: Role;
  agentId: AgentId;
  /** Worktree path the agent should work in (S2). Undefined for non-worktree runs. */
  cwd?: string;
  /** The agent's branch (S2). Undefined for non-worktree runs. */
  branch?: string;
}

export type Emit = (event: AgentEvent) => void;

export interface AgentAdapter {
  /** Backend identifier, e.g. "fake" | "claude" | "codewhale". */
  readonly backend: string;
  /** Context modalities this adapter can consume, richest first. */
  readonly contextModalities: readonly ContextModality[];
  /** Run one task to completion; resolves after the adapter emits a terminal event or is interrupted. */
  startTask(ctx: TaskContext, emit: Emit): Promise<void>;
  /** Cancel the in-flight task. */
  interrupt(): void;
}
```

- [ ] **Step 2: Declare `contextModalities` on `FakeAdapter`**

In `packages/core/src/fake-adapter.ts`, add the member just under `backend`:

```ts
export class FakeAdapter implements AgentAdapter {
  readonly backend = "fake";
  readonly contextModalities = ["text"] as const;
  private interrupted = false;
```

- [ ] **Step 3: Widen `ContextProvider.hydrate` + add `NotImplementedError`**

Replace `packages/core/src/context-provider.ts` with:

```ts
import type { TaskNode } from "./task-graph.js";
import type { ContextEnvelope, ContextModality } from "./context-envelope.js";

/** Thrown by providers for a modality they do not (yet) materialize. */
export class NotImplementedError extends Error {
  constructor(modality: ContextModality) {
    super(`context modality not implemented: ${modality}`);
    this.name = "NotImplementedError";
  }
}

/**
 * Seam for hydrating per-agent context into a fresh worktree (S2). S3 widens
 * hydrate to be modality-aware: an optional envelope + the richest modality the
 * adapter supports. Implementations must write gitignored files (never `git add`).
 */
export interface ContextProvider {
  hydrate(
    node: TaskNode,
    worktreePath: string,
    envelope?: ContextEnvelope,
    modality?: ContextModality,
  ): Promise<void>;
}

export class NoopContextProvider implements ContextProvider {
  async hydrate(
    _node: TaskNode,
    _worktreePath: string,
    _envelope?: ContextEnvelope,
    _modality?: ContextModality,
  ): Promise<void> {
    // intentionally empty
  }
}
```

- [ ] **Step 4: Update the Noop test to exercise the widened signature**

In `packages/core/tests/context-provider.test.ts`, replace the body with:

```ts
import { describe, it, expect } from "vitest";
import { NoopContextProvider, type ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";
import type { ContextEnvelope } from "../src/context-envelope.js";

const node: TaskNode = { id: "a", role: "coder", goal: "x", dependsOn: [] };

describe("NoopContextProvider", () => {
  it("hydrate resolves without writing anything (no envelope)", async () => {
    const cp: ContextProvider = new NoopContextProvider();
    await expect(cp.hydrate(node, "/tmp/whatever")).resolves.toBeUndefined();
  });

  it("hydrate resolves with an envelope + modality (still no-op)", async () => {
    const cp: ContextProvider = new NoopContextProvider();
    const env: ContextEnvelope = { editor: { cursor: { line: 0, col: 0 } } };
    await expect(cp.hydrate(node, "/tmp/whatever", env, "text")).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 5: Run core tests — expect pass**

Run: `npm run test -w @agent-team/core -- context-provider fake-adapter`
Expected: PASS. (`FakeAdapter` now satisfies the widened `AgentAdapter`; Noop satisfies the widened `ContextProvider`.)

- [ ] **Step 6: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/adapter.ts" \
            "vsCode Fork/packages/core/src/fake-adapter.ts" \
            "vsCode Fork/packages/core/src/context-provider.ts" \
            "vsCode Fork/packages/core/tests/context-provider.test.ts"
git commit -m "feat(core): modality-aware hydrate + contextModalities capability"
```

---

## Task 4: `TextContextProvider` (node-only materializer)

**Files:**
- Create: `packages/core/src/node/text-context-provider.ts`
- Modify: `packages/core/package.json`
- Create: `packages/core/tests/text-context-provider.test.ts`

This provider uses `node:fs`/`node:path`, so it lives under `src/node/` and is exported via the `@agent-team/core/node` subpath — never the main barrel (port-purity, mirroring `NodeGitRunner`).

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/text-context-provider.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";
import { TextContextProvider } from "../src/node/text-context-provider.js";
import { NotImplementedError } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";
import type { ContextEnvelope } from "../src/context-envelope.js";

const node: TaskNode = { id: "a", role: "coder", goal: "x", dependsOn: [] };
const CTX_PATH = ".agent-team/editor-context.md";

afterEach(async () => { await cleanupRepos(); });

it("writes editor-context.md describing active file, cursor L:C, and selection range", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  const env: ContextEnvelope = {
    editor: {
      activeFile: "src/app.ts",
      cursor: { line: 9, col: 4 },
      selection: { start: { line: 9, col: 4 }, end: { line: 11, col: 0 } },
    },
  };
  await cp.hydrate(node, dir, env, "text");
  const md = await readFile(join(dir, CTX_PATH), "utf8");
  expect(md).toContain("src/app.ts");
  expect(md).toContain("9:4");          // cursor L:C
  expect(md).toContain("9:4");          // selection start
  expect(md).toContain("11:0");         // selection end
});

it("writes nothing when envelope is undefined", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  await cp.hydrate(node, dir, undefined, "text");
  await expect(readFile(join(dir, CTX_PATH), "utf8")).rejects.toThrow();
});

it("writes nothing when envelope.editor is absent", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  await cp.hydrate(node, dir, {}, "text");
  await expect(readFile(join(dir, CTX_PATH), "utf8")).rejects.toThrow();
});

it("throws NotImplementedError for visual-primitives modality", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  const env: ContextEnvelope = { editor: { cursor: { line: 0, col: 0 } } };
  await expect(cp.hydrate(node, dir, env, "visual-primitives")).rejects.toBeInstanceOf(
    NotImplementedError,
  );
});

it("throws NotImplementedError for image modality", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  const env: ContextEnvelope = { editor: { cursor: { line: 0, col: 0 } } };
  await expect(cp.hydrate(node, dir, env, "image")).rejects.toBeInstanceOf(
    NotImplementedError,
  );
});

it("defaults modality to text when omitted (writes the file)", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  const env: ContextEnvelope = { editor: { activeFile: "a.ts", cursor: { line: 1, col: 1 } } };
  await cp.hydrate(node, dir, env);
  const md = await readFile(join(dir, CTX_PATH), "utf8");
  expect(md).toContain("a.ts");
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/core -- text-context-provider`
Expected: FAIL with `Cannot find module '../src/node/text-context-provider.js'`

- [ ] **Step 3: Write `packages/core/src/node/text-context-provider.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskNode } from "../task-graph.js";
import type { ContextProvider } from "../context-provider.js";
import { NotImplementedError } from "../context-provider.js";
import type { ContextEnvelope, ContextModality, EditorState } from "../context-envelope.js";

const CTX_DIR = ".agent-team";
const CTX_FILE = "editor-context.md";

/**
 * Materializes the `text` modality: writes a gitignored
 * `.agent-team/editor-context.md` describing the human's editor state. Non-text
 * modalities are the forward-compat runway — they throw NotImplementedError.
 * Never `git add`s (the .agent-team/ dir is gitignored by repo convention).
 */
export class TextContextProvider implements ContextProvider {
  async hydrate(
    _node: TaskNode,
    worktreePath: string,
    envelope?: ContextEnvelope,
    modality: ContextModality = "text",
  ): Promise<void> {
    if (modality !== "text") throw new NotImplementedError(modality);
    const editor = envelope?.editor;
    if (!editor) return; // nothing to hydrate; degrades to Noop

    const md = renderEditorContext(editor);
    const dir = join(worktreePath, CTX_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, CTX_FILE), md, "utf8");
  }
}

function pos(p: { line: number; col: number }): string {
  return `${p.line}:${p.col}`;
}

function renderEditorContext(e: EditorState): string {
  const lines: string[] = ["# Live editor context", ""];
  if (e.activeFile) lines.push(`- Active file: \`${e.activeFile}\``);
  if (e.cursor) lines.push(`- Cursor (line:col, 0-based): ${pos(e.cursor)}`);
  if (e.selection) {
    lines.push(`- Selection: ${pos(e.selection.start)} → ${pos(e.selection.end)}`);
  }
  lines.push("");
  return lines.join("\n");
}
```

- [ ] **Step 4: Add the `/node` subpath export for the provider**

In `packages/core/package.json`, the `exports` block currently maps `./node` to the git-runner. Change `./node` to point at a node barrel and add that barrel. First, update `exports`:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./node": {
      "types": "./dist/node/index.d.ts",
      "default": "./dist/node/index.js"
    }
  },
```

- [ ] **Step 5: Create the node barrel `packages/core/src/node/index.ts`**

```ts
export * from "./git-runner.js";
export * from "./text-context-provider.js";
```

Note: existing importers use `@agent-team/core/node` and pull `NodeGitRunner` from it — the barrel re-exports `NodeGitRunner`, so those imports keep working. (Before this change `./node` resolved straight to `git-runner.js`; the barrel is a superset.)

- [ ] **Step 6: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0. Confirm `dist/node/index.js` and `dist/node/text-context-provider.js` exist.

- [ ] **Step 7: Run the test — expect pass**

Run: `npm run test -w @agent-team/core -- text-context-provider`
Expected: PASS (6 tests).

- [ ] **Step 8: Sanity-check existing `/node` consumers still resolve**

Run: `npm run build -w @agent-team/host-headless`
Expected: exit 0 (it imports `NodeGitRunner` from `@agent-team/core/node`; the new barrel still exports it).

- [ ] **Step 9: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/node/text-context-provider.ts" \
            "vsCode Fork/packages/core/src/node/index.ts" \
            "vsCode Fork/packages/core/package.json" \
            "vsCode Fork/packages/core/tests/text-context-provider.test.ts"
git commit -m "feat(core): TextContextProvider via /node subpath (text materialization + stub branch)"
```

---

## Task 5: WorktreeManager envelope supplier

**Files:**
- Modify: `packages/core/src/worktree.ts`
- Modify: `packages/core/tests/worktree.test.ts`

`create()` is the real caller of `hydrate`. Add an optional supplier so the host can feed a live envelope per dispatch without touching the Scheduler.

- [ ] **Step 1: Add the failing test for supplier forwarding**

In `packages/core/tests/worktree.test.ts`, add a new test inside the existing `describe("WorktreeManager create/remove/prune", ...)` block (after the first `it`), and add the needed type import at the top of the file:

Add to the imports at the top:

```ts
import type { ContextEnvelope, ContextModality } from "../src/context-envelope.js";
```

Add the test:

```ts
it("forwards the supplied envelope + modality to hydrate", async () => {
  const git = new FakeGit();
  const seen: Array<{ env?: ContextEnvelope; mod?: ContextModality }> = [];
  const cp: ContextProvider = {
    async hydrate(_n, _path, env, mod) { seen.push({ env, mod }); },
  };
  const envelope: ContextEnvelope = { editor: { cursor: { line: 2, col: 1 } } };
  const wm = new WorktreeManager(git, "/repo", cp, () => ({ envelope, modality: "text" }));

  await wm.create(node, "agentteam/integration");

  expect(seen).toEqual([{ env: envelope, mod: "text" }]);
});

it("passes undefined envelope/modality when no supplier is given", async () => {
  const git = new FakeGit();
  const seen: Array<{ env?: ContextEnvelope; mod?: ContextModality }> = [];
  const cp: ContextProvider = {
    async hydrate(_n, _path, env, mod) { seen.push({ env, mod }); },
  };
  const wm = new WorktreeManager(git, "/repo", cp);

  await wm.create(node, "agentteam/integration");

  expect(seen).toEqual([{ env: undefined, mod: undefined }]);
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/core -- worktree.test`
Expected: FAIL — the `WorktreeManager` constructor takes 3 args; the 4th supplier arg is rejected / not forwarded.

- [ ] **Step 3: Add the supplier to `WorktreeManager`**

In `packages/core/src/worktree.ts`, update the imports and constructor, and the `create` body:

```ts
import type { GitRunner } from "./git.js";
import type { ContextProvider } from "./context-provider.js";
import type { TaskNode } from "./task-graph.js";
import type { ContextEnvelope, ContextModality } from "./context-envelope.js";

export interface Worktree {
  path: string;
  branch: string;
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[] };

/** Supplies the per-node context envelope + modality at dispatch time. */
export type EnvelopeSupplier = (node: TaskNode) => {
  envelope?: ContextEnvelope;
  modality?: ContextModality;
};

export class WorktreeManager {
  constructor(
    private readonly git: GitRunner,
    private readonly repoRoot: string,
    private readonly context: ContextProvider,
    private readonly envelopeSupplier?: EnvelopeSupplier,
  ) {}
```

Then update `create()` so the `hydrate` call forwards the supplier output:

```ts
  async create(node: TaskNode, base: string): Promise<Worktree> {
    const path = this.pathFor(node);
    const branch = this.branchFor(node);
    const res = await this.git.run(["worktree", "add", "-b", branch, path, base], this.repoRoot);
    if (res.code !== 0) throw new Error(`git worktree add failed: ${res.stderr.trim()}`);
    const supplied = this.envelopeSupplier?.(node);
    await this.context.hydrate(node, path, supplied?.envelope, supplied?.modality);
    return { path, branch };
  }
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm run test -w @agent-team/core -- worktree.test`
Expected: PASS. The original `create ... then hydrates` test still passes (the 2-arg providers in existing tests just ignore the extra args).

- [ ] **Step 5: Run the full core suite + build**

Run: `npm run test -w @agent-team/core` then `npm run build -w @agent-team/core`
Expected: all core tests pass (70 baseline + new context-envelope/text-context-provider/widened tests); build exit 0.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/worktree.ts" \
            "vsCode Fork/packages/core/tests/worktree.test.ts"
git commit -m "feat(core): WorktreeManager envelope supplier forwarded to hydrate"
```

---

## Task 6: Adapters declare `contextModalities = ["text"]`

**Files:**
- Modify: `packages/adapters-claude/src/adapter.ts`
- Modify: `packages/adapters-deepseek/src/adapter.ts`

- [ ] **Step 1: Add the member to `ClaudeAdapter`**

In `packages/adapters-claude/src/adapter.ts`, find the class declaring `readonly backend = "claude"` and add directly beneath it:

```ts
  readonly contextModalities = ["text"] as const;
```

- [ ] **Step 2: Add the member to `DeepSeekAdapter`**

In `packages/adapters-deepseek/src/adapter.ts`, beneath `readonly backend = "deepseek";` add:

```ts
  readonly contextModalities = ["text"] as const;
```

- [ ] **Step 3: Build both adapters — expect clean**

Run: `npm run build -w @agent-team/adapters-claude && npm run build -w @agent-team/adapters-deepseek`
Expected: exit 0 (both now satisfy the widened `AgentAdapter`).

- [ ] **Step 4: Run both adapter suites**

Run: `npm run test -w @agent-team/adapters-claude && npm run test -w @agent-team/adapters-deepseek`
Expected: PASS (27 + 19 baseline, unchanged).

- [ ] **Step 5: Commit**

```bash
git add -f "vsCode Fork/packages/adapters-claude/src/adapter.ts" \
            "vsCode Fork/packages/adapters-deepseek/src/adapter.ts"
git commit -m "feat(adapters): declare contextModalities = [text] on claude + deepseek"
```

---

## Task 7: host-vscode `EditorStateSource` (live stream)

**Files:**
- Create: `packages/host-vscode/src/editor-state-source.ts`
- Create: `packages/host-vscode/tests/editor-state-source.test.ts`

- [ ] **Step 1: Write the failing test (mock vscode)**

Create `packages/host-vscode/tests/editor-state-source.test.ts`:

```ts
import { it, expect, vi, beforeEach } from "vitest";

// vi.mock must precede any import that pulls in 'vscode'.
let activeEditorHandler: (ed: unknown) => void = () => {};
let selectionHandler: (e: unknown) => void = () => {};

vi.mock("vscode", () => ({
  window: {
    get activeTextEditor() { return undefined; },
    onDidChangeActiveTextEditor: (fn: (ed: unknown) => void) => {
      activeEditorHandler = fn;
      return { dispose: vi.fn() };
    },
    onDidChangeTextEditorSelection: (fn: (e: unknown) => void) => {
      selectionHandler = fn;
      return { dispose: vi.fn() };
    },
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: "/repo" } }],
    asRelativePath: (p: string) => p.replace(/^\/repo\//, ""),
  },
}));

import { EditorStateSource } from "../src/editor-state-source.js";

// A synthetic vscode TextEditor + Selection shape (only the fields the source reads).
function fakeEditor(relPath: string, sel: { sl: number; sc: number; el: number; ec: number }) {
  return {
    document: { uri: { fsPath: `/repo/${relPath}`, scheme: "file" } },
    selection: {
      active: { line: sel.el, character: sel.ec },
      start: { line: sel.sl, character: sel.sc },
      end: { line: sel.el, character: sel.ec },
      isEmpty: sel.sl === sel.el && sel.sc === sel.ec,
    },
  };
}

beforeEach(() => { vi.clearAllMocks(); });

it("current() is undefined before any editor event", () => {
  const src = new EditorStateSource();
  expect(src.current()).toBeUndefined();
  src.dispose();
});

it("captures active file + cursor on active-editor change (0-based, repo-relative POSIX)", () => {
  const src = new EditorStateSource();
  activeEditorHandler(fakeEditor("src/app.ts", { sl: 4, sc: 0, el: 4, ec: 0 }));
  const state = src.current();
  expect(state?.activeFile).toBe("src/app.ts");
  expect(state?.cursor).toEqual({ line: 4, col: 0 });
  expect(state?.selection).toBeUndefined(); // empty selection => no box
  src.dispose();
});

it("captures selection box on selection change", () => {
  const src = new EditorStateSource();
  selectionHandler({ textEditor: fakeEditor("src/app.ts", { sl: 2, sc: 1, el: 5, ec: 3 }) });
  const state = src.current();
  expect(state?.activeFile).toBe("src/app.ts");
  expect(state?.cursor).toEqual({ line: 5, col: 3 }); // active end of selection
  expect(state?.selection).toEqual({
    start: { line: 2, col: 1 },
    end: { line: 5, col: 3 },
  });
  src.dispose();
});

it("omits activeFile for a non-file editor (e.g. output channel)", () => {
  const src = new EditorStateSource();
  activeEditorHandler({
    document: { uri: { fsPath: "/foo", scheme: "output" } },
    selection: {
      active: { line: 0, character: 0 },
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
      isEmpty: true,
    },
  });
  const state = src.current();
  expect(state?.activeFile).toBeUndefined();
  src.dispose();
});

it("clears snapshot when active editor becomes undefined", () => {
  const src = new EditorStateSource();
  activeEditorHandler(fakeEditor("src/app.ts", { sl: 0, sc: 0, el: 0, ec: 0 }));
  activeEditorHandler(undefined);
  expect(src.current()).toBeUndefined();
  src.dispose();
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/host-vscode -- editor-state-source`
Expected: FAIL with `Cannot find module '../src/editor-state-source.js'`

- [ ] **Step 3: Write `packages/host-vscode/src/editor-state-source.ts`**

```ts
import * as vscode from "vscode";
import type { EditorState, Pos } from "@agent-team/core";

/**
 * Live snapshot of the human's editor state, sourced from vscode.window events.
 * Host-only (subscribes to the vscode API) — never imported by core. Maintains a
 * single mutable latest snapshot; current() is read at each hydrate boundary.
 */
export class EditorStateSource {
  #snapshot: EditorState | undefined;
  readonly #disposables: vscode.Disposable[] = [];

  constructor() {
    this.#disposables.push(
      vscode.window.onDidChangeActiveTextEditor((ed) => this.#onEditor(ed)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.#onEditor(e.textEditor)),
    );
    if (vscode.window.activeTextEditor) {
      this.#onEditor(vscode.window.activeTextEditor);
    }
  }

  current(): EditorState | undefined {
    return this.#snapshot;
  }

  /** Push disposables onto the extension context so the source is torn down with it. */
  register(subscriptions: { dispose(): unknown }[]): void {
    subscriptions.push({ dispose: () => this.dispose() });
  }

  dispose(): void {
    for (const d of this.#disposables.splice(0)) d.dispose();
    this.#snapshot = undefined;
  }

  #onEditor(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      this.#snapshot = undefined;
      return;
    }
    const state: EditorState = {};

    const uri = editor.document.uri;
    if (uri.scheme === "file") {
      // asRelativePath yields a repo-relative path; normalize to POSIX separators.
      state.activeFile = vscode.workspace.asRelativePath(uri, false).split("\\").join("/");
    }

    const sel = editor.selection;
    state.cursor = toPos(sel.active);
    if (!sel.isEmpty) {
      state.selection = { start: toPos(sel.start), end: toPos(sel.end) };
    }

    this.#snapshot = state;
  }
}

function toPos(p: vscode.Position): Pos {
  return { line: p.line, col: p.character };
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm run test -w @agent-team/host-vscode -- editor-state-source`
Expected: PASS (5 tests).

- [ ] **Step 5: Build host-vscode — expect clean**

Run: `npm run build -w @agent-team/host-vscode`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/host-vscode/src/editor-state-source.ts" \
            "vsCode Fork/packages/host-vscode/tests/editor-state-source.test.ts"
git commit -m "feat(host-vscode): EditorStateSource live cursor/selection stream + tests"
```

---

## Task 8: Wire envelope supplier into `composeVscode`

**Files:**
- Modify: `packages/host-vscode/src/compose.ts`
- Modify: `packages/host-vscode/src/extension.ts`

`composeVscode` builds the per-dispatch supplier from the live source and passes it as the WorktreeManager's 4th arg. The supplier computes modality from the adapter's capability. Since every adapter is `["text"]` today, `pickModality` always returns `"text"`.

- [ ] **Step 1: Accept an `EditorStateSource` and use `TextContextProvider` + supplier**

In `packages/host-vscode/src/compose.ts`, update the imports: add `pickModality` and `TextContextProvider`, drop `NoopContextProvider` if unused, and import the source type.

Add/adjust the core imports:

```ts
import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  IntegrationCoordinator,
  Scheduler,
  TaskGraph,
  pickModality,
} from "@agent-team/core";
```

Add the node-subpath import for the provider (alongside the existing `NodeGitRunner` import):

```ts
import { NodeGitRunner, TextContextProvider } from "@agent-team/core/node";
```

Add the source import near the panel import:

```ts
import type { ControlRoomPanel } from "./control-room/panel.js";
import type { EditorStateSource } from "./editor-state-source.js";
```

Change the `composeVscode` signature to take the source:

```ts
export async function composeVscode(
  graphPath: string,
  panel: ControlRoomPanel,
  editorStateSource: EditorStateSource,
): Promise<ScheduleResult> {
```

Replace the `worktrees` construction (currently `new WorktreeManager(git, repoRoot, new NoopContextProvider())`) with the text provider + supplier. The supplier is read per-node at `create()` time, so it always reflects the freshest snapshot:

```ts
  const contextModalities = ["text"] as const; // every adapter is text today
  const worktrees = new WorktreeManager(
    git,
    repoRoot,
    new TextContextProvider(),
    () => {
      const editor = editorStateSource.current();
      return {
        envelope: editor ? { editor } : undefined,
        modality: pickModality(contextModalities),
      };
    },
  );
```

Note: the supplier derives modality from the same `["text"]` capability every adapter declares (`adapterFor` builds a `ClaudeAdapter`). Keeping the literal here avoids constructing an adapter just to read its capability; if a future adapter declares a richer modality, read it from `adapterFor(node).contextModalities` instead.

- [ ] **Step 2: Construct + pass the source from the extension**

In `packages/host-vscode/src/extension.ts`, import the source and create it inside the command handler, register it for disposal, and pass it to `composeVscode`:

Add the import:

```ts
import { EditorStateSource } from "./editor-state-source.js";
```

Inside the `agent-team.run` command callback, after the panel is created and registered, add:

```ts
      const editorStateSource = new EditorStateSource();
      editorStateSource.register(context.subscriptions);
```

Update the `composeVscode` call to pass it:

```ts
        const result = await composeVscode(uris[0].fsPath, panel, editorStateSource);
```

- [ ] **Step 3: Build host-vscode — expect clean**

Run: `npm run build -w @agent-team/host-vscode`
Expected: exit 0. If you see `has no exported member 'TextContextProvider'`, rebuild core first (`npm run build -w @agent-team/core`) so the `/node` barrel is emitted.

- [ ] **Step 4: Run host-vscode tests — expect pass**

Run: `npm run test -w @agent-team/host-vscode`
Expected: PASS (5 panel baseline + 5 editor-state-source = 10).

- [ ] **Step 5: Commit**

```bash
git add -f "vsCode Fork/packages/host-vscode/src/compose.ts" \
            "vsCode Fork/packages/host-vscode/src/extension.ts"
git commit -m "feat(host-vscode): wire editor envelope + modality into composeVscode"
```

---

## Task 9: host-headless `--editor-state <json>` offline driver

**Files:**
- Modify: `packages/host-headless/src/compose.ts`
- Modify: `packages/host-headless/src/cli.ts`
- Create: `packages/host-headless/tests/editor-state-flag.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/host-headless/tests/editor-state-flag.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskGraph } from "@agent-team/core";
import type { EditorState } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeHeadless } from "../src/compose.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("host-headless --editor-state (offline)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s3-editor-"));
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "README.md"), "# base\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "base"], repo);
    await git.run(["branch", "agentteam/integration"], repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("editorState reaches hydrate: .agent-team/editor-context.md lands in the worktree", async () => {
    let seenContext = "";
    const query: QueryFn = async function* ({ options }) {
      const cwd = options.cwd as string;
      // The provider wrote the context file before the adapter ran — read it here.
      try {
        seenContext = readFileSync(join(cwd, ".agent-team", "editor-context.md"), "utf8");
      } catch { /* absent */ }
      writeFileSync(join(cwd, "feature.txt"), "done\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01 });
    };

    const editorState: EditorState = {
      activeFile: "src/app.ts",
      cursor: { line: 7, col: 2 },
      selection: { start: { line: 7, col: 2 }, end: { line: 9, col: 0 } },
    };

    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "g", dependsOn: [] }]);
    const host = composeHeadless({
      repoRoot: repo, graph, query, model: "claude-test",
      maxTurns: 50, permTimeoutMs: 1000, editorState,
    });

    const result = await host.run();
    expect(result.status).toBe("complete");
    expect(seenContext).toContain("src/app.ts");
    expect(seenContext).toContain("7:2");
    expect(seenContext).toContain("9:0");
  });

  it("no editorState ⇒ no context file written (current behavior preserved)", async () => {
    let fileExisted = true;
    const query: QueryFn = async function* ({ options }) {
      const cwd = options.cwd as string;
      try {
        readFileSync(join(cwd, ".agent-team", "editor-context.md"), "utf8");
      } catch { fileExisted = false; }
      writeFileSync(join(cwd, "feature.txt"), "done\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01 });
    };
    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "g", dependsOn: [] }]);
    const host = composeHeadless({
      repoRoot: repo, graph, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000,
    });
    await host.run();
    expect(fileExisted).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/host-headless -- editor-state-flag`
Expected: FAIL — `composeHeadless` has no `editorState` option, and the worktree uses `NoopContextProvider` so no file is written.

- [ ] **Step 3: Add `editorState` to `composeHeadless`**

In `packages/host-headless/src/compose.ts`:

Add to the `ComposeOptions` interface:

```ts
  /** Optional static editor state (offline driver for the S3 hydrate seam). */
  editorState?: import("@agent-team/core").EditorState;
```

Add `pickModality` to the core value import and switch the provider import to the `/node` barrel. Update the imports:

```ts
import {
  MessageBus,
  PolicyStore,
  ActionBroker,
  WorktreeManager,
  IntegrationCoordinator,
  Scheduler,
  pickModality,
} from "@agent-team/core";
```

```ts
import { NodeGitRunner, TextContextProvider } from "@agent-team/core/node";
```

(Remove `NoopContextProvider` from the core import list — it is no longer used here.)

Replace the `worktrees` construction:

```ts
  const contextModalities = ["text"] as const;
  const worktrees = new WorktreeManager(
    git,
    opts.repoRoot,
    new TextContextProvider(),
    () => ({
      envelope: opts.editorState ? { editor: opts.editorState } : undefined,
      modality: pickModality(contextModalities),
    }),
  );
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm run test -w @agent-team/host-headless -- editor-state-flag`
Expected: PASS (2 tests).

- [ ] **Step 5: Parse `--editor-state` in the CLI**

In `packages/host-headless/src/cli.ts`:

Add `editorState?: string` to the `Args` interface:

```ts
interface Args {
  goal?: string;
  graph?: string;
  repo: string;
  model: string;
  maxTurns: number;
  role: string;
  costCeiling?: number;
  editorState?: string;
}
```

In `parseArgs`, add to the returned object:

```ts
    editorState: getOpt("--editor-state"),
```

In `main()`, load the JSON (if the flag is present) and pass it to `composeHeadless`. Find the `composeHeadless({ ... })` call and add the `editorState` field, building it from the file:

```ts
  const editorState = args.editorState
    ? (JSON.parse(readFileSync(args.editorState, "utf8")) as import("@agent-team/core").EditorState)
    : undefined;
```

Then add `editorState` to the options object passed to `composeHeadless` (alongside `repoRoot`, `graph`, `query`, etc.).

- [ ] **Step 6: Build host-headless — expect clean**

Run: `npm run build -w @agent-team/host-headless`
Expected: exit 0.

- [ ] **Step 7: Run the full host-headless suite**

Run: `npm run test -w @agent-team/host-headless`
Expected: PASS (8 baseline + 2 new = 10).

- [ ] **Step 8: Commit**

```bash
git add -f "vsCode Fork/packages/host-headless/src/compose.ts" \
            "vsCode Fork/packages/host-headless/src/cli.ts" \
            "vsCode Fork/packages/host-headless/tests/editor-state-flag.test.ts"
git commit -m "feat(host-headless): --editor-state offline driver for hydrate seam"
```

---

## Task 10: Full-suite verification + done-criteria

**Files:** none (verification only)

- [ ] **Step 1: Clean full workspace build**

Run (from the `vsCode Fork` dir): `npm run build`
Expected: exit 0 — core → adapters-claude/-deepseek → hosts all build in order.

- [ ] **Step 2: Full workspace test suite**

Run: `npm run test`
Expected: all packages green, strictly above the 129 baseline. New tests:
- core: +7 context-envelope, +6 text-context-provider, +1 widened-Noop, +2 worktree-supplier (≈ +16 → core ~86)
- host-vscode: +5 editor-state-source → 10
- host-headless: +2 editor-state-flag → 10
- adapters-claude (27) / adapters-deepseek (19): unchanged

Total ≈ **152 tests** (was 129). Exact count may differ slightly by how assertions group into `it` blocks; the hard requirement is **green and > 129**.

- [ ] **Step 3: Port-purity guard — barrel must not pull node-only code**

Confirm `packages/core/src/index.ts` does NOT export `text-context-provider` and contains no `node:fs`/`node:path` import in any barrel-reachable module. `TextContextProvider` is reachable only via `@agent-team/core/node`.

Run: `npm run build -w @agent-team/core` and inspect that `dist/index.js` does not reference `text-context-provider`.
Expected: barrel stays pure; provider lives only under `dist/node/`.

- [ ] **Step 4: Final commit (if Step 2 surfaced any test-count fixups)**

If any assertion-count comment in this plan needed correcting in a test file, commit it:

```bash
git add -f "vsCode Fork/packages/<pkg>/tests/<file>.test.ts"
git commit -m "test(s3): finalize S3 editor-fusion suite"
```

Otherwise no commit — Task 10 is verification only.

---

## Done-criteria

- `npm run build` exits 0 (workspace build order core → adapters → hosts).
- `npm run test` is fully green with strictly more than the 129 baseline tests.
- `core` stays port-pure: the main barrel (`src/index.ts`) exports only the pure `context-envelope` additions; `TextContextProvider` is reachable solely through `@agent-team/core/node`.
- No changes to the Scheduler, bus, integration, or `TaskContext` (locked decisions §9). The envelope reaches `hydrate` via the host-supplied `WorktreeManager` envelope supplier.
- `visual-primitives` and `image` modalities throw `NotImplementedError` (typed runway, never reached today since all adapters declare `["text"]`).

---

## Self-review notes (spec §-by-§ coverage)

- §3.1 envelope types + `editorPrimitives` → Task 1. §3.2 `contextModalities` → Tasks 3 (interface), 6 (adapters), plus FakeAdapter in Task 3.
- §3.3 modality-aware hydrate + `TextContextProvider` + non-text stub → Tasks 3 (signature/`NotImplementedError`), 4 (provider). §3.4 `pickModality` + who-chooses → Task 1 (helper), Tasks 8/9 (host computes + passes).
- §4.1 `EditorStateSource` + composeVscode wiring → Tasks 7, 8. §4.2 `--editor-state` → Task 9.
- §8 tests: core pure + provider (temp-repo helpers) → Tasks 1, 4; host-vscode `vi.mock("vscode")` → Task 7; host-headless flag → Task 9; widened-Noop compile/no-op → Task 3.
- §2.1 port-purity (provider under `src/node/`, barrel pure) → Task 4 (+ Task 10 Step 3 guard).
