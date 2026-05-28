# B1 Live Smoke (manual — costs real API tokens)

This is the divergence guard for the recorded-SDK fixtures. Run it manually after
changes that touch the adapter or SDK version. NOT part of CI.

## Prereqs
- `ANTHROPIC_API_KEY` set in the environment, OR Claude Code CLI auth available.
- Workspace built: from `vsCode Fork/`: `npm run build`.

## Procedure
1. Create a throwaway temp git repo:
   ```sh
   tmp=$(mktemp -d)
   cd "$tmp" && git init -b main && git config user.email t@t.com && git config user.name T
   printf '# scratch\n' > README.md && git add . && git commit -m base
   ```
2. Run one real goal:
   ```sh
   node /c/Users/nik/Documents/AI/vsCode\ Fork/packages/host-headless/dist/cli.js \
     --goal "create a file hello.txt containing the text hello world" --repo "$tmp"
   ```
3. Confirm:
   - the live feed shows `message`, a `Write` tool_call (gated → allowed under autopilot), `~ hello.txt`, then `✓ done`;
   - `git show agentteam/integration:hello.txt` prints `hello world`;
   - `total cost: $…` is non-zero.
4. **Re-record fixtures:** if the SDK message shapes changed, update the cast
   fixtures in `adapters-claude/tests/event-mapper.test.ts` and
   `claude-adapter.test.ts` to match what you observed.
5. Delete the temp repo: `rm -rf "$tmp"`.

## Safety note
B1 is NOT OS-sandboxed. The agent runs with Bash/Write under the Autopilot preset;
only credential/destructive tool calls hit a GATE prompt. Run only in a throwaway repo.
