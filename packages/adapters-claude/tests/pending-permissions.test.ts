import { describe, it, expect } from "vitest";
import { PendingPermissions } from "../src/pending-permissions.js";

describe("PendingPermissions", () => {
  it("resolves a registered request with the given result", async () => {
    const pending = new PendingPermissions();
    const p = pending.register("r1", 1000);
    expect(pending.has("r1")).toBe(true);
    pending.resolve("r1", { behavior: "allow" });
    await expect(p).resolves.toEqual({ behavior: "allow" });
    expect(pending.has("r1")).toBe(false);
  });

  it("denies on timeout", async () => {
    const pending = new PendingPermissions();
    const p = pending.register("r2", 5);
    const result = await p;
    expect(result.behavior).toBe("deny");
    expect(pending.has("r2")).toBe(false);
  });

  it("resolves two concurrent requests independently (MULTI-AGENT seam)", async () => {
    const pending = new PendingPermissions();
    const p1 = pending.register("a-perm-0", 1000);
    const p2 = pending.register("b-perm-0", 1000);
    pending.resolve("b-perm-0", { behavior: "deny", message: "no" });
    pending.resolve("a-perm-0", { behavior: "allow" });
    await expect(p1).resolves.toEqual({ behavior: "allow" });
    await expect(p2).resolves.toEqual({ behavior: "deny", message: "no" });
  });

  it("resolve on an unknown id is a no-op (e.g. merge_conflict requests)", () => {
    const pending = new PendingPermissions();
    expect(() => pending.resolve("never-registered", { behavior: "allow" })).not.toThrow();
  });
});
