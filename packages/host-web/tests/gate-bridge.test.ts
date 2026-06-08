import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GateBridge } from "../src/gate-bridge.js";
import type { UnstampedBroadcast } from "../src/ring-buffer.js";

describe("GateBridge", () => {
  let broadcasts: UnstampedBroadcast[];
  let bridge: GateBridge;

  beforeEach(() => {
    vi.useFakeTimers();
    broadcasts = [];
    bridge = new GateBridge({ broadcast: (e) => broadcasts.push(e), graceMs: 5000 });
    bridge.clientConnected(); // default: one client present
  });
  afterEach(() => vi.useRealTimers());

  const ask = () =>
    bridge.askGate({ requestId: "r1", category: "destructive", summary: "rm -rf ./x" });

  it("broadcasts the gate and resolves true on allow (+ gate_resolved)", async () => {
    const p = ask();
    expect(broadcasts[0]).toMatchObject({ type: "gate", requestId: "r1" });
    bridge.command({ type: "allow", requestId: "r1" });
    await expect(p).resolves.toBe(true);
    expect(broadcasts[1]).toMatchObject({ type: "gate_resolved", requestId: "r1", allowed: true });
  });

  it("resolves false on deny", async () => {
    const p = ask();
    bridge.command({ type: "deny", requestId: "r1" });
    await expect(p).resolves.toBe(false);
  });

  it("first command wins; the duplicate is ignored", async () => {
    const p = ask();
    bridge.command({ type: "deny", requestId: "r1" });
    bridge.command({ type: "allow", requestId: "r1" });
    await expect(p).resolves.toBe(false);
    expect(broadcasts.filter((b) => b.type === "gate_resolved")).toHaveLength(1);
  });

  it("fails closed: pending gate with zero clients denies after the grace window", async () => {
    const p = ask();
    bridge.clientDisconnected(); // 1 -> 0
    vi.advanceTimersByTime(5001);
    await expect(p).resolves.toBe(false);
    expect(broadcasts.at(-1)).toMatchObject({ type: "gate_resolved", requestId: "r1", allowed: false });
  });

  it("a reconnect within the grace window cancels the deny", async () => {
    const p = ask();
    bridge.clientDisconnected();
    vi.advanceTimersByTime(2000);
    bridge.clientConnected(); // back before grace expiry
    vi.advanceTimersByTime(10_000);
    expect(bridge.pendingCount()).toBe(1); // still pending, not denied
    bridge.command({ type: "allow", requestId: "r1" });
    await expect(p).resolves.toBe(true);
  });

  it("a gate asked while zero clients are connected arms the grace timer itself", async () => {
    bridge.clientDisconnected(); // 0 clients
    const p = ask();
    vi.advanceTimersByTime(5001);
    await expect(p).resolves.toBe(false);
  });

  const askWithTimeout = () =>
    bridge.askGate({ requestId: "r1", category: "destructive", summary: "rm -rf ./x", timeoutMs: 60_000 });

  it("self-denies and broadcasts gate_resolved at timeoutMs even with a client connected", async () => {
    // A client IS connected (beforeEach), so grace never arms — only the per-gate
    // timeout can resolve this. Mirrors the adapter's permTimeoutMs.
    const p = askWithTimeout();
    expect(bridge.pendingCount()).toBe(1);
    vi.advanceTimersByTime(60_001);
    await expect(p).resolves.toBe(false);
    expect(broadcasts.at(-1)).toMatchObject({ type: "gate_resolved", requestId: "r1", allowed: false });
    expect(bridge.pendingCount()).toBe(0);
  });

  it("a command after the per-gate timeout is ignored (single gate_resolved, deny stands)", async () => {
    const p = askWithTimeout();
    vi.advanceTimersByTime(60_001);
    await expect(p).resolves.toBe(false);
    bridge.command({ type: "allow", requestId: "r1" }); // late
    expect(broadcasts.filter((b) => b.type === "gate_resolved")).toHaveLength(1);
    expect(broadcasts.at(-1)).toMatchObject({ allowed: false });
  });

  it("an allow before the timeout cancels the self-deny timer (no later spurious deny)", async () => {
    const p = askWithTimeout();
    bridge.command({ type: "allow", requestId: "r1" });
    await expect(p).resolves.toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(broadcasts.filter((b) => b.type === "gate_resolved")).toHaveLength(1);
    expect(broadcasts.at(-1)).toMatchObject({ allowed: true });
  });
});
