/** 0-based editor coordinates. */
export interface Pos {
  line: number;
  col: number;
}

export interface EditorState {
  /** Repo-relative POSIX path of the active file. Omitted if outside the repo. */
  activeFile?: string;
  /** The POINT primitive (from the human's cursor). */
  cursor?: Pos;
  /** The BOX primitive (from the human's selection; start <= end). */
  selection?: { start: Pos; end: Pos };
}

export interface ContextEnvelope {
  /** Optional; absent = nothing to hydrate. */
  editor?: EditorState;
}

export type ContextModality = "text" | "image" | "visual-primitives";

/** Richness ranking; higher index = richer. Used by pickModality. */
const MODALITY_RANK: readonly ContextModality[] = ["text", "image", "visual-primitives"];

/**
 * Pure projection of an EditorState into primitive geometry. Cursor -> point,
 * selection -> box. Reused verbatim by the future visual-primitives renderer.
 */
export function editorPrimitives(s: EditorState): {
  point?: Pos;
  box?: { start: Pos; end: Pos };
} {
  const out: { point?: Pos; box?: { start: Pos; end: Pos } } = {};
  if (s.cursor) out.point = s.cursor;
  if (s.selection) out.box = s.selection;
  return out;
}

/**
 * Returns the richest modality the adapter declares (text < image <
 * visual-primitives). Empty list falls back to "text".
 */
export function pickModality(
  supported: readonly ContextModality[],
): ContextModality {
  let best: ContextModality = "text";
  let bestRank = -1;
  for (const m of supported) {
    const rank = MODALITY_RANK.indexOf(m);
    if (rank > bestRank) {
      bestRank = rank;
      best = m;
    }
  }
  return best;
}
