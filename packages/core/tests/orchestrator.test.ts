import { describe, it, expect } from "vitest";
import { Orchestrator } from "../src/orchestrator.js";
import { MessageBus } from "../src/bus.js";
import { FakeAdapter } from "../src/fake-adapter.js";

describe("Orchestrator", () => {
  it("terminates with status 'done' when the lead emits done", async () => {
    const bus = new MessageBus();
    const orch = new Orchestrator({ bus, budget: { maxTurns: 100 } });
    const result = await orch.run("ship it", [
      { role: "lead", adapter: new FakeAdapter([
        { kind: "message", to: "all", text: "plan" },
        { kind: "done", summary: "goal met" },
      ]) },
    ]);
    expect(result.status).toBe("done");
    expect(result.summary).toBe("goal met");
  });

  it("terminates with status 'budget' when maxTurns is hit before done", async () => {
    const bus = new MessageBus();
    const orch = new Orchestrator({ bus, budget: { maxTurns: 2 } });
    const result = await orch.run("ship it", [
      { role: "lead", adapter: new FakeAdapter([
        { kind: "message", to: "all", text: "1" },
        { kind: "message", to: "all", text: "2" },
        { kind: "message", to: "all", text: "3" },
        { kind: "done", summary: "should not reach" },
      ]) },
    ]);
    expect(result.status).toBe("budget");
  });

  it("publishes every specialist event onto the bus with stamped from", async () => {
    const bus = new MessageBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(`${e.from}:${e.kind}`));
    const orch = new Orchestrator({ bus, budget: { maxTurns: 100 } });
    await orch.run("g", [
      { role: "lead", adapter: new FakeAdapter([{ kind: "done", summary: "ok" }]) },
      { role: "coder", adapter: new FakeAdapter([{ kind: "message", to: "lead", text: "hi" }]) },
    ]);
    expect(seen).toContain("coder#1:message");
    expect(seen).toContain("lead#0:done");
  });

  it("terminates with status 'drained' when agents finish without a lead 'done'", async () => {
    const bus = new MessageBus();
    const orch = new Orchestrator({ bus, budget: { maxTurns: 100 } });
    const result = await orch.run("g", [
      { role: "coder", adapter: new FakeAdapter([{ kind: "message", to: "all", text: "did some work" }]) },
    ]);
    expect(result.status).toBe("drained");
  });
});
