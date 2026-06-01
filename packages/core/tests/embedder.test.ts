import { describe, it, expect } from "vitest";
import { HashEmbedder } from "../src/embedder.js";

function l2(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

describe("HashEmbedder", () => {
  it("is deterministic and respects dim", async () => {
    const e = new HashEmbedder(64);
    expect(e.dim).toBe(64);
    const a = await e.embed("fix the login auth flow");
    const b = await e.embed("fix the login auth flow");
    expect(a.length).toBe(64);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("places token-overlapping texts nearer than disjoint ones", async () => {
    const e = new HashEmbedder(64);
    const q = await e.embed("login authentication session token");
    const near = await e.embed("authentication login user token");
    const far = await e.embed("css gradient button styling layout");
    expect(l2(q, near)).toBeLessThan(l2(q, far));
  });
});
