import { describe, it, expect } from "vitest";
import { roleOf, makeAgentId } from "../src/events.js";

describe("agent id helpers", () => {
  it("derives role from an agent id", () => {
    expect(roleOf("coder#1")).toBe("coder");
    expect(roleOf("lead#0")).toBe("lead");
  });

  it("builds an agent id from role + index", () => {
    expect(makeAgentId("reviewer", 2)).toBe("reviewer#2");
  });

  it("throws on a malformed id", () => {
    expect(() => roleOf("nonsense")).toThrow();
  });
});
