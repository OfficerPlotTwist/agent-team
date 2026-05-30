import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent, AgentId } from "@agent-team/core";
import { makeFileChangeEvent } from "./event-mapper.js";

export interface ExecuteResult {
  result: string;
  events: AgentEvent[];
}

export class ToolExecutor {
  execute(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
    agentId: AgentId,
  ): ExecuteResult {
    switch (name) {
      case "read_file":
        return this.#readFile(String(args["path"] ?? ""), cwd);
      case "write_file":
        return this.#writeFile(String(args["path"] ?? ""), String(args["content"] ?? ""), cwd, agentId);
      case "list_files":
        return this.#listFiles(String(args["dir"] ?? "."), cwd);
      default:
        return { result: `unknown tool: ${name}`, events: [] };
    }
  }

  #resolveSafe(filePath: string, cwd: string): string | null {
    const base = path.resolve(cwd);
    const resolved = path.resolve(base, filePath);
    return resolved.startsWith(base + path.sep) ? resolved : null;
  }

  #readFile(filePath: string, cwd: string): ExecuteResult {
    const resolved = this.#resolveSafe(filePath, cwd);
    if (!resolved) return { result: "error: path traversal not allowed", events: [] };
    try {
      return { result: fs.readFileSync(resolved, "utf8"), events: [] };
    } catch (err) {
      return { result: `error: ${String(err)}`, events: [] };
    }
  }

  #writeFile(filePath: string, content: string, cwd: string, agentId: AgentId): ExecuteResult {
    const resolved = this.#resolveSafe(filePath, cwd);
    if (!resolved) return { result: "error: path traversal not allowed", events: [] };
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, "utf8");
      return { result: "ok", events: [makeFileChangeEvent(agentId, filePath, content)] };
    } catch (err) {
      return { result: `error: ${String(err)}`, events: [] };
    }
  }

  #listFiles(dir: string, cwd: string): ExecuteResult {
    const base = path.resolve(cwd);
    const target = path.resolve(base, dir);
    // Allow base itself (dir=".") or strict children; block siblings like /tmp/repo-other
    if (target !== base && !target.startsWith(base + path.sep)) {
      return { result: "error: path traversal not allowed", events: [] };
    }
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      return {
        result: JSON.stringify(entries.map(e => e.name + (e.isDirectory() ? "/" : ""))),
        events: [],
      };
    } catch (err) {
      return { result: `error: ${String(err)}`, events: [] };
    }
  }
}
