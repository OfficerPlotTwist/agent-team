import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import type { AmbientTrigger } from "@agent-team/core";
import { CommitWatcher } from "../src/commit-watcher.js";

describe("CommitWatcher", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s4-watch-"));
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "seed"], repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("does not fire for the seed commit present at seed()", async () => {
    const fired: AmbientTrigger[] = [];
    const w = new CommitWatcher(git, repo, (t) => fired.push(t));
    await w.seed();
    await w.check();
    expect(fired).toHaveLength(0);
  });

  it("fires once for a new commit with the correct changed-file scope", async () => {
    const fired: AmbientTrigger[] = [];
    const w = new CommitWatcher(git, repo, (t) => fired.push(t));
    await w.seed();

    writeFileSync(join(repo, "feature.ts"), "export const f = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "feat: feature"], repo);

    await w.check();
    expect(fired).toHaveLength(1);
    expect(fired[0].reason).toBe("commit");
    expect(fired[0].scope).toEqual(["feature.ts"]);
    expect(fired[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("dedups: a second check on the same HEAD does not re-fire", async () => {
    const fired: AmbientTrigger[] = [];
    const w = new CommitWatcher(git, repo, (t) => fired.push(t));
    await w.seed();
    writeFileSync(join(repo, "feature.ts"), "export const f = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "feat: feature"], repo);

    await w.check();
    await w.check();
    expect(fired).toHaveLength(1);
  });
});
