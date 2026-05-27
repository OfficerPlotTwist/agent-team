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

describe("TaskGraph scheduling", () => {
  it("ready() returns only nodes whose deps are all complete and not started", () => {
    const g = new TaskGraph([n("a"), n("b"), n("c", ["a", "b"])]);
    expect(g.ready().map((x) => x.id).sort()).toEqual(["a", "b"]);
    g.start("a");
    expect(g.ready().map((x) => x.id)).toEqual(["b"]);
    g.complete("a");
    g.start("b");
    g.complete("b");
    expect(g.ready().map((x) => x.id)).toEqual(["c"]);
  });

  it("isDone() is true only once every node is complete", () => {
    const g = new TaskGraph([n("a"), n("b", ["a"])]);
    expect(g.isDone()).toBe(false);
    g.complete("a");
    expect(g.isDone()).toBe(false);
    g.complete("b");
    expect(g.isDone()).toBe(true);
  });

  it("topologicalOrder() lists every dependency before its dependents", () => {
    const g = new TaskGraph([n("d", ["b", "c"]), n("b", ["a"]), n("c", ["a"]), n("a")]);
    const order = g.topologicalOrder().map((x) => x.id);
    const pos = (id: string) => order.indexOf(id);
    expect(order).toHaveLength(4);
    expect(pos("a")).toBeLessThan(pos("b"));
    expect(pos("a")).toBeLessThan(pos("c"));
    expect(pos("b")).toBeLessThan(pos("d"));
    expect(pos("c")).toBeLessThan(pos("d"));
  });

  it("ids() and completedIds() expose run state", () => {
    const g = new TaskGraph([n("a"), n("b")]);
    expect(g.ids().sort()).toEqual(["a", "b"]);
    g.complete("a");
    expect(g.completedIds()).toEqual(["a"]);
  });

  it("start()/complete() reject unknown ids", () => {
    const g = new TaskGraph([n("a")]);
    expect(() => g.start("x")).toThrow(/unknown/i);
    expect(() => g.complete("x")).toThrow(/unknown/i);
  });
});

describe("TaskGraph write-ownership", () => {
  it("normalizes a node's declared writes at construction", () => {
    const g = new TaskGraph([
      { id: "a", role: "coder", goal: "do a", dependsOn: [], writes: ["src\\a.ts", "./src/b.ts"] },
    ]);
    expect(g.ready()[0].writes).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("defaults writes to [] when omitted", () => {
    const g = new TaskGraph([{ id: "a", role: "coder", goal: "do a", dependsOn: [] }]);
    expect(g.ready()[0].writes).toEqual([]);
  });

  it("throws when a writes path escapes the repo root", () => {
    expect(
      () => new TaskGraph([{ id: "a", role: "coder", goal: "do a", dependsOn: [], writes: ["../../etc/passwd"] }]),
    ).toThrow(/escapes repo root/i);
  });
});
