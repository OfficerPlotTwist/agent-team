import type { GitRunner } from "./git.js";
import type { ContextProvider } from "./context-provider.js";
import type { TaskNode } from "./task-graph.js";

export interface Worktree {
  path: string;
  branch: string;
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[] };

export class WorktreeManager {
  constructor(
    private readonly git: GitRunner,
    private readonly repoRoot: string,
    private readonly context: ContextProvider,
  ) {}

  private name(node: TaskNode): string {
    return `${node.role}-${node.id}`;
  }

  private pathFor(node: TaskNode): string {
    return `${this.repoRoot}/.worktrees/${this.name(node)}`;
  }

  private branchFor(node: TaskNode): string {
    return `agentteam/${this.name(node)}`;
  }

  async create(node: TaskNode, base: string): Promise<Worktree> {
    const path = this.pathFor(node);
    const branch = this.branchFor(node);
    const res = await this.git.run(["worktree", "add", "-b", branch, path, base], this.repoRoot);
    if (res.code !== 0) throw new Error(`git worktree add failed: ${res.stderr.trim()}`);
    await this.context.hydrate(node, path);
    return { path, branch };
  }

  async remove(node: TaskNode): Promise<void> {
    await this.git.run(["worktree", "remove", "--force", this.pathFor(node)], this.repoRoot);
  }

  async pruneAll(): Promise<void> {
    await this.git.run(["worktree", "prune"], this.repoRoot);
  }

  async list(): Promise<string[]> {
    const res = await this.git.run(["worktree", "list", "--porcelain"], this.repoRoot);
    return res.stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  }

  /**
   * Merge `branch` into the branch already checked out in `intoWorktree`.
   * Runs in the integration worktree — never the user's checked-out tree.
   */
  async merge(branch: string, intoWorktree: string): Promise<MergeResult> {
    const res = await this.git.run(["merge", "--no-edit", branch], intoWorktree);
    if (res.code === 0) return { ok: true };
    const diff = await this.git.run(
      ["diff", "--name-only", "--diff-filter=U"],
      intoWorktree,
    );
    const conflicts = diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    return { ok: false, conflicts };
  }
}
