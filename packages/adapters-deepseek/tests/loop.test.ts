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
