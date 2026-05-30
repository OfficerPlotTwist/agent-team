import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { Scheduler } from "../src/orchestrator.js";
import { MessageBus } from "../src/bus.js";
import { WorktreeManager } from "../src/worktree.js";
import { IntegrationCoordinator } from "../src/integration.js";
import { NoopContextProvider } from "../src/context-provider.js";
import { TaskGraph, type TaskNode } from "../src/task-graph.js";
import type { AgentAdapter, TaskContext, Emit } from "../src/adapter.js";
import { WritingAdapter } from "./helpers/writing-adapter.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";
import { NodeGitRunner } from "../src/node/git-runner.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

afterEach(async () => { await cleanupRepos(); });
const node = (id: string, dependsOn: string[] = []): TaskNode => ({ id, role: "coder", goal: id, dependsOn });

// Commits a file into the worktree but emits `error` instead of `done` — models a
// node that did partial work then failed/refused. Must NOT count as completed.
class NoDoneAdapter implements AgentAdapter {
  readonly backend = "no-done";
  private git = new NodeGitRunner();
  constructor(private file: string) {}
  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    await writeFile(join(ctx.cwd as string, this.file), "X");
    await this.git.run(["add", this.file], ctx.cwd as string);
    await this.git.run(["commit", "-m", "partial"], ctx.cwd as string);
    emit({ kind: "error", from: ctx.agentId, message: "refused" });
  }
  interrupt(): void {}
}

describe("Scheduler honest completion (gate on done)", () => {
  it("a node that does not emit done is blocked and its work is not merged", async () => {
    const { dir, git } = await makeTempRepo();
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const graph = new TaskGraph([node("ok"), node("bad")]);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) =>
      n.id === "ok" ? new WritingAdapter({ "ok.txt": "ok" }) : new NoDoneAdapter("bad.txt"),
    );

    expect(result.completed).toEqual(["ok"]);
    expect(result.blocked).toEqual(["bad"]);
    const intg = `${dir}/.worktrees/integration`;
    expect(existsSync(join(intg, "ok.txt"))).toBe(true);
    expect(existsSync(join(intg, "bad.txt"))).toBe(false); // partial work NOT merged
  });
});
