import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "../../src/node/git-runner.js";

const created: string[] = [];

/** Create an isolated temp git repo with one initial commit. Returns dir + a runner. */
export async function makeTempRepo(): Promise<{ dir: string; git: NodeGitRunner }> {
  const dir = (await mkdtemp(join(tmpdir(), "agentteam-"))).split("\\").join("/");
  created.push(dir);
  const git = new NodeGitRunner();
  await git.run(["init", "-b", "main"], dir);
  await git.run(["config", "user.email", "test@example.com"], dir);
  await git.run(["config", "user.name", "Test"], dir);
  await git.run(["config", "core.autocrlf", "false"], dir);
  await git.run(["commit", "--allow-empty", "-m", "init"], dir);
  return { dir, git };
}

/** Remove every temp repo created in this test run. */
export async function cleanupRepos(): Promise<void> {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
}
