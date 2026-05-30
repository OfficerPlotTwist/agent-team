# B2 Live Smoke — Parallel Team + Cost Ceiling (manual — costs real API tokens)

Live analog of the offline two-node + cost-ceiling tests. Run manually after changes
touching the host, adapter, or SDK version. NOT part of CI. Throwaway repo only — B1/B2
are NOT OS-sandboxed.

## Prereqs
- Claude Code CLI auth available (`~/.claude/.credentials.json`) or `ANTHROPIC_API_KEY` set.
- Workspace built: from `vsCode Fork/`: `npm run build`.

## 1. Parallel multi-agent (two independent nodes)
1. Throwaway repo:
   ```sh
   tmp=$(mktemp -d); cd "$tmp" && git init -b main && git config user.email t@t.com && git config user.name T
   printf '# scratch\n' > README.md && git add . && git commit -m base && git branch agentteam/integration
   ```
2. Graph file (two INDEPENDENT nodes => run concurrently):
   ```sh
   cat > graph.json <<'JSON'
   [
     { "id": "a", "role": "coder",     "goal": "create a file alpha.txt containing the text ALPHA", "dependsOn": [] },
     { "id": "b", "role": "architect", "goal": "create a file beta.txt containing the text BETA",  "dependsOn": [] }
   ]
   JSON
   ```
3. Run:
   ```sh
   node "/c/Users/nik/Documents/AI/vsCode Fork/packages/host-headless/dist/cli.js" --graph "$tmp/graph.json" --repo "$tmp" --max-turns 50
   ```
4. Confirm: both `coder#a` and `architect#b` appear on the feed; each shows `~ <file>` + `✓ done`;
   `git show agentteam/integration:alpha.txt` and `:beta.txt` both succeed; `total cost` ≈ sum; `completed: a, b`.

## 2. Cost ceiling (dependency chain so the cap bites deterministically)
1. New throwaway repo (repeat step 1 with a fresh `$tmp`).
2. Chain graph (`b` depends on `a`):
   ```sh
   cat > graph.json <<'JSON'
   [
     { "id": "a", "role": "coder", "goal": "create a file a.txt with the text A", "dependsOn": [] },
     { "id": "b", "role": "coder", "goal": "create a file b.txt with the text B", "dependsOn": ["a"] }
   ]
   JSON
   ```
3. Run with a ceiling BELOW one node's expected cost (e.g. 0.01):
   ```sh
   node "/c/Users/nik/Documents/AI/vsCode Fork/packages/host-headless/dist/cli.js" --graph "$tmp/graph.json" --repo "$tmp" --cost-ceiling 0.01 --max-turns 50
   ```
4. Confirm: `b` shows `✗ … team cost ceiling $0.0100 reached …` on the feed, `b` appears in the
   final `blocked:` line (it emitted no `done`, so the core gate reports it honestly — not `completed`),
   and `git show agentteam/integration:b.txt` FAILS (b's work was never merged — no spend). `a.txt`
   is present and `a` is in `completed:`.

## maxTurns is a per-agent turn budget
`--max-turns` (the Scheduler `budget.maxTurns`) is counted **per agent**: only a node that
exceeds its OWN budget is interrupted (and reported in `blocked`); healthy parallel siblings are
unaffected. An interrupted node emits no `done`, so the core gate reports it as `blocked` and does
not merge its partial work. Still set it generously (≥ ~25/node) so real agents have room to
finish; 50 is safe for these smokes. (Pre-core-robustness this was a single global counter that
could starve healthy siblings — fixed 2026-05-28.)

## Best-effort note
The ceiling is enforced at node-dispatch time against `ledger.total()`. Two INDEPENDENT nodes
launched in the same parallel wave can both start before either's cost lands, so the first wave
may overshoot the cap. The ceiling reliably gates downstream/later nodes (hence the dependency
chain in test 2). For strict pre-spend bounding, model work as a chain.

## Cleanup
`rm -rf "$tmp"` for each throwaway repo.
