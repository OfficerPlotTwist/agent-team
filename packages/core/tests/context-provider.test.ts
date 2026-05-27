import { describe, it, expect } from "vitest";
import { NoopContextProvider, type ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";

const node: TaskNode = { id: "a", role: "coder", goal: "x", dependsOn: [] };

describe("NoopContextProvider", () => {
  it("hydrate resolves without writing anything", async () => {
    const cp: ContextProvider = new NoopContextProvider();
    await expect(cp.hydrate(node, "/tmp/whatever")).resolves.toBeUndefined();
  });
});
