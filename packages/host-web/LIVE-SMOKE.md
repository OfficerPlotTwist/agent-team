# host-web live smoke (manual, NOT CI)

Prereqs: `npm run build && npm run build:ui -w @agent-team/host-web`; Claude Code
CLI OAuth creds present (`~/.claude/.credentials.json`); a THROWAWAY git repo
(host-web is not OS-sandboxed — same caveat as B1).

1. Make a throwaway repo:
   `git init -b main /tmp/hw-smoke && cd /tmp/hw-smoke && git commit --allow-empty -m base`
2. Graph file `g.json`:
   `[{ "id": "n1", "role": "coder", "goal": "create hello.txt containing 'hi', then run: rm -rf ./scratch", "dependsOn": [] }]`
3. Run: `node packages/host-web/dist/cli.js --graph g.json --repo /tmp/hw-smoke --model claude-haiku-4-5-20251001`
4. Open the printed URL. VERIFY:
   - [ ] conn bar green "connected"
   - [ ] feed streams events live (tool_call / file_change rows)
   - [ ] the `rm -rf` surfaces as a DESTRUCTIVE gate; click Allow; run completes
   - [ ] `git show agentteam/integration:hello.txt` prints "hi"
   - [ ] refresh the page mid-run → feed backfills via resume (no duplicates)
   - [ ] close ALL tabs while a gate is pending → after ~5s the CLI shows the deny
   - [ ] stage a proposal branch (see tests/compose-web.test.ts stageProposal) →
         Refresh lists it; diff shows; Accept merges onto HEAD
5. Scroll feel: with thousands of events, scrolling stays smooth and the DOM
   holds ~30 rows (inspect element count under #feed).

## Quick screenshot (headless)

With a run already serving, capture the live page:
`node packages/host-web/scripts/shot.mjs http://127.0.0.1:7340/`
→ writes `packages/host-web/scripts/control-room.png`.

## Known cosmetic limitation (v1)

The "⚠ missed events" divider (rendered after a ring-buffer-overflow resume gap)
is positioned once and does NOT reposition on a subsequent container resize, so
it can visually drift from its row if you resize the window after a gap. Cosmetic
only — feed content and ordering are unaffected. Fix deferred.
