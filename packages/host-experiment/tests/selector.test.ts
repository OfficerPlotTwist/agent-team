import { describe, it, expect } from "vitest";
import { selectWinner } from "../src/selector.js";
import type { VariantMetrics } from "../src/report.js";

const m = (over: Partial<VariantMetrics>): VariantMetrics => ({
  variant: "v", nodeId: "t__v", status: "completed", costUsd: 0.01, turns: 1,
  wallMs: 0, filesChanged: 0, insertions: 0, deletions: 0, commits: 0,
  branch: "agentteam/coder-t__v", ...over,
});

describe("selectWinner", () => {
  it("picks the cheapest completed variant", () => {
    const w = selectWinner([
      m({ variant: "a", costUsd: 0.05 }),
      m({ variant: "b", costUsd: 0.01 }),
      m({ variant: "c", costUsd: 0.03 }),
    ]);
    expect(w?.variant).toBe("b");
  });

  it("never picks a failed variant, even if it would rank first on cost", () => {
    const w = selectWinner([
      m({ variant: "broke", status: "failed", costUsd: 0.0, error: "boom" }),
      m({ variant: "ok", status: "completed", costUsd: 0.02 }),
    ]);
    expect(w?.variant).toBe("ok");
  });

  it("returns null when every variant failed", () => {
    expect(
      selectWinner([m({ status: "failed", error: "x" }), m({ status: "failed", error: "y" })]),
    ).toBeNull();
  });
});
