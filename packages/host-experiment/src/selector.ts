import type { VariantMetrics } from "./report.js";
import { rankVariants } from "./report.js";

/**
 * The tournament winner: the top-ranked COMPLETED variant (rankVariants already
 * orders completed-before-failed, then by cost, then turns). null if all failed.
 * Pure — the CLI performs the side effect (promote the winner's branch).
 */
export function selectWinner(metrics: VariantMetrics[]): VariantMetrics | null {
  return rankVariants(metrics).find((m) => m.status === "completed") ?? null;
}
