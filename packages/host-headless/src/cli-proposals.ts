#!/usr/bin/env node
import { stdout } from "node:process";
import { NodeGitRunner } from "@agent-team/core/node";
import { ProposalCoordinator } from "@agent-team/core";

function getOpt(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const repo = getOpt(argv, "--repo") ?? process.cwd();
  const coord = new ProposalCoordinator({ git: new NodeGitRunner(), repoRoot: repo });

  if (cmd === "list") {
    const proposals = await coord.list();
    if (proposals.length === 0) { stdout.write("no open proposals\n"); return; }
    for (const p of proposals) {
      const finding = p.finding.split("\n")[0] || "(no finding)";
      stdout.write(`${p.branch}  [${p.sha7}]  ${p.commitCount} commit(s)  ${finding}\n`);
    }
    return;
  }

  if (cmd === "show") {
    const branch = argv[1];
    if (!branch) { stdout.write("usage: agent-team-proposals show <branch>\n"); process.exitCode = 1; return; }
    const p = (await coord.list()).find((x) => x.branch === branch);
    if (!p) { stdout.write(`unknown proposal: ${branch}\n`); process.exitCode = 1; return; }
    stdout.write(`finding: ${p.finding || "(none)"}\n\n`);
    stdout.write(await coord.diff(branch));
    return;
  }

  if (cmd === "accept") {
    const branch = argv[1];
    if (!branch) { stdout.write("usage: agent-team-proposals accept <branch> [--onto <ref>]\n"); process.exitCode = 1; return; }
    const r = await coord.accept(branch, getOpt(argv, "--onto"));
    if (r.status === "merged") stdout.write(`merged ${branch} → ${r.onto}\n`);
    else if (r.status === "nothing") stdout.write(`nothing to merge (empty proposal): ${branch}\n`);
    else {
      stdout.write(`conflict merging ${branch} → ${r.onto}; aborted. conflicted files:\n${r.files.map((f) => "  " + f).join("\n")}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "reject") {
    const branch = argv[1];
    if (!branch) { stdout.write("usage: agent-team-proposals reject <branch>\n"); process.exitCode = 1; return; }
    await coord.reject(branch);
    stdout.write(`rejected ${branch}\n`);
    return;
  }

  stdout.write("usage: agent-team-proposals <list|show|accept|reject> [<branch>] [--repo <path>] [--onto <ref>]\n");
  process.exitCode = 1;
}

main().catch((err) => {
  stdout.write(`fatal: ${String(err)}\n`);
  process.exitCode = 1;
});
