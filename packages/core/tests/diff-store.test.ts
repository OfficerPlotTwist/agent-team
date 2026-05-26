import { describe, it, expect, vi } from "vitest";
import { DiffStore } from "../src/diff-store.js";
import type { FileChangeEvent } from "../src/events.js";

function change(proposalId: string, path: string): FileChangeEvent {
  return { kind: "file_change", from: "coder#1", proposalId, path, diff: `--- ${path}\n+++ ${path}\n` };
}

describe("DiffStore", () => {
  it("stages a proposal as pending", () => {
    const store = new DiffStore({ apply: vi.fn() });
    const p = store.stage(change("p1", "a.ts"));
    expect(p.status).toBe("pending");
    expect(store.list("pending")).toHaveLength(1);
  });

  it("approve applies via the applier and marks applied", async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    const store = new DiffStore({ apply });
    store.stage(change("p1", "a.ts"));
    const applied = await store.approve("p1");
    expect(apply).toHaveBeenCalledWith("a.ts", expect.stringContaining("a.ts"));
    expect(applied.status).toBe("applied");
    expect(store.list("pending")).toHaveLength(0);
  });

  it("reject marks rejected and never calls the applier", () => {
    const apply = vi.fn();
    const store = new DiffStore({ apply });
    store.stage(change("p1", "a.ts"));
    const rejected = store.reject("p1");
    expect(rejected.status).toBe("rejected");
    expect(apply).not.toHaveBeenCalled();
  });

  it("approve on an unknown id throws", async () => {
    const store = new DiffStore({ apply: vi.fn() });
    await expect(store.approve("nope")).rejects.toThrow();
  });
});
