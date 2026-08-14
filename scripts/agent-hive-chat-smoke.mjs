#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-agent-hive-chat-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_ENV = "development";
process.env.NODE_ENV = "development";
process.env.TASKNODE_DEV_AUTH_ENABLED = "true";
process.env.AMBIENT_API_KEY = "agent-hive-chat-smoke-key";
process.env.TASKNODE_JOBS_RETRIEVAL_ENABLED = "false";
process.env.TASKNODE_AGENT_HIVE_CHAT_RATE_LIMIT_MAX = "1";
process.env.TASKNODE_AGENT_HIVE_CHAT_RATE_LIMIT_WINDOW_MS = "60000";
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_POSTGRES_DISABLED = "true";
delete process.env.DATABASE_URL;
delete process.env.TASKNODE_DATABASE_ENABLED;

const originalFetch = globalThis.fetch;
let fetchCount = 0;
globalThis.fetch = async (url, options = {}) => {
  fetchCount += 1;
  assert.match(String(url), /\/chat\/completions$/);
  const body = JSON.parse(String(options.body || "{}"));
  assert.equal(body.model, "deepseek/deepseek-v4-flash-0731");
  return new Response(JSON.stringify({
    id: `resp_agent_hive_chat_${fetchCount}`,
    model: "deepseek-v4-pro",
    choices: [{ message: { content: `Hive reply ${fetchCount}.` }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 20,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 20,
      completion_tokens: 6,
      total_tokens: 26,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

function routeReq(method = "POST") {
  return { method, [Symbol.asyncIterator]: async function* iterator() {} };
}

async function callHiveChat({ payload, session, linkedWallet = null }) {
  const { handleHiveRoute } = await import("../server/hive-routes.js");
  let captured = null;
  const handled = await handleHiveRoute({
    getLinkedWallet: () => linkedWallet,
    json: (_res, status, body) => {
      captured = { status, body };
    },
    readJson: async () => payload,
    req: routeReq("POST"),
    res: {},
    session,
    url: new URL("https://tasknode.local/api/hive/chat"),
  });
  assert.equal(handled, true);
  assert.ok(captured);
  return captured;
}

try {
  const { getChatMessages } = await import("../server/repositories/chat-billing.js");
  const { resetAgentHiveChatRateLimitForTests } = await import("../server/hive-routes.js");

  resetAgentHiveChatRateLimitForTests();

  const trusted = await callHiveChat({
    payload: {
      message: "Agent Hive message.",
      conversationId: "account_acct_agent_hive_hive",
      conversationTitle: "Hive",
      metadata: { purpose: "agent_hive_chat_smoke" },
      agentHandle: "grashnuk",
      walletAddress: "rSpoofedPayloadWallet",
    },
    session: { accountId: "acct_agent_hive", displayName: "Grashnuk", primaryProvider: "wallet" },
    linkedWallet: { status: "linked", address: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW" },
  });
  assert.equal(trusted.status, 200);
  assert.equal(trusted.body.entry.metadata.senderType, "machine_agent");
  assert.equal(trusted.body.entry.metadata.agentOrigin.actorType, "machine_agent");
  assert.equal(trusted.body.entry.metadata.agentOrigin.agentHandle, "grashnuk");
  assert.equal(trusted.body.entry.metadata.agentOrigin.walletAddress, "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW");
  assert.equal(trusted.body.user.metadata.senderType, "machine_agent");
  assert.equal(trusted.body.user.metadata.agentOrigin.walletAddress, "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW");
  assert.equal(trusted.body.orcWorkJournal.reason, "database_disabled");
  assert.match(trusted.body.assistant.body, /Hive reply 1/);

  const trustedHistory = await getChatMessages({
    accountId: "acct_agent_hive",
    conversationId: "account_acct_agent_hive_hive",
  });
  assert.equal(trustedHistory[0].metadata.senderType, "machine_agent");
  assert.equal(trustedHistory[0].metadata.agentOrigin.actorType, "machine_agent");

  const spoofed = await callHiveChat({
    payload: {
      message: "Spoofed Hive message.",
      conversationId: "account_acct_human_hive",
      metadata: {
        senderType: "machine_agent",
        agentOrigin: { agent: true, actorType: "machine_agent", agentHandle: "spoof" },
      },
      agentHandle: "spoof",
      walletAddress: "rSpoofedWallet",
    },
    session: { accountId: "acct_human", displayName: "Human", primaryProvider: "github" },
    linkedWallet: null,
  });
  assert.equal(spoofed.status, 200);
  assert.equal(spoofed.body.entry.metadata.senderType, undefined);
  assert.equal(spoofed.body.entry.metadata.agentOrigin, undefined);
  assert.equal(spoofed.body.user.metadata.senderType, undefined);
  assert.equal(spoofed.body.user.metadata.agentOrigin, undefined);

  const otherWalletSameAccount = await callHiveChat({
    payload: {
      message: "Second verified wallet on same account should use a separate bucket.",
      conversationId: "account_acct_agent_hive_hive",
      agentHandle: "burzghash",
      walletAddress: "rSpoofedPayloadWalletTwo",
    },
    session: { accountId: "acct_agent_hive", displayName: "Grashnuk", primaryProvider: "wallet" },
    linkedWallet: { status: "linked", address: "rh8jpDYBeYyVKPzxaAFzMfxSSdRaCaenSt" },
  });
  assert.equal(otherWalletSameAccount.status, 200);
  assert.equal(
    otherWalletSameAccount.body.entry.metadata.agentOrigin.walletAddress,
    "rh8jpDYBeYyVKPzxaAFzMfxSSdRaCaenSt"
  );

  const limited = await callHiveChat({
    payload: {
      message: "Second agent message should be limited.",
      conversationId: "account_acct_agent_hive_hive",
      agentHandle: "grashnuk",
      walletAddress: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
    },
    session: { accountId: "acct_agent_hive", displayName: "Grashnuk", primaryProvider: "wallet" },
    linkedWallet: { status: "linked", address: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW" },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "agent_hive_chat_rate_limited");
  assert.equal(Number.isFinite(limited.body.retryAfterSeconds), true);

  assert.equal(fetchCount, 3);
  console.log("agent hive chat smoke ok");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
}
