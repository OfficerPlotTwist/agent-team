import type { RequestCategory } from "@agent-team/core";

const READ_ONLY = new Set(["Read", "Grep", "Glob", "NotebookRead", "TodoWrite"]);
const WEB = new Set(["WebFetch", "WebSearch"]);
const FILE_MUTATING = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// HARD-RULE patterns over a Bash command string. Conservative: a match wins.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\.ssh\//i,
  /id_rsa|id_ed25519/i,
  /[A-Z_]*(API_KEY|SECRET|TOKEN|PASSWORD)[A-Z_]*/,
  /\.env\b/i,
  /credentials/i,
];
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bsudo\b/i,
  /\b(reboot|shutdown|mkfs|dd\s+if=)\b/i,
  /\|\s*sh\b/i,
  /\bcurl\b.*\|/i,
  /\bnpm\s+publish\b/i,
  />\s*\/dev\/sd/i,
];

function classifyBash(command: string): RequestCategory {
  for (const re of CREDENTIAL_PATTERNS) if (re.test(command)) return "credential";
  for (const re of DESTRUCTIVE_PATTERNS) if (re.test(command)) return "destructive";
  return "external_action";
}

/**
 * Map an SDK tool call to a normalized RequestCategory.
 * Read-only -> info. File edits -> approval. Web -> external_action.
 * Bash -> external_action, escalated to destructive/credential by pattern (hard rules).
 * Unknown -> approval (conservative).
 */
export function classifyTool(toolName: string, input: Record<string, unknown>): RequestCategory {
  if (READ_ONLY.has(toolName)) return "info";
  if (FILE_MUTATING.has(toolName)) return "approval";
  if (WEB.has(toolName)) return "external_action";
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return classifyBash(command);
  }
  return "approval";
}
