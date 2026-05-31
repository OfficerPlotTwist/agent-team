import { describe, it, expect } from "vitest";
import { WorktreeManager } from "../src/worktree.js";
import type { GitRunner, GitResult } from "../src/git.js";
import type { ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";
import type { ContextEnvelope, ContextModality } from "../src/context-envelope.js";

class FakeGit implements GitRunner {
  calls: Array<{ args: string[]; cwd: string }> = [];
  result: GitResult = { code: 0, stdout: "", stderr: "" };
  async run(args: string[], cwd: string): Promise<GitResult> {
    this.calls.push({ args, cwd });
    return this.result;
  }
}

const node: TaskNode = { id: "build-api", role: "coder", goal: "x", dependsOn: [] };

describe("WorktreeManager create/remove/prune", () => {
  it("create adds a branch+worktree from base and then hydrates", async () => {
    const git = new FakeGit();
    const hydrated: string[] = [];
    const cp: ContextProvider = { async hydrate(_n, path) { hydrated.push(path); } };
    const wm = new WorktreeManager(git, "/repo", cp);

    const wt = await wm.create(node, "agentteam/integration");

    expect(wt.branch).toBe("agentteam/coder-build-api");
    expect(wt.path).toBe("/repo/.worktrees/coder-build-api");
    expect(git.calls[0].args).toEqual([
      "worktree", "add", "-b", "agentteam/coder-build-api",
      "/repo/.worktrees/coder-build-api", "agentteam/integration",
    ]);
    expect(git.calls[0].cwd).toBe("/repo");
    expect(hydrated).toEqual(["/repo/.worktrees/coder-build-api"]);
  });

  it("forwards the supplied envelope + modality to hydrate", async () => {
    const git = new FakeGit();
    const seen: Array<{ env?: ContextEnvelope; mod?: ContextModality }> = [];
    const cp: ContextProvider = {
      async hydrate(_n, _path, env, mod) { seen.push({ env, mod }); },
    };
    const envelope: ContextEnvelope = { editor: { cursor: { line: 2, col: 1 } } };
    const wm = new WorktreeManager(git, "/repo", cp, () => ({ envelope, modality: "text" }));

    await wm.create(node, "agentteam/integration");

    expect(seen).toEqual([{ env: envelope, mod: "text" }]);
  });

  it("passes undefined envelope/modality when no supplier is given", async () => {
    const git = new FakeGit();
    const seen: Array<{ env?: ContextEnvelope; mod?: ContextModality }> = [];
    const cp: ContextProvider = {
      async hydrate(_n, _path, env, mod) { seen.push({ env, mod }); },
    };
    const wm = new WorktreeManager(git, "/repo", cp);

    await wm.create(node, "agentteam/integration");

    expect(seen).toEqual([{ env: undefined, mod: undefined }]);
  });

  it("create throws if git worktree add fails", async () => {
    const git = new FakeGit();
    git.result = { code: 128, stdout: "", stderr: "fatal: already exists" };
    const wm = new WorktreeManager(git, "/repo", { async hydrate() {} });
    await expect(wm.create(node, "main")).rejects.toThrow(/already exists/);
  });

  it("remove force-removes the worktree dir", async () => {
    const git = new FakeGit();
    const wm = new WorktreeManager(git, "/repo", { async hydrate() {} });
    await wm.remove(node);
    expect(git.calls[0].args).toEqual([
      "worktree", "remove", "--force", "/repo/.worktrees/coder-build-api",
    ]);
  });

  it("pruneAll prunes stale registrations", async () => {
    const git = new FakeGit();
    const wm = new WorktreeManager(git, "/repo", { async hydrate() {} });
    await wm.pruneAll();
    expect(git.calls[0].args).toEqual(["worktree", "prune"]);
  });

  it("list returns the worktree paths from porcelain output", async () => {
    const git = new FakeGit();
    git.result = {
      code: 0,
      stdout: "worktree /repo\nHEAD abc\n\nworktree /repo/.worktrees/coder-build-api\nHEAD def\n",
      stderr: "",
    };
    const wm = new WorktreeManager(git, "/repo", { async hydrate() {} });
    expect(await wm.list()).toEqual(["/repo", "/repo/.worktrees/coder-build-api"]);
  });
});
