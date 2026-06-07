import { describe, it, expect } from "vitest";
import { RingBuffer } from "../src/ring-buffer.js";
import type { BusEvent } from "@agent-team/core";

const evt = (text: string) =>
  ({ type: "event", payload: { kind: "message", from: "lead#1", text } as BusEvent }) as const;

describe("RingBuffer", () => {
  it("stamps monotonically increasing seqs starting at 1", () => {
    const ring = new RingBuffer(10);
    expect(ring.stamp(evt("a")).seq).toBe(1);
    expect(ring.stamp(evt("b")).seq).toBe(2);
    expect(ring.latestSeq()).toBe(2);
  });

  it("after(n) returns only envelopes with seq > n, in order", () => {
    const ring = new RingBuffer(10);
    ring.stamp(evt("a")); ring.stamp(evt("b")); ring.stamp(evt("c"));
    const { items, gapped } = ring.after(1);
    expect(items.map((e) => e.seq)).toEqual([2, 3]);
    expect(gapped).toBe(false);
  });

  it("overflow drops oldest and reports gapped for dropped ranges", () => {
    const ring = new RingBuffer(3);
    for (const t of ["a", "b", "c", "d", "e"]) ring.stamp(evt(t)); // seqs 1..5, buffer holds 3..5
    const dropped = ring.after(0);
    expect(dropped.items.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(dropped.gapped).toBe(true);
    const intact = ring.after(2);
    expect(intact.items.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(intact.gapped).toBe(false);
  });

  it("up-to-date and fresh-buffer resumes are empty and not gapped", () => {
    const ring = new RingBuffer(3);
    expect(ring.after(0)).toEqual({ items: [], gapped: false });
    ring.stamp(evt("a"));
    expect(ring.after(1)).toEqual({ items: [], gapped: false });
  });
});
