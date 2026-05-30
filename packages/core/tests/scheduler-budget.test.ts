import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
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

afterEach(async () => { await cleanupRepos(); });
const node = (id: string, dependsOn: string[] = []): TaskNode => ({ id, role: "coder", goal: id, dependsOn });

// Emits `chatter` message events BEFORE doing its committable work + done. With a
// per-node budget below `chatter`, it is interrupted (no done) -> blocked, WITHOUT
// affecting a well-behaved sibling. interrupt() makes it stop before done.
class ChattyAdapter implements AgentAdapter {
  readonly backend = "chatty";
  private interrupted = false;
  private git = new NodeGitRunner();
  constructor(private chatter: number, private file: string) {}
  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.interrupted = false;
    for (let i = 0; i < this.chatter; i++) {
      if (this.interrupted) return;
      emit({ kind: "message", from: ctx.agentId, to: "all", text: `tick ${i}` });
      await new Promise((r) => setTimeout(r, 5)); // let the bus + interrupt land
    }
    if (this.interrupted) return;
    await writeFile(join(ctx.cwd as string, this.file), "C");
    await this.git.run(["add", this.file], ctx.cwd as string);
    await this.git.run(["commit", "-m", "chatty"], ctx.cwd as string);
    emit({ kind: "done", from: ctx.agentId, summary: "chatty done" });
  }
  interrupt(): void { this.interrupted = true; }
}

describe("Scheduler per-node turn budget", () => {
  it("interrupts only the node that exceeds its own budget; a healthy sibling completes", async () => {
    const { dir, git } = await makeTempRepo();
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const graph = new TaskGraph([node("chatty"), node("calm")]); // independent => parallel
    // maxTurns 5: "chatty" emits 50 messages (exceeds 5) -> interrupted -> blocked.
    // "calm" emits only its single `done` (1 event) -> completes.
    const sched = new Scheduler({ bus, budget: { maxTurns: 5 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) =>
      n.id === "chatty" ? new ChattyAdapter(50, "chatty.txt") : new WritingAdapter({ "calm.txt": "calm" }),
    );

    expect(result.completed).toContain("calm");      // sibling unaffected by chatty's events
    expect(result.completed).not.toContain("chatty");
    expect(result.blocked).toContain("chatty");
    expect(result.status).toBe("budget");
    const intg = `${dir}/.worktrees/integration`;
    expect(existsSync(join(intg, "calm.txt"))).toBe(true);
    expect(existsSync(join(intg, "chatty.txt"))).toBe(false);
  });
});
