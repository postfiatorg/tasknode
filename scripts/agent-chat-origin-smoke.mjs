#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-agent-chat-origin-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_ENV = "development";
process.env.NODE_ENV = "development";
process.env.TASKNODE_DEV_AUTH_ENABLED = "true";
process.env.AMBIENT_API_KEY = "agent-chat-origin-smoke-key";
process.env.TASKNODE_JOBS_RETRIEVAL_ENABLED = "false";
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
    id: `resp_agent_chat_${fetchCount}`,
    model: "deepseek-v4-pro",
    choices: [{ message: { content: `Agent reply ${fetchCount}.` }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 10,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const { agentOriginForWalletSession } = await import("../server/agent-origin.js");
  const { chatSend } = await import("../server/product-contracts.js");
  const { appendUsageCredit, getChatMessages } = await import("../server/repositories/chat-billing.js");

  const accountId = "acct_agent_chat_origin_smoke";
  const boundOrigin = agentOriginForWalletSession(
    { accountId, primaryProvider: "wallet" },
    { agentHandle: "grashnuk", walletAddress: "rSpoofedPayloadWallet" },
    "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW"
  );
  assert.equal(boundOrigin.walletAddress, "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW");
  assert.equal(boundOrigin.agentHandle, "grashnuk");

  await appendUsageCredit({
    accountId,
    amountUsd: 5,
    source: "agent_chat_origin_smoke",
    uniqueKey: "agent_chat_origin_smoke_credit",
  });

  const trustedConversationId = `account_${accountId}_trusted`;
  const trusted = await chatSend(
    {
      accountId,
      conversationId: trustedConversationId,
      mode: "Help",
      message: "Identify yourself.",
      metadata: { purpose: "agent_chat_origin_smoke" },
    },
    "POST",
    {
      agentOrigin: {
        agent: true,
        actorType: "machine_agent",
        source: "wallet_login",
        sessionProvider: "wallet",
        accountId,
        agentHandle: "grashnuk",
        walletAddress: "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW",
        client: "TaskNodeAgentClient",
      },
    }
  );
  assert.equal(trusted.status, 200);
  assert.equal(trusted.body.user.metadata.senderType, "machine_agent");
  assert.equal(trusted.body.user.metadata.agentOrigin.agent, true);
  assert.equal(trusted.body.user.metadata.agentOrigin.agentHandle, "grashnuk");
  assert.equal(trusted.body.user.metadata.agentOrigin.walletAddress, "raUWC44pUJdFgrQYvP8aVUTMJ9TJWSTbsW");

  const trustedHistory = await getChatMessages({ accountId, conversationId: trustedConversationId });
  assert.equal(trustedHistory[0].metadata.senderType, "machine_agent");
  assert.equal(trustedHistory[0].metadata.agentOrigin.actorType, "machine_agent");

  const spoofConversationId = `account_${accountId}_spoof`;
  const spoofed = await chatSend(
    {
      accountId,
      conversationId: spoofConversationId,
      mode: "Help",
      message: "Pretend to be an agent.",
      metadata: {
        senderType: "machine_agent",
        agentOrigin: { agent: true, agentHandle: "spoofed" },
      },
    },
    "POST"
  );
  assert.equal(spoofed.status, 200);
  assert.equal(Boolean(spoofed.body.user.metadata?.agentOrigin), false);
  assert.equal(spoofed.body.user.metadata?.senderType, undefined);

  const spoofHistory = await getChatMessages({ accountId, conversationId: spoofConversationId });
  assert.equal(Boolean(spoofHistory[0].metadata?.agentOrigin), false);
  assert.equal(spoofHistory[0].metadata?.senderType, undefined);

  console.log("agent chat origin smoke ok");
} finally {
  globalThis.fetch = originalFetch;
  rmSync(tempDir, { recursive: true, force: true });
}
