# Adapters-DeepSeek — Design

**Date:** 2026-05-29
**Status:** Approved design, pre-implementation-plan
**Builds on:** B1 (ClaudeAdapter seam proven), B2 (parallel team live), core robustness pass — all on `master`.
**Slice:** Plan B — second heterogeneous adapter; proves the `AgentAdapter` seam works with a manually-implemented tool-call loop (no agent SDK).

---

## 1. Goal & intent

Add `@agent-team/adapters-deepseek` — a second concrete `AgentAdapter` that drives **DeepSeek** (OpenAI-compatible chat-completion API) through a self-managed tool-call loop. ClaudeAdapter delegates loop management to the Claude Agent SDK; this adapter owns the loop itself, proving the seam is backend-agnostic, not SDK-shaped.

### 1.1 What this proves

- `AgentAdapter` works with a plain chat-completion backend — no vendor SDK required.
- The normalized event vocabulary (`file_change`, `done`, `error`) is producible from a tool-call loop, not just from SDK stream translation.
- `interrupt()` works against a loop-iteration flag, not an SDK cancellation token.

### 1.2 What this defers

- Permission/GATE flow — all tools auto-allow in this pass. GATE integration is a follow-on once the seam is proven.
- `action_request` emission — no broker path wired; not needed to prove the core seam.
- Multi-turn conversation memory — each `startTask` call is a fresh context.
- Streaming output events — loop uses non-streaming completions for simplicity; streaming is additive.

---

## 2. Package boundaries

Zero changes to `packages/core` or `packages/adapters-claude`.

```
packages/
  core/                      UNCHANGED
  adapters-claude/           UNCHANGED
  host-headless/             UNCHANGED
  adapters-deepseek/     NEW  DeepSeekAdapter + tool executor + loop
  host-vscode/           NEW  (separate spec)
```

`adapters-deepseek` is a **reusable library** — no CLI, no composition root. Future hosts (`host-vscode`, or a second headless CLI) import it directly.

Dependency graph:
```
adapters-deepseek
  └── @agent-team/core   (AgentAdapter, AgentEvent types)
  └── openai             (OpenAI-compatible client, NEW external dep)
```

---

## 3. New external dependency

**`openai` v4** — the standard OpenAI-compatible client.

Configured per-instance:
```ts
new OpenAI({ baseURL: "https://api.deepseek.com/v1", apiKey: process.env.DEEPSEEK_API_KEY })
```

No global singleton. The caller constructs and injects the client (same discipline as `ClaudeAdapter` receiving the SDK client). Default model: `"deepseek-coder"`.

---

## 4. Source layout

```
packages/adapters-deepseek/
  src/
    adapter.ts        # DeepSeekAdapter — implements AgentAdapter
    tool-defs.ts      # OpenAI tool definitions (JSON Schema shapes)
    tool-executor.ts  # executes tools against ctx.cwd on disk
    loop.ts           # tool-call / response loop; returns terminal AgentEvent
    event-mapper.ts   # tool results + finish reason → AgentEvents
    index.ts          # barrel: export { DeepSeekAdapter }
  tests/
    adapter.test.ts   # offline tests with mock OpenAI client
    loop.test.ts      # loop termination, interrupt, maxTurns guard
  package.json
  tsconfig.json
```

---

## 5. Component designs

### 5.1 `DeepSeekAdapter` (`adapter.ts`)

```ts
export class DeepSeekAdapter implements AgentAdapter {
  readonly backend = "deepseek";

  constructor(
    private readonly client: OpenAI,
    private readonly model = "deepseek-coder",
    private readonly maxTurns = 40,
  ) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> { ... }
  interrupt(): void { this.#interrupted = true; }

  #interrupted = false;
}
```

`startTask` delegates to `runLoop(ctx, emit, this.client, this.model, this.maxTurns, () => this.#interrupted)`.

### 5.2 `loop.ts`

Runs the tool-call / response cycle:

1. Build initial messages: system prompt (goal + role + cwd) + user turn ("Begin.").
2. POST `chat.completions.create` with tool definitions.
3. On `finish_reason === "tool_calls"`:
   - For each tool call: delegate to `ToolExecutor.execute(call, ctx.cwd)`
   - Collect resulting `AgentEvent[]` from the executor (a write → `file_change`)
   - Emit each event
   - Append assistant message + tool result messages
   - Check interrupt flag; if set, emit `error` (interrupted), return
   - Check turn count vs `maxTurns`; if exceeded, emit `error` (budget), return
   - Loop
4. On `done` tool call (special terminal tool): emit `done`, return.
5. On `finish_reason === "stop"` (model stopped without calling done): emit `done` with the final content as summary.
6. On API error: emit `error`, return (never throw — mirrors ClaudeAdapter error discipline).

### 5.3 `tool-defs.ts`

Four tool definitions in OpenAI JSON Schema format:

| Tool | Parameters | Side effects |
|---|---|---|
| `read_file` | `path: string` | none |
| `write_file` | `path: string`, `content: string` | writes file → `file_change` event |
| `list_files` | `dir: string` (default `.`) | none |
| `done` | `summary: string` | terminal — ends loop |

All paths are resolved relative to `ctx.cwd`. Paths that escape `ctx.cwd` via `..` traversal are rejected with a tool error result (no emit, no throw).

### 5.4 `tool-executor.ts`

```ts
export class ToolExecutor {
  execute(call: ToolCall, cwd: string): { result: string; events: AgentEvent[] }
}
```

- `read_file`: `fs.readFileSync` → string result
- `write_file`: `fs.mkdirSync` + `fs.writeFileSync` → result `"ok"`, events `[file_change]`
- `list_files`: `fs.readdirSync` → JSON array string
- `done`: returns sentinel; loop handles terminal logic
- Unknown tool name: returns error string, no events

### 5.5 `event-mapper.ts`

Thin helper — maps a `write_file` call result to a `file_change` AgentEvent. Keeps `loop.ts` free of event-shape knowledge.

---

## 6. Error handling

| Scenario | Behavior |
|---|---|
| API network error | Emit `error`, resolve (don't throw) |
| Tool path traversal | Tool result = error string; loop continues |
| `maxTurns` exceeded | Emit `error { reason: "budget" }`, resolve |
| `interrupt()` called | Emit `error { reason: "interrupted" }`, resolve |
| Model stops without `done` | Treat as success — emit `done` with final content |

---

## 7. Tests

All offline — no live API calls in CI.

**`adapter.test.ts`:**
- Mock `OpenAI` client returns a canned completion with one `write_file` call then `done`.
- Assert: `file_change` emitted, then `done` emitted, `startTask` resolves.
- Assert: `interrupt()` before second iteration stops the loop, emits `error`.

**`loop.test.ts`:**
- `maxTurns` guard: mock client always returns `tool_calls`; assert loop exits at limit.
- Path traversal: `write_file("../../etc/passwd", ...)` → tool error result, loop continues.

---

## 8. Build & workspace integration

`packages/adapters-deepseek/tsconfig.json` references `packages/core/tsconfig.json` (same pattern as `adapters-claude`). Root `package.json` build/test scripts gain `-w @agent-team/adapters-deepseek` in the correct position (after `core`, before any host that depends on it).

---

## 9. Locked decisions

- **Auto-allow all tools.** No GATE/broker path in this pass. Permission parity with ClaudeAdapter is a follow-on.
- **Non-streaming completions.** Streaming is additive; non-streaming is sufficient to prove the seam.
- **Injected `OpenAI` client.** No global singleton — callers configure base URL and API key.
- **`done` as a tool, not a finish reason.** Explicit terminal signal; avoids guessing on `stop` alone (though `stop` is also treated as success per §6).
- **Zero `packages/core` changes.** The `AgentAdapter` seam is stable; this package is purely additive.
