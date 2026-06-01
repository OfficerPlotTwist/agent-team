import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { GitRunner, AmbientTrigger } from "@agent-team/core";

export type TriggerHandler = (trigger: AmbientTrigger) => void | Promise<void>;

/**
 * Watches `.git/logs/HEAD`; on movement, derives the new commit's changed-file
 * scope and emits an AmbientTrigger. Dedups by SHA and processes reactions
 * sequentially (one at a time). fs.watch wiring is in start(); the SHA→trigger
 * logic is in check(), driven directly by tests.
 */
export class CommitWatcher {
  private lastSha = "";
  private fsw?: FSWatcher;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly git: GitRunner,
    private readonly repoRoot: string,
    private readonly onTrigger: TriggerHandler,
  ) {}

  /** Record the current HEAD without firing — we react only to NEW commits. */
  async seed(): Promise<void> {
    this.lastSha = await this.headSha();
  }

  /** Begin watching. Call seed() first. */
  start(): void {
    const logPath = join(this.repoRoot, ".git", "logs", "HEAD");
    this.fsw = watch(logPath, () => {
      this.chain = this.chain.then(() => this.check()).catch(() => undefined);
    });
  }

  stop(): void {
    this.fsw?.close();
    this.fsw = undefined;
  }

  /** Read HEAD; if it moved to an unseen SHA, emit a trigger. */
  async check(): Promise<void> {
    const sha = await this.headSha();
    if (!sha || sha === this.lastSha) return;
    this.lastSha = sha;
    const scope = await this.changedFiles(sha);
    await this.onTrigger({ reason: "commit", commitSha: sha, scope });
  }

  private async headSha(): Promise<string> {
    const res = await this.git.run(["rev-parse", "HEAD"], this.repoRoot);
    return res.code === 0 ? res.stdout.trim() : "";
  }

  private async changedFiles(sha: string): Promise<string[]> {
    const res = await this.git.run(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
      this.repoRoot,
    );
    return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }
}
