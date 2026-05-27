import { describe, it, expect } from "vitest";
import { normalizePath } from "../src/paths.js";

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("src\\a.ts")).toBe("src/a.ts");
  });

  it("strips a leading ./", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
  });

  it("collapses duplicate slashes", () => {
    expect(normalizePath("src//a.ts")).toBe("src/a.ts");
  });

  it("resolves .. segments", () => {
    expect(normalizePath("src/sub/../a.ts")).toBe("src/a.ts");
  });

  it("is idempotent on an already-canonical path", () => {
    expect(normalizePath("src/a.ts")).toBe("src/a.ts");
  });

  it("treats the three Windows/relative spellings as equal", () => {
    const canonical = normalizePath("src/a.ts");
    expect(normalizePath("src\\a.ts")).toBe(canonical);
    expect(normalizePath("./src/a.ts")).toBe(canonical);
  });
});
