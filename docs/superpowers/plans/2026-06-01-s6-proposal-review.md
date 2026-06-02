# S6 — Proposal Review & Promote (headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human list / inspect / accept / reject the `agentteam/reviewer-*` proposal branches S4 ambient agents stage, via a headless `agent-team-proposals` CLI over a port-pure core `ProposalCoordinator`.

**Architecture:** All promotion logic is git-over-the-`GitRunner`-port in a new pure `ProposalCoordinator` (core), sibling to `IntegrationCoordinator`. The CLI is a thin I/O consumer. One small S4 host edit makes `composeAmbient` persist the reviewer's finding as an `Ambient-Finding` commit trailer (temp-worktree amend) so the CLI reads everything from git. Zero Scheduler/bus/worktree/integration runtime change.

**Tech Stack:** TypeScript ESM (NodeNext), `vitest` v2, `@agent-team/core` (pure barrel + `/node`), `NodeGitRunner` over real temp repos. `GitRunner.run(args, cwd) → {code, stdout, stderr}` (never throws on non-zero).

**Baseline:** full suite green at 170 on `master`. Gate: `npm run build` exit 0; full suite green and **> 170**.

**Spec:** `docs/superpowers/specs/2026-06-01-s6-proposal-review-design.md`.

---

## File Map

| File | Responsibility |
|---|---|
| `packages/core/src/proposals.ts` | NEW — `Proposal`/`AcceptOutcome` types + `ProposalCoordinator` (list/diff/accept/reject) over `GitRunner` |
| `packages/core/src/index.ts` | MODIFY — `export * from "./proposals.js"` |
| `packages/core/tests/proposals.test.ts` | NEW — list/diff/reject (Task 1) + accept paths (Task 2) |
| `packages/host-headless/src/compose-ambient.ts` | MODIFY — after a proposal is staged, amend its commit with an `Ambient-Finding` trailer |
| `packages/host-headless/tests/compose-ambient.test.ts` | MODIFY — assert the trailer is written |
| `packages/host-headless/src/cli-proposals.ts` | NEW — `agent-team-proposals` CLI |
| `packages/host-headless/package.json` | MODIFY — add the `agent-team-proposals` bin |
| `packages/host-headless/tests/proposals-flow.test.ts` | NEW — staged proposal → list (finding) → accept (HEAD advanced) |

---

## Task 1: Core `ProposalCoordinator` — list / diff / reject

> **As-built note:** the result interface is named **`AmbientProposal`** (not
> `Proposal`) in every code block of this task — `diff-store.ts` already exports a
> `Proposal`, which collides on the barrel re-export (TS2308). Read `Proposal` →
> `AmbientProposal` throughout Tasks 1–2.

**Files:**
- Create: `packages/core/src/proposals.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/proposals.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/proposals.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import { ProposalCoordinator } from "../src/proposals.js";

const git = new NodeGitRunner();
async function run(args: string[], cwd: string) { return git.run(args, cwd); }

/** Make a repo with one commit on main, then stage a proposal branch
 *  agentteam/reviewer-<sha7> = reviewed commit + one improvement commit
 *  carrying an Ambient-Finding trailer. Returns { repo, sha7 }. */
async function makeRepoWithProposal(finding = "use a const enum"): Promise<{ repo: string; sha7: string }> {
  const repo = mkdtempSync(join(tmpdir(), "s6-")).split("\\").join("/");
  await run(["init", "-b", "main"], repo);
  await run(["config", "user.email", "t@t.com"], repo);
  await run(["config", "user.name", "T"], repo);
  writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
  await run(["add", "."], repo);
  await run(["commit", "-m", "feat: add x"], repo);
  const reviewedSha = (await run(["rev-parse", "HEAD"], repo)).stdout.trim();
  const sha7 = reviewedSha.slice(0, 7);
  const branch = `agentteam/reviewer-${sha7}`;
  // Stage the proposal branch from the reviewed commit with one improvement commit.
  await run(["branch", branch, reviewedSha], repo);
  await run(["switch", branch], repo);
  writeFileSync(join(repo, "app.ts"), "export const enum X { x = 2 }\n");
  await run(["commit", "-am", `reviewed x`, "--trailer", `Ambient-Finding: ${finding}`], repo);
  await run(["switch", "main"], repo);
  return { repo, sha7 };
}

describe("ProposalCoordinator list/diff/reject", () => {
  let repo: string;
  let sha7: string;
  beforeEach(async () => { ({ repo, sha7 } = await makeRepoWithProposal()); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("lists the proposal with sha7, commitCount, and finding", async () => {
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const proposals = await coord.list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].branch).toBe(`agentteam/reviewer-${sha7}`);
    expect(proposals[0].sha7).toBe(sha7);
    expect(proposals[0].commitCount).toBe(1);
    expect(proposals[0].finding).toBe("use a const enum");
    expect(proposals[0].reviewedSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("diff returns the reviewed-range diff", async () => {
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const d = await coord.diff(`agentteam/reviewer-${sha7}`);
    expect(d).toContain("const enum X");
    expect(d).toContain("app.ts");
  });

  it("reject deletes the branch", async () => {
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    await coord.reject(`agentteam/reviewer-${sha7}`);
    const after = await git.run(["rev-parse", "--verify", `agentteam/reviewer-${sha7}`], repo);
    expect(after.code).not.toBe(0); // branch gone
    expect(await coord.list()).toHaveLength(0);
  });

  it("list returns [] when there are no proposal branches", async () => {
    await git.run(["branch", "-D", `agentteam/reviewer-${sha7}`], repo);
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    expect(await coord.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/core -- proposals`
Expected: FAIL with `Cannot find module '../src/proposals.js'`.

- [ ] **Step 3: Write `packages/core/src/proposals.ts`**

```ts
import type { GitRunner } from "./git.js";

/** One staged ambient proposal, derived entirely from git. */
export interface Proposal {
  branch: string;        // e.g. "agentteam/reviewer-1a2b3c4"
  sha7: string;          // reviewed commit short sha (the branch-name suffix)
  reviewedSha: string;   // full sha the branch was cut from
  finding: string;       // the Ambient-Finding trailer ("" if none)
  commitCount: number;   // commits on the branch beyond reviewedSha (0 = empty)
}

export type AcceptOutcome =
  | { status: "merged"; branch: string; onto: string }
  | { status: "conflict"; branch: string; onto: string; files: string[] }
  | { status: "nothing"; branch: string };

export interface ProposalCoordinatorOptions {
  git: GitRunner;
  repoRoot: string;
  prefix?: string;         // default "agentteam/reviewer-"
  findingTrailer?: string; // default "Ambient-Finding"
}

/**
 * Lists / diffs / accepts / rejects the proposal branches S4 ambient agents
 * stage. Pure: depends only on the GitRunner port (+ repoRoot), so it carries
 * no node:* and is exported from the pure barrel beside IntegrationCoordinator.
 */
export class ProposalCoordinator {
  private readonly git: GitRunner;
  private readonly repoRoot: string;
  private readonly prefix: string;
  private readonly trailer: string;

  constructor(opts: ProposalCoordinatorOptions) {
    this.git = opts.git;
    this.repoRoot = opts.repoRoot;
    this.prefix = opts.prefix ?? "agentteam/reviewer-";
    this.trailer = opts.findingTrailer ?? "Ambient-Finding";
  }

  async list(): Promise<Proposal[]> {
    const res = await this.git.run(
      ["for-each-ref", "--format=%(refname:short)", `refs/heads/${this.prefix}*`],
      this.repoRoot,
    );
    const branches = res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    const out: Proposal[] = [];
    for (const branch of branches) {
      const sha7 = branch.slice(this.prefix.length);
      const reviewedSha = await this.reviewedSha(sha7);
      const commitCount = await this.commitCount(reviewedSha, branch);
      const finding = (
        await this.git.run(
          ["show", "-s", `--format=%(trailers:key=${this.trailer},valueonly)`, branch],
          this.repoRoot,
        )
      ).stdout.trim();
      out.push({ branch, sha7, reviewedSha, finding, commitCount });
    }
    return out;
  }

  async diff(branch: string): Promise<string> {
    const reviewedSha = await this.reviewedSha(branch.slice(this.prefix.length));
    return (await this.git.run(["diff", `${reviewedSha}..${branch}`], this.repoRoot)).stdout;
  }

  async reject(branch: string): Promise<void> {
    await this.git.run(["branch", "-D", branch], this.repoRoot);
    await this.git.run(["worktree", "prune"], this.repoRoot);
  }

  private async reviewedSha(sha7: string): Promise<string> {
    return (await this.git.run(["rev-parse", sha7], this.repoRoot)).stdout.trim();
  }

  private async commitCount(reviewedSha: string, branch: string): Promise<number> {
    const r = await this.git.run(["rev-list", "--count", `${reviewedSha}..${branch}`], this.repoRoot);
    return Number(r.stdout.trim()) || 0;
  }
}
```

- [ ] **Step 4: Export from the barrel**

In `packages/core/src/index.ts`, add after the `export * from "./integration.js";` line:

```ts
export * from "./proposals.js";
```

- [ ] **Step 5: Run the test — expect pass**

Run: `npm run test -w @agent-team/core -- proposals`
Expected: PASS (4 tests).

- [ ] **Step 6: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/proposals.ts" \
            "vsCode Fork/packages/core/src/index.ts" \
            "vsCode Fork/packages/core/tests/proposals.test.ts"
git commit -m "feat(core): ProposalCoordinator list/diff/reject over GitRunner"
```

---

## Task 2: Core `ProposalCoordinator.accept` — default merge / --onto / conflict / empty

**Files:**
- Modify: `packages/core/src/proposals.ts`
- Modify: `packages/core/tests/proposals.test.ts` (reuse the `makeRepoWithProposal` helper)

- [ ] **Step 1: Add the failing accept tests**

Append to `packages/core/tests/proposals.test.ts`:

```ts
describe("ProposalCoordinator accept", () => {
  it("clean-merges the proposal into the current branch (HEAD advances)", async () => {
    const { repo, sha7 } = await makeRepoWithProposal();
    const before = (await git.run(["rev-parse", "main"], repo)).stdout.trim();
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const r = await coord.accept(`agentteam/reviewer-${sha7}`);
    expect(r.status).toBe("merged");
    const after = (await git.run(["rev-parse", "main"], repo)).stdout.trim();
    expect(after).not.toBe(before); // --no-ff merge commit landed
    // the reviewer's change is now in the working tree
    const headFile = (await git.run(["show", "main:app.ts"], repo)).stdout;
    expect(headFile).toContain("const enum X");
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports conflict and aborts (tree clean) when the target diverged", async () => {
    const { repo, sha7 } = await makeRepoWithProposal();
    // Advance main on the SAME line so the proposal merge conflicts.
    writeFileSync(join(repo, "app.ts"), "export const x = 99; // human edit\n");
    await git.run(["commit", "-am", "chore: bump x to 99"], repo);
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const r = await coord.accept(`agentteam/reviewer-${sha7}`);
    expect(r.status).toBe("conflict");
    if (r.status === "conflict") expect(r.files).toContain("app.ts");
    // merge was aborted — no MERGE_HEAD, no unmerged paths
    const mh = await git.run(["rev-parse", "--verify", "MERGE_HEAD"], repo);
    expect(mh.code).not.toBe(0);
    const unmerged = (await git.run(["diff", "--name-only", "--diff-filter=U"], repo)).stdout.trim();
    expect(unmerged).toBe("");
    rmSync(repo, { recursive: true, force: true });
  });

  it("returns 'nothing' for an empty proposal (no commits beyond reviewed)", async () => {
    const { repo, sha7 } = await makeRepoWithProposal();
    const branch = `agentteam/reviewer-${sha7}`;
    // Reset the proposal branch back to the reviewed commit (0 commits ahead).
    const reviewedSha = (await git.run(["rev-parse", sha7], repo)).stdout.trim();
    await git.run(["branch", "-f", branch, reviewedSha], repo);
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const r = await coord.accept(branch);
    expect(r.status).toBe("nothing");
    rmSync(repo, { recursive: true, force: true });
  });

  it("--onto merges into another branch via a throwaway worktree, leaving HEAD untouched", async () => {
    const { repo, sha7 } = await makeRepoWithProposal();
    const reviewedSha = (await git.run(["rev-parse", sha7], repo)).stdout.trim();
    await git.run(["branch", "land", reviewedSha], repo); // a separate target branch
    const headBefore = (await git.run(["rev-parse", "main"], repo)).stdout.trim();
    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const r = await coord.accept(`agentteam/reviewer-${sha7}`, "land");
    expect(r.status).toBe("merged");
    if (r.status === "merged") expect(r.onto).toBe("land");
    // land advanced; main (HEAD) did NOT; no leftover temp worktree
    expect((await git.run(["rev-parse", "land"], repo)).stdout.trim()).not.toBe(reviewedSha);
    expect((await git.run(["rev-parse", "main"], repo)).stdout.trim()).toBe(headBefore);
    const wt = (await git.run(["worktree", "list"], repo)).stdout;
    expect(wt).not.toContain("proposal-accept");
    rmSync(repo, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests — expect failure**

Run: `npm run test -w @agent-team/core -- proposals`
Expected: FAIL — `coord.accept is not a function`.

- [ ] **Step 3: Add `accept` to `ProposalCoordinator`**

In `packages/core/src/proposals.ts`, add these methods to the class (after `reject`):

```ts
  async accept(branch: string, onto?: string): Promise<AcceptOutcome> {
    const current = (
      await this.git.run(["rev-parse", "--abbrev-ref", "HEAD"], this.repoRoot)
    ).stdout.trim();
    const target = onto ?? current;
    const reviewedSha = await this.reviewedSha(branch.slice(this.prefix.length));
    if ((await this.commitCount(reviewedSha, branch)) === 0) {
      return { status: "nothing", branch };
    }

    if (target === current) {
      return this.mergeIn(this.repoRoot, branch, target);
    }

    // --onto path: merge inside a throwaway worktree so HEAD/working tree are untouched.
    const tmp = `${this.repoRoot}/.worktrees/proposal-accept-${branch.slice(this.prefix.length)}`;
    await this.git.run(["worktree", "add", "--force", tmp, target], this.repoRoot);
    try {
      return await this.mergeIn(tmp, branch, target);
    } finally {
      await this.git.run(["worktree", "remove", "--force", tmp], this.repoRoot);
    }
  }

  private async mergeIn(cwd: string, branch: string, onto: string): Promise<AcceptOutcome> {
    const m = await this.git.run(["merge", "--no-ff", branch], cwd);
    if (m.code === 0) return { status: "merged", branch, onto };
    const files = (
      await this.git.run(["diff", "--name-only", "--diff-filter=U"], cwd)
    ).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    await this.git.run(["merge", "--abort"], cwd);
    return { status: "conflict", branch, onto, files };
  }
```

- [ ] **Step 4: Run the tests — expect pass**

Run: `npm run test -w @agent-team/core -- proposals`
Expected: PASS (8 tests total).

- [ ] **Step 5: Build core — expect clean**

Run: `npm run build -w @agent-team/core`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/core/src/proposals.ts" \
            "vsCode Fork/packages/core/tests/proposals.test.ts"
git commit -m "feat(core): ProposalCoordinator.accept (merge into HEAD; --onto via temp worktree; conflict aborts)"
```

---

## Task 3: `composeAmbient` persists the finding as a commit trailer

**Files:**
- Modify: `packages/host-headless/src/compose-ambient.ts`
- Modify: `packages/host-headless/tests/compose-ambient.test.ts`

The host already captures `doneSummary` and `sawFileChange` in `fire()`. When a proposal is staged, amend its tip commit to carry the finding as an `Ambient-Finding` trailer, via a temp worktree (the agent's own worktree is already gone by this point).

- [ ] **Step 1: Add the failing test**

Append to `packages/host-headless/tests/compose-ambient.test.ts` (inside the existing `describe("composeAmbient (offline)", …)` block, after the last test):

```ts
  it("writes the reviewer finding as an Ambient-Finding trailer on the proposal commit", async () => {
    const sha = await headSha(git, repo);
    const sha7 = sha.slice(0, 7);
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "app.ts"), "export const x = 2; // reviewed\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "x should be a const enum for clarity", total_cost_usd: 0.01 });
    };
    const host = composeAmbient({ repoRoot: repo, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000 });
    await host.fire({ reason: "commit", commitSha: sha, scope: ["app.ts"] });

    const trailer = await git.run(
      ["show", "-s", "--format=%(trailers:key=Ambient-Finding,valueonly)", `agentteam/reviewer-${sha7}`],
      repo,
    );
    expect(trailer.stdout.trim()).toBe("x should be a const enum for clarity");
  });
```

(The `composeAmbient (offline)` block's `beforeEach` already builds a temp repo with one `app.ts` commit and assigns `repo`/`git`; this test reuses them.)

- [ ] **Step 2: Run the test — expect failure**

Run: `npm run test -w @agent-team/host-headless -- compose-ambient`
Expected: FAIL — the trailer is empty (`""` !== the finding).

- [ ] **Step 3: Add the trailer-amend to `fire()`**

In `packages/host-headless/src/compose-ambient.ts`, inside `fire()`, locate:

```ts
    const result = await scheduler.run(adapterFor);
    off();

    bus.publish({
      kind: "ambient_report",
```

Insert the amend between `off();` and `bus.publish(`:

```ts
    const result = await scheduler.run(adapterFor);
    off();

    // Persist the reviewer's finding onto the proposal commit as a trailer so the
    // proposals CLI can read it from git alone. The agent's worktree is already
    // removed, so amend through a throwaway worktree. Single-line the summary
    // (trailers are one line). Best-effort: a failed amend must not fail the run.
    if (sawFileChange && doneSummary) {
      const tmp = `${opts.repoRoot}/.worktrees/proposal-finding-${sha7}`;
      const value = doneSummary.replace(/\s+/g, " ").trim();
      const added = await git.run(["worktree", "add", "--force", tmp, branch], opts.repoRoot);
      if (added.code === 0) {
        await git.run(["commit", "--amend", "--no-edit", "--trailer", `Ambient-Finding: ${value}`], tmp);
        await git.run(["worktree", "remove", "--force", tmp], opts.repoRoot);
      }
    }

    bus.publish({
      kind: "ambient_report",
```

- [ ] **Step 4: Run the test — expect pass**

Run: `npm run test -w @agent-team/host-headless -- compose-ambient`
Expected: PASS (existing compose-ambient tests + the new trailer test).

- [ ] **Step 5: Build host-headless — expect clean**

Run: `npm run build -w @agent-team/host-headless`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/host-headless/src/compose-ambient.ts" \
            "vsCode Fork/packages/host-headless/tests/compose-ambient.test.ts"
git commit -m "feat(host-headless): composeAmbient persists finding as an Ambient-Finding commit trailer"
```

---

## Task 4: `agent-team-proposals` CLI

**Files:**
- Create: `packages/host-headless/src/cli-proposals.ts`
- Modify: `packages/host-headless/package.json`

- [ ] **Step 1: Write `packages/host-headless/src/cli-proposals.ts`**

```ts
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
```

- [ ] **Step 2: Add the bin entry to `package.json`**

In `packages/host-headless/package.json`, change the `bin` block to:

```json
  "bin": {
    "agent-team-run": "./dist/cli.js",
    "agent-team-ambient": "./dist/cli-ambient.js",
    "agent-team-proposals": "./dist/cli-proposals.js"
  },
```

- [ ] **Step 3: Build host-headless — expect clean**

Run: `npm run build -w @agent-team/host-headless`
Expected: exit 0. Confirm `dist/cli-proposals.js` exists.

- [ ] **Step 4: Commit**

```bash
git add -f "vsCode Fork/packages/host-headless/src/cli-proposals.ts" \
            "vsCode Fork/packages/host-headless/package.json"
git commit -m "feat(host-headless): agent-team-proposals CLI (list/show/accept/reject)"
```

---

## Task 5: End-to-end flow test + full verification

**Files:**
- Create: `packages/host-headless/tests/proposals-flow.test.ts`

- [ ] **Step 1: Write the offline end-to-end test**

Create `packages/host-headless/tests/proposals-flow.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeGitRunner } from "@agent-team/core/node";
import { ProposalCoordinator } from "@agent-team/core";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "@agent-team/adapters-claude";
import { composeAmbient } from "../src/compose-ambient.js";

const asMsg = (o: unknown): SDKMessage => o as SDKMessage;

describe("proposals end-to-end (ambient stage → list → accept)", () => {
  let repo: string;
  let git: NodeGitRunner;

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "s6-flow-")).split("\\").join("/");
    git = new NodeGitRunner();
    await git.run(["init", "-b", "main"], repo);
    await git.run(["config", "user.email", "t@t.com"], repo);
    await git.run(["config", "user.name", "T"], repo);
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
    await git.run(["add", "."], repo);
    await git.run(["commit", "-m", "feat: add x"], repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("an ambient reaction's proposal lists with its finding and accepts onto HEAD", async () => {
    const sha = (await git.run(["rev-parse", "HEAD"], repo)).stdout.trim();
    const query: QueryFn = async function* ({ options }) {
      writeFileSync(join(options.cwd as string, "app.ts"), "export const x = 2; // reviewed\n");
      yield asMsg({ type: "result", subtype: "success", is_error: false, result: "tightened x", total_cost_usd: 0.01 });
    };
    const host = composeAmbient({ repoRoot: repo, query, model: "claude-test", maxTurns: 50, permTimeoutMs: 1000 });
    await host.fire({ reason: "commit", commitSha: sha, scope: ["app.ts"] });

    const coord = new ProposalCoordinator({ git, repoRoot: repo });
    const proposals = await coord.list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].finding).toBe("tightened x");
    expect(proposals[0].commitCount).toBe(1);

    const before = (await git.run(["rev-parse", "main"], repo)).stdout.trim();
    const r = await coord.accept(proposals[0].branch);
    expect(r.status).toBe("merged");
    expect((await git.run(["rev-parse", "main"], repo)).stdout.trim()).not.toBe(before);
    expect((await git.run(["show", "main:app.ts"], repo)).stdout).toContain("reviewed");
  });
});
```

- [ ] **Step 2: Run the test — expect pass**

Run: `npm run test -w @agent-team/host-headless -- proposals-flow`
Expected: PASS (1 test). (Implementation already exists from Tasks 1–4; this is the integration proof.)

- [ ] **Step 3: Full workspace build**

Run (from the `vsCode Fork` dir): `npm run build`
Expected: exit 0 — core → adapters → hosts.

- [ ] **Step 4: Full workspace test suite**

Run: `npm run test`
Expected: all packages green, strictly above the 170 baseline. New tests: core +8 (proposals), host-headless +1 (trailer) +1 (flow) → ~**180**. Hard requirement: green and > 170.

- [ ] **Step 5: Port-purity guard — barrel stays pure**

Run: `grep -n "node:" packages/core/src/proposals.ts`
Expected: no output (`proposals.ts` imports only the `GitRunner` type).

- [ ] **Step 6: Commit**

```bash
git add -f "vsCode Fork/packages/host-headless/tests/proposals-flow.test.ts"
git commit -m "test(s6): end-to-end ambient stage → list → accept flow"
```

---

## Done-criteria

- `npm run build` exits 0 (workspace order core → adapters → hosts).
- `npm run test` fully green, strictly more than the 170 baseline.
- `core` stays port-pure: `proposals.ts` has no `node:*`; it imports only the `GitRunner` type.
- Scheduler/bus/worktree/integration runtime unchanged — `proposals.ts` is additive; the only host edit is `composeAmbient` writing a finding trailer.
- A staged proposal lists with its finding; `accept` clean-merges onto HEAD (and `--onto` merges elsewhere via a temp worktree, HEAD untouched); a divergent `accept` reports `conflict` and aborts (tree clean); `reject` deletes the branch.
- `agent-team-proposals` exposes `list` / `show` / `accept` / `reject`.

---

## Self-review notes (spec §-by-§ coverage)

- §2 surface (core coordinator + CLI) → Tasks 1, 2, 4. §2 accept-into-HEAD + `--onto` → Task 2. §2 conflict abort+report → Task 2 (conflict test). §2 finding-as-trailer → Task 3.
- §4.1 types → Task 1. §4.2 git verbs (list/diff/accept/reject) → Tasks 1–2. §4.3 CLI → Task 4.
- §5 data flow → Task 5 (end-to-end). §6 error handling: empty proposal → Task 2; conflict → Task 2; missing trailer → Task 1 (`finding: ""` path covered by the no-trailer empty-list case; the CLI prints "(no finding)").
- §7 testing → Tasks 1–3, 5 (all offline temp repos). §11 acceptance → Task 5 verification.
- §8 out-of-scope (panel, integration-branch review, auto-promote, conflict loop, batch, memory findings) — no tasks, by design.
