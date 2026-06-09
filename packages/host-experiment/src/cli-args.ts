export interface CliArgs {
  task: string;
  taskId: string;
  role: string;
  variants: string;
  repo: string;
  report: string;
  maxTurns: number;
  model: string;
}

const DEFAULT_REPORT = "C:/Users/nik/Documents/AI/Book_Library/experiment-report.md";

export function parseArgs(argv: string[]): CliArgs {
  const getOpt = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const task = getOpt("--task");
  if (task === undefined) throw new Error("--task <goal> is required");
  const variants = getOpt("--variants");
  if (variants === undefined) throw new Error("--variants <file.json> is required");
  return {
    task,
    taskId: getOpt("--task-id") ?? "task",
    role: getOpt("--role") ?? "coder",
    variants,
    repo: getOpt("--repo") ?? process.cwd(),
    report: getOpt("--report") ?? DEFAULT_REPORT,
    maxTurns: Number(getOpt("--max-turns") ?? "50"),
    model: getOpt("--model") ?? "claude-opus-4-8",
  };
}
