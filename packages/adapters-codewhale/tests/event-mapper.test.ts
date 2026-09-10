import { describe, it, expect } from "vitest";
import { mapLine } from "../src/event-mapper.js";

// Exact transcript from a live `codewhale exec --auto --output-format stream-json` run.
const transcript = [
  `{"type":"tool_use","name":"write_file","id":"call_00_qQ...","input":{"path":"hello.txt","content":"hi"}}`,
  `{"type":"tool_result","id":"call_00_qQ...","output":"...diff text...","status":"success"}`,
  `{"type":"tool_use","name":"read_file","id":"call_00_P4...","input":{"path":"hello.txt"}}`,
  `{"type":"tool_result","id":"call_00_P4...","output":"hi","status":"success"}`,
  `{"type":"content","content":"Done"}`,
  `{"type":"content","content":"."}`,
  `{"type":"session_capture","content":"1720752c-..."}`,
  `{"type":"metadata","meta":{"model":"deepseek-v4-pro","input_tokens":186029,"output_tokens":167,"session_id":"...","status":"completed"}}`,
  `{"type":"done"}`,
];

describe("mapLine", () => {
  it("maps tool_use lines to tool_call events with name and args", () => {
    const r0 = mapLine(transcript[0], "coder#1");
    expect(r0).toEqual({
      kind: "tool_call",
      event: {
        kind: "tool_call",
        from: "coder#1",
        name: "write_file",
        args: { path: "hello.txt", content: "hi" },
      },
    });
    const r2 = mapLine(transcript[2], "coder#1");
    expect(r2).toEqual({
      kind: "tool_call",
      event: {
        kind: "tool_call",
        from: "coder#1",
        name: "read_file",
        args: { path: "hello.txt" },
      },
    });
  });

  it("extracts metadata (model, tokens, status) without emitting an event", () => {
    const r = mapLine(transcript[7], "coder#1");
    expect(r.kind).toBe("metadata");
    if (r.kind !== "metadata") return;
    expect(r.meta.model).toBe("deepseek-v4-pro");
    expect(r.meta.input_tokens).toBe(186029);
    expect(r.meta.output_tokens).toBe(167);
    expect(r.meta.status).toBe("completed");
  });

  it("ignores tool_result, content, session_capture, and done lines", () => {
    for (const i of [1, 3, 4, 5, 6, 8]) {
      expect(mapLine(transcript[i], "coder#1")).toEqual({ kind: "ignore" });
    }
  });

  it("ignores unparseable and unknown lines", () => {
    expect(mapLine("not json at all", "coder#1")).toEqual({ kind: "ignore" });
    expect(mapLine("", "coder#1")).toEqual({ kind: "ignore" });
    expect(mapLine(`{"type":"some_future_type","x":1}`, "coder#1")).toEqual({ kind: "ignore" });
    expect(mapLine(`{"no":"type"}`, "coder#1")).toEqual({ kind: "ignore" });
  });
});
