import { describe, it, expect, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MessageBus } from "../src/bus.js";
import { WorktreeManager } from "../src/worktree.js";
import { IntegrationCoordinator } from "../src/integration.js";
import type { ContextProvider } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";
import type { ActionRequestEvent } from "../src/events.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

const coder = (id: string): TaskNode => ({ id, role: "coder", goal: id, dependsOn: [] });
const noop: ContextProvider = { async hydrate() {} };

async function commitFile(git: { run: (a: string[], c: string) => Promise<unknown> }, wtPath: string, file: string, body: string) {
  await writeFile(join(wtPath, file), body);
  await git.run(["add", file], wtPath);
  await git.run(["commit", "-m", `add ${file}`], wtPath);
}

describe("IntegrationCoordinator", () => {
  it("init creates the integration branch + worktree and tip() points at it", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);
    const coord = new IntegrationCoordinator(git, wm, new MessageBus(), dir);
    await coord.init("main");
    expect(coord.tip()).toBe("agentteam/integration");
    const branches = await git.run(["branch", "--list", "agentteam/integration"], dir);
    expect((branches as { stdout: string }).stdout).toContain("agentteam/integration");
  });

  it("integrate merges a clean branch and reports merged", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);
    const coord = new IntegrationCoordinator(git, wm, new MessageBus(), dir);
    await coord.init("main");
    const a = await wm.create(coder("a"), coord.tip());
    await commitFile(git, a.path, "a.txt", "from a\n");
    const outcome = await coord.integrate("coder#a", a.branch);
    expect(outcome.status).toBe("merged");
  });

  it("integrate publishes a merge_conflict action_request on conflict", async () => {
    const { dir, git } = await makeTempRepo();
    const wm = new WorktreeManager(git, dir, noop);
    const bus = new MessageBus();
    const requests: ActionRequestEvent[] = [];
    bus.subscribe((e) => { if (e.kind === "action_request") requests.push(e); });
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    await coord.init("main");

    const a = await wm.create(coder("a"), coord.tip());
    const b = await wm.create(coder("b"), coord.tip());
    await commitFile(git, a.path, "shared.txt", "alpha\n");
    await commitFile(git, b.path, "shared.txt", "beta\n");

    expect((await coord.integrate("coder#a", a.branch)).status).toBe("merged");
    const outcome = await coord.integrate("coder#b", b.branch);

    expect(outcome.status).toBe("conflict");
    expect(requests).toHaveLength(1);
    expect(requests[0].category).toBe("merge_conflict");
    expect(requests[0].from).toBe("coder#b");
    expect((requests[0].payload as { conflicts: string[] }).conflicts).toContain("shared.txt");
  });
});
