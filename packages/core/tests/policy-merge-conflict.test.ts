import { describe, it, expect } from "vitest";
import { PolicyStore } from "../src/policy/store.js";
import { CATEGORIES } from "../src/policy/model.js";

describe("merge_conflict policy category", () => {
  it("is registered in CATEGORIES", () => {
    expect(CATEGORIES).toContain("merge_conflict");
  });

  it("routes a coder's conflict to the lead under the pair preset", () => {
    const store = new PolicyStore();
    store.applyPreset("pair");
    expect(store.get("coder", "merge_conflict")).toEqual({ mode: "ROUTE", route: "lead" });
  });

  it("keeps routing to lead under autopilot (stamp preserves ROUTE cells)", () => {
    const store = new PolicyStore();
    store.applyPreset("autopilot");
    expect(store.get("coder", "merge_conflict")).toEqual({ mode: "ROUTE", route: "lead" });
  });
});
