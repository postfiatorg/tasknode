import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "tasknodeofficial-runtime-store-"));
process.env.TASKNODE_STORE_PATH = join(tempDir, "runtime-store.json");
delete process.env.CHAT_MODEL_FRONTIER_INSTANT;
delete process.env.CHAT_MODEL_FRONTIER_THINKING;
delete process.env.CHAT_MODEL_PRIVATE_INSTANT;
delete process.env.CHAT_MODEL_PRIVATE_THINKING;
process.env.OPENAI_MODEL = "generic-openai-smoke-model";
delete process.env.OPENROUTER_MODEL;

try {
  const {
    actualChatCost,
    modelForMode,
    openAiResponseRequest,
    openRouterChatRequest,
    shouldUseWebSearch,
  } = await import("../server/chat-router.js");
  const {
    appendUsageCredit,
    appendChatTurn,
    deleteChatConversation,
    delinkWalletFromAccount,
    getContextDocument,
    getContextHistory,
    getLinkedWallet,
    linkWalletToAccount,
    listChatConversations,
    renameChatConversation,
    saveContextDocument,
    saveIndexedContextHistory,
    usageSummary,
  } = await import("../server/runtime-store.js");
  const { appState } = await import("../server/app-state.js");

  if (modelForMode("Frontier Instant") !== "chat-latest") {
    throw new Error("Frontier Instant must default to OpenAI chat-latest.");
  }

  if (modelForMode("Frontier Thinking") !== "gpt-5.5") {
    throw new Error("Frontier Thinking must default to pinned OpenAI gpt-5.5.");
  }

  if (modelForMode("Private Instant") !== "qwen/qwen3-vl-8b-instruct") {
    throw new Error("Private Instant must default to a pinned OpenRouter ZDR multimodal model.");
  }

  if (modelForMode("Private Thinking") !== "deepseek/deepseek-v4-pro") {
    throw new Error("Private Thinking must default to pinned OpenRouter DeepSeek V4 Pro.");
  }

  if (actualChatCost("Frontier Instant", { inputTokens: 1_000_000, outputTokens: 1_000_000 }) !== 35) {
    throw new Error("Frontier Instant chat-latest pricing drifted from the configured OpenAI token rates.");
  }

  if (actualChatCost("Frontier Thinking", { inputTokens: 1_000_000, outputTokens: 1_000_000 }) !== 35) {
    throw new Error("Frontier Thinking gpt-5.5 pricing drifted from the configured OpenAI token rates.");
  }

  if (!shouldUseWebSearch("Can you search what is going on today?") || shouldUseWebSearch("Reply exactly ok.")) {
    throw new Error("Web search routing should be explicit and should not attach tools to every Frontier request.");
  }

  const frontierRequest = openAiResponseRequest({
    mode: "Frontier Instant",
    model: "chat-latest",
    message: "Search today's public health news and read the attached note.",
    conversationId: "runtime-smoke-response-contract",
    attachments: [
      {
        name: "note.txt",
        mimeType: "text/plain",
        size: 12,
        dataUrl: "data:text/plain;base64,SGVsbG8gd29ybGQ=",
      },
    ],
  });

  if (
    frontierRequest.model !== "chat-latest" ||
    frontierRequest.tools?.[0]?.type !== "web_search" ||
    frontierRequest.input?.[0]?.content?.[1]?.type !== "input_file"
  ) {
    throw new Error(`OpenAI Responses request is missing search or attachment support: ${JSON.stringify(frontierRequest)}`);
  }

  const basicFrontierRequest = openAiResponseRequest({
    mode: "Frontier Instant",
    model: "chat-latest",
    message: "Reply exactly ok.",
    conversationId: "runtime-smoke-basic-response-contract",
  });

  if (basicFrontierRequest.tools.length !== 0 || basicFrontierRequest.tool_choice) {
    throw new Error(`Basic OpenAI Responses requests should not carry web search tools: ${JSON.stringify(basicFrontierRequest)}`);
  }

  const frontierThinkingRequest = openAiResponseRequest({
    mode: "Frontier Thinking",
    model: "gpt-5.5",
    message: "Think carefully and answer.",
    conversationId: "runtime-smoke-frontier-thinking-contract",
  });

  if (
    frontierThinkingRequest.model !== "gpt-5.5" ||
    frontierThinkingRequest.reasoning?.effort !== "high" ||
    frontierThinkingRequest.max_output_tokens !== 4096
  ) {
    throw new Error(`Frontier Thinking must use gpt-5.5 high reasoning: ${JSON.stringify(frontierThinkingRequest)}`);
  }

  const openRouterRequest = openRouterChatRequest({
    mode: "Private Instant",
    model: "openrouter/auto",
    message: "Review the attached image, PDF, and note.",
    conversationId: "runtime-smoke-openrouter-contract",
    attachments: [
      {
        name: "pixel.png",
        mimeType: "image/png",
        size: 68,
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
      {
        name: "brief.pdf",
        mimeType: "application/pdf",
        size: 10,
        dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
      },
      {
        name: "note.txt",
        mimeType: "text/plain",
        size: 11,
        dataUrl: "data:text/plain;base64,aGVsbG8gd29ybGQ=",
      },
    ],
  });
  const privateUserContent = openRouterRequest.messages.at(-1)?.content || [];

  if (
    openRouterRequest.provider?.zdr !== true ||
    openRouterRequest.provider?.data_collection !== "deny" ||
    openRouterRequest.plugins?.[0]?.pdf?.engine !== "cloudflare-ai" ||
    privateUserContent?.[1]?.type !== "image_url" ||
    privateUserContent?.[2]?.type !== "file" ||
    privateUserContent?.[3]?.text?.includes("hello world") !== true
  ) {
    throw new Error(`OpenRouter private request is missing ZDR or attachment support: ${JSON.stringify(openRouterRequest)}`);
  }

  const openRouterThinkingRequest = openRouterChatRequest({
    mode: "Private Thinking",
    model: "openrouter/auto",
    message: "Think carefully and answer.",
    conversationId: "runtime-smoke-openrouter-thinking-contract",
  });

  if (
    openRouterThinkingRequest.reasoning?.effort !== "high" ||
    openRouterThinkingRequest.reasoning?.exclude !== true ||
    openRouterThinkingRequest.provider?.require_parameters !== true ||
    openRouterThinkingRequest.max_tokens !== 4096
  ) {
    throw new Error(`Private Thinking must use OpenRouter high reasoning with strict provider routing: ${JSON.stringify(openRouterThinkingRequest)}`);
  }

  const oldOpenRouterWebSearchEnabled = process.env.OPENROUTER_WEB_SEARCH_ENABLED;
  process.env.OPENROUTER_WEB_SEARCH_ENABLED = "true";
  const openRouterSearchRequest = openRouterChatRequest({
    mode: "Private Instant",
    model: "openrouter/auto",
    message: "Can you search what is going on today?",
    conversationId: "runtime-smoke-openrouter-search-contract",
  });
  if (oldOpenRouterWebSearchEnabled === undefined) {
    delete process.env.OPENROUTER_WEB_SEARCH_ENABLED;
  } else {
    process.env.OPENROUTER_WEB_SEARCH_ENABLED = oldOpenRouterWebSearchEnabled;
  }

  if (openRouterSearchRequest.tools?.[0]?.type !== "openrouter:web_search") {
    throw new Error(`OpenRouter web search should be available behind the explicit env gate: ${JSON.stringify(openRouterSearchRequest)}`);
  }

  const first = appendUsageCredit({
    accountId: "acct_runtime_smoke",
    amountUsd: 5,
    source: "initial_provider_credit",
    note: "runtime smoke",
    uniqueKey: "initial_provider_credit:acct_runtime_smoke",
  });
  const replay = appendUsageCredit({
    accountId: "acct_runtime_smoke",
    amountUsd: 5,
    source: "initial_provider_credit",
    note: "runtime smoke replay",
    uniqueKey: "initial_provider_credit:acct_runtime_smoke",
  });
  const summary = usageSummary({ accountId: "acct_runtime_smoke" });

  if (!first?.id || replay?.id !== first.id || replay?.idempotentReplay !== true) {
    throw new Error("Initial provider credit is not idempotent.");
  }

  if (summary.currentCreditUsd !== 5 || summary.ledgerEntryCount !== 1) {
    throw new Error(`Unexpected credit summary: ${JSON.stringify(summary)}`);
  }

  const persistedChat = appendChatTurn({
    accountId: "acct_runtime_smoke",
    conversationId: "account_acct_runtime_smoke_default",
    mode: "Frontier Instant",
    provider: "openai",
    model: "chat-latest",
    responseId: "runtime-smoke-response",
    userMessage: "Bill this message.",
    assistantMessage: "Billed.",
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      costUsd: actualChatCost("Frontier Instant", { inputTokens: 120, outputTokens: 30 }),
    },
  });
  const debitedSummary = usageSummary({ accountId: "acct_runtime_smoke" });
  const expectedDebit = actualChatCost("Frontier Instant", { inputTokens: 120, outputTokens: 30 });

  if (
    !persistedChat.ledgerEntry ||
    persistedChat.ledgerEntry.kind !== "chat_debit" ||
    debitedSummary.currentSpendUsd !== expectedDebit ||
    debitedSummary.availableCreditUsd !== Number((5 - expectedDebit).toFixed(6))
  ) {
    throw new Error(
      `Usage debit did not affect available balance: ${JSON.stringify({ persistedChat, debitedSummary })}`
    );
  }

  appendChatTurn({
    accountId: "acct_runtime_smoke",
    conversationId: "account_acct_runtime_smoke_mutation",
    mode: "Frontier Instant",
    provider: "openai",
    model: "chat-latest",
    responseId: "runtime-smoke-mutation",
    userMessage: "Rename this chat.",
    assistantMessage: "Ready.",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
  });

  const renamedChat = renameChatConversation({
    accountId: "acct_runtime_smoke",
    conversationId: "account_acct_runtime_smoke_mutation",
    title: "Renamed runtime smoke chat",
  });
  const renamedList = listChatConversations({ accountId: "acct_runtime_smoke" });

  if (
    !renamedChat.ok ||
    !renamedList.some((chat) => chat.conversationId === "account_acct_runtime_smoke_mutation" && chat.title === "Renamed runtime smoke chat")
  ) {
    throw new Error(`Chat rename did not persist: ${JSON.stringify({ renamedChat, renamedList })}`);
  }

  const deletedChat = deleteChatConversation({
    accountId: "acct_runtime_smoke",
    conversationId: "account_acct_runtime_smoke_mutation",
  });
  const deletedList = listChatConversations({ accountId: "acct_runtime_smoke" });

  if (
    !deletedChat.ok ||
    deletedList.some((chat) => chat.conversationId === "account_acct_runtime_smoke_mutation")
  ) {
    throw new Error(`Chat delete did not remove the conversation: ${JSON.stringify({ deletedChat, deletedList })}`);
  }

  const savedContext = saveContextDocument({
    accountId: "acct_runtime_smoke",
    title: "Runtime smoke context",
    body: "This account-scoped context remains available without a linked wallet.",
  });

  if (!savedContext.ok) {
    throw new Error(`Native context did not save: ${JSON.stringify(savedContext)}`);
  }

  const imported = saveIndexedContextHistory({
    accountId: "acct_runtime_smoke",
    snapshot: {
      walletAddress: "rSmokeWalletAddress",
      contextRevisions: [
        {
          id: "ctx-1",
          cid: "ipfs://bafyContextSmoke",
          tx_hash: "ABC123",
          created_at: "2026-05-16T00:00:00.000Z",
          word_count: 42,
        },
      ],
      tasks: [
        {
          id: "task-1",
          title: "Private task title",
          status: "rewarded",
          verification_type: "text",
        },
      ],
      taskEvents: [
        {
          id: "event-1",
          task_id: "task-1",
          event_type: "submission_recorded",
          event_payload: JSON.stringify({
            artifact_cid: "ipfs://bafyEvidenceSmoke",
            response_text: "PRIVATE EVIDENCE TEXT MUST NOT BE STORED",
          }),
          created_at: "2026-05-16T00:01:00.000Z",
        },
      ],
    },
  });
  const unlinkedContext = getContextDocument({ accountId: "acct_runtime_smoke" });
  const unlinkedHistory = getContextHistory({ accountId: "acct_runtime_smoke" });
  const history = getContextHistory({
    accountId: "acct_runtime_smoke",
    walletAddress: "rSmokeWalletAddress",
  });
  const otherWalletHistory = getContextHistory({
    accountId: "acct_runtime_smoke",
    walletAddress: "rDifferentSmokeWallet",
  });
  const serializedHistory = JSON.stringify(history);

  if (!imported.ok || history.contextUpdateCount !== 1 || history.taskEventCount !== 1) {
    throw new Error(`Unexpected context history summary: ${serializedHistory}`);
  }

  if (unlinkedContext.revision !== 1 || unlinkedHistory.contextUpdateCount !== 0 || unlinkedHistory.canHydrate) {
    throw new Error(
      `Unlinked context/history boundary failed: ${JSON.stringify({ unlinkedContext, unlinkedHistory })}`
    );
  }

  if (otherWalletHistory.contextUpdateCount !== 0 || otherWalletHistory.pointerCount !== 0) {
    throw new Error(`Wallet-scoped history leaked to another wallet: ${JSON.stringify(otherWalletHistory)}`);
  }

  const accountSession = { accountId: "acct_runtime_smoke" };
  const linked = linkWalletToAccount({
    accountId: accountSession.accountId,
    address: "rSmokeWalletAddress",
    publicKey: "smoke-public-key",
    challengeId: "smoke-challenge",
    signature: "smoke-signature",
  });
  const linkedState = appState(accountSession);

  if (!linked.ok || linkedState.context.history.contextUpdateCount !== 1) {
    throw new Error(`Linked wallet history did not appear: ${JSON.stringify(linkedState.context.history)}`);
  }

  const delinked = delinkWalletFromAccount({ accountId: accountSession.accountId });
  const delinkedState = appState(accountSession);

  if (
    !delinked.ok ||
    delinkedState.context.document.revision !== 1 ||
    delinkedState.context.history.pointerCount !== 0 ||
    delinkedState.context.history.canHydrate
  ) {
    throw new Error(`Delinked app state boundary failed: ${JSON.stringify(delinkedState.context)}`);
  }

  const relinked = linkWalletToAccount({
    accountId: accountSession.accountId,
    address: "rSmokeWalletAddress",
    publicKey: "smoke-public-key",
    challengeId: "smoke-challenge-2",
    signature: "smoke-signature-2",
    proofPurpose: "wallet_relink",
  });
  const relinkedState = appState(accountSession);

  if (!relinked.ok || relinkedState.context.history.contextUpdateCount !== 1) {
    throw new Error(`Relinked wallet history did not reappear: ${JSON.stringify(relinkedState.context.history)}`);
  }

  delinkWalletFromAccount({ accountId: accountSession.accountId });
  const linkedOther = linkWalletToAccount({
    accountId: accountSession.accountId,
    address: "rDifferentSmokeWallet",
    publicKey: "smoke-public-key-3",
    challengeId: "smoke-challenge-3",
    signature: "smoke-signature-3",
    proofPurpose: "wallet_relink",
  });
  const otherLinkedState = appState(accountSession);

  if (!linkedOther.ok || otherLinkedState.context.history.pointerCount !== 0) {
    throw new Error(`Different linked wallet saw old history: ${JSON.stringify(otherLinkedState.context.history)}`);
  }

  const reclaimAddress = "rReclaimSmokeWallet";
  const firstOwner = linkWalletToAccount({
    accountId: "acct_reclaim_owner_a",
    address: reclaimAddress,
    publicKey: "smoke-reclaim-public-key",
    challengeId: "smoke-reclaim-challenge-a",
    signature: "smoke-reclaim-signature-a",
  });
  const reclaimed = linkWalletToAccount({
    accountId: "acct_reclaim_owner_b",
    address: reclaimAddress,
    publicKey: "smoke-reclaim-public-key",
    challengeId: "smoke-reclaim-challenge-b",
    signature: "smoke-reclaim-signature-b",
    proofPurpose: "wallet_relink",
  });
  const firstOwnerWallet = getLinkedWallet({ accountId: "acct_reclaim_owner_a" });
  const secondOwnerWallet = getLinkedWallet({ accountId: "acct_reclaim_owner_b" });

  if (
    !firstOwner.ok ||
    !reclaimed.ok ||
    reclaimed.reclaimedWalletCount !== 1 ||
    firstOwnerWallet.status !== "not_linked" ||
    secondOwnerWallet.status !== "linked" ||
    secondOwnerWallet.address !== reclaimAddress
  ) {
    throw new Error(
      `Wallet reclaim boundary failed: ${JSON.stringify({ firstOwner, reclaimed, firstOwnerWallet, secondOwnerWallet })}`
    );
  }

  if (!history.latestContextPointer?.cid || history.latestContextPointer.cid !== "bafyContextSmoke") {
    throw new Error("Latest context pointer was not normalized.");
  }

  if (!serializedHistory.includes("bafyEvidenceSmoke")) {
    throw new Error("Indexed task event CID was not retained.");
  }

  if (serializedHistory.includes("PRIVATE EVIDENCE TEXT MUST NOT BE STORED")) {
    throw new Error("Indexed history import leaked raw event payload text.");
  }

  console.log("runtime store smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
