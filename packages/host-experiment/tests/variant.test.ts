import { describe, it, expect } from "vitest";
import { variantNodeId, assertGitSafe } from "../src/variant.js";

describe("variant ids", () => {
  it("joins task and variant with __ (git-safe, never ':')", () => {
    expect(variantNodeId("fizzbuzz", "opus")).toBe("fizzbuzz__opus");
  });

  it("assertGitSafe accepts plain names", () => {
    expect(() => assertGitSafe("opus-4-8")).not.toThrow();
    expect(() => assertGitSafe("haiku_cheap")).not.toThrow();
  });

  it("assertGitSafe rejects names that break git ref rules", () => {
    for (const bad of ["has:colon", "has space", "..dots", "tilde~", "caret^", "q?", "star*", "", "-leading", "--", "_leading"]) {
      expect(() => assertGitSafe(bad), bad).toThrow();
    }
  });
});
