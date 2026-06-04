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
process.env.DEEPSEEK_API_KEY = "runtime-smoke-deepseek-key";
delete process.env.OPENROUTER_MODEL;
delete process.env.DEEPSEEK_CHAT_MODEL;
delete process.env.OPENROUTER_CHAT_ENABLED;
delete process.env.TASKNODE_ENABLE_OPENROUTER_CHAT;
delete process.env.DEEPSEEK_CHAT_ENABLED;
delete process.env.TASKNODE_ENABLE_DEEPSEEK_CHAT;
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
    deepSeekChatRequest,
    modelForMode,
    openAiResponseRequest,
    openRouterChatRequest,
  } = await import("../server/chat-router.js");
  const { deepSeekUsage, openRouterUsage } = await import("../server/chat-provider-usage.js");
  const {
    appendUsageCredit,
    appendChatTurn,
    createAccountSession,
    deleteAccountRuntimeData,
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
    saveContextHistoryProjection,
    updateEthereumDepositSync,
    usageSummary,
    walletInitiationGrantStatus,
  } = await import("../server/runtime-store.js");
  const {
    getAccountWalletCloud,
  } = await import("../server/account-wallet-cloud.js");
  const {
    chatEstimate,
    chatEstimateForAccount,
    usageActions,
    walletActionStart,
    walletCreateStart,
    walletLinkStart,
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

  if (modelForMode("Discount Thinking") !== "deepseek-v4-pro") {
    throw new Error("Discount Thinking must default to direct DeepSeek V4 Pro.");
  }

  if (!chatExecutionStatus("Private Instant").enabled) {
    throw new Error("Private Instant should be enabled when an OpenRouter key is configured.");
  }

  if (!chatExecutionStatus("Discount Thinking").enabled) {
    throw new Error("Discount Thinking should be enabled when a DeepSeek key is configured.");
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

  if (actualChatCost("Discount Thinking", { inputTokens: 1_000_000, outputTokens: 1_000_000 }) !== 1.305) {
    throw new Error("Discount Thinking direct DeepSeek V4 Pro pricing drifted from configured discount token rates.");
  }

  if (
    actualChatCost("Discount Thinking", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      promptCacheHitTokens: 1_000_000,
      promptCacheMissTokens: 0,
    }) !== 0.873625
  ) {
    throw new Error("Discount Thinking direct DeepSeek cache-hit pricing drifted from configured discount token rates.");
  }

  const frontierSearchEstimate = chatEstimate({
    mode: "Frontier Instant",
    message: "Search latest public health news.",
  });
  if (
    frontierSearchEstimate.estimatedWebSearchCalls !== 4 ||
    frontierSearchEstimate.estimatedToolCostUsd !== 0.04 ||
    frontierSearchEstimate.estimatedUsd <= frontierSearchEstimate.estimatedTokenUsd
  ) {
    throw new Error(`Frontier estimates should reserve maximum web-search tool cost: ${JSON.stringify(frontierSearchEstimate)}`);
  }

  const privateSearchEstimate = chatEstimate({
    mode: "Private Instant",
    message: "Search latest public health news.",
  });
  if (privateSearchEstimate.estimatedWebSearchCalls !== 0 || privateSearchEstimate.estimatedToolCostUsd !== 0) {
    throw new Error(`Private modes should not estimate web-search tool cost: ${JSON.stringify(privateSearchEstimate)}`);
  }

  const openRouterProviderCostUsage = openRouterUsage({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 2000,
      total_tokens: 3000,
      cost: 0.000123,
    },
  }, "Private Instant");
  if (openRouterProviderCostUsage.costUsd !== 0.000123) {
    throw new Error(`OpenRouter usage should prefer provider-returned cost: ${JSON.stringify(openRouterProviderCostUsage)}`);
  }

  const openRouterZeroCostUsage = openRouterUsage({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 2000,
      total_tokens: 3000,
      cost: 0,
    },
  }, "Private Instant");
  if (openRouterZeroCostUsage.costUsd !== 0) {
    throw new Error(`OpenRouter usage should preserve provider-returned zero cost: ${JSON.stringify(openRouterZeroCostUsage)}`);
  }

  const deepSeekDiscountUsage = deepSeekUsage({
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 200,
      prompt_cache_miss_tokens: 800,
      completion_tokens: 2000,
      total_tokens: 3000,
    },
  }, "Discount Thinking");
  if (deepSeekDiscountUsage.costUsd !== 0.002089) {
    throw new Error(`DeepSeek direct usage should use cache-aware direct API pricing: ${JSON.stringify(deepSeekDiscountUsage)}`);
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
    throw new Error(`OpenAI Responses request is missing prompt-governed search tool or readable text attachment support: ${JSON.stringify(frontierRequest)}`);
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

  if (
    basicFrontierRequest.tools?.[0]?.type !== "web_search" ||
    basicFrontierRequest.tool_choice !== "auto" ||
    Object.prototype.hasOwnProperty.call(basicFrontierRequest, "max_output_tokens")
  ) {
    throw new Error(`Basic OpenAI Responses requests should carry prompt-governed web search tools without a hard output cap: ${JSON.stringify(basicFrontierRequest)}`);
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
  const makeSmokeTask = (prefix, index, status, pft = 0) => ({
    fullId: `${prefix.toLowerCase().replace(/\s+/g, "_")}_${index}`,
    title: `${prefix} task ${index}`,
    kind: index % 2 === 0 ? "Engineering" : "Personal",
    status,
    due: "May 18, 4:00 PM",
    pft,
    description: `${prefix} smoke task ${index}.`,
    steps: [`Complete ${prefix.toLowerCase()} step ${index}`],
    verification: { body: `${prefix} verification note ${index}.` },
  });
  const smokeTaskContext = {
    sync: {
      source: "task_projections",
      status: "ready",
      projectionCount: 66,
      lastSyncedAt: "2026-05-18T14:00:00.000Z",
    },
    outstanding: Array.from({ length: 21 }, (_, index) => makeSmokeTask("Outstanding", index + 1, "Proposed", 3.2)),
    verification: Array.from({ length: 21 }, (_, index) => makeSmokeTask("Pending verification", index + 1, "Verification requested", 1.5)),
    refused: Array.from({ length: 11 }, (_, index) => makeSmokeTask("Refused", index + 1, "Refused")),
    rewarded: Array.from({ length: 13 }, (_, index) => makeSmokeTask("Rewarded", index + 1, "Rewarded", 2.5)),
  };
  const smokeContextDocument = {
    title: "Runtime Smoke Context",
    revision: 7,
    updatedAt: "2026-05-18T14:30:00.000Z",
    body: "<p>The user's active context sentinel is houston 1421.</p><p>They are fixing P0s in Task Node.</p>",
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
  const chatTaskEstimate = chatEstimate(
    {
      mode: "Frontier Instant",
      message: "Use my tasks and reply.",
    },
    { taskContext: smokeTaskContext }
  );
  if (
    chatTaskEstimate.taskInputTokens <= 0 ||
    chatTaskEstimate.inputTokens <= baseMemoryEstimate.inputTokens ||
    chatTaskEstimate.estimatedUsd <= baseMemoryEstimate.estimatedUsd
  ) {
    throw new Error(`Chat estimate should include billable task context tokens: ${JSON.stringify({ baseMemoryEstimate, chatTaskEstimate })}`);
  }
  const chatContextEstimate = chatEstimate(
    {
      mode: "Frontier Instant",
      message: "What city and number are in my context doc?",
    },
    { contextDocument: smokeContextDocument }
  );
  if (
    chatContextEstimate.contextDocumentInputTokens <= 0 ||
    chatContextEstimate.inputTokens <= baseMemoryEstimate.inputTokens ||
    chatContextEstimate.estimatedUsd <= baseMemoryEstimate.estimatedUsd
  ) {
    throw new Error(`Chat estimate should include billable context document tokens: ${JSON.stringify({ baseMemoryEstimate, chatContextEstimate })}`);
  }

  await saveContextDocument({
    accountId: "account_context_smoke",
    title: smokeContextDocument.title,
    body: smokeContextDocument.body,
  });
  const accountContextEstimate = await chatEstimateForAccount(
    {
      mode: "Frontier Instant",
      message: "What city and number are in my context doc?",
    },
    "account_context_smoke"
  );
  if (accountContextEstimate.contextDocumentInputTokens <= 0) {
    throw new Error(`Account chat estimate must load the saved context document: ${JSON.stringify(accountContextEstimate)}`);
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
  const frontierContextRequest = openAiResponseRequest({
    mode: "Frontier Instant",
    model: "chat-latest",
    message: "What city and number are in my context doc?",
    conversationId: "runtime-smoke-frontier-context-contract",
    contextDocument: smokeContextDocument,
  });
  if (
    !frontierContextRequest.instructions.includes("<account_context_document>") ||
    !frontierContextRequest.instructions.includes("houston 1421") ||
    frontierContextRequest.instructions.includes("<p>")
  ) {
    throw new Error(`OpenAI chat instructions must include the current context document as readable text: ${frontierContextRequest.instructions}`);
  }
  const frontierTaskRequest = openAiResponseRequest({
    mode: "Frontier Instant",
    model: "chat-latest",
    message: "Which task needs attention?",
    conversationId: "runtime-smoke-frontier-task-context-contract",
    taskContext: smokeTaskContext,
  });

  if (
    !frontierTaskRequest.instructions.includes("<outstanding_tasks count=\"21\">") ||
    !frontierTaskRequest.instructions.includes("<pending_verification_tasks count=\"21\">") ||
    !frontierTaskRequest.instructions.includes("<refused_tasks count=\"11\">") ||
    !frontierTaskRequest.instructions.includes("<rewarded_tasks count=\"13\">") ||
    !frontierTaskRequest.instructions.includes("Outstanding task 21") ||
    !frontierTaskRequest.instructions.includes("Pending verification task 21") ||
    !frontierTaskRequest.instructions.includes("Refused task 10") ||
    frontierTaskRequest.instructions.includes("Refused task 11") ||
    !frontierTaskRequest.instructions.includes("Rewarded task 12") ||
    frontierTaskRequest.instructions.includes("Rewarded task 13")
  ) {
    throw new Error(`OpenAI task context must include grouped task state: ${frontierTaskRequest.instructions}`);
  }
  const frontierThinkingTaskRequest = openAiResponseRequest({
    mode: "Frontier Thinking",
    model: "gpt-5.5",
    message: "Think through my task state.",
    conversationId: "runtime-smoke-frontier-thinking-task-context-contract",
    taskContext: smokeTaskContext,
  });
  if (!frontierThinkingTaskRequest.instructions.includes("<account_tasks_context>")) {
    throw new Error(`Frontier Thinking must include grouped task context: ${frontierThinkingTaskRequest.instructions}`);
  }
  const frontierThinkingContextRequest = openAiResponseRequest({
    mode: "Frontier Thinking",
    model: "gpt-5.5",
    message: "Think through my context.",
    conversationId: "runtime-smoke-frontier-thinking-context-contract",
    contextDocument: smokeContextDocument,
  });
  if (!frontierThinkingContextRequest.instructions.includes("houston 1421")) {
    throw new Error(`Frontier Thinking must include current context document: ${frontierThinkingContextRequest.instructions}`);
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
    Object.prototype.hasOwnProperty.call(frontierThinkingRequest, "max_output_tokens")
  ) {
    throw new Error(`Frontier Thinking must use gpt-5.5 high reasoning without a hard output cap: ${JSON.stringify(frontierThinkingRequest)}`);
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
    openRouterRequest.provider?.require_parameters !== true ||
    openRouterRequest.provider?.order?.[0] !== "parasail" ||
    openRouterRequest.provider?.only?.includes("akashml") !== true ||
    openRouterRequest.reasoning?.effort !== "none" ||
    openRouterRequest.reasoning?.exclude !== true ||
    openRouterRequest.max_tokens !== 16384 ||
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
  const openRouterContextRequest = openRouterChatRequest({
    mode: "Private Instant",
    model: "openrouter/auto",
    message: "What city and number are in my context doc?",
    conversationId: "runtime-smoke-openrouter-context-contract",
    contextDocument: smokeContextDocument,
  });
  const openRouterContextInstructions = openRouterContextRequest.messages?.[0]?.content || "";
  if (
    !openRouterContextInstructions.includes("<account_context_document>") ||
    !openRouterContextInstructions.includes("houston 1421") ||
    openRouterContextInstructions.includes("<p>")
  ) {
    throw new Error(`OpenRouter chat instructions must include the current context document as readable text: ${openRouterContextInstructions}`);
  }
  const openRouterTaskRequest = openRouterChatRequest({
    mode: "Private Instant",
    model: "openrouter/auto",
    message: "Which task needs attention?",
    conversationId: "runtime-smoke-openrouter-task-context-contract",
    taskContext: smokeTaskContext,
  });
  const openRouterTaskInstructions = openRouterTaskRequest.messages?.[0]?.content || "";

  if (
    !openRouterTaskInstructions.includes("<account_tasks_context>") ||
    !openRouterTaskInstructions.includes("<outstanding_tasks count=\"21\">") ||
    !openRouterTaskInstructions.includes("<pending_verification_tasks count=\"21\">") ||
    !openRouterTaskInstructions.includes("<refused_tasks count=\"11\">") ||
    !openRouterTaskInstructions.includes("<rewarded_tasks count=\"13\">") ||
    !openRouterTaskInstructions.includes("Outstanding task 21") ||
    !openRouterTaskInstructions.includes("Pending verification task 21") ||
    !openRouterTaskInstructions.includes("Refused task 10") ||
    openRouterTaskInstructions.includes("Refused task 11") ||
    !openRouterTaskInstructions.includes("Rewarded task 12") ||
    openRouterTaskInstructions.includes("Rewarded task 13")
  ) {
    throw new Error(`OpenRouter task context must include grouped task state: ${openRouterTaskInstructions}`);
  }
  const openRouterThinkingTaskRequest = openRouterChatRequest({
    mode: "Private Thinking",
    model: "openrouter/auto",
    message: "Think through my task state.",
    conversationId: "runtime-smoke-openrouter-thinking-task-context-contract",
    taskContext: smokeTaskContext,
  });
  const openRouterThinkingTaskInstructions = openRouterThinkingTaskRequest.messages?.[0]?.content || "";
  if (!openRouterThinkingTaskInstructions.includes("<account_tasks_context>")) {
    throw new Error(`Private Thinking must include grouped task context: ${openRouterThinkingTaskInstructions}`);
  }
  const openRouterThinkingContextRequest = openRouterChatRequest({
    mode: "Private Thinking",
    model: "openrouter/auto",
    message: "Think through my context.",
    conversationId: "runtime-smoke-openrouter-thinking-context-contract",
    contextDocument: smokeContextDocument,
  });
  const openRouterThinkingContextInstructions = openRouterThinkingContextRequest.messages?.[0]?.content || "";
  if (!openRouterThinkingContextInstructions.includes("houston 1421")) {
    throw new Error(`Private Thinking must include current context document: ${openRouterThinkingContextInstructions}`);
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

  const deepSeekThinkingRequest = deepSeekChatRequest({
    mode: "Discount Thinking",
    model: "deepseek-v4-pro",
    message: "Review the note.",
    conversationId: "runtime-smoke-deepseek-contract",
    attachments: [
      {
        name: "note.txt",
        mimeType: "text/plain",
        size: 11,
        dataUrl: "data:text/plain;base64,aGVsbG8gd29ybGQ=",
      },
      {
        name: "pixel.png",
        mimeType: "image/png",
        size: 68,
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    ],
  });
  const deepSeekUserMessage = deepSeekThinkingRequest.messages.at(-1)?.content || "";
  if (
    deepSeekThinkingRequest.model !== "deepseek-v4-pro" ||
    deepSeekThinkingRequest.thinking?.type !== "enabled" ||
    deepSeekThinkingRequest.reasoning_effort !== "high" ||
    deepSeekThinkingRequest.max_tokens !== 4096 ||
    !deepSeekUserMessage.includes("hello world") ||
    !deepSeekUserMessage.includes("Attached file not sent to DeepSeek API Direct")
  ) {
    throw new Error(`Discount Thinking must use direct DeepSeek high reasoning with text-only attachment handling: ${JSON.stringify(deepSeekThinkingRequest)}`);
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

  const { runEthereumDepositSmoke } = await import("./ethereum-deposit-smoke.mjs");
  await runEthereumDepositSmoke({
    appendChatTurn,
    appendUsageCredit,
    depositReceiveNode,
    getEthereumDepositAccount,
    getOrCreateEmailAccount,
    linkWalletToAccount,
    updateEthereumDepositSync,
    usageActions,
    usageTopUpStart,
    usageTopUpSync,
  });

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
  const createStart = await walletCreateStart("POST", createFlowSession.session);
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
    createVerify.body.initiationGift?.status !== "local_vault_required"
  ) {
    throw new Error(`Create wallet flow did not link with a local-vault gate: ${JSON.stringify({ createStart, createVerify, createLinkedWallet })}`);
  }
  const retryWithoutVault = await walletActionStart(
    "/api/wallet/initiation/retry",
    "POST",
    createFlowSession.session
  );
  if (
    retryWithoutVault.status !== 409 ||
    retryWithoutVault.body?.error !== "local_vault_confirmation_required"
  ) {
    throw new Error(`Initiation retry should require local vault confirmation: ${JSON.stringify(retryWithoutVault)}`);
  }
  const retryWithoutFaucet = await walletActionStart(
    "/api/wallet/initiation/retry",
    "POST",
    createFlowSession.session,
    { localVaultConfirmed: true }
  );
  if (
    retryWithoutFaucet.status !== 502 ||
    retryWithoutFaucet.body?.initiationGift?.reason !== "faucet_not_configured"
  ) {
    throw new Error(`Initiation retry should report faucet configuration without relinking: ${JSON.stringify(retryWithoutFaucet)}`);
  }

  const linkFlowAccount = getOrCreateProviderAccount({ provider: "github", providerUserId: "runtime-smoke-link-gh", username: "runtime-smoke-link" });
  const linkFlowSession = createAccountSession(linkFlowAccount, { provider: "github", assurance: "medium" });
  const linkStart = walletLinkStart("POST", linkFlowSession.session);
  const linkProof = signWalletChallenge(generateTaskNodeMnemonic(), linkStart.body.challenge.message);
  const linkVerify = await walletLinkVerify({ challengeId: linkStart.body.challenge.id, address: linkProof.address, publicKey: linkProof.publicKey, signature: linkProof.signature }, "POST", linkFlowSession.session);
  const linkLinkedWallet = getLinkedWallet({ accountId: linkFlowAccount.id });
  if (linkStart.status !== 200 || linkStart.body.challenge.purpose !== "wallet_link" || linkVerify.status !== 200 || linkLinkedWallet.status !== "linked" || linkLinkedWallet.address !== linkProof.address) {
    throw new Error(`Link wallet flow did not persist linked proof: ${JSON.stringify({ linkStart, linkVerify, linkLinkedWallet })}`);
  }
  const retryAfterLink = await walletActionStart("/api/wallet/initiation/retry", "POST", linkFlowSession.session, { localVaultConfirmed: true });
  if (retryAfterLink.status !== 409 || retryAfterLink.body?.initiationGift?.reason !== "wallet_create_proof_required") {
    throw new Error(`Initiation retry must reject linked-only wallets: ${JSON.stringify(retryAfterLink)}`);
  }
  const emailAccount = getOrCreateEmailAccount({ email: "runtime-smoke@example.com", canonicalEmail: "runtime-smoke@example.com", maskedEmail: "r***@example.com" });
  const emailGift = walletInitiationGrantStatus({ accountId: emailAccount.id });
  if (emailGift.eligible || emailGift.reason !== "email_ineligible") {
    throw new Error(`Email-only accounts must not be initiation-gift eligible: ${JSON.stringify(emailGift)}`);
  }
  const emailTopUpGrantAccount = getOrCreateEmailAccount({ email: "runtime-smoke-usdc-grant@example.com", canonicalEmail: "runtime-smoke-usdc-grant@example.com", maskedEmail: "r***@example.com" });
  linkWalletToAccount({ accountId: emailTopUpGrantAccount.id, address: "rRuntimeSmokeUsdcTopUpGrant1111111", publicKey: "runtime-smoke-usdc-topup-pubkey", challengeId: "runtime-smoke-usdc-topup-challenge", signature: "runtime-smoke-usdc-topup-signature", proofPurpose: "wallet_create" });
  const emailTopUpGift = walletInitiationGrantStatus({ accountId: emailTopUpGrantAccount.id, walletAddress: "rRuntimeSmokeUsdcTopUpGrant1111111", source: "usdc_top_up" });
  if (!emailTopUpGift.eligible || emailTopUpGift.amountPft !== 12) {
    throw new Error(`Email account with a created wallet should be USDC top-up grant eligible: ${JSON.stringify(emailTopUpGift)}`);
  }
  linkWalletToAccount({ accountId: emailTopUpGrantAccount.id, address: "rRuntimeSmokeUsdcTopUpGrant1111111", publicKey: "runtime-smoke-usdc-topup-relink-pubkey", challengeId: "runtime-smoke-usdc-topup-relink-challenge", signature: "runtime-smoke-usdc-topup-relink-signature", proofPurpose: "wallet_relink" });
  const relinkedWallet = getLinkedWallet({ accountId: emailTopUpGrantAccount.id });
  const relinkedTopUpGift = walletInitiationGrantStatus({ accountId: emailTopUpGrantAccount.id, walletAddress: relinkedWallet.address, source: "usdc_top_up" });
  if (relinkedWallet.walletCreatedInAccount !== true || !relinkedTopUpGift.eligible || relinkedTopUpGift.amountPft !== 12) {
    throw new Error(`Relinked created wallet should remain USDC top-up grant eligible: ${JSON.stringify({ relinkedWallet, relinkedTopUpGift })}`);
  }
  const reservedTopUpGift = await reserveWalletInitiationGrant({
    accountId: emailTopUpGrantAccount.id,
    walletAddress: "rRuntimeSmokeUsdcTopUpGrant1111111",
    amountDrops: emailTopUpGift.amountDrops,
    amountPft: emailTopUpGift.amountPft,
    source: "usdc_top_up",
    trigger: {
      asset: "USDC",
      amountUsd: 12.34,
      ledgerEntryId: "ledger_runtime_smoke_usdc_topup",
      depositAccountId: "ethdep_runtime_smoke_usdc_topup",
      topUpUniqueKey: "ethereum_deposit:ethdep_runtime_smoke_usdc_topup:USDC:12340000",
    },
  });
  if (
    !reservedTopUpGift.ok ||
    reservedTopUpGift.grant.status !== "processing" ||
    reservedTopUpGift.grant.source !== "usdc_top_up"
  ) {
    throw new Error(`USDC top-up grant was not reserved for an email account: ${JSON.stringify(reservedTopUpGift)}`);
  }
  await completeWalletInitiationGrant({ grantId: reservedTopUpGift.internalGrant.id, txHash: "RUNTIME_SMOKE_USDC_TOPUP_INIT_TX", faucetAddress: "rRuntimeSmokeFaucet" });
  const replayTopUpGift = walletInitiationGrantStatus({ accountId: emailTopUpGrantAccount.id, walletAddress: "rRuntimeSmokeUsdcTopUpGrant1111111", source: "usdc_top_up" });
  if (replayTopUpGift.eligible || replayTopUpGift.reason !== "account_registered") {
    throw new Error(`USDC top-up grant must be account-idempotent: ${JSON.stringify(replayTopUpGift)}`);
  }
  const firstGiftStatus = walletInitiationGrantStatus({
    accountId: oauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInit1111111111111",
  });
  if (!firstGiftStatus.eligible || firstGiftStatus.amountPft !== 12) {
    throw new Error(`OAuth account should be eligible for one wallet initiation gift: ${JSON.stringify(firstGiftStatus)}`);
  }
  const reservedGift = await reserveWalletInitiationGrant({
    accountId: oauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInit1111111111111",
    amountDrops: firstGiftStatus.amountDrops,
    amountPft: firstGiftStatus.amountPft,
  });
  if (!reservedGift.ok || reservedGift.grant.status !== "processing") {
    throw new Error(`Wallet initiation grant was not reserved: ${JSON.stringify(reservedGift)}`);
  }
  const completedGift = await completeWalletInitiationGrant({
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
  const deletedGiftAccount = deleteAccountRuntimeData({
    accountId: oauthAccount.id,
    archiveId: "deleted_account_runtime_smoke_oauth",
    actorSessionId: "runtime-smoke-session",
    reason: "runtime_smoke_recreate_guard",
  });
  if (!deletedGiftAccount.ok || deletedGiftAccount.removed.accountDeletionAudit !== 1) {
    throw new Error(`Account deletion should create a deletion audit record: ${JSON.stringify(deletedGiftAccount)}`);
  }
  const recreatedOauthAccount = getOrCreateProviderAccount({
    provider: "github",
    providerUserId: "runtime-smoke-gh",
    username: "runtime-smoke",
  });
  const recreatedGift = walletInitiationGrantStatus({
    accountId: recreatedOauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInitReplay111111",
  });
  if (recreatedGift.eligible || recreatedGift.reason !== "deleted_account_faucet_guard") {
    throw new Error(`Deleted account identity must not be eligible for another initiation grant: ${JSON.stringify(recreatedGift)}`);
  }
  process.env.TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_ACCOUNT_IDS = recreatedOauthAccount.id;
  const exemptRecreatedGift = walletInitiationGrantStatus({
    accountId: recreatedOauthAccount.id,
    walletAddress: "rRuntimeSmokeWalletInitReplay111111",
  });
  delete process.env.TASKNODE_DELETION_FAUCET_GUARD_EXEMPT_ACCOUNT_IDS;
  if (!exemptRecreatedGift.eligible) {
    throw new Error(`Configured QA account exemption should allow recycled account testing: ${JSON.stringify(exemptRecreatedGift)}`);
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

  const projected = saveContextHistoryProjection({
    accountId: "acct_runtime_smoke",
    projection: {
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

  if (!projected.ok || history.contextUpdateCount !== 1 || history.taskEventCount !== 1) {
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
  const accountWalletCloud = getAccountWalletCloud({ accountId: accountSession.accountId });
  const cloudAddresses = accountWalletCloud.wallets.map((wallet) => wallet.address).sort();
  if (
    accountWalletCloud.activeWalletAddress !== "rDifferentSmokeWallet" ||
    !cloudAddresses.includes("rSmokeWalletAddress") ||
    !cloudAddresses.includes("rDifferentSmokeWallet")
  ) {
    throw new Error(`Account wallet cloud did not retain linked-wallet history: ${JSON.stringify(accountWalletCloud)}`);
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
  const reclaimedCloud = getAccountWalletCloud({ accountId: "acct_reclaim_owner_a" });
  if (reclaimedCloud.wallets.some((wallet) => wallet.address === reclaimAddress)) {
    throw new Error(`Reclaimed wallet stayed in old owner cloud: ${JSON.stringify(reclaimedCloud)}`);
  }

  if (!history.latestContextPointer?.cid || history.latestContextPointer.cid !== "bafyContextSmoke") {
    throw new Error("Latest context pointer was not normalized.");
  }

  if (!serializedHistory.includes("bafyEvidenceSmoke")) {
    throw new Error("Projected task event CID was not retained.");
  }

  if (serializedHistory.includes("PRIVATE EVIDENCE TEXT MUST NOT BE STORED")) {
    throw new Error("Context history projection leaked raw event payload text.");
  }

  console.log("runtime store smoke ok");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
