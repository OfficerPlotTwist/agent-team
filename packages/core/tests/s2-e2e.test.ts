import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MessageBus, Scheduler, WorktreeManager, IntegrationCoordinator,
  NoopContextProvider, TaskGraph, ActionBroker, PolicyStore,
  type TaskNode, type ActionRequestEvent,
} from "../src/index.js";
import { WritingAdapter } from "./helpers/writing-adapter.js";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";

afterEach(async () => { await cleanupRepos(); });

const node = (id: string, dependsOn: string[] = []): TaskNode => ({ id, role: "coder", goal: id, dependsOn });

describe("S2 end-to-end", () => {
  it("runs a parallel DAG to completion through the public API", async () => {
    const { dir, git } = await makeTempRepo();
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);
    const graph = new TaskGraph([node("setup"), node("api", ["setup"]), node("ui", ["setup"])]);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });

    const result = await sched.run((n) => new WritingAdapter({ [`${n.id}.txt`]: n.id }));

    expect(result.status).toBe("complete");
    expect(result.blocked).toEqual([]);
    const intgPath = `${dir}/.worktrees/integration`;
    for (const id of ["setup", "api", "ui"]) {
      expect(await readFile(join(intgPath, `${id}.txt`), "utf8")).toBe(id);
    }
  });

  it("a conflicting pair surfaces a merge_conflict request the broker routes to lead", async () => {
    const { dir, git } = await makeTempRepo();
    const bus = new MessageBus();
    const wm = new WorktreeManager(git, dir, new NoopContextProvider());
    const coord = new IntegrationCoordinator(git, wm, bus, dir);

    const policy = new PolicyStore();
    policy.applyPreset("pair");
    const routed: Array<{ id: string; to: string }> = [];
    const broker = new ActionBroker(policy, {
      gate: () => {},
      route: (req, _from, to) => routed.push({ id: req.requestId, to }),
      notify: () => {},
    });
    bus.subscribe((e) => { if (e.kind === "action_request") broker.handle(e as ActionRequestEvent); });

    const graph = new TaskGraph([node("x"), node("y")]);
    const sched = new Scheduler({ bus, budget: { maxTurns: 1000 }, graph, worktrees: wm, integration: coord, baseRef: "main" });
    const result = await sched.run((n) => new WritingAdapter({ "shared.txt": `${n.id}\n` }));

    expect(result.completed).toHaveLength(1);
    expect(result.blocked).toHaveLength(1);
    expect(routed).toHaveLength(1);
    expect(routed[0].to).toBe("lead");
  });
});
