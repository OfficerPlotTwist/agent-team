import type { GitRunner } from "./git.js";

/** One staged ambient proposal, derived entirely from git. */
export interface AmbientProposal {
  branch: string;        // e.g. "agentteam/reviewer-1a2b3c4"
  sha7: string;          // reviewed commit short sha (the branch-name suffix)
  reviewedSha: string;   // full sha the branch was cut from
  finding: string;       // the Ambient-Finding trailer ("" if none)
  commitCount: number;   // commits on the branch beyond reviewedSha (0 = empty)
}

export type AcceptOutcome =
  | { status: "merged"; branch: string; onto: string }
  | { status: "conflict"; branch: string; onto: string; files: string[] }
  | { status: "nothing"; branch: string };

export interface ProposalCoordinatorOptions {
  git: GitRunner;
  repoRoot: string;
  prefix?: string;         // default "agentteam/reviewer-"
  findingTrailer?: string; // default "Ambient-Finding"
}

/**
 * Lists / diffs / rejects the proposal branches S4 ambient agents stage
 * (accept arrives in a later task). Pure: depends only on the GitRunner port
 * (+ repoRoot), so it carries
 * no node:* and is exported from the pure barrel beside IntegrationCoordinator.
 */
export class ProposalCoordinator {
  private readonly git: GitRunner;
  private readonly repoRoot: string;
  private readonly prefix: string;
  private readonly trailer: string;

  constructor(opts: ProposalCoordinatorOptions) {
    this.git = opts.git;
    this.repoRoot = opts.repoRoot;
    this.prefix = opts.prefix ?? "agentteam/reviewer-";
    this.trailer = opts.findingTrailer ?? "Ambient-Finding";
  }

  async list(): Promise<AmbientProposal[]> {
    const res = await this.git.run(
      ["for-each-ref", "--format=%(refname:short)", `refs/heads/${this.prefix}*`],
      this.repoRoot,
    );
    const branches = res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const out: AmbientProposal[] = [];
    for (const branch of branches) {
      const sha7 = branch.slice(this.prefix.length);
      const reviewedSha = await this.resolveReviewedSha(sha7);
      const commitCount = await this.commitCount(reviewedSha, branch);
      const finding = (
        await this.git.run(
          ["show", "-s", `--format=%(trailers:key=${this.trailer},valueonly)`, branch],
          this.repoRoot,
        )
      ).stdout.trim();
      out.push({ branch, sha7, reviewedSha, finding, commitCount });
    }
    return out;
  }

  async diff(branch: string): Promise<string> {
    const reviewedSha = await this.resolveReviewedSha(branch.slice(this.prefix.length));
    return (await this.git.run(["diff", `${reviewedSha}..${branch}`], this.repoRoot)).stdout;
  }

  async reject(branch: string): Promise<void> {
    await this.git.run(["branch", "-D", branch], this.repoRoot);
    await this.git.run(["worktree", "prune"], this.repoRoot);
  }

  async accept(branch: string, onto?: string): Promise<AcceptOutcome> {
    const current = (
      await this.git.run(["rev-parse", "--abbrev-ref", "HEAD"], this.repoRoot)
    ).stdout.trim();
    const target = onto ?? current;
    const reviewedSha = await this.resolveReviewedSha(branch.slice(this.prefix.length));
    if ((await this.commitCount(reviewedSha, branch)) === 0) {
      return { status: "nothing", branch };
    }

    if (target === current) {
      return this.mergeIn(this.repoRoot, branch, target);
    }

    // --onto path: merge inside a throwaway worktree so HEAD/working tree are untouched.
    const tmp = `${this.repoRoot}/.worktrees/proposal-accept-${branch.slice(this.prefix.length)}`;
    await this.git.run(["worktree", "add", "--force", tmp, target], this.repoRoot);
    try {
      return await this.mergeIn(tmp, branch, target);
    } finally {
      await this.git.run(["worktree", "remove", "--force", tmp], this.repoRoot);
    }
  }

  private async mergeIn(cwd: string, branch: string, onto: string): Promise<AcceptOutcome> {
    const m = await this.git.run(["merge", "--no-ff", branch], cwd);
    if (m.code === 0) return { status: "merged", branch, onto };
    const files = (
      await this.git.run(["diff", "--name-only", "--diff-filter=U"], cwd)
    ).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    await this.git.run(["merge", "--abort"], cwd);
    return { status: "conflict", branch, onto, files };
  }

  private async resolveReviewedSha(sha7: string): Promise<string> {
    // Throw on a failed rev-parse: an empty sha would silently degrade the
    // `<reviewedSha>..<branch>` ranges below to `HEAD..<branch>` (a wrong answer
    // with no error). A clear throw beats a misleading count/diff.
    const res = await this.git.run(["rev-parse", sha7], this.repoRoot);
    if (res.code !== 0) throw new Error(`rev-parse ${sha7} failed: ${res.stderr.trim()}`);
    return res.stdout.trim();
  }

  private async commitCount(reviewedSha: string, branch: string): Promise<number> {
    const r = await this.git.run(["rev-list", "--count", `${reviewedSha}..${branch}`], this.repoRoot);
    return Number(r.stdout.trim()) || 0;
  }
}
