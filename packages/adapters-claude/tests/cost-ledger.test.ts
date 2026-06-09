import { describe, it, expect } from "vitest";
import { CostLedger } from "../src/cost-ledger.js";

describe("CostLedger", () => {
  it("accumulates cost and token usage per agent independently", () => {
    const l = new CostLedger();
    l.add("coder#a", 0.01);
    l.add("coder#a", 0.02);
    l.addUsage("coder#a", { tokensIn: 100, tokensOut: 20 });
    l.addUsage("coder#a", { tokensIn: 50, tokensOut: 5 });
    l.add("coder#b", 0.05);
    l.addUsage("coder#b", { tokensIn: 300, tokensOut: 60 });

    expect(l.total()).toBeCloseTo(0.08);
    expect(l.perAgent().get("coder#a")).toBeCloseTo(0.03);
    expect(l.usagePerAgent().get("coder#a")).toEqual({ tokensIn: 150, tokensOut: 25 });
    expect(l.usagePerAgent().get("coder#b")).toEqual({ tokensIn: 300, tokensOut: 60 });
  });

  it("usagePerAgent returns a defensive copy (mutating it does not corrupt the ledger)", () => {
    const l = new CostLedger();
    l.addUsage("coder#a", { tokensIn: 10, tokensOut: 2 });
    const snap = l.usagePerAgent();
    snap.get("coder#a")!.tokensIn = 999;
    expect(l.usagePerAgent().get("coder#a")!.tokensIn).toBe(10);
  });
});
