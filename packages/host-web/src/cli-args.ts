export interface CliArgs {
  graph: string;
  repo: string;
  port: number;
  model: string;
  maxTurns: number;
  costCeiling?: number;
  memory?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const getOpt = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const graph = getOpt("--graph");
  if (graph === undefined) throw new Error("--graph <file.json> is required");
  const ceilingRaw = getOpt("--cost-ceiling");
  return {
    graph,
    repo: getOpt("--repo") ?? process.cwd(),
    port: Number(getOpt("--port") ?? "7340"),
    model: getOpt("--model") ?? "claude-opus-4-8",
    maxTurns: Number(getOpt("--max-turns") ?? "50"),
    costCeiling: ceilingRaw !== undefined ? Number(ceilingRaw) : undefined,
    memory: getOpt("--memory"),
  };
}
