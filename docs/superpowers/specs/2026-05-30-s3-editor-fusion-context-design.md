# S3 — Deep Editor Fusion (Context Input) — Design

**Date:** 2026-05-30
**Status:** Approved design, pre-implementation-plan
**Builds on:** S2 (`ContextProvider.hydrate` seam, worktree+merge), B1/B2 (live Claude/parallel), core robustness, DeepSeek adapter, host-vscode + Control Room — all on `master` (`b8702c1`).
**Slice:** S3, **input side only**. Editor state becomes a first-class, modality-tagged input to the existing per-node hydrate seam, with a live cursor/selection stream owned by the VS Code host. Lays the full runway for visual-primitive models behind a typed-stub branch — no speculative machinery built now.

---

## 1. Goal & intent

Make the human's live editor state (active file, cursor, selection) flow into each agent's context through the **existing** `ContextProvider.hydrate` seam, and shape that seam so a future "visual-primitive" model (consumes an image via cheap pointers instead of token-expanded screenshots) is adopted by adding **one adapter + one renderer** — with zero changes to the Scheduler, worktrees, bus, or host wiring.

### 1.1 The governing insight

`hydrate(node, worktreePath)` already delivers context as **gitignored files written into the worktree, pre-run, once per node**. The agent's own file-reading tools pick them up. S3 keeps that mechanism and makes *what* gets written modality-aware:

- The human's **cursor** is a **point**; the human's **selection** is a **box** — exactly the two primitive types in DeepSeek's *Thinking with Visual Primitives* (cursor→POINT, selection→BOX). Naming them that now means the future visual renderer is a re-projection of the same envelope, not a redesign.
- Today the envelope materializes to **text** (a gitignored `.md`). Tomorrow the same envelope materializes to an **image + point/box sidecar** the model points at. Same seam, same envelope, different materializer.

### 1.2 What this milestone delivers

- A core `ContextEnvelope` / `EditorState` value type (modality-agnostic).
- A `contextModalities` capability declaration on `AgentAdapter`.
- A modality-aware `hydrate` + a real `TextContextProvider` (materializes the `text` modality).
- A `visual-primitives` materialization branch that is a **typed stub** (`NotImplemented`) — the entire forward-compat runway, deliberately unimplemented.
- A VS Code host `EditorStateSource` that streams cursor/selection into an always-current snapshot, wired into `composeVscode`.
- A headless escape hatch (`--editor-state <json>`) to drive the seam offline.

### 1.3 What this milestone defers

- **Output side** — inline-diff decorations / apply-reject in the editor. That touches the merge-result review surface, a different seam; it stays the separately-deferred host-vscode "diff-review panel" milestone.
- **Mid-turn reactivity** — see §6. The stream is live; consumption is turn-boundary. True mid-generation injection is out of scope.
- **Viewport & recent-edit-history signals** (levels 4–5) — viewport ≠ intent; recent-edits is S4 ambient territory.
- **Any real visual-primitive implementation** — the model API does not exist yet; we ship only the typed branch.

---

## 2. Package boundaries

```
packages/
  core/                  CHANGED  envelope types, adapter capability, modality-aware hydrate, TextContextProvider
  adapters-claude/       CHANGED  one line: contextModalities = ["text"]
  adapters-deepseek/     CHANGED  one line: contextModalities = ["text"]
  host-headless/         CHANGED  optional --editor-state flag → static envelope
  host-vscode/           CHANGED  EditorStateSource (the live stream) + envelope wired into composeVscode
```

`fake-adapter.ts` (core) also declares `["text"]`. No new packages, no new external dependencies.

### 2.1 Port-purity guard (unchanged discipline)

The live stream subscribes to `vscode.window` events — that is **host-only** code and never enters `core`. `core` gains only pure value types + a file-writing provider (same class of code as the existing `NoopContextProvider`; `node:fs`/`node:path` usage stays out of the `src/index.ts` barrel, consistent with the `src/node/` rule). The cursor→point / selection→box projection is a **pure function** in `core`, unit-tested in isolation, reused verbatim by the future renderer.

---

## 3. Core changes

### 3.1 New value types (`packages/core/src/context-envelope.ts`, NEW)

```ts
export interface Pos { line: number; col: number }          // 0-based, editor coords

export interface EditorState {
  activeFile?: string;                 // repo-relative POSIX path
  cursor?: Pos;                        // the POINT primitive
  selection?: { start: Pos; end: Pos };// the BOX primitive (start <= end)
}

export interface ContextEnvelope {
  editor?: EditorState;                // optional; absent = nothing to hydrate
}

export type ContextModality = "text" | "image" | "visual-primitives";
```

A pure projection helper lives here too (used by `text` materialization now, the visual renderer later):

```ts
export function editorPrimitives(s: EditorState): {
  point?: Pos;                         // from cursor
  box?: { start: Pos; end: Pos };      // from selection
};
```

### 3.2 Capability on the seam (`packages/core/src/adapter.ts`)

```ts
export interface AgentAdapter {
  readonly backend: string;
  readonly contextModalities: readonly ContextModality[]; // NEW
  startTask(ctx: TaskContext, emit: Emit): Promise<void>;
  interrupt(): void;
}
```

Existing adapters declare `["text"]`. A future visual model declares e.g. `["visual-primitives", "text"]` (richest first). `TaskContext` is **unchanged** — context is delivered as files, not via `ctx`.

### 3.3 Modality-aware hydrate (`packages/core/src/context-provider.ts`)

```ts
export interface ContextProvider {
  hydrate(
    node: TaskNode,
    worktreePath: string,
    envelope?: ContextEnvelope,        // NEW, optional
    modality?: ContextModality,        // NEW, optional — richest the adapter supports
  ): Promise<void>;
}
```

- `NoopContextProvider` keeps its empty body — signature widened, behavior unchanged; all existing call sites that pass only `(node, worktreePath)` still compile.
- **`TextContextProvider` (NEW)** materializes `modality === "text"`: if `envelope.editor` is present, write a gitignored `.agent-team/editor-context.md` into `worktreePath` describing active file + cursor `L:C` + selection range and excerpt. Absent editor / undefined envelope → no file written (degrades to Noop).
- Any non-`text` modality (`image`, `visual-primitives`) → **typed stub**: throws `NotImplementedError(modality)`. This is the runway, intentionally inert. Filling the `visual-primitives` branch later means rendering the viewport to a PNG + writing a point/box sidecar from `editorPrimitives()`; no other file changes. (`image` is reserved in the union for a plain-screenshot backend; unimplemented for the same reason.)
- `.agent-team/` is written gitignored (provider never `git add`s — existing rule).

### 3.4 Who chooses the modality

The composition root (host) computes the modality via a pure core helper `pickModality(supported)` and passes it to `hydrate`. `pickModality` ranks `text < image < visual-primitives` and returns the richest modality the adapter declares, falling back to `"text"` on an empty list. Today every adapter declares `["text"]`, so the result is always `"text"` and the stub branches in §3.3 are never reached.

---

## 4. Host changes

### 4.1 `host-vscode` — the live stream

`EditorStateSource` (NEW, host-vscode):

- Subscribes to `vscode.window.onDidChangeActiveTextEditor` and `onDidChangeTextEditorSelection`.
- Maintains a single mutable **latest snapshot**: `{ activeFile, cursor, selection }`, normalized to repo-relative POSIX paths and 0-based positions.
- Exposes `current(): EditorState | undefined`.
- Disposed with the extension (pushes its disposables onto the context subscriptions).

`composeVscode` wiring: at each node dispatch it reads `editorStateSource.current()`, builds `{ editor }` into a `ContextEnvelope`, computes `pickModality(adapter.contextModalities)`, and passes both into the `TextContextProvider.hydrate` call. The Control Room webview is untouched.

### 4.2 `host-headless` — offline driver

A `--editor-state <path-to-json>` CLI flag loads a static `EditorState` JSON and feeds it as the envelope to `hydrate`. Lets the seam (and the text materialization) be exercised end-to-end with no VS Code. Absent flag → no envelope → current behavior.

---

## 5. Data flow

```
VS Code editor                host-vscode                     core                          worktree
──────────────                ───────────                     ────                          ────────
selection/active changes ──► EditorStateSource.current() ──► ContextEnvelope{editor}
                                                              pickModality(["text"]) = text
                             composeVscode dispatch  ─────►  TextContextProvider.hydrate(
                                                                node, wt, envelope, "text") ─► writes
                                                                                                .agent-team/
                                                                                                editor-context.md
                             adapter.startTask(ctx, emit) (cwd = wt) ─ agent reads the file via its own tools
```

Future swap (no orchestrator change): a `visual-primitives` adapter → `pickModality` returns `"visual-primitives"` → the (future) provider branch writes `editor-view.png` + `primitives.json` from `editorPrimitives()`.

---

## 6. Honest "live" semantics (load-bearing)

The ClaudeAdapter wraps the SDK's autoregressive `query()` loop, which **cannot accept mid-generation context injection**. Therefore:

- **The stream is genuinely live** — `EditorStateSource` updates its snapshot on every cursor/selection change.
- **Consumption is turn-boundary** — an agent sees the freshest snapshot at its `hydrate` boundary (node start, or any explicit future re-hydrate), not mid-token.
- True mid-turn reactivity would require interrupt-and-restart of the adapter and is explicitly **out of scope** for S3.

The spec states this plainly so "live-streaming cursor" is not read as the model reacting keystroke-by-keystroke within a single generation.

---

## 7. Error handling

| Scenario | Behavior |
|---|---|
| `envelope` undefined or `envelope.editor` absent | Write nothing; hydrate resolves (Noop-equivalent) |
| `modality === "visual-primitives"` | Throw `NotImplementedError` (typed stub; never reached today since all adapters are `text`) |
| Active file outside the repo/worktree | `activeFile` omitted from the snapshot (can't make a repo-relative path); cursor/selection still emitted if meaningful |
| `EditorStateSource` before any editor focused | `current()` returns `undefined` → no envelope |
| `.agent-team/` write fails (fs error) | Propagates from `hydrate` (same failure surface as any provider write today) |

---

## 8. Tests (all offline, matches repo discipline)

**core:**
- `editorPrimitives()` pure projection: cursor→point, selection→box, both/neither.
- `pickModality()`: `["text"]`→text; `["visual-primitives","text"]`→visual-primitives; `[]`→text fallback.
- `TextContextProvider.hydrate`: envelope with editor + modality=text → asserts gitignored `.agent-team/editor-context.md` content (active file, `L:C`, selection range); absent editor → no file; modality=visual-primitives → asserts `NotImplementedError`. Uses the existing temp-repo helpers (`makeTempRepo`/`cleanupRepos`).
- `NoopContextProvider` still satisfies the widened interface (compile + no-op behavior).

**host-vscode:**
- `vi.mock("vscode")` feeds synthetic `onDidChangeActiveTextEditor` / `onDidChangeTextEditorSelection` events → assert `EditorStateSource.current()` snapshot (path normalization, 0-based coords) and the `ContextEnvelope` `composeVscode` builds from it.

**host-headless:**
- `--editor-state fixture.json` → assert the loaded `EditorState` reaches `hydrate` and the text file lands in the worktree (offline, real temp repo).

Done-criteria: `npm run build` exit 0; full suite green with the new tests added on top of the current 129 (core +pure/provider tests, host-vscode +source test, host-headless +flag test).

---

## 9. Locked decisions

- **Input-only.** Output diff-review stays a separate host-vscode milestone; S3 does not touch the merge-result review surface.
- **Seam-only forward-compat.** `visual-primitives` is a typed `NotImplemented` branch — no renderer, no mock adapter, no speculative API. Adoption later = 1 adapter (declares the modality) + 1 renderer (fills the branch).
- **Cursor=POINT, selection=BOX** named in the envelope now, so the future visual path re-projects rather than redesigns.
- **Stream in the host, value types + provider in core.** Core stays port-pure; `vscode` events never enter core.
- **Live stream, turn-boundary consumption.** No mid-generation injection (SDK constraint); stated explicitly, not implied.
- **Context delivered as gitignored files** (existing `hydrate` mechanism) — `TaskContext` unchanged, no prompt-injection path added.
- **No new external dependency.**
