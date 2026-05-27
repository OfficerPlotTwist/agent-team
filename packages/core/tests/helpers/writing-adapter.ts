import type { AgentAdapter, TaskContext, Emit } from "../../src/adapter.js";
import { NodeGitRunner } from "../../src/node/git-runner.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Test adapter: writes `files` into the worktree (ctx.cwd), commits them with real
 * git, then emits `done`. Models a specialist that does real work in its worktree.
 */
export class WritingAdapter implements AgentAdapter {
  readonly backend = "writing-fake";
  private interrupted = false;
  private readonly git = new NodeGitRunner();

  constructor(private readonly files: Record<string, string>) {}

  async startTask(ctx: TaskContext, emit: Emit): Promise<void> {
    this.interrupted = false;
    if (!ctx.cwd) throw new Error("WritingAdapter requires ctx.cwd");
    for (const [name, body] of Object.entries(this.files)) {
      if (this.interrupted) return;
      await writeFile(join(ctx.cwd, name), body);
      await this.git.run(["add", name], ctx.cwd);
      await this.git.run(["commit", "-m", `${ctx.agentId}: add ${name}`], ctx.cwd);
    }
    if (this.interrupted) return;
    emit({ kind: "done", from: ctx.agentId, summary: `${ctx.agentId} done` });
  }

  interrupt(): void {
    this.interrupted = true;
  }
}
