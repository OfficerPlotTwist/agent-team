import { describe, it, expect } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mapStreamMessage, interpretResult } from "../src/event-mapper.js";

// Minimal SDK-shaped fixtures (cast — we only touch fields the mapper reads).
const asMsg = (o: unknown): SDKMessage => o as SDKMessage;
const assistantText = (text: string) =>
  asMsg({ type: "assistant", message: { content: [{ type: "text", text }] } });
const assistantToolUse = (name: string, input: Record<string, unknown>) =>
  asMsg({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name, input }] } });
const resultSuccess = (
  result: string,
  cost: number,
  usage?: { input_tokens: number; output_tokens: number },
) =>
  asMsg({
    type: "result", subtype: "success", is_error: false, result, total_cost_usd: cost,
    ...(usage ? { usage } : {}),
  });
const resultError = (errors: string[]) =>
  asMsg({ type: "result", subtype: "error_during_execution", is_error: true, errors });

describe("mapStreamMessage", () => {
  it("maps an assistant text block to a message event", () => {
    expect(mapStreamMessage(assistantText("hello there"), "coder#a")).toEqual([
      { kind: "message", from: "coder#a", to: "all", text: "hello there" },
    ]);
  });

  it("maps an assistant tool_use block to a tool_call event", () => {
    expect(mapStreamMessage(assistantToolUse("Write", { file_path: "a.ts" }), "coder#a")).toEqual([
      { kind: "tool_call", from: "coder#a", name: "Write", args: { file_path: "a.ts" } },
    ]);
  });

  it("ignores empty text blocks", () => {
    expect(mapStreamMessage(assistantText("   "), "coder#a")).toEqual([]);
  });

  it("returns [] for non-assistant messages", () => {
    expect(mapStreamMessage(resultSuccess("done", 0.01), "coder#a")).toEqual([]);
    expect(mapStreamMessage(asMsg({ type: "system", subtype: "init" }), "coder#a")).toEqual([]);
  });
});

describe("interpretResult", () => {
  it("returns ok with summary + cost + token usage on success", () => {
    expect(
      interpretResult(resultSuccess("created a.ts", 0.012, { input_tokens: 1200, output_tokens: 340 })),
    ).toEqual({
      ok: true,
      summary: "created a.ts",
      costUsd: 0.012,
      tokensIn: 1200,
      tokensOut: 340,
    });
  });

  it("defaults token usage to 0 when the result has no usage", () => {
    expect(interpretResult(resultSuccess("x", 0.01))).toMatchObject({ tokensIn: 0, tokensOut: 0 });
  });

  it("folds cache-read + cache-creation tokens into tokensIn (no under-count on cached runs)", () => {
    const cached = asMsg({
      type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01,
      usage: {
        input_tokens: 200, output_tokens: 50,
        cache_read_input_tokens: 4000, cache_creation_input_tokens: 800,
      },
    });
    expect(interpretResult(cached)).toMatchObject({ tokensIn: 5000, tokensOut: 50 });
  });

  it("returns not-ok with joined errors on error subtype", () => {
    expect(interpretResult(resultError(["boom", "bang"]))).toEqual({
      ok: false,
      message: "boom; bang",
    });
  });
});
