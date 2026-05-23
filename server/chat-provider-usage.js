import { actualChatCost, chatModeConfig } from "./chat-router.js";
import { maxOpenAiWebSearchToolCalls, webSearchUsdPerCall } from "./chat-search-tools.js";

function countOpenAiOutputItems(body, type) {
  return (body?.output || []).filter((item) => item?.type === type).length;
}

export function openAiUsage(body, mode) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.input_tokens || 0);
  const outputTokens = Number(usage.output_tokens || 0);
  const webSearchCalls = Math.max(
    countOpenAiOutputItems(body, "web_search_call"),
    Number(usage.web_search_calls || usage.web_search_requests || 0)
  );
  const tokenCostUsd = actualChatCost(mode, { inputTokens, outputTokens });
  const toolCostUsd = Number((webSearchCalls * webSearchUsdPerCall).toFixed(6));
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens || inputTokens + outputTokens),
    webSearchCalls,
    toolCostUsd,
    costUsd: Number((tokenCostUsd + toolCostUsd).toFixed(6)),
  };
}

export function openRouterUsage(body, mode) {
  const usage = body?.usage || {};
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  const providerCost = Number(usage.cost || 0);
  const webSearchCalls = Number(usage.server_tool_use?.web_search_requests || 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(usage.total_tokens || inputTokens + outputTokens),
    webSearchCalls,
    toolCostUsd: 0,
    costUsd: Number(
      (providerCost || actualChatCost(mode, { inputTokens, outputTokens })).toFixed(6)
    ),
  };
}

export function fallbackUsage({ mode, message, text }) {
  const inputTokens = Math.max(1, Math.ceil(String(message || "").length / 4));
  const outputTokens = Math.max(1, Math.ceil(String(text || "").length / 4));
  const config = chatModeConfig(mode);
  const webSearchCalls = config.provider === "openai" ? maxOpenAiWebSearchToolCalls : 0;
  const toolCostUsd = Number((webSearchCalls * webSearchUsdPerCall).toFixed(6));
  const tokenCostUsd = actualChatCost(mode, { inputTokens, outputTokens });

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    webSearchCalls,
    toolCostUsd,
    costUsd: Number((tokenCostUsd + toolCostUsd).toFixed(6)),
    estimated: true,
  };
}
