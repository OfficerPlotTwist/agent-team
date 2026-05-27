import { describe, it, expect } from "vitest";
import { TaskGraph, type TaskNode } from "../src/task-graph.js";

const n = (id: string, dependsOn: string[] = []): TaskNode => ({
  id, role: "coder", goal: `do ${id}`, dependsOn,
});

describe("TaskGraph construction", () => {
  it("accepts a valid acyclic graph", () => {
    expect(() => new TaskGraph([n("a"), n("b", ["a"])])).not.toThrow();
  });

  it("throws on a duplicate node id", () => {
    expect(() => new TaskGraph([n("a"), n("a")])).toThrow(/duplicate/i);
  });

  it("throws when a node depends on an unknown id", () => {
    expect(() => new TaskGraph([n("a", ["ghost"])])).toThrow(/unknown/i);
  });

  it("throws on a dependency cycle", () => {
    expect(() => new TaskGraph([n("a", ["b"]), n("b", ["a"])])).toThrow(/cycle/i);
  });

  it("throws on a self-dependency cycle", () => {
    expect(() => new TaskGraph([n("a", ["a"])])).toThrow(/cycle/i);
  });
});
