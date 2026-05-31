import { describe, it, expect, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempRepo, cleanupRepos } from "./helpers/temp-repo.js";
import { TextContextProvider } from "../src/node/text-context-provider.js";
import { NotImplementedError } from "../src/context-provider.js";
import type { TaskNode } from "../src/task-graph.js";
import type { ContextEnvelope } from "../src/context-envelope.js";

const node: TaskNode = { id: "a", role: "coder", goal: "x", dependsOn: [] };
const CTX_PATH = ".agent-team/editor-context.md";

afterEach(async () => { await cleanupRepos(); });

it("writes editor-context.md describing active file, cursor L:C, and selection range", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  const env: ContextEnvelope = {
    editor: {
      activeFile: "src/app.ts",
      cursor: { line: 9, col: 4 },
      selection: { start: { line: 9, col: 4 }, end: { line: 11, col: 0 } },
    },
  };
  await cp.hydrate(node, dir, env, "text");
  const md = await readFile(join(dir, CTX_PATH), "utf8");
  expect(md).toContain("src/app.ts");
  expect(md).toContain("9:4");          // cursor L:C
  expect(md).toContain("9:4");          // selection start
  expect(md).toContain("11:0");         // selection end
});

it("writes nothing when envelope is undefined", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  await cp.hydrate(node, dir, undefined, "text");
  await expect(readFile(join(dir, CTX_PATH), "utf8")).rejects.toThrow();
});

it("writes nothing when envelope.editor is absent", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  await cp.hydrate(node, dir, {}, "text");
  await expect(readFile(join(dir, CTX_PATH), "utf8")).rejects.toThrow();
});

it("throws NotImplementedError for visual-primitives modality", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  const env: ContextEnvelope = { editor: { cursor: { line: 0, col: 0 } } };
  await expect(cp.hydrate(node, dir, env, "visual-primitives")).rejects.toBeInstanceOf(
    NotImplementedError,
  );
});

it("throws NotImplementedError for image modality", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  const env: ContextEnvelope = { editor: { cursor: { line: 0, col: 0 } } };
  await expect(cp.hydrate(node, dir, env, "image")).rejects.toBeInstanceOf(
    NotImplementedError,
  );
});

it("defaults modality to text when omitted (writes the file)", async () => {
  const { dir } = await makeTempRepo();
  const cp = new TextContextProvider();
  const env: ContextEnvelope = { editor: { activeFile: "a.ts", cursor: { line: 1, col: 1 } } };
  await cp.hydrate(node, dir, env);
  const md = await readFile(join(dir, CTX_PATH), "utf8");
  expect(md).toContain("a.ts");
});
