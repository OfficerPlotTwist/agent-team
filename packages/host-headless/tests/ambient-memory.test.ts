import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import type { AmbientTrigger } from "@agent-team/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeAmbient } from "../src/compose-ambient.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

async function headSha(git: NodeGitRunner, repo: string): Promise<string> {
  return (await git.run(["rev-parse", "HEAD"], repo)).stdout.trim();
}

/** Read every hydrated memory file in the agent worktree's .agent-team dir. */
function readMemory(cwd: string): string {
  const dir = join(cwd, ".agent-team");
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith("memory-"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
  } catch {
    return "";
  }
}

describe("ambient findings → shared memory (offline)", () => {
  let repo: string;
  let dbDir: string;
  let dbPath: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s4mem-repo-")).split("\\").join("/");
    dbDir = mkdtempSync(join(tmpdir(), "s4mem-db-")).split("\\").join("/");
    dbPath = join(dbDir, "memory.db");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "feat: add x"], repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("records a reviewer finding that a later ambient reaction hydrates", async () => {
    // --- Reaction 1: reviewer finds something about app.ts ---
    const shaA = await headSha(git, repo);
    const q1: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "app.ts"), "export const x = 2; // reviewed\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "x should be a const enum for clarity", total_cost_usd: 0.01 });
    };
    const r1 = composeAmbient({
      repoRoot: repo, query: q1, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000, git, memoryDb: dbPath,
    });
    await r1.fire({ reason: "commit", commitSha: shaA, scope: ["app.ts"] });
    r1.close();

    // --- A second human commit touching the same file ---
    writeFileSync(join(repo, "app.ts"), "export const x = 3;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "chore: bump x"], repo);
    const shaB = await headSha(git, repo);

    // --- Reaction 2: its reviewer worktree should be hydrated with reaction 1's finding ---
    let seenMemory = "";
    const q2: QueryFn = async function* ({ options }) {
      seenMemory = readMemory(options.cwd as string);
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "looks fine", total_cost_usd: 0.01 });
    };
    const r2 = composeAmbient({
      repoRoot: repo, query: q2, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000, git, memoryDb: dbPath,
    });
    const trigger: AmbientTrigger = { reason: "commit", commitSha: shaB, scope: ["app.ts"] };
    await r2.fire(trigger);
    r2.close();

    expect(seenMemory).toContain("x should be a const enum for clarity"); // reaction 1's finding summary
    expect(seenMemory).toContain("reviewer"); // recorded under the reviewer role
  });

  it("memoryDb absent ⇒ no .agent-team memory files (today's behavior verbatim)", async () => {
    const sha = await headSha(git, repo);
    let seenMemory = "x";
    const q: QueryFn = async function* ({ options }) {
      seenMemory = readMemory(options.cwd as string);
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "looks fine", total_cost_usd: 0.01 });
    };
    const host = composeAmbient({
      repoRoot: repo, query: q, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000, git,
    });
    await host.fire({ reason: "commit", commitSha: sha, scope: ["app.ts"] });
    host.close();
    expect(seenMemory).toBe(""); // no provider ⇒ nothing hydrated
  });
});
