import { describe, it, expect } from "vitest";
import {
  editorPrimitives,
  pickModality,
  type EditorState,
} from "../src/context-envelope.js";

describe("editorPrimitives", () => {
  it("maps cursor to point", () => {
    const s: EditorState = { cursor: { line: 3, col: 5 } };
    expect(editorPrimitives(s)).toEqual({ point: { line: 3, col: 5 } });
  });

  it("maps selection to box", () => {
    const s: EditorState = {
      selection: { start: { line: 1, col: 0 }, end: { line: 2, col: 4 } },
    };
    expect(editorPrimitives(s)).toEqual({
      box: { start: { line: 1, col: 0 }, end: { line: 2, col: 4 } },
    });
  });

  it("maps both cursor and selection", () => {
    const s: EditorState = {
      cursor: { line: 9, col: 2 },
      selection: { start: { line: 9, col: 2 }, end: { line: 9, col: 8 } },
    };
    expect(editorPrimitives(s)).toEqual({
      point: { line: 9, col: 2 },
      box: { start: { line: 9, col: 2 }, end: { line: 9, col: 8 } },
    });
  });

  it("returns empty object when neither present", () => {
    expect(editorPrimitives({})).toEqual({});
  });
});

describe("pickModality", () => {
  it("returns text for ['text']", () => {
    expect(pickModality(["text"])).toBe("text");
  });

  it("returns the richest supported modality", () => {
    expect(pickModality(["visual-primitives", "text"])).toBe("visual-primitives");
    expect(pickModality(["text", "image"])).toBe("image");
  });

  it("falls back to text on empty list", () => {
    expect(pickModality([])).toBe("text");
  });
});
