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
import type { AgentAdapter } from "../src/adapter.js";
import { existsSync } from "node:fs";

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

  it("stop() promptly unblocks a run whose only node is hung", async () => {
    const { dir, git } = await makeTempRepo();
    const graph = new TaskGraph([node("a")]);
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    // Hangs until interrupted, then rejects — so the node fails rather than merges.
    class HangingAdapter implements AgentAdapter {
      readonly backend = "hang";
      private reject?: (e: unknown) => void;
      startTask(): Promise<void> {
        return new Promise<void>((_resolve, reject) => { this.reject = reject; });
      }
      interrupt(): void { this.reject?.(new Error("interrupted")); }
    }

    const runP = sched.run(() => new HangingAdapter());
    // Let the loop start the node and reach `await tick`, then stop it. Without
    // stop() waking the loop, `await tick` would never resolve and this hangs.
    await new Promise((r) => setTimeout(r, 50));
    sched.stop();
    const result = await runP;
    expect(result.status).toBe("stopped");
    expect(result.completed).toEqual([]);
  });

  it("removes the node's worktree even when the adapter throws", async () => {
    const { dir, git } = await makeTempRepo();
    const graph = new TaskGraph([node("boom")]);
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    class ThrowingAdapter implements AgentAdapter {
      readonly backend = "throw";
      async startTask(): Promise<void> { throw new Error("kaboom"); }
      interrupt(): void {}
    }

    const result = await sched.run(() => new ThrowingAdapter());
    expect(result.status).toBe("blocked");
    expect(result.blocked).toEqual(["boom"]);
    // The worktree was created before startTask threw; it must be cleaned up.
    expect(existsSync(`${dir}/.worktrees/coder-boom`)).toBe(false);
  });
});
