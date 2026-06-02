import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import { ProposalCoordinator } from "../src/proposals.js";

const git = new NodeGitRunner();
async function run(args: string[], cwd: string) { return git.run(args, cwd); }

/** Make a repo with one commit on main, then stage a proposal branch
 *  agentteam/reviewer-<sha7> = reviewed commit + one improvement commit
 *  carrying an Ambient-Finding trailer. Returns { repo, sha7 }. */
async function makeRepoWithProposal(finding = "use a const enum"): Promise<{ repo: string; sha7: string }> {
  const repo = mkdtempSync(join(tmpdir(), "s6-")).split("\\").join("/");
  await run(["init", "-b", "main"], repo);
  await run(["config", "user.email", "t@t.com"], repo);
  await run(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
  await run(["add", "."], repo);
  await run(["commit", "-m", "feat: add x"], repo);
  const reviewedSha = (await run(["rev-parse", "HEAD"], repo)).stdout.trim();
  const sha7 = reviewedSha.slice(0, 7);
  const branch = `agentteam/reviewer-${sha7}`;
  // Stage the proposal branch from the reviewed commit with one improvement commit.
  await run(["branch", branch, reviewedSha], repo);
  await run(["switch", branch], repo);
  writeFileSync(join(repo, "app.ts"), "export const enum X { x = 2 }\n");
  await run(["commit", "-am", `reviewed x`, "--trailer", `Ambient-Finding: ${finding}`], repo);
  await run(["switch", "main"], repo);
  return { repo, sha7 };
}

describe("ProposalCoordinator list/diff/reject", () => {
  let repo: string;
  let sha7: string;
  beforeEach(async () => { ({ repo, sha7 } = await makeRepoWithProposal()); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("lists the proposal with sha7, commitCount, and finding", async () => {
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const proposals = await coord.list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].branch).toBe(`agentteam/reviewer-${sha7}`);
    expect(proposals[0].sha7).toBe(sha7);
    expect(proposals[0].commitCount).toBe(1);
    expect(proposals[0].finding).toBe("use a const enum");
    expect(proposals[0].reviewedSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("diff returns the reviewed-range diff", async () => {
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const d = await coord.diff(`agentteam/reviewer-${sha7}`);
    expect(d).toContain("const enum X");
    expect(d).toContain("app.ts");
  });

  it("reject deletes the branch", async () => {
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    await coord.reject(`agentteam/reviewer-${sha7}`);
    const after = await git.run(["rev-parse", "--verify", `agentteam/reviewer-${sha7}`], repo);
    expect(after.code).not.toBe(0); // branch gone
    expect(await coord.list()).toHaveLength(0);
  });

  it("list returns [] when there are no proposal branches", async () => {
    await git.run(["branch", "-D", `agentteam/reviewer-${sha7}`], repo);
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    expect(await coord.list()).toEqual([]);
  });
});
