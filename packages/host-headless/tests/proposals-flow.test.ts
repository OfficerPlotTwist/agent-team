import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import { ProposalCoordinator } from "@agent-team/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeAmbient } from "../src/compose-ambient.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("proposals end-to-end (ambient stage → list → accept)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s6-flow-")).split("\\").join("/");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "feat: add x"], repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("an ambient reaction's proposal lists with its finding and accepts onto HEAD", async () => {
    const sha = (await git.run(["rev-parse", "HEAD"], repo)).stdout.trim();
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "app.ts"), "export const x = 2; // reviewed\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "tightened x", total_cost_usd: 0.01 });
    };
    const host = composeAmbient({ repoRoot: repo, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000 });
    await host.fire({ reason: "commit", commitSha: sha, scope: ["app.ts"] });

    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const proposals = await coord.list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].finding).toBe("tightened x");
    expect(proposals[0].commitCount).toBe(1);

    const before = (await git.run(["rev-parse", "main"], repo)).stdout.trim();
    const r = await coord.accept(proposals[0].branch);
    expect(r.status).toBe("merged");
    expect((await git.run(["rev-parse", "main"], repo)).stdout.trim()).not.toBe(before);
    expect((await git.run(["show", "main:app.ts"], repo)).stdout).toContain("reviewed");
  });
});
