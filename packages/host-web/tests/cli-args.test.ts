import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli-args.js";

describe("parseArgs (agent-team-web)", () => {
  it("requires --graph", () => {
    expect(() => parseArgs([])).toThrow("--graph");
  });

  it("applies defaults", () => {
    const a = parseArgs(["--graph", "g.json"]);
    expect(a).toMatchObject({ graph: "g.json", port: 7340, model: "claude-opus-4-8", maxTurns: 50 });
    expect(a.repo).toBe(process.cwd());
    expect(a.costCeiling).toBeUndefined();
    expect(a.memory).toBeUndefined();
  });

  it("parses every flag", () => {
    const a = parseArgs([
      "--graph", "g.json", "--repo", "/r", "--port", "8080",
      "--model", "m", "--max-turns", "9", "--cost-ceiling", "1.25", "--memory", "mem.db",
    ]);
    expect(a).toEqual({
      graph: "g.json", repo: "/r", port: 8080,
      model: "m", maxTurns: 9, costCeiling: 1.25, memory: "mem.db",
    });
  });
});
