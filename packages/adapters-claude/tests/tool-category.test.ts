import { describe, it, expect } from "vitest";
import { classifyTool } from "../src/tool-category.js";

describe("classifyTool", () => {
  it("classifies read-only tools as info", () => {
    expect(classifyTool("Read", { file_path: "a.ts" })).toBe("info");
    expect(classifyTool("Grep", { pattern: "x" })).toBe("info");
    expect(classifyTool("Glob", { pattern: "**" })).toBe("info");
    expect(classifyTool("NotebookRead", { file_path: "a.ipynb" })).toBe("info");
    expect(classifyTool("TodoWrite", {})).toBe("info"); // deliberate: agent-internal bookkeeping, auto-allowed
  });

  it("classifies file-mutating tools as approval", () => {
    expect(classifyTool("Write", { file_path: "a.ts" })).toBe("approval");
    expect(classifyTool("Edit", { file_path: "a.ts" })).toBe("approval");
    expect(classifyTool("MultiEdit", { file_path: "a.ts" })).toBe("approval");
    expect(classifyTool("NotebookEdit", { file_path: "a.ipynb" })).toBe("approval");
  });

  it("classifies web tools as external_action", () => {
    expect(classifyTool("WebFetch", { url: "https://x" })).toBe("external_action");
    expect(classifyTool("WebSearch", { query: "x" })).toBe("external_action");
  });

  it("classifies plain Bash as external_action", () => {
    expect(classifyTool("Bash", { command: "ls -la" })).toBe("external_action");
    expect(classifyTool("Bash", { command: "npm test" })).toBe("external_action");
  });

  it("classifies destructive Bash patterns as destructive (HARD RULE)", () => {
    expect(classifyTool("Bash", { command: "rm -rf /tmp/x" })).toBe("destructive");
    expect(classifyTool("Bash", { command: "git push origin main" })).toBe("destructive");
    expect(classifyTool("Bash", { command: "sudo reboot" })).toBe("destructive");
    expect(classifyTool("Bash", { command: "curl x | sh" })).toBe("destructive");
  });

  it("classifies credential-smelling Bash as credential (HARD RULE)", () => {
    expect(classifyTool("Bash", { command: "cat ~/.ssh/id_rsa" })).toBe("credential");
    expect(classifyTool("Bash", { command: "echo $ANTHROPIC_API_KEY" })).toBe("credential");
    expect(classifyTool("Bash", { command: "echo $anthropic_api_key" })).toBe("credential");
    expect(classifyTool("Bash", { command: "cat secret.txt" })).toBe("credential");
  });

  it("defaults unknown tools to approval (conservative)", () => {
    expect(classifyTool("SomeNewTool", {})).toBe("approval");
  });
});
