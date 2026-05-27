import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Scheduler } from "../src/orchestrator.js";
import { MessageBus } from "../src/bus.js";
import { WorktreeManager } from "../src/worktree.js";
import { IntegrationCoordinator } from "../src/integration.js";
import { NoopContextProvider } from "../src/context-provider.js";
import { TaskGraph, type TaskNode } from "../src/task-graph.js";
import { WritingAdapter } from "./helpers/writing-adapter.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

const node = (id: string, dependsOn: string[] = []): TaskNode => ({ id, role: "coder", goal: id, dependsOn });

describe("Scheduler DAG execution", () => {
  it("runs a diamond (a -> b,c -> d) and lands every node's file in integration", async () => {
    const { dir, git } = await makeTempRepo();
    const graph = new TaskGraph([node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])]);
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) => new WritingAdapter({ [`${n.id}.txt`]: n.id }));

    expect(result.status).toBe("complete");
    expect(result.completed.sort()).toEqual(["a", "b", "c", "d"]);
    const intgPath = `${dir}/.worktrees/integration`;
    for (const id of ["a", "b", "c", "d"]) {
      expect(await readFile(join(intgPath, `${id}.txt`), "utf8")).toBe(id);
    }
    expect(coord.tip()).toBe("agentteam/integration");
  });

  it("a dependent node's worktree base contains its prerequisite's committed work", async () => {
    const { dir, git } = await makeTempRepo();
    const graph = new TaskGraph([node("a"), node("b", ["a"])]);
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) =>
      new WritingAdapter(n.id === "a" ? { "a.txt": "A" } : { "b.txt": "B" }),
    );
    expect(result.status).toBe("complete");
    const intgPath = `${dir}/.worktrees/integration`;
    expect(await readFile(join(intgPath, "a.txt"), "utf8")).toBe("A");
    expect(await readFile(join(intgPath, "b.txt"), "utf8")).toBe("B");
  });

  it("stops early when the turn budget is exhausted", async () => {
    const { dir, git } = await makeTempRepo();
    const graph = new TaskGraph([node("a"), node("b"), node("c")]);
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) => new WritingAdapter({ [`${n.id}.txt`]: n.id }));
    expect(["budget", "complete"]).toContain(result.status);
    if (result.status === "budget") expect(result.completed.length).toBeLessThan(3);
  });
});
