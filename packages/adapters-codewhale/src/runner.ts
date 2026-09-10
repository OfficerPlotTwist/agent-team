import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Handle to a spawned codewhale process. */
export interface LineProcess {
  /** Resolves with the process exit code (spawn errors resolve as 1). */
  wait: Promise<number>;
  kill(): void;
}

/** Spawns `codewhale <args>` in `cwd` and feeds each stdout line to `onLine`. */
export type LineRunner = (args: string[], cwd: string, onLine: (line: string) => void) => LineProcess;

/** Real runner: spawns the `codewhale` binary from PATH with JSONL stdout. */
export const spawnLineRunner: LineRunner = (args, cwd, onLine) => {
  const child = spawn("codewhale", args, { cwd });
  const rl = createInterface({ input: child.stdout });
  rl.on("line", onLine);
  const wait = new Promise<number>((resolve) => {
    child.on("error", () => resolve(1)); // spawn failure (e.g. binary not found)
    child.on("close", (code) => resolve(code ?? 1));
  });
  return { wait, kill: () => void child.kill() };
};
