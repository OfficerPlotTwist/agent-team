import { describe, it, expect, vi } from "vitest";
import { ActionBroker } from "../src/broker.js";
import { PolicyStore } from "../src/policy/store.js";
import type { ActionRequestEvent } from "../src/events.js";

function req(from: string, category: ActionRequestEvent["category"]): ActionRequestEvent {
  return { kind: "action_request", from, requestId: "r1", category, summary: "do it", timeoutMs: 1000 };
}

function makeBroker() {
  const store = new PolicyStore();
  store.applyPreset("pair");
  const gate = vi.fn();
  const route = vi.fn();
  const notify = vi.fn();
  const broker = new ActionBroker(store, { gate, route, notify });
  return { broker, gate, route, notify };
}

describe("ActionBroker", () => {
  it("routes a coder approval request to the reviewer", () => {
    const { broker, route } = makeBroker();
    const res = broker.handle(req("coder#1", "approval"));
    expect(res).toEqual({ mode: "ROUTE", route: "reviewer", requestId: "r1" });
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r1" }), "coder#1", "reviewer");
  });

  it("gates a coder destructive request (hard rule)", () => {
    const { broker, gate } = makeBroker();
    const res = broker.handle(req("coder#1", "destructive"));
    expect(res.mode).toBe("GATE");
    expect(gate).toHaveBeenCalledOnce();
  });

  it("notifies on an ops external_action", () => {
    const { broker, notify } = makeBroker();
    const res = broker.handle(req("ops#1", "external_action"));
    expect(res.mode).toBe("NOTIFY");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("AUTO performs no side effect", () => {
    const { broker, gate, route, notify } = makeBroker();
    const res = broker.handle(req("lead#0", "info"));
    expect(res.mode).toBe("AUTO");
    expect(gate).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
