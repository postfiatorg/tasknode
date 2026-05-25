import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-security-smoke-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
process.env.TASKNODE_ENV = "production";
process.env.NODE_ENV = "production";
delete process.env.TASKNODE_DEV_AUTH_ENABLED;
process.env.OPENAI_API_KEY = "security-smoke-openai-key";
process.env.TASKNODE_ADMIN_CREDIT_TOKEN = "security-smoke-admin-token";
delete process.env.DATABASE_URL;
delete process.env.TASKNODE_DATABASE_ENABLED;

try {
  const {
    authDevStart,
    chatSend,
    chatStreamStart,
    taskRequestIntentStart,
    usageAdminCredit,
  } = await import("../server/product-contracts.js");
  const { appState } = await import("../server/app-state.js");
  const { conversationIdForChatWrite } = await import("../server/chat-conversation-ids.js");
  const { conversationIdForSession } = await import("../server/runtime-store.js");
  const {
    appendChatTurn,
    getChatMessages,
    usageLedger,
  } = await import("../server/repositories/chat-billing.js");
  const { checkRateLimit, resetRateLimitsForTests } = await import("../server/rate-limit.js");
  const { sanitizeContextHtml } = await import("../shared/context-html.js");

  const devAuth = authDevStart(
    { email: "security-smoke@tasknode.local" },
    "POST"
  );
  assert.equal(devAuth.status, 503);
  assert.equal(devAuth.body.error, "dev_auth_disabled");

  const signedOutChat = await chatSend(
    {
      message: "This must not call a provider.",
      mode: "Frontier Instant",
      conversationId: "security-smoke-signed-out",
    },
    "POST"
  );
  assert.equal(signedOutChat.status, 401);
  assert.equal(signedOutChat.body.error, "chat_login_required");

  const noCreditChat = await chatSend(
    {
      accountId: "acct_security_smoke",
      message: "This must be rejected before provider execution.",
      mode: "Frontier Instant",
      conversationId: "account_acct_security_smoke_default",
    },
    "POST"
  );
  assert.equal(noCreditChat.status, 402);
  assert.equal(noCreditChat.body.error, "chat_credit_required");

  const noCreditStream = await chatStreamStart(
    {
      accountId: "acct_security_smoke",
      message: "This stream must be rejected before provider execution.",
      mode: "Frontier Instant",
      conversationId: "account_acct_security_smoke_default",
    },
    "POST"
  );
  assert.equal(noCreditStream.status, 402);
  assert.equal(noCreditStream.body.error, "chat_credit_required");

  const invalidAttachment = {
    name: "broken.txt",
    mimeType: "text/plain",
    dataUrl: "not-a-data-url",
  };
  const invalidAttachmentChat = await chatSend(
    {
      accountId: "acct_security_smoke",
      message: "This must be rejected before billing or provider execution.",
      mode: "Frontier Instant",
      conversationId: "account_acct_security_smoke_default",
      attachments: [invalidAttachment],
    },
    "POST"
  );
  assert.equal(invalidAttachmentChat.status, 400);
  assert.equal(invalidAttachmentChat.body.error, "chat_attachment_invalid");
  assert.equal(invalidAttachmentChat.body.attachmentErrors[0].code, "invalid_data_url");

  const invalidAttachmentStream = await chatStreamStart(
    {
      accountId: "acct_security_smoke",
      message: "This stream must be rejected before provider execution.",
      mode: "Frontier Instant",
      conversationId: "account_acct_security_smoke_default",
      attachments: [invalidAttachment],
    },
    "POST"
  );
  assert.equal(invalidAttachmentStream.status, 400);
  assert.equal(invalidAttachmentStream.body.error, "chat_attachment_invalid");

  const lowCreditAccount = "acct_security_web_search_low_credit";
  const lowCreditGrant = await usageAdminCredit(
    {
      accountId: lowCreditAccount,
      amountUsd: 0.03,
      note: "low web search credit",
      idempotencyKey: "security-web-search-low-credit",
    },
    "POST",
    "Bearer security-smoke-admin-token"
  );
  assert.equal(lowCreditGrant.status, 200);

  const lowCreditWebSearchChat = await chatSend(
    {
      accountId: lowCreditAccount,
      message: "Search latest public health news.",
      mode: "Frontier Instant",
      conversationId: `account_${lowCreditAccount}_default`,
    },
    "POST"
  );
  assert.equal(lowCreditWebSearchChat.status, 402);
  assert.equal(lowCreditWebSearchChat.body.error, "chat_credit_required");
  assert.equal(lowCreditWebSearchChat.body.estimate.estimatedWebSearchCalls, 4);
  assert.equal(lowCreditWebSearchChat.body.estimate.estimatedToolCostUsd, 0.04);
  assert.equal(lowCreditWebSearchChat.body.usage.availableCreditUsd, 0.03);

  const signedOutTaskRequest = await taskRequestIntentStart(
    {
      userDetailText: "This must not persist without a signed-in account.",
      conversationId: "security-smoke-task-request",
    },
    "POST"
  );
  assert.equal(signedOutTaskRequest.status, 401);
  assert.equal(signedOutTaskRequest.body.error, "task_request_login_required");

  const invalidTaskRequest = await taskRequestIntentStart(
    {
      accountId: "acct_security_smoke",
      userDetailText: "This task request has a broken attachment.",
      conversationId: "account_acct_security_smoke_task_request",
      attachments: [invalidAttachment],
    },
    "POST"
  );
  assert.equal(invalidTaskRequest.status, 400);
  assert.equal(invalidTaskRequest.body.error, "task_request_attachment_invalid");
  assert.equal(invalidTaskRequest.body.attachmentErrors[0].code, "invalid_data_url");

  const ownedConversationId = "account_acct_security_owner_default";
  await appendChatTurn({
    accountId: "acct_security_owner",
    conversationId: ownedConversationId,
    mode: "Frontier Instant",
    provider: "openai",
    model: "chat-latest",
    responseId: "security-smoke-owned-chat",
    userMessage: "This account owns this history.",
    assistantMessage: "Owned history persisted.",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  });

  const ownerMessages = await getChatMessages({
    accountId: "acct_security_owner",
    conversationId: ownedConversationId,
  });
  assert.equal(ownerMessages.length, 2);
  assert.equal(ownerMessages[0].body, "This account owns this history.");

  await assert.rejects(
    () => getChatMessages({
      accountId: "acct_security_other",
      conversationId: ownedConversationId,
    }),
    /chat_conversation_not_found/
  );
  await assert.rejects(
    () => getChatMessages({
      conversationId: ownedConversationId,
    }),
    /chat_conversation_not_found/
  );

  const rawOwnedConversationId = "conv_security_raw_owned";
  const rawResolvedConversationId = await conversationIdForChatWrite({
    conversationIdForSession,
    existsForAccount: async ({ accountId, conversationId }) =>
      accountId === "acct_security_owner" && conversationId === rawOwnedConversationId,
    requestedId: rawOwnedConversationId,
    session: { accountId: "acct_security_owner" },
  });
  assert.equal(rawResolvedConversationId, rawOwnedConversationId);

  const newDraftConversationId = await conversationIdForChatWrite({
    conversationIdForSession,
    existsForAccount: async () => false,
    requestedId: "chat_security_new",
    session: { accountId: "acct_security_owner" },
  });
  assert.equal(newDraftConversationId, "account_acct_security_owner_chat_security_new");

  const signedOutState = await appState(null);
  assert.deepEqual(signedOutState.chat.seedMessages, []);
  assert.deepEqual(signedOutState.chat.recents, []);
  assert.equal(signedOutState.usage.currentSpendUsd, 0);
  assert.equal(signedOutState.usage.currentCreditUsd, 0);
  assert.equal(signedOutState.usage.availableCreditUsd, 0);
  assert.equal(signedOutState.usage.ledgerEntryCount, 0);

  const adminNoIdempotency = await usageAdminCredit(
    {
      accountId: "acct_security_smoke",
      amountUsd: 1,
      note: "missing idempotency",
    },
    "POST",
    "Bearer security-smoke-admin-token"
  );
  assert.equal(adminNoIdempotency.status, 400);
  assert.equal(adminNoIdempotency.body.error, "usage_credit_idempotency_required");

  const scopedLedger = await usageLedger({ accountId: lowCreditAccount, limit: 5 });
  assert.equal(scopedLedger.accountId, lowCreditAccount);
  assert.equal(scopedLedger.entries.length >= 1, true);
  const unscopedLedger = await usageLedger({ accountId: "", conversationId: "", limit: 5 });
  assert.equal(unscopedLedger.accountId, null);
  assert.equal(unscopedLedger.conversationId, null);
  assert.equal(unscopedLedger.ledgerEntryCount, 0);
  assert.deepEqual(unscopedLedger.entries, []);

  const sanitized = sanitizeContextHtml(`
    <h1 onclick="steal()">Title</h1>
    <img src=x onerror="steal()">
    <p style="background:url(javascript:steal())">Safe text</p>
    <script>steal()</script>
    <svg><script>steal()</script></svg>
  `);
  assert.match(sanitized, /<h1>Title<\/h1>/);
  assert.match(sanitized, /<p>Safe text<\/p>/);
  assert.equal(/onerror|onclick|javascript:|<script|<svg|<img/i.test(sanitized), false);

  resetRateLimitsForTests();
  assert.equal(checkRateLimit({ key: "security-smoke-rate", limit: 2 }).allowed, true);
  assert.equal(checkRateLimit({ key: "security-smoke-rate", limit: 2 }).allowed, true);
  const limited = checkRateLimit({ key: "security-smoke-rate", limit: 2 });
  assert.equal(limited.allowed, false);
  assert.equal(limited.retryAfterSeconds >= 1, true);

  console.log("security smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
