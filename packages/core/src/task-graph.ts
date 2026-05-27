import type { Role } from "./events.js";
import { normalizePath } from "./paths.js";

export interface TaskNode {
  id: string;
  role: Role;
  goal: string;
  dependsOn: string[];
  /** Repo-relative file paths this node owns; default []. Normalized at
   *  construction (backslashes → forward slashes, "./" stripped). Throws if a
   *  path escapes the repo root via "..". */
  writes?: string[];
}

export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>();
  private readonly started = new Set<string>();
  private readonly completed = new Set<string>();

  constructor(nodes: TaskNode[]) {
    for (const node of nodes) {
      if (this.nodes.has(node.id)) throw new Error(`Duplicate task id: ${node.id}`);
      this.nodes.set(node.id, { ...node, writes: (node.writes ?? []).map(normalizePath) });
    }
    for (const node of this.nodes.values()) {
      for (const dep of node.dependsOn) {
        if (!this.nodes.has(dep)) {
          throw new Error(`Task ${node.id} depends on unknown task ${dep}`);
        }
      }
    }
    this.assertAcyclic();
  }

  private assertAcyclic(): void {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of this.nodes.keys()) color.set(id, WHITE);
    const visit = (id: string): void => {
      color.set(id, GRAY);
      for (const dep of this.nodes.get(id)!.dependsOn) {
        const c = color.get(dep);
        if (c === GRAY) throw new Error(`Dependency cycle detected at task ${dep}`);
        if (c === WHITE) visit(dep);
      }
      color.set(id, BLACK);
    };
    for (const id of this.nodes.keys()) {
      if (color.get(id) === WHITE) visit(id);
    }
  }

  ready(): TaskNode[] {
    const out: TaskNode[] = [];
    for (const node of this.nodes.values()) {
      if (this.started.has(node.id) || this.completed.has(node.id)) continue;
      if (node.dependsOn.every((dep) => this.completed.has(dep))) out.push(node);
    }
    return out;
  }

  start(id: string): void {
    if (!this.nodes.has(id)) throw new Error(`Unknown task: ${id}`);
    this.started.add(id);
  }

  complete(id: string): void {
    if (!this.nodes.has(id)) throw new Error(`Unknown task: ${id}`);
    this.completed.add(id);
  }

  isDone(): boolean {
    return this.completed.size === this.nodes.size;
  }

  ids(): string[] {
    return [...this.nodes.keys()];
  }

  completedIds(): string[] {
    return [...this.completed];
  }

  topologicalOrder(): TaskNode[] {
    const order: TaskNode[] = [];
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const dep of this.nodes.get(id)!.dependsOn) visit(dep);
      order.push(this.nodes.get(id)!);
    };
    for (const id of this.nodes.keys()) visit(id);
    return order;
  }
}
