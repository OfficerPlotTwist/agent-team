import type { Role, RequestCategory } from "../events.js";

export type HandlingMode = "GATE" | "ROUTE" | "NOTIFY" | "AUTO";

export interface PolicyCell {
  mode: HandlingMode;
  /** Required when mode === "ROUTE": the role that fulfills the request. */
  route?: Role;
}

export type PolicyTable = Record<Role, Record<RequestCategory, PolicyCell>>;

export const CATEGORIES: readonly RequestCategory[] = [
  "approval",
  "credential",
  "judgment",
  "external_action",
  "destructive",
  "merge_conflict",
  "info",
];

/** Categories that are pinned to GATE and only changeable with an explicit force. */
export const HARD_RULE_CATEGORIES: readonly RequestCategory[] = ["credential", "destructive"];
