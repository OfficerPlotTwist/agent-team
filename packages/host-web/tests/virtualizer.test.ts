import { describe, it, expect } from "vitest";
import {
  makeGeometry, appendRows, resetRows, totalHeight, firstVisible, windowFor, isAtBottom,
} from "../ui/src/virtualizer.js";

describe("feed virtualizer math", () => {
  it("appendRows accumulates offsets with row padding", () => {
    const g = makeGeometry(6);
    appendRows(g, [20, 40, 20]);
    expect(g.offsets).toEqual([0, 26, 72, 98]);
    expect(totalHeight(g)).toBe(98);
  });

  it("firstVisible binary-searches the offset table", () => {
    const g = makeGeometry(0);
    appendRows(g, [10, 10, 10, 10]); // offsets 0,10,20,30,40
    expect(firstVisible(g, 0)).toBe(0);
    expect(firstVisible(g, 9.9)).toBe(0);
    expect(firstVisible(g, 10)).toBe(1);
    expect(firstVisible(g, 35)).toBe(3);
  });

  it("windowFor clamps overscan to the row range", () => {
    const g = makeGeometry(0);
    appendRows(g, Array.from({ length: 100 }, () => 10)); // 1000 tall
    const w = windowFor(g, 500, 100, 5);
    expect(w.i0).toBe(45); // firstVisible(500)=50, minus overscan
    expect(w.i1).toBeGreaterThanOrEqual(60); // covers viewport bottom + overscan
    expect(windowFor(g, 0, 100, 5).i0).toBe(0);
    expect(windowFor(g, 990, 100, 5).i1).toBe(99);
    expect(windowFor(makeGeometry(0), 0, 100).i1).toBe(-1); // empty feed
  });

  it("isAtBottom respects slack and resetRows rebuilds in place", () => {
    const g = makeGeometry(0);
    appendRows(g, [100, 100]);
    expect(isAtBottom(g, 100, 100)).toBe(true);
    expect(isAtBottom(g, 50, 100)).toBe(false);
    resetRows(g, [10, 10]);
    expect(g.offsets).toEqual([0, 10, 20]);
  });
});
