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

function estimatePayload(payload) {
  const message = typeof payload?.message === "string" ? payload.message.trim() : "";
  const mode = typeof payload?.mode === "string" ? payload.mode : "Private Instant";
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments.slice(0, 4) : [];
  return { message, mode: normalizedChatMode(mode), attachments };
}

export function chatEstimate(payload, { memoryContext = null } = {}) {
  const { message, mode, attachments } = estimatePayload(payload);
  const modeConfig = chatModeConfig(mode);
  const baseInputCharacters = chatInputCharacterEstimate({ message, attachments });
  const memoryContextCharacters = formatChatMemoryContext(memoryContext).length;
  const inputCharacters = baseInputCharacters + memoryContextCharacters;
  const inputTokens = Math.max(1, Math.ceil(inputCharacters / 4));
  const baseInputTokens = Math.max(1, Math.ceil(baseInputCharacters / 4));
  const memoryInputTokens = memoryContextCharacters > 0 ? Math.ceil(memoryContextCharacters / 4) : 0;
  const estimatedOutputTokens = modeConfig.maxOutputTokens || (mode.includes("Thinking") ? 1800 : 700);
  const estimatedUsd = actualChatCost(mode, {
    inputTokens,
    outputTokens: estimatedOutputTokens,
  });
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
    memoryInputTokens,
    memoryContextCharacters,
    estimatedOutputTokens,
    estimatedUsd: Number(Math.max(0.0001, estimatedUsd).toFixed(6)),
    currency: "USD",
    billingModel: "usage_based",
    requiresConfirmation: estimatedUsd >= 0.05,
    policy: "This is an estimate only. Final billing is based on provider usage returned after execution.",
  };
}

export async function chatEstimateForAccount(payload, accountId = "") {
  const memoryContext = accountId ? await chatMemoryContextForAccount(accountId) : null;
  return chatEstimate(payload, { memoryContext });
}
