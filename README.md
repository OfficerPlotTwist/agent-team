# agent-team

A multi-agent orchestration runtime for code work. Agents run **concurrently on
the same repository** without stepping on each other, because isolation is a
git worktree per task and integration is a real merge.

```
TaskGraph ──► Scheduler ──┬─► worktree/task-a ──► adapter ──► merge ─┐
  (DAG,                   ├─► worktree/task-b ──► adapter ──► merge ─┼─► integration
   acyclic-checked)       └─► worktree/task-c ── blocked (dep)       ─┘
                                    │
                            MessageBus (causal chains, cycle detection)
```

## The problem it solves

Fan out N agents on one codebase and they collide: two agents edit the same
file, a third reads a half-finished state, and the transcript gives you no way
to tell which change came from where. The usual answers are to serialize the
agents (slow) or to let them share a working tree and hope (unreliable).

This runtime takes the third option. Every ready task gets its **own git
worktree**. Agents never see each other's uncommitted work. When a task
finishes, its branch merges into an `integration` branch and its dependents
unlock. A merge conflict is not a crash — it is a `MergeResult` with a file
list, and the scheduler treats that node as blocked.

That makes the interesting failure modes *observable* instead of silent:

| Failure | How it surfaces |
|---|---|
| Two agents touch the same lines | `MergeResult { ok: false, conflicts: [...] }` |
| A task depends on something that never finishes | scheduler returns `"blocked"` |
| Agents talk in circles | `MessageBus` emits `CycleInfo` when one role recurs past `maxChainRepeats` in a causal chain |
| A run goes runaway | `Budget { maxTurns }` → status `"budget"` |

## Core concepts

**`TaskGraph`** — the unit of work. Validates at construction: duplicate ids
rejected, dependencies on unknown tasks rejected, and a three-colour DFS
asserts the graph is acyclic. A malformed plan fails before any model is
called, not halfway through.

**`Scheduler`** — executes a `TaskGraph`. Creates a worktree per ready node,
runs ready nodes concurrently, merges each branch into integration on `done`,
unlocks dependents, and terminates on exactly four conditions:
`complete` · `budget` · `stopped` · `blocked`.

**`Orchestrator`** — the simpler conversational sibling. Routes turns between
role-specialised adapters over the bus under a turn budget. Statuses:
`done` · `budget` · `stopped` · `drained`.

**`MessageBus`** — sequenced, timestamped event log with subscribers. Tracks
causal chains and fires a cycle listener when a role repeats too often in one
chain — the "two agents politely handing the same task back and forth"
failure, caught mechanically.

**`ActionBroker`** — resolves proposed actions before they take effect, so
policy sits between an agent's intent and the filesystem.

**`ProposalCoordinator`** — ambient agents stage work on proposal branches
rather than committing directly. List, diff, reject. Derived entirely from
git, so it depends on nothing but the `GitRunner` port.

## Layout

```
packages/
  core/                 orchestration engine — TaskGraph, Scheduler, Orchestrator,
                        MessageBus, ActionBroker, WorktreeManager, ProposalCoordinator,
                        context providers, policy presets
  adapters-claude/      model adapters — each implements the same AgentAdapter port,
  adapters-deepseek/    so adding a provider is an adapter, not a fork of the runtime
  adapters-codewhale/
  host-vscode/          hosts — each drives the same core through a different surface
  host-web/
  host-headless/
  host-experiment/      A/B harness: runs variants and reports per-variant model + tokens
```

The core is kept pure: anything touching `node:*` lives behind a port in
`core/src/node/` (`GitRunner`, a text context provider, a sqlite-vec context
provider). That is what lets the same engine run inside a VS Code extension, a
browser, and a headless CLI without conditional compilation.

## Build and test

```bash
npm install
npm run build
npm test
```

258 test cases across 67 test files (vitest); 27 of those files cover the core
engine — the graph validator, scheduler termination conditions, merge conflict
handling, and bus cycle detection.

## Status

Working research runtime, not a product. It has no external users, no release,
and no stability guarantee. It exists because the multi-agent coordination
problem is more interesting than the prompt-engineering problem, and the parts
worth getting right — isolation, termination, and observability of failure —
are the parts most frameworks leave to chance.
