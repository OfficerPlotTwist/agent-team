# adapters-deepseek Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@agent-team/adapters-deepseek` — a second `AgentAdapter` that drives DeepSeek (OpenAI-compatible API) through a self-managed tool-call loop, proving the adapter seam is backend-agnostic.

**Architecture:** A new npm workspace package `packages/adapters-deepseek/` with four source files: tool definitions, a tool executor, a loop runner, and the adapter class. Tests are offline — a mock `OpenAI` client replaces real API calls. No changes to any existing package.

**Tech Stack:** TypeScript ESM (NodeNext), `openai` v4 (OpenAI-compatible client), `vitest` v2, `@agent-team/core` for types/interfaces.

---

## File Map

| File | Responsibility |
|---|---|
| `packages/adapters-deepseek/package.json` | Package manifest, deps, scripts |
| `packages/adapters-deepseek/tsconfig.json` | TypeScript config (mirrors adapters-claude) |
| `packages/adapters-deepseek/src/index.ts` | Public barrel |
| `packages/adapters-deepseek/src/tool-defs.ts` | OpenAI tool JSON schemas |
| `packages/adapters-deepseek/src/event-mapper.ts` | Pure fn: build `FileChangeEvent` |
| `packages/adapters-deepseek/src/tool-executor.ts` | Execute tools on disk |
| `packages/adapters-deepseek/src/loop.ts` | Agentic tool-call/response loop |
| `packages/adapters-deepseek/src/adapter.ts` | `DeepSeekAdapter` implements `AgentAdapter` |
| `packages/adapters-deepseek/tests/tool-executor.test.ts` | ToolExecutor unit tests (real fs, temp dir) |
| `packages/adapters-deepseek/tests/loop.test.ts` | loop unit tests (mock client) |
| `packages/adapters-deepseek/tests/adapter.test.ts` | adapter integration tests (mock client) |
| `package.json` (workspace root) | Add adapters-deepseek to build/test scripts |

---

## Task 1: Package scaffold

**Files:**
- Create: `packages/adapters-deepseek/package.json`
- Create: `packages/adapters-deepseek/tsconfig.json`
- Create: `packages/adapters-deepseek/src/index.ts`

- [ ] **Step 1: Create the package directory**

```bash
mkdir -p "packages/adapters-deepseek/src" "packages/adapters-deepseek/tests"
```

- [ ] **Step 2: Write `packages/adapters-deepseek/package.json`**

```json
{
  "name": "@agent-team/adapters-deepseek",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@agent-team/core": "*",
    "openai": "^4.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Write `packages/adapters-deepseek/tsconfig.json`**

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
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Write `packages/adapters-deepseek/src/index.ts`** (empty barrel for now — will be filled in Task 6)

```ts
export { DeepSeekAdapter } from "./adapter.js";
```

Note: this file will cause a type error until `adapter.ts` exists. That is expected — it compiles once all tasks are complete.

- [ ] **Step 5: Install the new package into the workspace**

Run from the workspace root (`packages/adapters-deepseek/` parent):
```bash
npm install
```

Expected: npm links `@agent-team/adapters-deepseek` in the workspace and installs `openai` into `packages/adapters-deepseek/node_modules`.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/adapters-deepseek/package.json" \
            "vsCode Fork/packages/adapters-deepseek/tsconfig.json" \
            "vsCode Fork/packages/adapters-deepseek/src/index.ts"
git commit -m "chore(adapters-deepseek): package scaffold"
```

---

## Task 2: Tool definitions and event mapper

**Files:**
- Create: `packages/adapters-deepseek/src/tool-defs.ts`
- Create: `packages/adapters-deepseek/src/event-mapper.ts`

These are pure data/functions with no branching — no separate unit test needed. They are tested indirectly by Tasks 3 and 4.

- [ ] **Step 1: Write `packages/adapters-deepseek/src/tool-defs.ts`**

```ts
import type OpenAI from "openai";

export const TOOL_DEFINITIONS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the working directory." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file, creating it and any parent directories if needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the working directory." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and directories inside a directory.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Directory path relative to working directory. Defaults to '.'." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Signal that the task is complete. Always call this when finished.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Brief description of what was accomplished." },
        },
        required: ["summary"],
      },
    },
  },
];
```

- [ ] **Step 2: Write `packages/adapters-deepseek/src/event-mapper.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { FileChangeEvent, AgentId } from "@agent-team/core";

export function makeFileChangeEvent(
  agentId: AgentId,
  filePath: string,
  content: string,
): FileChangeEvent {
  return {
    kind: "file_change",
    from: agentId,
    proposalId: randomUUID(),
    path: filePath,
    diff: content,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add -f "vsCode Fork/packages/adapters-deepseek/src/tool-defs.ts" \
            "vsCode Fork/packages/adapters-deepseek/src/event-mapper.ts"
git commit -m "feat(adapters-deepseek): tool definitions + event mapper"
```

---

## Task 3: ToolExecutor

**Files:**
- Create: `packages/adapters-deepseek/src/tool-executor.ts`
- Create: `packages/adapters-deepseek/tests/tool-executor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters-deepseek/tests/tool-executor.test.ts`:

```ts
import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolExecutor } from "../src/tool-executor.js";

let cwd: string;
const executor = new ToolExecutor();

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "ds-exec-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

it("read_file returns file content", () => {
  writeFileSync(join(cwd, "a.txt"), "hello world");
  const { result, events } = executor.execute("read_file", { path: "a.txt" }, cwd, "coder#1");
  expect(result).toBe("hello world");
  expect(events).toHaveLength(0);
});

it("read_file returns error string for missing file (no throw)", () => {
  const { result } = executor.execute("read_file", { path: "nope.txt" }, cwd, "coder#1");
  expect(result).toMatch(/error/i);
});

it("write_file creates the file and emits file_change", () => {
  const { result, events } = executor.execute("write_file", { path: "b.txt", content: "world" }, cwd, "coder#1");
  expect(result).toBe("ok");
  expect(existsSync(join(cwd, "b.txt"))).toBe(true);
  expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("world");
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("file_change");
  expect((events[0] as import("@agent-team/core").FileChangeEvent).path).toBe("b.txt");
  expect((events[0] as import("@agent-team/core").FileChangeEvent).from).toBe("coder#1");
});

it("write_file creates parent directories", () => {
  const { result } = executor.execute("write_file", { path: "sub/dir/c.txt", content: "nested" }, cwd, "coder#1");
  expect(result).toBe("ok");
  expect(existsSync(join(cwd, "sub", "dir", "c.txt"))).toBe(true);
});

it("list_files returns directory entries as JSON array", () => {
  writeFileSync(join(cwd, "x.txt"), "");
  const { result } = executor.execute("list_files", { dir: "." }, cwd, "coder#1");
  const entries = JSON.parse(result) as string[];
  expect(entries.some(e => e.startsWith("x.txt"))).toBe(true);
});

it("blocks path traversal on read_file", () => {
  const { result } = executor.execute("read_file", { path: "../../etc/passwd" }, cwd, "coder#1");
  expect(result).toContain("not allowed");
});

it("blocks path traversal on write_file", () => {
  const { result } = executor.execute("write_file", { path: "../escape.txt", content: "x" }, cwd, "coder#1");
  expect(result).toContain("not allowed");
  expect(existsSync(join(cwd, "..", "escape.txt"))).toBe(false);
});

it("returns error string for unknown tool name (no throw)", () => {
  const { result, events } = executor.execute("magic_spell", {}, cwd, "coder#1");
  expect(result).toContain("unknown tool");
  expect(events).toHaveLength(0);
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npm run test -w @agent-team/adapters-deepseek
```

Expected: fail with `Cannot find module '../src/tool-executor.js'`

- [ ] **Step 3: Write `packages/adapters-deepseek/src/tool-executor.ts`**

```ts
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent, AgentId } from "@agent-team/core";
import { makeFileChangeEvent } from "./event-mapper.js";

export interface ExecuteResult {
  result: string;
  events: AgentEvent[];
}

export class ToolExecutor {
  execute(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
    agentId: AgentId,
  ): ExecuteResult {
    switch (name) {
      case "read_file":
        return this.#readFile(String(args["path"] ?? ""), cwd);
      case "write_file":
        return this.#writeFile(String(args["path"] ?? ""), String(args["content"] ?? ""), cwd, agentId);
      case "list_files":
        return this.#listFiles(String(args["dir"] ?? "."), cwd);
      default:
        return { result: `unknown tool: ${name}`, events: [] };
    }
  }

  #resolveSafe(filePath: string, cwd: string): string | null {
    const base = path.resolve(cwd);
    const resolved = path.resolve(base, filePath);
    return resolved.startsWith(base + path.sep) ? resolved : null;
  }

  #readFile(filePath: string, cwd: string): ExecuteResult {
    const resolved = this.#resolveSafe(filePath, cwd);
    if (!resolved) return { result: "error: path traversal not allowed", events: [] };
    try {
      return { result: fs.readFileSync(resolved, "utf8"), events: [] };
    } catch (err) {
      return { result: `error: ${String(err)}`, events: [] };
    }
  }

  #writeFile(filePath: string, content: string, cwd: string, agentId: AgentId): ExecuteResult {
    const resolved = this.#resolveSafe(filePath, cwd);
    if (!resolved) return { result: "error: path traversal not allowed", events: [] };
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, "utf8");
      return { result: "ok", events: [makeFileChangeEvent(agentId, filePath, content)] };
    } catch (err) {
      return { result: `error: ${String(err)}`, events: [] };
    }
  }

  #listFiles(dir: string, cwd: string): ExecuteResult {
    const base = path.resolve(cwd);
    const target = path.resolve(base, dir);
    // Allow base itself (dir=".") or strict children; block siblings like /tmp/repo-other
    if (target !== base && !target.startsWith(base + path.sep)) {
      return { result: "error: path traversal not allowed", events: [] };
    }
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      return {
        result: JSON.stringify(entries.map(e => e.name + (e.isDirectory() ? "/" : ""))),
        events: [],
      };
    } catch (err) {
      return { result: `error: ${String(err)}`, events: [] };
    }
  }
}
```

Note: `#listFiles` uses an inline traversal check (not `#resolveSafe`) to allow listing the base dir itself (`target === base` when `dir = "."`). The `#resolveSafe` helper returns null for `.` because `path.resolve(base, ".")` equals `base`, not `base + sep + something`.

- [ ] **Step 4: Run tests — expect all pass**

```bash
npm run test -w @agent-team/adapters-deepseek
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add -f "vsCode Fork/packages/adapters-deepseek/src/tool-executor.ts" \
            "vsCode Fork/packages/adapters-deepseek/tests/tool-executor.test.ts"
git commit -m "feat(adapters-deepseek): ToolExecutor + tests"
```

---

## Task 4: Agentic loop

**Files:**
- Create: `packages/adapters-deepseek/src/loop.ts`
- Create: `packages/adapters-deepseek/tests/loop.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters-deepseek/tests/loop.test.ts`:

```ts
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLoop } from "../src/loop.js";
import type { AgentEvent, TaskContext } from "@agent-team/core";
import type OpenAI from "openai";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "ds-loop-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

function makeCtx(): TaskContext {
  return { goal: "test goal", role: "coder", agentId: "coder#1", cwd };
}

function makeClient(responses: unknown[]): OpenAI {
  let i = 0;
  return {
    chat: { completions: { create: vi.fn(async () => responses[i++]) } },
  } as unknown as OpenAI;
}

function doneResponse(summary = "finished") {
  return {
    choices: [{ finish_reason: "tool_calls", index: 0, message: {
      role: "assistant", content: null,
      tool_calls: [{ id: "c1", type: "function",
        function: { name: "done", arguments: JSON.stringify({ summary }) } }],
    }}],
  };
}

it("emits done when model calls the done tool", async () => {
  const client = makeClient([doneResponse("all done")]);
  const events: AgentEvent[] = [];
  await runLoop(makeCtx(), (e) => events.push(e), client, "deepseek-coder", 10, () => false);
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("done");
  expect((events[0] as import("@agent-team/core").DoneEvent).summary).toBe("all done");
});

it("emits done when model stops without calling done (finish_reason stop)", async () => {
  const client = makeClient([{
    choices: [{ finish_reason: "stop", index: 0, message: { role: "assistant", content: "I am done", tool_calls: null } }],
  }]);
  const events: AgentEvent[] = [];
  await runLoop(makeCtx(), (e) => events.push(e), client, "deepseek-coder", 10, () => false);
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("done");
  expect((events[0] as import("@agent-team/core").DoneEvent).summary).toBe("I am done");
});

it("emits file_change then done across two turns", async () => {
  const client = makeClient([
    { choices: [{ finish_reason: "tool_calls", index: 0, message: { role: "assistant", content: null,
        tool_calls: [{ id: "c1", type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "hello" }) } }] } }] },
    doneResponse("wrote file"),
  ]);
  const events: AgentEvent[] = [];
  await runLoop(makeCtx(), (e) => events.push(e), client, "deepseek-coder", 10, () => false);
  expect(events.some(e => e.kind === "file_change")).toBe(true);
  expect(events.at(-1)?.kind).toBe("done");
});

it("emits error (not done) when interrupted before loop starts", async () => {
  const client = makeClient([]);
  const events: AgentEvent[] = [];
  await runLoop(makeCtx(), (e) => events.push(e), client, "deepseek-coder", 10, () => true);
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("error");
  expect((events[0] as import("@agent-team/core").ErrorEvent).message).toBe("interrupted");
  expect((client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
});

it("emits error when interrupted after first API call returns", async () => {
  // The mock sets shouldInterrupt=true WHILE processing the response.
  // The interrupt check inside the tool_calls for-loop catches it.
  let shouldInterrupt = false;
  const client = {
    chat: { completions: { create: vi.fn(async () => {
      shouldInterrupt = true;
      return { choices: [{ finish_reason: "tool_calls", index: 0, message: { role: "assistant", content: null,
        tool_calls: [{ id: "c1", type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: "x.txt" }) } }] } }] };
    })}},
  } as unknown as OpenAI;
  const events: AgentEvent[] = [];
  await runLoop(makeCtx(), (e) => events.push(e), client, "deepseek-coder", 10, () => shouldInterrupt);
  expect(events.some(e => e.kind === "error" && (e as import("@agent-team/core").ErrorEvent).message === "interrupted")).toBe(true);
  expect(events.every(e => e.kind !== "done")).toBe(true);
});

it("emits error containing 'budget' when maxTurns exceeded", async () => {
  // read_file on a non-existent file returns an error string (no throw) — loop keeps running
  const loopingResponse = { choices: [{ finish_reason: "tool_calls", index: 0, message: { role: "assistant", content: null,
    tool_calls: [{ id: "c1", type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: "missing.txt" }) } }] } }] };
  const client = makeClient(Array.from({ length: 5 }, () => loopingResponse));
  const events: AgentEvent[] = [];
  await runLoop(makeCtx(), (e) => events.push(e), client, "deepseek-coder", 3, () => false);
  const last = events.at(-1);
  expect(last?.kind).toBe("error");
  expect((last as import("@agent-team/core").ErrorEvent).message).toContain("budget");
});

it("emits error on API exception (no throw from runLoop)", async () => {
  const client = {
    chat: { completions: { create: vi.fn(async () => { throw new Error("network failure"); }) } },
  } as unknown as OpenAI;
  const events: AgentEvent[] = [];
  await expect(runLoop(makeCtx(), (e) => events.push(e), client, "deepseek-coder", 10, () => false))
    .resolves.toBeUndefined();
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("error");
  expect((events[0] as import("@agent-team/core").ErrorEvent).message).toContain("network failure");
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npm run test -w @agent-team/adapters-deepseek
```

Expected: fail with `Cannot find module '../src/loop.js'`

- [ ] **Step 3: Write `packages/adapters-deepseek/src/loop.ts`**

```ts
import type OpenAI from "openai";
import type { TaskContext, Emit } from "@agent-team/core";
import { TOOL_DEFINITIONS } from "./tool-defs.js";
import { ToolExecutor } from "./tool-executor.js";

export async function runLoop(
  ctx: TaskContext,
  emit: Emit,
  client: OpenAI,
  model: string,
  maxTurns: number,
  isInterrupted: () => boolean,
): Promise<void> {
  const executor = new ToolExecutor();
  const cwd = ctx.cwd ?? process.cwd();

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are a ${ctx.role} agent. Goal: ${ctx.goal}. Working directory: ${cwd}. Use tools to accomplish the goal, then call done() when finished.`,
    },
    { role: "user", content: "Begin." },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    if (isInterrupted()) {
      emit({ kind: "error", from: ctx.agentId, message: "interrupted" });
      return;
    }

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
      });
    } catch (err) {
      emit({ kind: "error", from: ctx.agentId, message: `api error: ${String(err)}` });
      return;
    }

    const choice = response.choices[0];
    if (!choice) {
      emit({ kind: "error", from: ctx.agentId, message: "no choices in response" });
      return;
    }

    const msg = choice.message;
    messages.push(msg);

    if (!msg.tool_calls?.length) {
      // Model stopped without calling a tool — treat as successful completion
      emit({ kind: "done", from: ctx.agentId, summary: msg.content ?? "" });
      return;
    }

    for (const toolCall of msg.tool_calls) {
      if (isInterrupted()) {
        emit({ kind: "error", from: ctx.agentId, message: "interrupted" });
        return;
      }

      const name = toolCall.function.name;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      } catch {
        args = {};
      }

      if (name === "done") {
        emit({ kind: "done", from: ctx.agentId, summary: String(args["summary"] ?? "") });
        return;
      }

      const { result, events } = executor.execute(name, args, cwd, ctx.agentId);
      for (const event of events) emit(event);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  emit({ kind: "error", from: ctx.agentId, message: `budget: exceeded ${maxTurns} turns` });
}
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
npm run test -w @agent-team/adapters-deepseek
```

Expected: all 7 loop tests + 8 executor tests pass (15 total).

- [ ] **Step 5: Commit**

```bash
git add -f "vsCode Fork/packages/adapters-deepseek/src/loop.ts" \
            "vsCode Fork/packages/adapters-deepseek/tests/loop.test.ts"
git commit -m "feat(adapters-deepseek): runLoop + tests"
```

---

## Task 5: DeepSeekAdapter

**Files:**
- Create: `packages/adapters-deepseek/src/adapter.ts`
- Create: `packages/adapters-deepseek/tests/adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/adapters-deepseek/tests/adapter.test.ts`:

```ts
import { it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeepSeekAdapter } from "../src/adapter.js";
import type { AgentEvent, TaskContext, DoneEvent, ErrorEvent } from "@agent-team/core";
import type OpenAI from "openai";

function makeTempCtx(): { ctx: TaskContext; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "ds-adapter-"));
  return {
    ctx: { goal: "write a greeting", role: "coder", agentId: "coder#1", cwd },
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function makeClient(responses: unknown[]): OpenAI {
  let i = 0;
  return {
    chat: { completions: { create: vi.fn(async () => responses[i++]) } },
  } as unknown as OpenAI;
}

afterEach(() => vi.clearAllMocks());

it("backend is 'deepseek'", () => {
  expect(new DeepSeekAdapter(makeClient([]), "deepseek-coder", 10).backend).toBe("deepseek");
});

it("emits file_change then done on write_file → done sequence", async () => {
  const { ctx, cleanup } = makeTempCtx();
  try {
    const client = makeClient([
      { choices: [{ finish_reason: "tool_calls", index: 0, message: { role: "assistant", content: null,
        tool_calls: [{ id: "c1", type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "hello" }) } }] } }] },
      { choices: [{ finish_reason: "tool_calls", index: 0, message: { role: "assistant", content: null,
        tool_calls: [{ id: "c2", type: "function",
          function: { name: "done", arguments: JSON.stringify({ summary: "wrote greeting" }) } }] } }] },
    ]);
    const adapter = new DeepSeekAdapter(client, "deepseek-coder", 10);
    const events: AgentEvent[] = [];
    await adapter.startTask(ctx, (e) => events.push(e));
    expect(events.some(e => e.kind === "file_change")).toBe(true);
    expect(events.at(-1)?.kind).toBe("done");
    expect((events.at(-1) as DoneEvent).summary).toBe("wrote greeting");
  } finally { cleanup(); }
});

it("interrupt() stops the loop — error emitted, no done", async () => {
  const { ctx, cleanup } = makeTempCtx();
  try {
    let adapter!: DeepSeekAdapter;
    // The mock calls adapter.interrupt() when the first API call returns
    const client = {
      chat: { completions: { create: vi.fn(async () => {
        adapter.interrupt();
        return { choices: [{ finish_reason: "tool_calls", index: 0, message: { role: "assistant", content: null,
          tool_calls: [{ id: "c1", type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "x.txt" }) } }] } }] };
      })}},
    } as unknown as OpenAI;
    adapter = new DeepSeekAdapter(client, "deepseek-coder", 10);
    const events: AgentEvent[] = [];
    await adapter.startTask(ctx, (e) => events.push(e));
    expect(events.some(e => e.kind === "error")).toBe(true);
    expect(events.every(e => e.kind !== "done")).toBe(true);
  } finally { cleanup(); }
});

it("startTask resolves (no throw) even when the API fails", async () => {
  const { ctx, cleanup } = makeTempCtx();
  try {
    const client = {
      chat: { completions: { create: vi.fn(async () => { throw new Error("timeout"); }) } },
    } as unknown as OpenAI;
    const adapter = new DeepSeekAdapter(client, "deepseek-coder", 10);
    const events: AgentEvent[] = [];
    await expect(adapter.startTask(ctx, (e) => events.push(e))).resolves.toBeUndefined();
    expect(events.at(-1)?.kind).toBe("error");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npm run test -w @agent-team/adapters-deepseek
```

Expected: fail with `Cannot find module '../src/adapter.js'`

- [ ] **Step 3: Write `packages/adapters-deepseek/src/adapter.ts`**

```ts
import type OpenAI from "openai";
import type { AgentAdapter, TaskContext, Emit } from "@agent-team/core";
import { runLoop } from "./loop.js";

export class DeepSeekAdapter implements AgentAdapter {
  readonly backend = "deepseek";
  #interrupted = false;

  constructor(
    private readonly client: OpenAI,
    private readonly model = "deepseek-coder",
    private readonly maxTurns = 40,
  ) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.#interrupted = false;
    await runLoop(ctx, emit, this.client, this.model, this.maxTurns, () => this.#interrupted);
  }

  interrupt(): void {
    this.#interrupted = true;
  }
}
```

- [ ] **Step 4: Run all tests — expect all pass**

```bash
npm run test -w @agent-team/adapters-deepseek
```

Expected: 19 tests pass (8 executor + 7 loop + 4 adapter).

- [ ] **Step 5: Build — expect clean**

```bash
npm run build -w @agent-team/adapters-deepseek
```

Expected: exit 0, `dist/` created with `index.js`, `index.d.ts`, and source maps.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/adapters-deepseek/src/adapter.ts" \
            "vsCode Fork/packages/adapters-deepseek/tests/adapter.test.ts"
git commit -m "feat(adapters-deepseek): DeepSeekAdapter + tests"
```

---

## Task 6: Workspace integration

**Files:**
- Modify: `package.json` (workspace root)

- [ ] **Step 1: Update root `package.json` build and test scripts**

The new package builds after `core` (it depends on core) and before any host that uses it. Add it between `adapters-claude` and `host-headless`:

```json
{
  "name": "agent-team-workspace",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build -w @agent-team/core && npm run build -w @agent-team/adapters-claude && npm run build -w @agent-team/adapters-deepseek && npm run build -w @agent-team/host-headless",
    "test": "npm run test -w @agent-team/core && npm run test -w @agent-team/adapters-claude && npm run test -w @agent-team/adapters-deepseek && npm run test -w @agent-team/host-headless",
    "build:core": "npm run build -w @agent-team/core"
  }
}
```

- [ ] **Step 2: Run the full workspace build**

```bash
npm run build
```

Expected: exit 0, all four packages build cleanly.

- [ ] **Step 3: Run the full workspace test suite**

```bash
npm run test
```

Expected: 70 (core) + 27 (adapters-claude) + 19 (adapters-deepseek) + 8 (host-headless) = **124 tests pass**.

- [ ] **Step 4: Commit**

```bash
git add -f "vsCode Fork/package.json"
git commit -m "chore: wire adapters-deepseek into workspace build + test scripts"
```
