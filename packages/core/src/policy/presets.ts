import type { PolicyTable } from "./model.js";

export type PresetName = "copilot" | "pair" | "autopilot";

/** The "Pair" preset — gate only risky things. Mirrors the spec's worked table. */
const PAIR: PolicyTable = {
  lead: {
    approval: { mode: "AUTO" }, credential: { mode: "GATE" }, judgment: { mode: "GATE" },
    external_action: { mode: "ROUTE", route: "ops" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "AUTO" },
  },
  architect: {
    approval: { mode: "NOTIFY" }, credential: { mode: "GATE" }, judgment: { mode: "ROUTE", route: "lead" },
    external_action: { mode: "GATE" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "AUTO" },
  },
  coder: {
    approval: { mode: "ROUTE", route: "reviewer" }, credential: { mode: "GATE" }, judgment: { mode: "ROUTE", route: "lead" },
    external_action: { mode: "ROUTE", route: "ops" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "ROUTE", route: "lead" },
  },
  reviewer: {
    approval: { mode: "AUTO" }, credential: { mode: "GATE" }, judgment: { mode: "ROUTE", route: "lead" },
    external_action: { mode: "GATE" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "AUTO" },
  },
  ops: {
    approval: { mode: "NOTIFY" }, credential: { mode: "GATE" }, judgment: { mode: "GATE" },
    external_action: { mode: "NOTIFY" }, destructive: { mode: "GATE" },
    merge_conflict: { mode: "ROUTE", route: "lead" }, info: { mode: "AUTO" },
  },
};

/** Helper: clone PAIR and rewrite every non-hard-rule cell to a single mode. */
function stamp(base: PolicyTable, mode: "GATE" | "NOTIFY"): PolicyTable {
  const out = structuredClone(base);
  for (const role of Object.keys(out) as (keyof PolicyTable)[]) {
    for (const cat of Object.keys(out[role]) as (keyof PolicyTable["lead"])[]) {
      if (cat === "credential" || cat === "destructive") continue; // hard rules handled by store
      // Preserve ROUTE targets; only shift mode for non-routed cells.
      if (out[role][cat].mode !== "ROUTE") out[role][cat] = { mode };
    }
  }
  return out;
}

export const PRESETS: Record<PresetName, PolicyTable> = {
  pair: PAIR,
  copilot: stamp(PAIR, "GATE"),
  autopilot: stamp(PAIR, "NOTIFY"),
};
