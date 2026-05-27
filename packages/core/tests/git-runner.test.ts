import { describe, it, expect, afterEach } from "vitest";
import { NodeGitRunner } from "../src/node/git-runner.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

describe("NodeGitRunner", () => {
  it("runs git and reports stdout + exit code 0 in a real repo", async () => {
    const { dir, git } = await makeTempRepo();
    const res = await git.run(["rev-parse", "--is-inside-work-tree"], dir);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("true");
  });

  it("reports a non-zero exit code and stderr on a failing command", async () => {
    const { dir, git } = await makeTempRepo();
    const res = await git.run(["checkout", "does-not-exist"], dir);
    expect(res.code).not.toBe(0);
    expect(res.stderr.length).toBeGreaterThan(0);
  });
});
