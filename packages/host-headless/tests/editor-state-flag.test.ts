import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskGraph } from "@agent-team/core";
import type { EditorState } from "@agent-team/core";
import { NodeGitRunner } from "@agent-team/core/node";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeHeadless } from "../src/compose.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("host-headless --editor-state (offline)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s3-editor-"));
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

  it("editorState reaches hydrate: .agent-team/editor-context.md lands in the worktree", async () => {
    let seenContext = "";
    const query: QueryFn = async function* ({ options }) {
      const cwd = options.cwd as string;
      // The provider wrote the context file before the adapter ran — read it here.
      try {
        seenContext = readFileSync(join(cwd, ".agent-team", "editor-context.md"), "utf8");
      } catch { /* absent */ }
      writeFileSync(join(cwd, "feature.txt"), "done\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01 });
    };

    const editorState: EditorState = {
      activeFile: "src/app.ts",
      cursor: { line: 7, col: 2 },
      selection: { start: { line: 7, col: 2 }, end: { line: 9, col: 0 } },
    };

    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "g", dependsOn: [] }]);
    const host = composeHeadless({
      repoRoot: repo, graph, query, model: "claude-test",
      maxTurns: 50, permTimeoutMs: 1000, editorState,
    });

    const result = await host.run();
    expect(result.status).toBe("complete");
    expect(seenContext).toContain("src/app.ts");
    expect(seenContext).toContain("7:2");
    expect(seenContext).toContain("9:0");
  });

  it("no editorState ⇒ no context file written (current behavior preserved)", async () => {
    let fileExisted = true;
    const query: QueryFn = async function* ({ options }) {
      const cwd = options.cwd as string;
      try {
        readFileSync(join(cwd, ".agent-team", "editor-context.md"), "utf8");
      } catch { fileExisted = false; }
      writeFileSync(join(cwd, "feature.txt"), "done\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01 });
    };
    const graph = new TaskGraph([{ id: "n1", role: "coder", goal: "g", dependsOn: [] }]);
    const host = composeHeadless({
      repoRoot: repo, graph, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000,
    });
    await host.run();
    expect(fileExisted).toBe(false);
  });
});
