import { execFile } from "node:child_process";
import type { GitRunner, GitResult } from "../git.js";

export class NodeGitRunner implements GitRunner {
  run(args: string[], cwd: string): Promise<GitResult> {
    return new Promise<GitResult>((resolve) => {
      execFile(
        "git",
        args,
        { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : err
                ? 1
                : 0;
          resolve({ code, stdout: stdout.toString(), stderr: stderr.toString() });
        },
      );
    });
  }
}
