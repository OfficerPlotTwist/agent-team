import { TaskGraph } from "@agent-team/core";
import type { Role, TaskNode } from "@agent-team/core";
import type { Variant } from "./variant.js";
import { variantNodeId, assertGitSafe } from "./variant.js";

export interface ExperimentTask {
  taskId: string;
  role: Role;
  goal: string;
}

export interface ExpandedExperiment {
  graph: TaskGraph;
  variantByNodeId: Map<string, Variant>;
  baseRole: Role;
}

/**
 * One task + K variants -> K dependency-free sibling nodes (same goal/role,
 * id = `${taskId}__${variant.name}`). All ready in one wave => parallel.
 */
export function expandTask(task: ExperimentTask, variants: Variant[]): ExpandedExperiment {
  if (variants.length === 0) throw new Error("expandTask needs at least one variant");
  assertGitSafe(task.taskId);

  const variantByNodeId = new Map<string, Variant>();
  const nodes: TaskNode[] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    if (seen.has(v.name)) throw new Error(`duplicate variant name: ${v.name}`);
    seen.add(v.name);
    assertGitSafe(v.name);
    const id = variantNodeId(task.taskId, v.name);
    nodes.push({ id, role: task.role, goal: task.goal, dependsOn: [] });
    variantByNodeId.set(id, v);
  }

  return { graph: new TaskGraph(nodes), variantByNodeId, baseRole: task.role };
}
