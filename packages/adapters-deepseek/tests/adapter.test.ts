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
