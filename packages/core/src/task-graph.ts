import type { Role } from "./events.js";

export interface TaskNode {
  id: string;
  role: Role;
  goal: string;
  dependsOn: string[];
}

export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>();
  private readonly started = new Set<string>();
  private readonly completed = new Set<string>();

  constructor(nodes: TaskNode[]) {
    for (const node of nodes) {
      if (this.nodes.has(node.id)) throw new Error(`Duplicate task id: ${node.id}`);
      this.nodes.set(node.id, node);
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
}
