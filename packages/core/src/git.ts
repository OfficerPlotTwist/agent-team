export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  /** Run `git <args>` in `cwd`. Never throws on non-zero exit — returns the code. */
  run(args: string[], cwd: string): Promise<GitResult>;
}
