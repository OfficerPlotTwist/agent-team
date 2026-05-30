// @ts-check
// Runs inside the VS Code webview sandbox — no Node APIs.

const vscode = acquireVsCodeApi();
const feed = /** @type {HTMLUListElement} */ (document.getElementById("feed"));
const inbox = /** @type {HTMLDivElement} */ (document.getElementById("inbox"));
let userScrolled = false;

if (feed) {
  feed.addEventListener("scroll", () => {
    userScrolled = feed.scrollTop + feed.clientHeight < feed.scrollHeight - 20;
  });
}

const BADGE_COLORS = /** @type {Record<string, string>} */ ({
  file_change: "#4a9eff",
  done: "#4caf50",
  error: "#f44336",
  action_request: "#ff9800",
  tool_call: "#9c7cff",
  message: "#888",
});

window.addEventListener("message", (/** @type {MessageEvent} */ event) => {
  const msg = /** @type {{ type: string; payload?: unknown; requestId?: string; category?: string; summary?: string }} */ (event.data);
  if (msg.type === "event") appendToFeed(/** @type {Record<string,unknown>} */ (msg.payload));
  if (msg.type === "gate") appendGateCard(msg);
});

/**
 * @param {Record<string, unknown>} event
 */
function appendToFeed(event) {
  if (!feed) return;
  const li = document.createElement("li");
  li.className = "feed-item";

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = new Date().toLocaleTimeString();

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = String(event["kind"] ?? "");
  badge.style.backgroundColor = BADGE_COLORS[String(event["kind"])] ?? "#888";

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = summarize(event);

  li.append(time, badge, text);
  feed.appendChild(li);
  if (!userScrolled) feed.scrollTop = feed.scrollHeight;
}

/**
 * @param {Record<string, unknown>} e
 * @returns {string}
 */
function summarize(e) {
  const kind = String(e["kind"]);
  if (kind === "file_change") return String(e["path"] ?? "");
  if (kind === "done") return `${e["from"]}: ${String(e["summary"] ?? "").slice(0, 120)}`;
  if (kind === "error") return `${e["from"]}: ${String(e["message"] ?? "").slice(0, 120)}`;
  if (kind === "action_request") return `${e["from"]} [${e["category"]}] ${String(e["summary"] ?? "").slice(0, 120)}`;
  if (kind === "tool_call") return `${e["from"]} → ${e["name"]}`;
  if (kind === "message") return `${e["from"]}: ${String(e["text"] ?? "").slice(0, 120)}`;
  return "";
}

/**
 * @param {{ requestId?: string; category?: string; summary?: string; payload?: unknown }} msg
 */
function appendGateCard(msg) {
  if (!inbox) return;
  const card = document.createElement("div");
  card.className = "gate-card";

  const header = document.createElement("div");
  header.className = "gate-header";
  header.textContent = `[${msg.category ?? "?"}] ${msg.summary ?? ""}`;

  const payload = document.createElement("pre");
  payload.className = "gate-payload";
  payload.textContent = msg.payload
    ? JSON.stringify(msg.payload, null, 2).slice(0, 200)
    : "";

  const actions = document.createElement("div");
  actions.className = "gate-actions";

  const allow = document.createElement("button");
  allow.className = "btn-allow";
  allow.textContent = "Allow";
  allow.addEventListener("click", () => {
    vscode.postMessage({ type: "allow", requestId: msg.requestId });
    card.remove();
  });

  const deny = document.createElement("button");
  deny.className = "btn-deny";
  deny.textContent = "Deny";
  deny.addEventListener("click", () => {
    vscode.postMessage({ type: "deny", requestId: msg.requestId });
    card.remove();
  });

  actions.append(allow, deny);
  card.append(header, payload, actions);
  inbox.appendChild(card);
}
