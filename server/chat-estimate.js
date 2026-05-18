import {
  actualChatCost,
  chatExecutionStatus,
  chatInputCharacterEstimate,
  chatModeConfig,
  normalizedChatMode,
} from "./chat-router.js";
import {
  chatMemoryContextForAccount,
  formatChatMemoryContext,
} from "./chat-memory-context.js";
import {
  chatContextDocumentForAccount,
  formatChatContextDocument,
} from "./chat-account-context.js";
import {
  maxOpenAiWebSearchToolCalls,
  shouldUseWebSearch,
  webSearchUsdPerCall,
} from "./chat-search-tools.js";
import {
  formatChatTaskContext,
  taskContextForAccount,
} from "./chat-task-context.js";

function estimatePayload(payload) {
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  const mode = typeof payload?.mode === "string" ? payload.mode : "Private Instant";
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments.slice(0, 4) : [];
  return { message, mode: normalizedChatMode(mode), attachments };
}

export function chatEstimate(payload, { contextDocument = null, memoryContext = null, taskContext = null } = {}) {
  const { message, mode, attachments } = estimatePayload(payload);
  const modeConfig = chatModeConfig(mode);
  const baseInputCharacters = chatInputCharacterEstimate({ message, attachments });
  const contextDocumentCharacters = formatChatContextDocument(contextDocument).length;
  const memoryContextCharacters = formatChatMemoryContext(memoryContext).length;
  const taskContextCharacters = formatChatTaskContext(taskContext).length;
  const inputCharacters = baseInputCharacters + contextDocumentCharacters + memoryContextCharacters + taskContextCharacters;
  const inputTokens = Math.max(1, Math.ceil(inputCharacters / 4));
  const baseInputTokens = Math.max(1, Math.ceil(baseInputCharacters / 4));
  const contextDocumentInputTokens = contextDocumentCharacters > 0 ? Math.ceil(contextDocumentCharacters / 4) : 0;
  const memoryInputTokens = memoryContextCharacters > 0 ? Math.ceil(memoryContextCharacters / 4) : 0;
  const taskInputTokens = taskContextCharacters > 0 ? Math.ceil(taskContextCharacters / 4) : 0;
  const estimatedOutputTokens = modeConfig.maxOutputTokens || (mode.includes("Thinking") ? 1800 : 700);
  const estimatedTokenUsd = actualChatCost(mode, {
    inputTokens,
    outputTokens: estimatedOutputTokens,
  });
  const estimatedWebSearchCalls =
    modeConfig.provider === "openai" && shouldUseWebSearch(message) ? maxOpenAiWebSearchToolCalls : 0;
  const estimatedToolCostUsd = Number((estimatedWebSearchCalls * webSearchUsdPerCall).toFixed(6));
  const estimatedUsd = Number(Math.max(0.0001, estimatedTokenUsd + estimatedToolCostUsd).toFixed(6));
  const execution = chatExecutionStatus(mode);

  return {
    ok: true,
    mode,
    provider: execution.provider,
    model: execution.model,
    providerConfigured: execution.configured,
    providerStatus: execution.status,
    executionReady: execution.enabled,
    inputTokens,
    baseInputTokens,
    contextDocumentInputTokens,
    memoryInputTokens,
    taskInputTokens,
    contextDocumentCharacters,
    memoryContextCharacters,
    taskContextCharacters,
    estimatedOutputTokens,
    estimatedWebSearchCalls,
    estimatedTokenUsd,
    estimatedToolCostUsd,
    estimatedUsd,
    currency: "USD",
    billingModel: "usage_based",
    requiresConfirmation: estimatedUsd >= 0.05,
    policy: "This is an estimate only. Final billing is based on provider usage returned after execution.",
  };
}

export async function chatEstimateForAccount(payload, accountId = "") {
  const [contextDocument, memoryContext, taskContext] = accountId
    ? await Promise.all([
        chatContextDocumentForAccount(accountId),
        chatMemoryContextForAccount(accountId),
        taskContextForAccount(accountId),
      ])
    : [null, null, null];
  return chatEstimate(payload, { contextDocument, memoryContext, taskContext });
}
