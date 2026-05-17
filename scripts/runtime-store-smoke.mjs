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
process.env.OPENROUTER_API_KEY = "runtime-smoke-openrouter-key";
delete process.env.OPENROUTER_MODEL;
delete process.env.OPENROUTER_CHAT_ENABLED;
delete process.env.TASKNODE_ENABLE_OPENROUTER_CHAT;
delete process.env.TASKNODE_PFT_FAUCET_SEED;
delete process.env.FAUCET_SEED;
delete process.env.PFTL_FAUCET_WSS_URL;
delete process.env.PFTL_FAUCET_WSS_URL_FALLBACKS;

try {
  const { HDNodeWallet } = await import("ethers");
  const depositReceiveNode = HDNodeWallet.fromPhrase(
    "test test test test test test test test test test test junk",
    undefined,
    "m/44'/60'/0'/0"
  );
  process.env.ETH_DEPOSIT_XPUB = depositReceiveNode.neuter().extendedKey;
  process.env.ETH_DEPOSIT_ETH_USD_PRICE = "2000";
  process.env.ETH_DEPOSIT_START_INDEX = "1";

  const {
    actualChatCost,
    chatExecutionStatus,
    modelForMode,
    openAiResponseRequest,
    openRouterChatRequest,
    shouldUseWebSearch,
  } = await import("../server/chat-router.js");
  const {
    appendUsageCredit,
    appendChatTurn,
    createAccountSession,
    deleteChatConversation,
    delinkWalletFromAccount,
    getContextDocument,
    getContextHistory,
    getEthereumDepositAccount,
    getLinkedWallet,
    getOrCreateEmailAccount,
    getOrCreateProviderAccount,
    linkWalletToAccount,
    listChatConversations,
    renameChatConversation,
    completeWalletInitiationGrant,
    reserveWalletInitiationGrant,
    saveContextDocument,
    saveIndexedContextHistory,
    usageSummary,
    walletInitiationGrantStatus,
  } = await import("../server/runtime-store.js");
  const {
    chatEstimate,
    usageActions,
    walletActionStart,
    walletCreateStart,
    walletLinkVerify,
    usageTopUpStart,
    usageTopUpSync,
  } = await import("../server/product-contracts.js");
  const {
    generateTaskNodeMnemonic,
    signWalletChallenge,
  } = await import("../src/wallet-core.js");
  const { appState } = await import("../server/app-state.js");

  if (modelForMode("Frontier Instant") !== "chat-latest") {
    throw new Error("Frontier Instant must default to OpenAI chat-latest.");
  }

  if (modelForMode("Frontier Thinking") !== "gpt-5.5") {
    throw new Error("Frontier Thinking must default to pinned OpenAI gpt-5.5.");
  }

  if (modelForMode("Private Instant") !== "deepseek/deepseek-v4-flash") {
    throw new Error("Private Instant must default to pinned OpenRouter DeepSeek V4 Flash.");
  }

  if (modelForMode("Private Thinking") !== "deepseek/deepseek-v4-pro") {
    throw new Error("Private Thinking must default to pinned OpenRouter DeepSeek V4 Pro.");
  }

  if (!chatExecutionStatus("Private Instant").enabled) {
    throw new Error("Private Instant should be enabled when an OpenRouter key is configured.");
  }

  process.env.OPENROUTER_CHAT_ENABLED = "false";
  if (chatExecutionStatus("Private Instant").enabled) {
    throw new Error("Private Instant should respect the explicit OpenRouter kill switch.");
  }
  delete process.env.OPENROUTER_CHAT_ENABLED;

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
    frontierRequest.input?.[0]?.content?.[1]?.type !== "input_text" ||
    !frontierRequest.input?.[0]?.content?.[1]?.text?.includes("Hello world")
  ) {
    throw new Error(`OpenAI Responses request is missing search or readable text attachment support: ${JSON.stringify(frontierRequest)}`);
  }

  const frontierPdfRequest = openAiResponseRequest({
    mode: "Frontier Instant",
    model: "chat-latest",
    message: "Read the attached PDF.",
    conversationId: "runtime-smoke-response-pdf-contract",
    attachments: [
      {
        name: "source.pdf",
        mimeType: "application/pdf",
        size: 12,
        dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
      },
    ],
  });

  if (frontierPdfRequest.input?.[0]?.content?.[1]?.type !== "input_file") {
    throw new Error(`OpenAI Responses PDF request should preserve file attachment support: ${JSON.stringify(frontierPdfRequest)}`);
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

  const smokeMemoryContext = {
    deepMemories: [
      {
        conversationTitle: "Deep memory #2",
        createdAt: "2026-05-17T18:24:43.872Z",
        userRequestSummary: "- The user asked for account-level continuity across chat tabs.",
        systemResponseSummary: "- The assistant agreed to inject durable memory into future chat context.",
        memoryText: "The user is refining Task Node memory so every chat has useful account context without blocking normal chat execution.",
      },
    ],
    memories: [
      {
        createdAt: "2026-05-17T18:30:00.000Z",
        userRequestSummary: "TURN_USER_FIELD_SHOULD_NOT_APPEAR",
        systemResponseSummary: "TURN_ASSISTANT_FIELD_SHOULD_NOT_APPEAR",
        memoryText: "Recent memory should carry forward as date plus memory text only.",
      },
    ],
  };
  const baseMemoryEstimate = chatEstimate({
    mode: "Frontier Instant",
    message: "Use my memory and reply.",
  });
  const chatMemoryEstimate = chatEstimate(
    {
      mode: "Frontier Instant",
      message: "Use my memory and reply.",
    },
    { memoryContext: smokeMemoryContext }
  );

  if (
    chatMemoryEstimate.memoryInputTokens <= 0 ||
    chatMemoryEstimate.inputTokens <= baseMemoryEstimate.inputTokens ||
    chatMemoryEstimate.estimatedUsd <= baseMemoryEstimate.estimatedUsd
  ) {
    throw new Error(`Chat estimate should include billable memory context tokens: ${JSON.stringify({ baseMemoryEstimate, chatMemoryEstimate })}`);
  }

  const frontierMemoryRequest = openAiResponseRequest({
    mode: "Frontier Instant",
    model: "chat-latest",
    message: "Use my memory and reply.",
    conversationId: "runtime-smoke-frontier-memory-contract",
    memoryContext: smokeMemoryContext,
  });

  if (
    !frontierMemoryRequest.instructions.includes("<deep_memory>") ||
    !frontierMemoryRequest.instructions.includes("User:") ||
    !frontierMemoryRequest.instructions.includes("Assistant:") ||
    !frontierMemoryRequest.instructions.includes("Recent memory should carry forward") ||
    frontierMemoryRequest.instructions.includes("TURN_USER_FIELD_SHOULD_NOT_APPEAR") ||
    frontierMemoryRequest.instructions.includes("TURN_ASSISTANT_FIELD_SHOULD_NOT_APPEAR")
  ) {
    throw new Error(`OpenAI memory context must include deep memory and memory-only recent records: ${frontierMemoryRequest.instructions}`);
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
    openRouterRequest.provider?.order?.[0] !== "parasail" ||
    openRouterRequest.provider?.only?.includes("akashml") !== true ||
    openRouterRequest.plugins?.[0]?.pdf?.engine !== "cloudflare-ai" ||
    privateUserContent?.[1]?.type !== "image_url" ||
    privateUserContent?.[2]?.type !== "file" ||
    privateUserContent?.[3]?.text?.includes("hello world") !== true
  ) {
    throw new Error(`OpenRouter private request is missing ZDR or attachment support: ${JSON.stringify(openRouterRequest)}`);
  }

  const openRouterMemoryRequest = openRouterChatRequest({
    mode: "Private Instant",
    model: "openrouter/auto",
    message: "Use my memory and reply.",
    conversationId: "runtime-smoke-openrouter-memory-contract",
    memoryContext: smokeMemoryContext,
  });
  const openRouterMemoryInstructions = openRouterMemoryRequest.messages?.[0]?.content || "";

  if (
    !openRouterMemoryInstructions.includes("<deep_memory>") ||
    !openRouterMemoryInstructions.includes("User:") ||
    !openRouterMemoryInstructions.includes("Assistant:") ||
    !openRouterMemoryInstructions.includes("Recent memory should carry forward") ||
    openRouterMemoryInstructions.includes("TURN_USER_FIELD_SHOULD_NOT_APPEAR") ||
    openRouterMemoryInstructions.includes("TURN_ASSISTANT_FIELD_SHOULD_NOT_APPEAR")
  ) {
    throw new Error(`OpenRouter memory context must include deep memory and memory-only recent records: ${openRouterMemoryInstructions}`);
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
    openRouterThinkingRequest.provider?.order?.[0] !== "novita" ||
    openRouterThinkingRequest.provider?.only?.includes("deepinfra") !== true ||
    openRouterThinkingRequest.max_tokens !== 4096
  ) {
    throw new Error(`Private Thinking must use OpenRouter high reasoning with strict provider routing: ${JSON.stringify(openRouterThinkingRequest)}`);
  }

  const openRouterSearchRequest = openRouterChatRequest({
    mode: "Private Instant",
    model: "openrouter/auto",
    message: "Can you search what is going on today?",
    conversationId: "runtime-smoke-openrouter-search-contract",
  });

  if (openRouterSearchRequest.tools) {
    throw new Error(`Private OpenRouter requests must not carry web search tools: ${JSON.stringify(openRouterSearchRequest)}`);
  }

  const topUpAction = usageActions().find((action) => action.id === "top_up_start");
  if (topUpAction?.enabled !== true) {
    throw new Error(`Ethereum top-up action should be enabled with an xpub: ${JSON.stringify(topUpAction)}`);
  }

  const noLoginTopUp = usageTopUpStart({}, "POST", null);
  if (noLoginTopUp.status !== 401 || noLoginTopUp.body?.error !== "usage_top_up_login_required") {
    throw new Error(`Ethereum top-up should require account login: ${JSON.stringify(noLoginTopUp)}`);
  }

  const topUp = usageTopUpStart({}, "POST", { accountId: "acct_eth_smoke" });
  const expectedDepositAddress = depositReceiveNode.neuter().deriveChild(1).address;
  const topUpSymbols = (topUp.body?.depositAccount?.assets || []).map((asset) => asset.symbol);
  if (
    topUp.status !== 200 ||
    topUp.body?.depositAccount?.address !== expectedDepositAddress ||
    topUp.body?.depositAccount?.withdrawalsEnabled !== false ||
    ["ETH", "USDC", "USDT"].every((symbol) => topUpSymbols.includes(symbol)) !== true
  ) {
    throw new Error(`Ethereum top-up address allocation failed: ${JSON.stringify(topUp)}`);
  }

  const replayTopUp = usageTopUpStart({}, "POST", { accountId: "acct_eth_smoke" });
  const storedDeposit = getEthereumDepositAccount({ accountId: "acct_eth_smoke" });
  if (
    replayTopUp.body?.depositAccount?.address !== topUp.body.depositAccount.address ||
    storedDeposit?.address !== topUp.body.depositAccount.address
  ) {
    throw new Error("Ethereum top-up address was not stable for the account.");
  }

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const payload = JSON.parse(options.body || "{}");
    if (payload.method === "eth_getBalance") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: "0x0" }), { status: 200 });
    }
    if (payload.method === "eth_call") {
      const target = String(payload.params?.[0]?.to || "").toLowerCase();
      const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
      const result = target === usdc ? "0xbc4b20" : "0x0";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }), { status: 200 });
    }
    return originalFetch(url, options);
  };
  let syncedTopUp = null;
  try {
    syncedTopUp = await usageTopUpSync({}, "POST", { accountId: "acct_eth_smoke" });
  } finally {
    global.fetch = originalFetch;
  }
  if (
    syncedTopUp.status !== 200 ||
    syncedTopUp.body?.creditedEntries?.[0]?.amountUsd !== 12.34 ||
    syncedTopUp.body?.usage?.availableCreditUsd !== 12.34
  ) {
    throw new Error(`Ethereum top-up sync did not credit USDC delta: ${JSON.stringify(syncedTopUp)}`);
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

  const oauthAccount = getOrCreateProviderAccount({
    provider: "github",
    providerUserId: "runtime-smoke-gh",
    username: "runtime-smoke",
  });
  const createFlowAccount = getOrCreateProviderAccount({
    provider: "github",
    providerUserId: "runtime-smoke-create-gh",
    username: "runtime-smoke-create",
  });
  const createFlowSession = createAccountSession(createFlowAccount, { provider: "github", assurance: "medium" });
  const createStart = walletCreateStart("POST", createFlowSession.session);
  const createMnemonic = generateTaskNodeMnemonic();
  const createProof = signWalletChallenge(createMnemonic, createStart.body.challenge.message);
  const createVerify = await walletLinkVerify({
    challengeId: createStart.body.challenge.id,
    address: createProof.address,
    publicKey: createProof.publicKey,
    signature: createProof.signature,
  }, "POST", createFlowSession.session);
  const createLinkedWallet = getLinkedWallet({ accountId: createFlowAccount.id });
  if (
    createStart.status !== 200 ||
    createStart.body.challenge.purpose !== "wallet_create" ||
    createVerify.status !== 200 ||
    createLinkedWallet.status !== "linked" ||
    createLinkedWallet.address !== createProof.address ||
    createVerify.body.initiationGift?.status !== "not_configured"
  ) {
    throw new Error(`Create wallet flow did not link with a non-faucet fallback: ${JSON.stringify({ createStart, createVerify, createLinkedWallet })}`);
  }
  const retryWithoutFaucet = await walletActionStart(
    "/api/wallet/initiation/retry",
    "POST",
    createFlowSession.session
  );
  if (
    retryWithoutFaucet.status !== 502 ||
    retryWithoutFaucet.body?.initiationGift?.reason !== "faucet_not_configured"
  ) {
    throw new Error(`Initiation retry should report faucet configuration without relinking: ${JSON.stringify(retryWithoutFaucet)}`);
  }
  const emailAccount = getOrCreateEmailAccount({
    email: "runtime-smoke@example.com",
    canonicalEmail: "runtime-smoke@example.com",
    maskedEmail: "r***@example.com",
  });
  const emailGift = walletInitiationGrantStatus({ accountId: emailAccount.id });
  if (emailGift.eligible || emailGift.reason !== "email_ineligible") {
    throw new Error(`Email-only accounts must not be initiation-gift eligible: ${JSON.stringify(emailGift)}`);
  }
  const firstGiftStatus = walletInitiationGrantStatus({
    accountId: oauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInit1111111111111",
  });
  if (!firstGiftStatus.eligible || firstGiftStatus.amountPft !== 12) {
    throw new Error(`OAuth account should be eligible for one wallet initiation gift: ${JSON.stringify(firstGiftStatus)}`);
  }
  const reservedGift = reserveWalletInitiationGrant({
    accountId: oauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInit1111111111111",
    amountDrops: firstGiftStatus.amountDrops,
    amountPft: firstGiftStatus.amountPft,
  });
  if (!reservedGift.ok || reservedGift.grant.status !== "processing") {
    throw new Error(`Wallet initiation grant was not reserved: ${JSON.stringify(reservedGift)}`);
  }
  const completedGift = completeWalletInitiationGrant({
    grantId: reservedGift.internalGrant.id,
    txHash: "RUNTIME_SMOKE_INIT_TX",
    faucetAddress: "rRuntimeSmokeFaucet",
  });
  if (!completedGift.ok || completedGift.grant.status !== "completed") {
    throw new Error(`Wallet initiation grant was not completed: ${JSON.stringify(completedGift)}`);
  }
  const replayGift = walletInitiationGrantStatus({
    accountId: oauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInit1111111111111",
  });
  if (replayGift.eligible || replayGift.reason !== "account_registered") {
    throw new Error(`Wallet initiation grant must be account-idempotent: ${JSON.stringify(replayGift)}`);
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
  const linkedState = await appState(accountSession);

  if (!linked.ok || linkedState.context.history.contextUpdateCount !== 1) {
    throw new Error(`Linked wallet history did not appear: ${JSON.stringify(linkedState.context.history)}`);
  }

  const delinked = delinkWalletFromAccount({ accountId: accountSession.accountId });
  const delinkedState = await appState(accountSession);

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
  const relinkedState = await appState(accountSession);

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
  const otherLinkedState = await appState(accountSession);

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
