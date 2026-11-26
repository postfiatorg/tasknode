// Discord announcement check for the board manager.
//
// Network tasks require a public Discord announcement as an anti-sybil proof:
// it ties the work to a real member of the server. The manager's terminal has
// no Discord access, so the server resolves each announcement link with its
// own bot and reports what it found: who posted it, when, and whether that is
// the contributor's linked Discord account. Read-only.
import { query as defaultQuery } from "./db/pool.js";
import { discordEvidencePolicy, parseDiscordMessageLink } from "./task-review-evidence.js";

const MAX_LINKS = 3;
const FETCH_TIMEOUT_MS = 4000;
const SEPARATORS = new Set([" ", "\n", "\t", "\r", '"', "'", "<", ">", "(", ")", "[", "]", ",", "\\"]);

// Every distinct Discord message link in the submitted payloads.
export function discordMessageLinks(...payloads) {
  const text = payloads.map((value) => (typeof value === "string" ? value : JSON.stringify(value ?? ""))).join(" ");
  const found = new Map();
  let token = "";
  for (const char of `${text} `) {
    if (!SEPARATORS.has(char)) { token += char; continue; }
    if (token.includes("discord")) {
      const link = parseDiscordMessageLink(token);
      if (link && !found.has(link.messageId)) found.set(link.messageId, link);
    }
    token = "";
  }
  return [...found.values()].slice(0, MAX_LINKS);
}

async function linkedDiscordUsernames(accountId, queryImpl) {
  const result = await queryImpl(
    "SELECT identity_json FROM account_provider_identities WHERE account_id = $1 AND provider = 'discord'",
    [accountId]
  );
  return result.rows
    .map((row) => String(row.identity_json?.username || "").trim().toLowerCase())
    .filter(Boolean);
}

async function resolveMessage(link, { policy, usernames, taskCreatedAt, fetchImpl }) {
  const base = { url: link.url, channel_id: link.channelId, message_id: link.messageId };
  if (policy.allowedGuildIds.length && !policy.allowedGuildIds.includes(link.guildId)) return { ...base, status: "wrong_server" };
  if (policy.allowedChannelIds.length && !policy.allowedChannelIds.includes(link.channelId)) return { ...base, status: "wrong_channel" };
  let response;
  try {
    response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(link.channelId)}/messages/${encodeURIComponent(link.messageId)}`, {
      headers: { authorization: `Bot ${policy.botToken}`, "user-agent": "tasknode-board-discord-check" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { ...base, status: "check_failed", detail: String(error?.message || error).slice(0, 160) };
  }
  if (response.status === 404) return { ...base, status: "not_found" };
  if (response.status === 401 || response.status === 403) return { ...base, status: "bot_cannot_read", detail: `HTTP ${response.status}` };
  if (!response.ok) return { ...base, status: "check_failed", detail: `HTTP ${response.status}` };
  const message = await response.json();
  const author = String(message?.author?.username || "").trim().toLowerCase();
  const postedAt = message?.timestamp ? new Date(message.timestamp) : null;
  return {
    ...base,
    status: "found",
    author_username: author,
    author_is_bot: message?.author?.bot === true,
    author_is_linked_account: Boolean(author) && usernames.includes(author),
    posted_at: postedAt ? postedAt.toISOString() : null,
    posted_after_task_created: Boolean(postedAt && taskCreatedAt && postedAt >= new Date(taskCreatedAt)),
    content: String(message?.content || "").slice(0, 600),
  };
}

// Returns { state, linked_discord_usernames, announcements, verdict }.
// verdict "verified" means one announcement exists, was posted by the
// contributor's linked Discord account, after the task was created.
export async function boardDiscordEvidence({ accountId = "", taskCreatedAt = null, payloads = [] } = {}, {
  env = process.env, fetchImpl = fetch, queryImpl = defaultQuery,
} = {}) {
  const links = discordMessageLinks(...payloads);
  if (!links.length) return { state: "no_link_submitted", announcements: [], verdict: "none" };
  const policy = discordEvidencePolicy(env);
  if (!policy.botToken) return { state: "bot_not_configured", announcements: links.map((link) => ({ url: link.url, status: "unchecked" })), verdict: "unchecked" };
  const usernames = await linkedDiscordUsernames(accountId, queryImpl);
  const announcements = await Promise.all(links.map((link) => resolveMessage(link, { policy, usernames, taskCreatedAt, fetchImpl })));
  const verified = announcements.some((item) => item.status === "found" && item.author_is_linked_account && item.posted_after_task_created && !item.author_is_bot);
  const unreadable = announcements.every((item) => ["check_failed", "bot_cannot_read"].includes(item.status));
  return {
    state: "checked",
    linked_discord_usernames: usernames,
    announcements,
    verdict: verified ? "verified" : unreadable ? "unchecked" : "not_verified",
  };
}
