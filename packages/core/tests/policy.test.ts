import { describe, it, expect } from "vitest";
import { PolicyStore } from "../src/policy/store.js";

describe("PolicyStore", () => {
  it("applies the Pair preset (coder approval routes to reviewer)", () => {
    const store = new PolicyStore();
    store.applyPreset("pair");
    expect(store.get("coder", "approval")).toEqual({ mode: "ROUTE", route: "reviewer" });
  });

  it("Pair preset routes coder external_action to ops but lets ops notify", () => {
    const store = new PolicyStore();
    store.applyPreset("pair");
    expect(store.get("coder", "external_action")).toEqual({ mode: "ROUTE", route: "ops" });
    expect(store.get("ops", "external_action")).toEqual({ mode: "NOTIFY" });
  });

  it("hard rule: credential + destructive stay GATE even on Autopilot", () => {
    const store = new PolicyStore();
    store.applyPreset("autopilot");
    expect(store.get("coder", "credential").mode).toBe("GATE");
    expect(store.get("coder", "destructive").mode).toBe("GATE");
  });

  it("setCell overrides a single cell but cannot un-GATE a hard-rule category unless forced", () => {
    const store = new PolicyStore();
    store.applyPreset("pair");
    store.setCell("coder", "destructive", { mode: "AUTO" });
    expect(store.get("coder", "destructive").mode).toBe("GATE"); // still gated
    store.setCell("coder", "destructive", { mode: "AUTO" }, { force: true });
    expect(store.get("coder", "destructive").mode).toBe("AUTO"); // forced through
  });
});
