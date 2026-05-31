import { describe, it, expect } from "vitest";
import { NoopContextProvider, type ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";
import type { ContextEnvelope } from "../src/context-envelope.js";

const node: TaskNode = { id: "a", role: "coder", goal: "x", dependsOn: [] };

describe("NoopContextProvider", () => {
  it("hydrate resolves without writing anything (no envelope)", async () => {
    const cp: ContextProvider = new NoopContextProvider();
    await expect(cp.hydrate(node, "/tmp/whatever")).resolves.toBeUndefined();
  });

  it("hydrate resolves with an envelope + modality (still no-op)", async () => {
    const cp: ContextProvider = new NoopContextProvider();
    const env: ContextEnvelope = { editor: { cursor: { line: 0, col: 0 } } };
    await expect(cp.hydrate(node, "/tmp/whatever", env, "text")).resolves.toBeUndefined();
  });
});
