import { describe, it, expect, vi } from "vitest";
import {
  MessageBus, Orchestrator, ActionBroker, PolicyStore, DiffStore, FakeAdapter,
} from "../src/index.js";
import type { ActionRequestEvent, FileChangeEvent } from "../src/index.js";

describe("headless team integration", () => {
  it("runs a fake team: coder proposes a diff, requests approval (routed), lead finishes", async () => {
    const bus = new MessageBus();

    const policy = new PolicyStore();
    policy.applyPreset("pair");
    const route = vi.fn();
    const broker = new ActionBroker(policy, { gate: vi.fn(), route, notify: vi.fn() });

    const diffs = new DiffStore({ apply: vi.fn().mockResolvedValue(undefined) });

    // Wire the bus into broker + diff store.
    bus.subscribe((e) => {
      if (e.kind === "action_request") broker.handle(e as ActionRequestEvent);
      if (e.kind === "file_change") diffs.stage(e as FileChangeEvent);
    });

    const orch = new Orchestrator({ bus, budget: { maxTurns: 100 } });
    const result = await orch.run("add a function", [
      { role: "coder", adapter: new FakeAdapter([
        { kind: "file_change", proposalId: "p1", path: "src/x.ts", diff: "--- src/x.ts\n+++ src/x.ts\n" },
        { kind: "action_request", requestId: "r1", category: "approval", summary: "review my diff", timeoutMs: 1000 },
      ]) },
      { role: "lead", adapter: new FakeAdapter([
        { kind: "done", summary: "integrated" },
      ]) },
    ]);

    expect(result.status).toBe("done");
    expect(diffs.list("pending")).toHaveLength(1);
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r1" }), "coder#0", "reviewer");
  });
});
