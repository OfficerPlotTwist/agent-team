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
 * Lists / diffs / accepts / rejects the proposal branches S4 ambient agents
 * stage. Pure: depends only on the GitRunner port (+ repoRoot), so it carries
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

  private async resolveReviewedSha(sha7: string): Promise<string> {
    return (await this.git.run(["rev-parse", sha7], this.repoRoot)).stdout.trim();
  }

  private async commitCount(reviewedSha: string, branch: string): Promise<number> {
    const r = await this.git.run(["rev-list", "--count", `${reviewedSha}..${branch}`], this.repoRoot);
    return Number(r.stdout.trim()) || 0;
  }
}
