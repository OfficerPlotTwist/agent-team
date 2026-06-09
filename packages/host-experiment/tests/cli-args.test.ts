import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli-args.js";

describe("parseArgs (agent-team-experiment)", () => {
  it("requires --task and --variants", () => {
    expect(() => parseArgs(["--variants", "v.json"])).toThrow("--task");
    expect(() => parseArgs(["--task", "g"])).toThrow("--variants");
  });

  it("applies defaults", () => {
    const a = parseArgs(["--task", "write fizzbuzz", "--variants", "v.json"]);
    expect(a).toMatchObject({
      task: "write fizzbuzz", variants: "v.json", taskId: "task",
      role: "coder", maxTurns: 50, model: "claude-opus-4-8",
    });
    expect(a.repo).toBe(process.cwd());
    expect(a.report).toMatch(/Book_Library/);
  });

  it("parses every flag", () => {
    const a = parseArgs([
      "--task", "g", "--task-id", "fizz", "--role", "reviewer",
      "--variants", "v.json", "--repo", "/r", "--report", "/out.md",
      "--max-turns", "9", "--model", "m",
    ]);
    expect(a).toEqual({
      task: "g", taskId: "fizz", role: "reviewer", variants: "v.json",
      repo: "/r", report: "/out.md", maxTurns: 9, model: "m",
    });
  });
});
