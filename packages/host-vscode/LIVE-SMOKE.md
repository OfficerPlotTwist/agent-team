# host-vscode Live Smoke

Manual validation checklist. Run after every structural change to `composeVscode` or `ControlRoomPanel`.

## Prerequisites

- VS Code 1.85+
- A git repo open as the workspace folder (use the same repo as `host-headless` live smoke)
- `agentteam/integration` branch exists (or will be created automatically)
- Claude Code CLI auth present at `~/.claude/.credentials.json`

## Build

```bash
npm run build -w @agent-team/host-vscode
```

## Install the extension (dev mode)

In VS Code: **Run > Start Debugging** with a launch config pointing to `packages/host-vscode/dist/extension.js`, or use the Extension Development Host:

1. Open `packages/host-vscode/` in VS Code
2. Press F5 (or Run > Start Debugging)
3. A new Extension Development Host window opens

## Smoke steps

### 1. Run a single-node graph

Create `/tmp/smoke-graph.json`:
```json
[{ "id": "n1", "role": "coder", "goal": "write a file called hello.txt containing the text hello world", "dependsOn": [] }]
```

In the Extension Development Host:
1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **"Agent Team: Run"**
3. Select `smoke-graph.json` when prompted
4. The Control Room panel opens

**Expected:**
- Live feed shows `tool_call` and `file_change` events as the agent works
- `done` event appears when the agent finishes
- VS Code notification: "Agent Team done — status: completed | completed: n1 | blocked: none"
- Verify `hello.txt` committed to `agentteam/integration`:
  ```bash
  git show agentteam/integration:hello.txt
  ```

### 2. Verify gate card (GATE path)

Temporarily change `store.applyPreset("autopilot")` in `compose.ts` to `store.applyPreset("gatekeep")`, rebuild, and re-run the smoke.

**Expected:**
- A gate card appears in the Action Inbox with Allow / Deny buttons
- Clicking Allow unblocks the agent
- Clicking Deny causes an error event in the feed

Revert the preset change after confirming.

### 3. Verify retain-context

While a run is in progress:
1. Switch to another editor tab (hides the webview)
2. Switch back to the Control Room tab

**Expected:** Feed log is intact (no blank panel, no reset to empty).

## Pass criteria

- [ ] Live feed populates during run
- [ ] Gate card appears and resolves correctly
- [ ] `done` event and VS Code notification fire on completion
- [ ] `hello.txt` present in `agentteam/integration`
- [ ] Panel state survives tab switch
