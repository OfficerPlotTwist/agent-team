import type { Role, RequestCategory } from "../events.js";
import { HARD_RULE_CATEGORIES, type PolicyCell, type PolicyTable } from "./model.js";
import { PRESETS, type PresetName } from "./presets.js";

export class PolicyStore {
  private table: PolicyTable | null = null;
  private forced = new Set<string>(); // `${role}:${category}` cells that bypass hard rules

  applyPreset(name: PresetName): void {
    this.table = structuredClone(PRESETS[name]);
    this.forced.clear();
  }

  setCell(role: Role, category: RequestCategory, cell: PolicyCell, opts: { force?: boolean } = {}): void {
    this.require();
    this.table![role][category] = cell;
    if (opts.force) this.forced.add(`${role}:${category}`);
    else this.forced.delete(`${role}:${category}`);
  }

  get(role: Role, category: RequestCategory): PolicyCell {
    this.require();
    const cell = this.table![role][category];
    const isHard = HARD_RULE_CATEGORIES.includes(category);
    if (isHard && !this.forced.has(`${role}:${category}`)) {
      return { mode: "GATE" };
    }
    return cell;
  }

  private require(): void {
    if (!this.table) throw new Error("PolicyStore: applyPreset() must be called first");
  }
}
