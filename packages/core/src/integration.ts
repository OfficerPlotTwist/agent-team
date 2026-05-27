import type { GitRunner } from "./git.js";
import type { MessageBus } from "./bus.js";
import type { WorktreeManager } from "./worktree.js";
import type { AgentId } from "./events.js";

export type IntegrationOutcome =
  | { status: "merged" }
  | { status: "conflict"; requestId: string; conflicts: string[] };

export class IntegrationCoordinator {
  readonly branch = "agentteam/integration";
  private readonly worktreePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private reqSeq = 0;

  constructor(
    private readonly git: GitRunner,
    private readonly worktrees: WorktreeManager,
    private readonly bus: MessageBus,
    private readonly repoRoot: string,
  ) {
    this.worktreePath = `${repoRoot}/.worktrees/integration`;
  }

  /** Create the integration branch from `baseRef` and a dedicated worktree for it. */
  async init(baseRef: string): Promise<void> {
    const b = await this.git.run(["branch", "-f", this.branch, baseRef], this.repoRoot);
    if (b.code !== 0) throw new Error(`create integration branch failed: ${b.stderr.trim()}`);
    const w = await this.git.run(["worktree", "add", this.worktreePath, this.branch], this.repoRoot);
    if (w.code !== 0) throw new Error(`integration worktree add failed: ${w.stderr.trim()}`);
  }

  /** The ref new agent worktrees are cut from: the integration branch tip. */
  tip(): string {
    return this.branch;
  }

  /** Merge one agent branch into integration. Serialized via an internal queue. */
  integrate(authorId: AgentId, branch: string): Promise<IntegrationOutcome> {
    const run = this.queue.then(() => this.doMerge(authorId, branch));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doMerge(authorId: AgentId, branch: string): Promise<IntegrationOutcome> {
    const res = await this.worktrees.merge(branch, this.worktreePath);
    if (res.ok) return { status: "merged" };
    const requestId = `mc-${++this.reqSeq}`;
    this.bus.publish({
      kind: "action_request",
      from: authorId,
      requestId,
      category: "merge_conflict",
      summary: `Merge conflict integrating ${branch}`,
      payload: { branch, conflicts: res.conflicts },
      timeoutMs: 0,
    });
    return { status: "conflict", requestId, conflicts: res.conflicts };
  }
}
