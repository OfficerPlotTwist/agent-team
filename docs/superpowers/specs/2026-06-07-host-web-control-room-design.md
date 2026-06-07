# host-web — Control Room as a standalone webapp (design)

**Date:** 2026-06-07
**Status:** Approved design, pre-plan
**Milestone:** `@agent-team/host-web` v1

## 1. Goal

A browser-based Control Room: live bus feed, gate inbox (allow/deny), and S6
proposal review (list/diff/accept/reject) — served by a single Node process
that owns the run, the same way `composeVscode` does. No VS Code required.

Feasibility is pre-validated by two spikes (2026-06-06/07, recorded in project
memory; artifacts at `Busdriver/agent-team/pretext-feed-spike/`):

- pretext virtualized feed over 10k events: marginal `prepare()` 0.12ms avg
  (warmup-dominated 19ms claim debunked), full `layout()` pass 20.3ms,
  scroll p95 frame delta 8.3ms with ~30 live DOM rows.
- exclusion-geometry dodge (not in v1 scope): rebuild 0.08ms avg per drag frame.

## 2. Locked decisions

1. **Approach A — self-contained host.** `composeWeb` owns the run
   (Scheduler + NodeGitRunner + ClaudeAdapter + PolicyStore), mirrors
   `composeVscode`, does NOT import host-headless. Attach-mode (sidecar
   watching an external run) is explicitly deferred — it requires a bus
   serialization seam that does not exist and is its own milestone.
2. **v1 scope: feed + gate inbox + S6 proposals UI.** No run launcher, no
   dodge-circle flourish.
3. **Transport: WebSocket via the `ws` package** (user choice over SSE+POST).
   Consequence accepted: heartbeat, reconnect, and resume-replay are OUR
   protocol obligations (SSE would have provided reconnect/Last-Event-ID
   natively). These are spec'd in §4 and MUST be implemented and tested in v1,
   not deferred.
4. **Gate semantics: fail closed.** Socket drop ⇒ pending gates deny — same
   semantics as `ControlRoomPanel.askGate` resolving false on dispose.
5. **Zero changes outside the new package.** `packages/core`, `adapters-*`,
   `host-headless`, `host-vscode` end this milestone with an empty diff.

## 3. Package layout

```
packages/host-web/
  package.json            # deps: ws, @agent-team/core, @agent-team/adapters-claude,
                          #       @anthropic-ai/claude-agent-sdk
                          # devDeps: vite, @chenglou/pretext, typescript, vitest, @types/ws
  src/
    protocol.ts           # envelope + command types (shared server/UI, types only)
    ring-buffer.ts        # fixed-capacity seq-stamped envelope buffer (pure)
    gate-bridge.ts        # requestId-keyed pending gates, fail-closed
    proposals-service.ts  # thin wrapper over core ProposalCoordinator
    server.ts             # node:http + ws upgrade + static serving of ui/dist
    compose.ts            # composeWeb composition root
    cli.ts                # agent-team-web entry
                          # flags: --graph <file.json> (required), --repo <path>
                          #        (default cwd), --port <n> (default 7340),
                          #        --cost-ceiling <usd>, --memory <db> —
                          #        ceiling/memory semantics identical to host-headless
  ui/                     # vite project (vanilla TS, no framework)
    index.html
    src/main.ts           # boot, ws client (reconnect+resume), panes
    src/feed.ts           # pretext virtualized feed (spike pattern)
    src/gates.ts          # gate inbox pane
    src/proposals.ts      # proposals pane (list → diff → accept/reject)
    src/virtualizer.ts    # pure offset/window math (node-testable)
  tests/                  # offline vitest (see §8)
  LIVE-SMOKE.md           # manual browser smoke, not CI
```

`ui/dist` is gitignored; `npm run build:ui` (vite build) produces it; the
server 404s with a friendly "run build:ui" message when dist is absent.
UI runtime deps (`@chenglou/pretext`) are devDeps: they exist only inside the
vite bundle, never in server runtime.

## 4. WS protocol

Envelope: every server→browser message carries a server-assigned monotonic
`seq` (per-process, starts 1). Browser→server commands carry no seq.

server → browser:

| type | fields | source |
|---|---|---|
| `event` | `payload: BusEvent` | MessageBus subscriber |
| `gate` | `requestId, category, summary` | GateBridge |
| `gate_resolved` | `requestId, allowed` | GateBridge (echo to all clients) |
| `proposals` | `items: AmbientProposal[]` | ProposalsService (on connect + after change) |
| `proposal_diff` | `branch, diff` | reply to `proposal_show` |
| `proposal_outcome` | `branch, outcome` (incl. conflict file list) | after accept/reject |
| `hello` | `latestSeq, runState: "running"\|"settled", gapped?: true` | on (re)connect, before replay |

browser → server: `allow {requestId}` · `deny {requestId}` ·
`proposal_show {branch}` · `proposal_accept {branch, onto?}` ·
`proposal_reject {branch}` · `proposal_refresh {}` · `resume {afterSeq}`.

**Resume:** server keeps a ring buffer of the last 5,000 envelopes. On
`resume {afterSeq}` it replays every buffered envelope with `seq > afterSeq`
in order. If `afterSeq` has fallen out of the buffer, server sends `hello`
with a `gapped: true` flag and the client renders a "missed events" divider.

**Heartbeat:** `ws` server-side ping every 15s; a connection missing 2 pongs
is terminated. Client reconnects with exponential backoff (0.5s → 8s cap) and
sends `resume` with the last seq it saw.

**Multi-client:** all connected clients receive all envelopes; first
allow/deny wins a gate, others get `gate_resolved`.

## 5. Gate bridge

`GateBridge` implements the same role as `ControlRoomPanel.askGate`:

- `askGate(requestId, category, summary): Promise<boolean>` — broadcasts the
  `gate` envelope, stores the resolver keyed by `requestId`.
- First `allow`/`deny` command resolves it; subsequent commands for the same
  id are ignored; `gate_resolved` is broadcast.
- **Fail closed:** if ALL clients disconnect while gates are pending, pending
  gates resolve `false` after a short grace window (5s) to survive refreshes.
- No second timeout: `PendingPermissions`' existing timeout→deny in
  adapters-claude remains the only timer.

Wired into the broker exactly as in `composeVscode` (the `BrokerHandlers`
seam); the policy preset stays `autopilot`.

## 6. Proposals service

Thin wrapper over core's `ProposalCoordinator` (S6):

- Push `proposals` (from `coord.list()` — which already skips malformed
  branches) on: client connect, after accept/reject, and on a client
  `proposal_refresh` command (a Refresh button in the UI). NOTE: composeWeb
  does NOT run ambient agents — proposal branches are staged by a separate
  `agent-team-ambient` process into the same repo, so there is no in-process
  event to react to; explicit refresh is the honest trigger. (A repo watcher
  is deferred.)
- `proposal_show` → `coord.diff(branch)` → `proposal_diff`.
- `proposal_accept {branch, onto?}` → `coord.accept` → `proposal_outcome`
  (conflict outcome carries the `--diff-filter=U` file list verbatim) + a
  refreshed `proposals` push.
- Commands are serialized through a single in-process queue — `accept`
  mutates the repo; concurrent accepts from two tabs must not interleave
  (S6's per-instance `acceptSeq` protects paths, not repo state).

## 7. UI

Vanilla TS + vite, no framework — same discipline as the webview, and the
pretext feed wants direct DOM control. Three panes:

- **Feed** (`feed.ts` + `virtualizer.ts`): the spike pattern productionized —
  `prepare()` once per event (cache), heights via `layout()`, prefix-sum
  offsets, binary-search window, ~30 absolute-positioned rows, spacer div.
  Auto-stick to bottom unless the user has scrolled up (the webview's
  existing scroll-detection behavior). `virtualizer.ts` is pure math
  (offsets, window, stick state) — node-testable without a DOM.
- **Gate inbox** (`gates.ts`): pending gates pinned above the feed, loudest
  element on screen; Allow/Deny buttons send commands; `gate_resolved`
  removes entries (covers multi-tab races).
- **Proposals** (`proposals.ts`): branch list with finding summaries (from
  the S6 `Ambient-Finding:` trailer, surfaced via `coord.list()`), per-branch
  diff view (monospace pre, no syntax highlighting in v1), Accept/Reject with
  outcome toast; conflict outcome lists the conflicted files.

Reconnect UX: a thin connection bar (connected / reconnecting / gapped).

## 8. Testing

Offline vitest, existing harness idioms (`WritingAdapter`, `makeTempRepo`):

- **Protocol/server:** compose against a fake adapter, connect a real `ws`
  client to an ephemeral-port server. Assert: event envelopes arrive in seq
  order; gate round-trip (gate → allow → adapter proceeds); fail-closed
  (drop all clients mid-gate → denied after grace); resume replays exactly
  the gap; ring-buffer overflow → `gapped` hello.
- **Proposals:** temp repo with a staged `agentteam/reviewer-*` branch →
  list/show/accept round-trip over the socket; conflict path asserts the
  file list.
- **UI pure logic:** `virtualizer.ts` (offsets, window, stick-to-bottom
  transitions) in plain node tests.
- **Not in CI:** pretext rendering (needs a browser font engine) →
  `LIVE-SMOKE.md` manual smoke + a playwright screenshot script following the
  spike's `shot.mjs` pattern.

Gate: full workspace `npm run build` exit 0 and all suites green, count
strictly greater than the current 181.

## 9. Non-goals (v1)

- No auth; server binds `127.0.0.1` only (refusing `--host` by design).
- No run launcher; the run is whatever the CLI was started with.
- No attach-mode / multi-run; no editor surface; no dodge-circle flourish
  (carve pattern recorded in project memory if wanted later).
- No syntax-highlighted diffs.

## 10. Done criteria

1. `agent-team-web --graph g.json --repo <r>` serves the Control Room; a
   browser shows the live feed; gates surface and resolve from the page;
   proposals list/diff/accept/reject work end-to-end on a temp repo.
2. Zero diff outside `packages/host-web` (plus root workspace wiring:
   `package.json` workspaces entry + lockfile).
3. Build + tests green per §8 gate.
4. `LIVE-SMOKE.md` documents the manual browser smoke.
