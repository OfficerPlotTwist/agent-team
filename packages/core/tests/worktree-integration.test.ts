import { describe, it, expect, afterEach } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorktreeManager } from "../src/worktree.js";
import type { ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

const coder = (id: string): TaskNode => ({ id, role: "coder", goal: id, dependsOn: [] });
const noop: ContextProvider = { async hydrate() {} };

async function commitFile(git: { run: (a: string[], c: string) => Promise<unknown> }, wtPath: string, file: string, body: string) {
  await writeFile(join(wtPath, file), body);
  await git.run(["add", file], wtPath);
  await git.run(["commit", "-m", `add ${file}`], wtPath);
}

describe("WorktreeManager merge (real git)", () => {
  it("merges two branches that touch different files cleanly", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);

    const a = await wm.create(coder("a"), "main");
    const b = await wm.create(coder("b"), "main");
    await commitFile(git, a.path, "a.txt", "from a\n");
    await commitFile(git, b.path, "b.txt", "from b\n");

    const intg = await wm.create(coder("intg"), "main");
    expect(await wm.merge(a.branch, intg.path)).toEqual({ ok: true });
    expect(await wm.merge(b.branch, intg.path)).toEqual({ ok: true });
    expect((await readFile(join(intg.path, "a.txt"), "utf8"))).toBe("from a\n");
    expect((await readFile(join(intg.path, "b.txt"), "utf8"))).toBe("from b\n");
  });

  it("reports conflicts when two branches edit the same line", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);
    const a = await wm.create(coder("a"), "main");
    const b = await wm.create(coder("b"), "main");
    await commitFile(git, a.path, "shared.txt", "alpha\n");
    await commitFile(git, b.path, "shared.txt", "beta\n");

    const intg = await wm.create(coder("intg"), "main");
    expect(await wm.merge(a.branch, intg.path)).toEqual({ ok: true });
    const result = await wm.merge(b.branch, intg.path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflicts).toContain("shared.txt");
  });

  it("aborts a conflicted merge so the worktree stays usable for the next merge", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);
    const a = await wm.create(coder("a"), "main");
    const b = await wm.create(coder("b"), "main");
    const c = await wm.create(coder("c"), "main");
    await commitFile(git, a.path, "shared.txt", "alpha\n");
    await commitFile(git, b.path, "shared.txt", "beta\n");      // conflicts with a
    await commitFile(git, c.path, "other.txt", "gamma\n");      // touches a different file

    const intg = await wm.create(coder("intg"), "main");
    expect(await wm.merge(a.branch, intg.path)).toEqual({ ok: true });
    expect((await wm.merge(b.branch, intg.path)).ok).toBe(false); // conflict + abort

    // If the conflicted merge was aborted, the worktree is clean and the next
    // unrelated merge succeeds (no lingering MERGE_HEAD, no empty-conflict cascade).
    const status = await git.run(["status", "--porcelain"], intg.path);
    expect((status as { stdout: string }).stdout.trim()).toBe("");
    expect(await wm.merge(c.branch, intg.path)).toEqual({ ok: true });
    expect((await readFile(join(intg.path, "other.txt"), "utf8"))).toBe("gamma\n");
  });

  it("hydrated context files are written, untracked, and not carried by a merge", async () => {
    const { dir, git } = await makeTempRepo();
    const fixture: ContextProvider = {
      async hydrate(_n, path) { await writeFile(join(path, "CONTEXT.md"), "ephemeral\n"); },
    };
    const wm = new WorktreeManager(git, dir, fixture);
    const a = await wm.create(coder("a"), "main");

    const status = await git.run(["status", "--porcelain", "--untracked-files=all"], a.path);
    expect((status as { stdout: string }).stdout).toContain("CONTEXT.md");

    await commitFile(git, a.path, "real.txt", "work\n");
    const intg = await wm.create(coder("intg"), "main");
    await wm.merge(a.branch, intg.path);
    const lsfiles = await git.run(["ls-files"], intg.path);
    expect((lsfiles as { stdout: string }).stdout).toContain("real.txt");
    expect((lsfiles as { stdout: string }).stdout).not.toContain("CONTEXT.md");
  });
});
