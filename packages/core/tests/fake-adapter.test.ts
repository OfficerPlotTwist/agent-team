import { describe, it, expect } from "vitest";
import { FakeAdapter } from "../src/fake-adapter.js";
import type { AgentEvent } from "../src/events.js";

describe("FakeAdapter", () => {
  it("emits its scripted events with `from` set to the agent id, ending in done", async () => {
    const adapter = new FakeAdapter([
      { kind: "message", to: "all", text: "starting" },
      { kind: "done", summary: "finished" },
    ]);
    const out: AgentEvent[] = [];
    await adapter.startTask({ goal: "g", role: "coder", agentId: "coder#1" }, (e) => out.push(e));
    expect(out.map((e) => e.kind)).toEqual(["message", "done"]);
    expect(out.every((e) => e.from === "coder#1")).toBe(true);
  });

  it("stops emitting after interrupt", async () => {
    const adapter = new FakeAdapter([
      { kind: "message", to: "all", text: "one" },
      { kind: "message", to: "all", text: "two" },
      { kind: "done", summary: "done" },
    ]);
    const out: AgentEvent[] = [];
    const p = adapter.startTask({ goal: "g", role: "coder", agentId: "coder#1" }, (e) => {
      out.push(e);
      if (out.length === 1) adapter.interrupt();
    });
    await p;
    expect(out.length).toBe(1);
  });
});
