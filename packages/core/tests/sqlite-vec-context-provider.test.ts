import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteVecContextProvider } from "../src/node/sqlite-vec-context-provider.js";
import { HashEmbedder } from "../src/embedder.js";
import type { TaskNode } from "../src/task-graph.js";

const node = (goal: string): TaskNode => ({ id: "qnode", role: "coder", goal, dependsOn: [] });

describe("SqliteVecContextProvider (offline)", () => {
  let dir: string;
  let dbPath: string;
  let wt: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "s5-mem-")).split("\\").join("/");
    dbPath = join(dir, "memory.db");
    wt = join(dir, "wt");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records decisions and hydrates the closest as a gitignored file", async () => {
    const p = new SqliteVecContextProvider({ dbPath, embedder: new HashEmbedder(256), k: 1 });
    await p.record({ id: "auth1", role: "coder", goal: "implement user login authentication", summary: "added JWT bearer token session validation", createdAt: "2026-06-01T00:00:00Z" });
    await p.record({ id: "css1", role: "coder", goal: "redesign marketing homepage layout", summary: "switched hero section to flexbox grid spacing", createdAt: "2026-06-01T00:01:00Z" });

    await p.hydrate(node("fix the user login authentication session bug"), wt);

    const authFile = join(wt, ".agent-team", "memory-auth1.md");
    const cssFile = join(wt, ".agent-team", "memory-css1.md");
    expect(existsSync(authFile)).toBe(true);
    expect(readFileSync(authFile, "utf8")).toContain("added JWT bearer token session validation");
    // k=1 ⇒ only the closest hit is written, not the unrelated css decision.
    expect(existsSync(cssFile)).toBe(false);
    p.close();
  });

  it("empty store ⇒ hydrate writes nothing", async () => {
    const p = new SqliteVecContextProvider({ dbPath, embedder: new HashEmbedder(64) });
    await p.hydrate(node("anything"), wt);
    expect(existsSync(join(wt, ".agent-team"))).toBe(false);
    p.close();
  });
});
