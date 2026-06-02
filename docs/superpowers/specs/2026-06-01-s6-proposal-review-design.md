# S6 — Proposal Review & Promote (headless) Design

**Status:** Approved design, ready for implementation plan.
**Date:** 2026-06-01

---

## 1. Goal

Give a human a way to **list, inspect, accept (promote), or reject** the
`agentteam/reviewer-*` proposal branches that S4 ambient agents stage. This
closes the loop S4 opened — ambient reactions stage a proposal branch and post
an `ambient_report`, but **nothing lets a person act on the branch** — and it
realizes the "gated human landing step" that `IntegrationCoordinator` has
referenced since S2 (its `cleanup()` is deliberately *not* called by the
Scheduler "because the result must persist for the gated landing step").

v1 scope is **ambient reviewer proposals only**. Reviewing the team-run
integration branch, a VS Code panel, auto-promotion, conflict-resolution loops,
and batch accept are all **out of scope** (§8).

---

## 2. Locked decisions

- **Surface = headless-first CLI**, matching the S4 precedent (S4 shipped a CLI
  and deferred its panel). The promotion *logic* lives in a **port-pure core
  coordinator** (`ProposalCoordinator`, over the existing `GitRunner` port),
  sibling to `IntegrationCoordinator`; the CLI is the first thin consumer. A
  future VS Code panel is a second consumer of the same engine — no rework.
- **Accept lands on the current branch**, with an `--onto <ref>` override.
  Rationale: a proposal branch is cut **straight from the reviewed commit**
  (`AmbientIntegration.tip()` returns the reviewed SHA), so the improvement's
  natural home is the branch that commit lives on — i.e. where you're working.
- **Conflicts abort + report. No auto-resolve.** Consistent with the repo's
  stance that a `merge_conflict` is informational; the proposal branch is left
  intact for a manual retry.
- **The finding travels in git, not memory — as a commit trailer.** The ambient
  run persists the reviewer's `ambient_report.summary` onto the proposal commit
  as an **`Ambient-Finding:` git trailer**. Because the agent's commit is already
  made and its worktree is removed by the time the host finalizes, the host adds
  the trailer via a **temporary worktree amend** (`git worktree add <tmp> <branch>`
  → `git commit --amend --trailer "Ambient-Finding: <summary>" --no-edit` →
  `git worktree remove <tmp>` — ~3 git calls; rewrites the proposal commit SHA,
  which is fine since the branch is the agent's own throwaway). The CLI reads
  finding + diff + commits from **git alone** — no dependency on the S5 sqlite-vec
  store, no "memory off" fallback, a clean 1:1 mapping with the branch, and the
  *why* lands **permanently in your merged history** on accept (chosen over a git
  note specifically because a note never enters history and does not push/clone).

---

## 3. Architecture — one core engine, one thin CLI, one tiny S4 tweak

```
   S4 composeAmbient (host)                 S6 (this milestone)
   ────────────────────────                 ───────────────────
   commit → reviewer run                     agent-team-proposals CLI
     stages agentteam/reviewer-<sha7>          │  list / show / accept / reject
     + Ambient-Finding trailer  ─────────────► │
                                               ▼
                                    ProposalCoordinator (@agent-team/core, PURE)
                                      list() · diff() · accept() · reject()
                                               │  GitRunner port
                                               ▼
                                         NodeGitRunner (real git)
```

- **`ProposalCoordinator` (core, port-pure).** Lives in `packages/core/src/proposals.ts`,
  exported from the pure barrel beside `IntegrationCoordinator`. Depends only on
  the `GitRunner` **port** (+ `repoRoot`), so it has no `node:*` and is unit-
  testable with the fake/real runner. It owns ALL the git verbs; the CLI is I/O
  only.
- **`agent-team-proposals` CLI (host-headless).** A new bin that constructs a
  `NodeGitRunner` + `ProposalCoordinator` and renders the four subcommands. No
  logic beyond arg-parse + formatting.
- **`composeAmbient` finding-persist (host-headless, the only S4 edit).** After a
  reaction stages a proposal (i.e. `sawFileChange`), amend the proposal commit to
  carry the finding as an `Ambient-Finding` trailer (via a temp-worktree amend).
  Host-only; **zero core-runtime change** — the Scheduler/bus/worktree/integration
  are untouched, same discipline as S3/S4/S5.

---

## 4. Interfaces

### 4.1 Core types + coordinator (`packages/core/src/proposals.ts`)

```ts
import type { GitRunner } from "./git.js";

/** One staged ambient proposal, derived entirely from git. */
export interface Proposal {
  branch: string;        // e.g. "agentteam/reviewer-1a2b3c4"
  sha7: string;          // reviewed commit short sha (from the branch name)
  reviewedSha: string;   // full sha the branch was cut from (the trigger commit)
  finding: string;       // the Ambient-Finding trailer ("" if none)
  commitCount: number;   // commits on the branch beyond reviewedSha (0 = empty)
}

export type AcceptOutcome =
  | { status: "merged";   branch: string; onto: string }
  | { status: "conflict"; branch: string; onto: string; files: string[] }
  | { status: "nothing";  branch: string };   // no commits to merge (empty proposal)

export interface ProposalCoordinatorOptions {
  git: GitRunner;
  repoRoot: string;
  prefix?: string;        // default "agentteam/reviewer-"
  findingTrailer?: string; // default "Ambient-Finding"
}

export class ProposalCoordinator {
  constructor(opts: ProposalCoordinatorOptions);
  list(): Promise<Proposal[]>;
  diff(branch: string): Promise<string>;
  accept(branch: string, onto?: string): Promise<AcceptOutcome>;
  reject(branch: string): Promise<void>;
}
```

### 4.2 Git verbs (how each method maps to the `GitRunner` port)

- **`list()`** — `git for-each-ref --format=%(refname:short) refs/heads/<prefix>*`.
  For each branch: `sha7` = suffix after the prefix; `reviewedSha` =
  `git rev-parse <sha7>`; `commitCount` = `git rev-list --count <reviewedSha>..<branch>`;
  `finding` = the `<findingTrailer>` value parsed from
  `git show -s --format=%(trailers:key=<findingTrailer>,valueonly) <branch>`
  (empty string when absent).
- **`diff(branch)`** — `git diff <reviewedSha>..<branch>` (reviewedSha resolved as above).
- **`accept(branch, onto?)`** —
  1. `current` = `git rev-parse --abbrev-ref HEAD`; `target` = `onto ?? current`.
  2. If `commitCount === 0` → `{status:"nothing"}` (no merge attempted).
  3. **If `target === current`** (the default path): `git merge --no-ff <branch>`
     in the main working tree, so the change lands in your working copy.
  4. **If `target !== current`** (the `--onto` path): merge inside a **throwaway
     worktree** — `git worktree add <tmp> <target>` → `git merge --no-ff <branch>`
     there → `git worktree remove <tmp>`. Your checkout and working tree are never
     touched; no dirty-tree restriction; you are never stranded on `<target>`.
  5. Either path: success → `{status:"merged", onto:target}`. On merge failure,
     capture `git diff --name-only --diff-filter=U` → `git merge --abort` →
     `{status:"conflict", files, onto:target}` (in the `--onto` path the abort +
     `worktree remove` both happen in the temp worktree, leaving nothing behind).
- **`reject(branch)`** — `git branch -D <branch>`; best-effort
  `git worktree prune` to clear any stale worktree (the proposal worktree is
  normally already removed by the Scheduler).

### 4.3 CLI surface (`agent-team-proposals`)

```
agent-team-proposals list                 # table: branch · sha7 · #commits · finding (first line)
agent-team-proposals show   <branch>       # finding + full diff
agent-team-proposals accept <branch> [--onto <ref>]
agent-team-proposals reject <branch>
# global: --repo <path>   (default cwd)
```

---

## 5. Data flow

1. **(S4, earlier session)** An ambient reaction stages `agentteam/reviewer-<sha7>`
   from your commit and, if a diff was produced, the host amends the proposal
   commit to carry the reviewer's finding as an `Ambient-Finding` trailer. The
   branch is never merged.
2. **(S6, later session)** You run `agent-team-proposals list` → see open
   proposals with their findings → `show <branch>` to read the rationale + diff →
   `accept <branch>` (merge onto your current branch) or `reject <branch>`
   (delete it).
3. Accept merges cleanly → the improvement lands on your branch; or conflicts →
   the merge is aborted, conflicted files are reported, the proposal is untouched
   for a manual retry.

---

## 6. Error handling

- **No proposals / unknown branch** — `list` prints "no open proposals"; `show`/
  `accept`/`reject` on an unknown branch error clearly, no mutation.
- **Accept onto your current branch with a dirty tree** — let `git merge` decide:
  it proceeds on a clean tree and refuses (untouched) if local changes would be
  overwritten; surface git's message verbatim. (The `--onto <other>` path is
  unaffected — it merges in a throwaway worktree and never reads your working tree.)
- **Empty proposal (commitCount 0)** — `accept` returns `nothing` (the "no
  changes" reviewer left an empty branch); `list` still shows it so `reject` can
  clean it up.
- **Conflict** — files reported, merge aborted, branch intact (no resolution loop).
- **Missing trailer** — `finding` is `""`; everything else still works (the finding
  is decoration, not a dependency).

---

## 7. Testing (all offline, temp repos, real git via `NodeGitRunner`)

- **Core `ProposalCoordinator`** (`packages/core/tests/proposals.test.ts`):
  `list` finds staged branches with sha7/commitCount/finding; `diff` returns the
  reviewed-range diff; `accept` clean-merges onto HEAD and advances it; `accept`
  on a divergent target reports `conflict` + aborts (tree clean afterward);
  `accept` on an empty branch returns `nothing`; `reject` deletes the branch.
- **Host integration** (`packages/host-headless/tests/proposals-flow.test.ts`):
  run `composeAmbient` (scripted `QueryFn`) to stage a *real* proposal with a
  finding trailer, then drive `ProposalCoordinator` to `list` (finding present) →
  `accept` and assert the reviewed file change landed on HEAD.

---

## 8. Scope fence

**In v1:** `ProposalCoordinator` (list/diff/accept/reject) in core; the
`agent-team-proposals` CLI; the `composeAmbient` finding-trailer persist; offline
tests.

**Deferred (explicit out of scope):** VS Code review/promote panel; reviewing
the team-run `agentteam/integration` branch; auto-promote / policy-gated promote;
conflict-resolution re-attempt loop; batch accept/reject; pulling findings from
the S5 memory store.

---

## 9. File map

| File | Action |
|---|---|
| `packages/core/src/proposals.ts` | NEW — `ProposalCoordinator` + `Proposal`/`AcceptOutcome` types (pure, `GitRunner` port) |
| `packages/core/src/index.ts` | MODIFY — `export * from "./proposals.js"` |
| `packages/core/tests/proposals.test.ts` | NEW — list/diff/accept-clean/accept-conflict-aborts/accept-empty/reject |
| `packages/host-headless/src/compose-ambient.ts` | MODIFY — persist finding as an `Ambient-Finding` commit trailer (temp-worktree amend) when a proposal is staged |
| `packages/host-headless/src/cli-proposals.ts` | NEW — `agent-team-proposals` CLI (list/show/accept/reject, `--repo`, `--onto`) |
| `packages/host-headless/package.json` | MODIFY — add the `agent-team-proposals` bin |
| `packages/host-headless/tests/proposals-flow.test.ts` | NEW — staged proposal → list (finding) → accept (HEAD advanced) |

---

## 10. Open questions for the planning phase (not blockers)

- **Trailer amend mechanism** — spec uses a temp-worktree `--amend`. The plan
  confirms the exact temp-worktree path + cleanup (and that the proposal-commit
  SHA rewrite is invisible to the watcher, since the watched HEAD is the human's
  branch, not the reviewer branch).
- **Temp-worktree path for `--onto`** — the plan confirms the temp-worktree
  location (under `.worktrees/`, like `IntegrationCoordinator`) and that it is
  always removed, including on the conflict/abort path.
- **Already-merged proposals** — whether `list` should flag a proposal whose
  commits are already reachable from HEAD (stale). Defer unless trivial.

---

## 11. Acceptance criteria

- `npm run build` exit 0; full suite green and **above the current 170 baseline**.
- Core barrel stays **port-pure** — `proposals.ts` imports only the `GitRunner`
  type; no `node:*` in `dist/index.js`.
- Scheduler/bus/worktree/integration runtime **unchanged** — `proposals.ts` is
  additive; the only S4 edit is `composeAmbient` writing a finding trailer (host-only).
- Offline tests prove: a staged proposal lists with its finding; `accept`
  clean-merges onto HEAD; a divergent `accept` reports `conflict` and aborts;
  `reject` deletes the branch.
- `agent-team-proposals` exposes `list` / `show` / `accept` / `reject`.
