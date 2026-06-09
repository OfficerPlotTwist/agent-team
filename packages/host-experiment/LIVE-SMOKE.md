# host-experiment live smoke (manual, NOT CI)

Prereqs: `npm run build`; Claude Code CLI OAuth creds (`~/.claude/.credentials.json`);
a THROWAWAY git repo with at least one commit (not OS-sandboxed — B1 caveat).

1. Throwaway repo:
   `git init -b main /tmp/hx && cd /tmp/hx && echo seed > seed.txt && git add . && git commit -m base`
2. `variants.json`:
   `[{"name":"haiku","model":"claude-haiku-4-5-20251001"},{"name":"sonnet","model":"claude-sonnet-4-6"}]`
3. Run:
   `node packages/host-experiment/dist/cli.js --task "create fizzbuzz.py printing 1..20" --task-id fizz --variants variants.json --repo /tmp/hx --report /tmp/hx/report.md`
4. VERIFY:
   - [ ] both variants run; the printed table shows per-variant cost / turns / status / branch, and a `winner:` line
   - [ ] `git -C /tmp/hx branch` lists `agentteam/coder-fizz__haiku` and `...__sonnet`, BOTH unmerged
   - [ ] the winner is promoted: `agentteam/winner-fizz` exists and points at the winning variant's branch
   - [ ] `main` is unchanged (`git -C /tmp/hx rev-parse main` == the base from step 1); NO `agentteam/integration` branch exists
   - [ ] `git -C /tmp/hx show agentteam/coder-fizz__haiku:fizzbuzz.py` shows that variant's output
   - [ ] `/tmp/hx/report.md` (+ `.json`) written, ranked, **Winner** marked, wall-clock labeled advisory, footer present
   - [ ] per-variant diff artifacts written: `/tmp/hx/haiku.diff` and `/tmp/hx/sonnet.diff` exist and differ
5. Validity: confirm the two variants produced INDEPENDENT solutions (neither references the other) —
   they forked from the same frozen base and never saw each other's branch.

## Notes

- The winner branch uses `git branch -f`, so re-runs on the same repo overwrite it cleanly (idempotent).
- Promotion is non-destructive: it creates/moves `agentteam/winner-<task>` only; your working branch and
  `main` are never touched. To adopt the winner: `git merge agentteam/winner-fizz` (or cherry-pick) yourself.
- Same OS-sandbox caveat as B1 — run only in a throwaway repo; under autopilot a destructive tool call is
  GATE→auto-denied (uniformly across variants), but file writes auto-allow.
