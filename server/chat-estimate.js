import {
  actualChatCost,
  chatExecutionStatus,
  chatInputCharacterEstimate,
  chatModeConfig,
  effectiveDefaultChatMode,
  isKnownChatMode,
  normalizedChatMode,
} from "./chat-router.js";
import { effectiveDefaultChatMode as defaultChatModeForEstimate } from "./chat-mode-defaults.js";
import { chatHistoryCharacterEstimate } from "./chat-provider-message-builders.js";
import {
  chatMemoryContextForAccount,
  formatChatMemoryContext,
  taskNodeInstructions,
} from "./chat-memory-context.js";
import {
  chatContextDocumentForAccount,
  formatChatContextDocument,
} from "./chat-account-context.js";
import {
  maxOpenAiWebSearchToolCalls,
  webSearchUsdPerCall,
} from "./chat-search-tools.js";
import {
  formatChatTaskContext,
  taskContextForAccount,
} from "./chat-task-context.js";
import { jobsRetrievalEstimateText } from "./jobs-corpus.js";
import { contextDocumentPacket } from "./context-line-map.js";
import {
  contextEditPromptText,
  renderContextEditPrompt,
} from "./context-edit-prompts.js";
import { getActiveContextEditProposal } from "./repositories/context-edit.js";
import { getChatMessages } from "./repositories/chat-billing.js";

function estimatePayload(payload) {
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  const requestedMode = typeof payload?.mode === "string" ? payload.mode.trim() : "";
  const mode = requestedMode || defaultChatModeForEstimate();
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments.slice(0, 4) : [];
  const contextMode = payload?.contextMode === "context_edit" || mode === "context_edit" ? "context_edit" : "";
  const effectiveMode = contextMode ? "Frontier Thinking" : mode;
  if (!isKnownChatMode(effectiveMode)) {
    const error = new Error("unknown_chat_mode");
    error.status = 400;
    error.mode = effectiveMode;
    throw error;
  }
  return { message, mode: normalizedChatMode(effectiveMode), attachments, contextMode };
}

export function chatEstimate(
  payload,
  {
    contextDocument = null,
    memoryContext = null,
    taskContext = null,
    historyMessages = null,
    activeProposal = null,
  } = {}
) {
  const { message, mode, attachments, contextMode } = estimatePayload(payload);
  const modeConfig = chatModeConfig(mode);
  const baseInputCharacters = chatInputCharacterEstimate({ message, attachments });
  const historyCharacters = contextMode === "context_edit" || !Array.isArray(historyMessages) || historyMessages.length === 0
    ? 0
    : chatHistoryCharacterEstimate(historyMessages, { provider: modeConfig.provider });
  const contextDocumentCharacters = formatChatContextDocument(contextDocument).length;
  const memoryContextCharacters = formatChatMemoryContext(memoryContext).length;
  const taskContextCharacters = formatChatTaskContext(taskContext).length;
  const estimatedJobsEssence = contextMode === "context_edit" ? "" : jobsRetrievalEstimateText();
  const jobsRetrievalCharacters = estimatedJobsEssence.length;
  const instructionCharacters = contextMode === "context_edit"
    ? renderContextEditPrompt({
        contextDocument,
        memoryContext,
        taskContext,
        historyMessages: Array.isArray(historyMessages) ? historyMessages : [],
        activeProposal,
        userRequest: message,
      }).length
    : taskNodeInstructions({
        contextDocument,
        memoryContext,
        taskContext,
        jobsEssence: estimatedJobsEssence,
      }).length;
  const contextEditLineNumberCharacters = contextMode === "context_edit"
    ? contextDocumentPacket(contextDocument || {}).lineNumberedText.length
    : 0;
  const contextEditPromptCharacters = contextMode === "context_edit" ? contextEditPromptText.length : 0;
  const baseInstructionCharacters = Math.max(
    0,
    instructionCharacters -
      contextDocumentCharacters -
      memoryContextCharacters -
      taskContextCharacters -
      jobsRetrievalCharacters
  );
  const inputCharacters = baseInputCharacters + historyCharacters + instructionCharacters;
  const inputTokens = Math.max(1, Math.ceil(inputCharacters / 4));
  const baseInputTokens = Math.max(1, Math.ceil((baseInputCharacters + historyCharacters) / 4));
  const contextDocumentInputTokens = contextDocumentCharacters > 0 ? Math.ceil(contextDocumentCharacters / 4) : 0;
  const memoryInputTokens = memoryContextCharacters > 0 ? Math.ceil(memoryContextCharacters / 4) : 0;
  const taskInputTokens = taskContextCharacters > 0 ? Math.ceil(taskContextCharacters / 4) : 0;
  const jobsRetrievalInputTokens = jobsRetrievalCharacters > 0 ? Math.ceil(jobsRetrievalCharacters / 4) : 0;
  const historyInputTokens = historyCharacters > 0 ? Math.ceil(historyCharacters / 4) : 0;
  const instructionInputTokens = Math.max(1, Math.ceil(instructionCharacters / 4));
  const baseInstructionInputTokens =
    baseInstructionCharacters > 0 ? Math.ceil(baseInstructionCharacters / 4) : 0;
  const estimatedOutputTokens = modeConfig.maxOutputTokens || (modeConfig.reasoningEffort ? 1800 : 700);
  const estimatedTokenUsd = actualChatCost(mode, {
    inputTokens,
    outputTokens: estimatedOutputTokens,
  });
  const estimatedWebSearchCalls =
    modeConfig.provider === "openai" && contextMode !== "context_edit" ? maxOpenAiWebSearchToolCalls : 0;
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
    contextMode,
    executionReady: execution.enabled,
    inputTokens,
    baseInputTokens,
    instructionInputTokens,
    baseInstructionInputTokens,
    contextDocumentInputTokens,
    memoryInputTokens,
    taskInputTokens,
    jobsRetrievalInputTokens,
    historyInputTokens,
    historyCharacters,
    instructionCharacters,
    baseInstructionCharacters,
    contextDocumentCharacters,
    memoryContextCharacters,
    taskContextCharacters,
    jobsRetrievalCharacters,
    contextEditLineNumberCharacters,
    contextEditPromptCharacters,
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
  const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId.trim() : "";
  const contextMode = payload?.contextMode === "context_edit" || payload?.mode === "context_edit"
    ? "context_edit"
    : "";

  const [contextDocument, memoryContext, taskContext, historyMessages, activeProposal] = await Promise.all([
    accountId ? chatContextDocumentForAccount(accountId) : null,
    accountId ? chatMemoryContextForAccount(accountId) : null,
    accountId ? taskContextForAccount(accountId) : null,
    accountId && conversationId
      ? getChatMessages({ accountId, conversationId, limit: 12 }).catch(() => [])
      : [],
    accountId && conversationId && contextMode
      ? getActiveContextEditProposal({ accountId, conversationId }).catch(() => null)
      : null,
  ]);

  return chatEstimate(payload, {
    contextDocument,
    memoryContext,
    taskContext,
    historyMessages,
    activeProposal,
  });
}
