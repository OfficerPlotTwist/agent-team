import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskGraph } from "@agent-team/core";
import type { AgentEvent } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeHeadless } from "../src/compose.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("host-headless two-node integration (offline, multi-agent seam)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "b1-two-"));
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "README.md"), "# base\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "base"], repo);
    await git.run(["branch", "agentteam/integration"], repo);
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("runs two independent nodes: both merge clean, both costs aggregate, both agentIds appear", async () => {
    const query: QueryFn = async function* ({ prompt, options }) {
      const file = prompt.includes("alpha") ? "alpha.txt" : "beta.txt";
      yield asMsg({ type: "assistant", message: { content: [{ type: "text", text: `creating ${file}` }] } });
      writeFileSync(join(options.cwd as string, file), `${file}\n`);
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: `made ${file}`, total_cost_usd: 0.01 });
    };

    const graph = new TaskGraph([
      { id: "a", role: "coder", goal: "create alpha", dependsOn: [] },
      { id: "b", role: "architect", goal: "create beta", dependsOn: [] },
    ]);
    const host = composeHeadless({ repoRoot: repo, graph, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000 });

    const feed: AgentEvent[] = [];
    host.bus.subscribe((e) => feed.push(e));

    const result = await host.run();

    expect(result.status).toBe("complete");
    expect(result.completed.sort()).toEqual(["a", "b"]);

    expect(host.ledger.total()).toBeCloseTo(0.02);
    expect(host.ledger.perAgent().get("coder#a")).toBeCloseTo(0.01);
    expect(host.ledger.perAgent().get("architect#b")).toBeCloseTo(0.01);

    const froms = new Set(feed.map((e) => e.from));
    expect(froms.has("coder#a")).toBe(true);
    expect(froms.has("architect#b")).toBe(true);

    expect((await git.run(["show", "agentteam/integration:alpha.txt"], repo)).code).toBe(0);
    expect((await git.run(["show", "agentteam/integration:beta.txt"], repo)).code).toBe(0);
  });
});
