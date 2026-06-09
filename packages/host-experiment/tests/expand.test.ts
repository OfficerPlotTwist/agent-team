import { describe, it, expect } from "vitest";
import { expandTask } from "../src/expand.js";
import type { Variant } from "../src/variant.js";

const variants: Variant[] = [
  { name: "cheap", model: "claude-haiku-4-5-20251001" },
  { name: "thorough", model: "claude-opus-4-8" },
];

describe("expandTask", () => {
  it("creates one dependency-free sibling node per variant", () => {
    const { graph, variantByNodeId } = expandTask(
      { taskId: "fizzbuzz", role: "coder", goal: "write fizzbuzz" },
      variants,
    );
    expect(graph.ids().sort()).toEqual(["fizzbuzz__cheap", "fizzbuzz__thorough"]);
    const n = graph.get("fizzbuzz__cheap")!;
    expect(n.role).toBe("coder");
    expect(n.goal).toBe("write fizzbuzz");
    expect(n.dependsOn).toEqual([]);
    expect(variantByNodeId.get("fizzbuzz__thorough")!.model).toBe("claude-opus-4-8");
  });

  it("all nodes are ready at once (one parallel wave)", () => {
    const { graph } = expandTask({ taskId: "t", role: "coder", goal: "g" }, variants);
    expect(graph.ready().map((n) => n.id).sort()).toEqual(["t__cheap", "t__thorough"]);
  });

  it("rejects duplicate variant names", () => {
    expect(() =>
      expandTask({ taskId: "t", role: "coder", goal: "g" }, [
        { name: "dup", model: "m" },
        { name: "dup", model: "m2" },
      ]),
    ).toThrow(/duplicate/i);
  });

  it("rejects non-git-safe variant names", () => {
    expect(() =>
      expandTask({ taskId: "t", role: "coder", goal: "g" }, [{ name: "bad:name", model: "m" }]),
    ).toThrow();
  });

  it("requires at least one variant", () => {
    expect(() => expandTask({ taskId: "t", role: "coder", goal: "g" }, [])).toThrow(/at least one/i);
  });
});
