import { describe, it, expect } from "vitest";
import { CompositeContextProvider } from "../src/composite-context-provider.js";
import type { ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";

const node: TaskNode = { id: "n1", role: "coder", goal: "g", dependsOn: [] };

describe("CompositeContextProvider", () => {
  it("calls every provider's hydrate, in order, with the same args", async () => {
    const calls: string[] = [];
    const make = (tag: string): ContextProvider => ({
      async hydrate(n, wt) {
        calls.push(`${tag}:${n.id}:${wt}`);
      },
    });
    const composite = new CompositeContextProvider([make("A"), make("B")]);
    await composite.hydrate(node, "/tmp/wt");
    expect(calls).toEqual(["A:n1:/tmp/wt", "B:n1:/tmp/wt"]);
  });

  it("no providers ⇒ no-op", async () => {
    const composite = new CompositeContextProvider([]);
    await expect(composite.hydrate(node, "/tmp/wt")).resolves.toBeUndefined();
  });
});
