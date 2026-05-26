import { describe, it, expect, vi } from "vitest";
import { MessageBus } from "../src/bus.js";
import type { MessageEvent } from "../src/events.js";

function msg(from: string, to: string, text: string, causedBy?: number): MessageEvent {
  return { kind: "message", from, to, text, ...(causedBy !== undefined ? { causedBy } : {}) };
}

describe("MessageBus", () => {
  it("stamps monotonically increasing seq and a timestamp", () => {
    const bus = new MessageBus();
    const a = bus.publish(msg("lead#0", "all", "hi"));
    const b = bus.publish(msg("lead#0", "all", "again"));
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(typeof a.ts).toBe("number");
  });

  it("delivers every published event to subscribers", () => {
    const bus = new MessageBus();
    const seen: number[] = [];
    bus.subscribe((e) => seen.push(e.seq));
    bus.publish(msg("lead#0", "all", "one"));
    bus.publish(msg("lead#0", "all", "two"));
    expect(seen).toEqual([0, 1]);
  });

  it("unsubscribe stops delivery", () => {
    const bus = new MessageBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    bus.publish(msg("lead#0", "all", "one"));
    off();
    bus.publish(msg("lead#0", "all", "two"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("detects a causal cycle when a role recurs past the limit", () => {
    const bus = new MessageBus({ maxChainRepeats: 2 });
    const onCycle = vi.fn();
    bus.onCycle(onCycle);
    // coder -> reviewer -> coder -> reviewer -> coder (coder appears 3x)
    const e0 = bus.publish(msg("coder#1", "reviewer", "check this"));
    const e1 = bus.publish(msg("reviewer#1", "coder", "question", e0.seq));
    const e2 = bus.publish(msg("coder#1", "reviewer", "answer", e1.seq));
    const e3 = bus.publish(msg("reviewer#1", "coder", "another q", e2.seq));
    bus.publish(msg("coder#1", "reviewer", "answer2", e3.seq));
    expect(onCycle).toHaveBeenCalledTimes(1);
  });

  it("does not flag short chains as cycles", () => {
    const bus = new MessageBus({ maxChainRepeats: 2 });
    const onCycle = vi.fn();
    bus.onCycle(onCycle);
    const e0 = bus.publish(msg("coder#1", "reviewer", "check"));
    bus.publish(msg("reviewer#1", "coder", "ok", e0.seq));
    expect(onCycle).not.toHaveBeenCalled();
  });
});
