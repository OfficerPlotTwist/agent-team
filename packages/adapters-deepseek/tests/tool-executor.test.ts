import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolExecutor } from "../src/tool-executor.js";

let cwd: string;
const executor = new ToolExecutor();

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "ds-exec-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

it("read_file returns file content", () => {
  writeFileSync(join(cwd, "a.txt"), "hello world");
  const { result, events } = executor.execute("read_file", { path: "a.txt" }, cwd, "coder#1");
  expect(result).toBe("hello world");
  expect(events).toHaveLength(0);
});

it("read_file returns error string for missing file (no throw)", () => {
  const { result } = executor.execute("read_file", { path: "nope.txt" }, cwd, "coder#1");
  expect(result).toMatch(/error/i);
});

it("write_file creates the file and emits file_change", () => {
  const { result, events } = executor.execute("write_file", { path: "b.txt", content: "world" }, cwd, "coder#1");
  expect(result).toBe("ok");
  expect(existsSync(join(cwd, "b.txt"))).toBe(true);
  expect(readFileSync(join(cwd, "b.txt"), "utf8")).toBe("world");
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("file_change");
  expect((events[0] as import("@agent-team/core").FileChangeEvent).path).toBe("b.txt");
  expect((events[0] as import("@agent-team/core").FileChangeEvent).from).toBe("coder#1");
});

it("write_file creates parent directories", () => {
  const { result } = executor.execute("write_file", { path: "sub/dir/c.txt", content: "nested" }, cwd, "coder#1");
  expect(result).toBe("ok");
  expect(existsSync(join(cwd, "sub", "dir", "c.txt"))).toBe(true);
});

it("list_files returns directory entries as JSON array", () => {
  writeFileSync(join(cwd, "x.txt"), "");
  const { result } = executor.execute("list_files", { dir: "." }, cwd, "coder#1");
  const entries = JSON.parse(result) as string[];
  expect(entries.some(e => e.startsWith("x.txt"))).toBe(true);
});

it("blocks path traversal on read_file", () => {
  const { result } = executor.execute("read_file", { path: "../../etc/passwd" }, cwd, "coder#1");
  expect(result).toContain("not allowed");
});

it("blocks path traversal on write_file", () => {
  const { result } = executor.execute("write_file", { path: "../escape.txt", content: "x" }, cwd, "coder#1");
  expect(result).toContain("not allowed");
  expect(existsSync(join(cwd, "..", "escape.txt"))).toBe(false);
});

it("returns error string for unknown tool name (no throw)", () => {
  const { result, events } = executor.execute("magic_spell", {}, cwd, "coder#1");
  expect(result).toContain("unknown tool");
  expect(events).toHaveLength(0);
});
