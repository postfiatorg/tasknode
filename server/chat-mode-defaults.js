function hasOpenAi() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function hasOpenRouter() {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER);
}

function hasDeepSeek() {
  return Boolean(process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK);
}

function openRouterChatEnabled() {
  const explicitlyDisabled =
    process.env.OPENROUTER_CHAT_ENABLED === "false" ||
    process.env.TASKNODE_ENABLE_OPENROUTER_CHAT === "false";
  return hasOpenRouter() && !explicitlyDisabled;
}

function deepSeekChatEnabled() {
  const explicitlyDisabled =
    process.env.DEEPSEEK_CHAT_ENABLED === "false" ||
    process.env.TASKNODE_ENABLE_DEEPSEEK_CHAT === "false";
  return hasDeepSeek() && !explicitlyDisabled;
}

export const fallbackChatModeLabel = "Private Instant";

export function effectiveDefaultChatMode() {
  if (hasOpenAi()) return "Frontier Instant";
  if (openRouterChatEnabled()) return "Private Instant";
  if (deepSeekChatEnabled()) return "Discount Thinking";
  if (hasOpenRouter()) return "Private Instant";
  if (hasDeepSeek()) return "Discount Thinking";
  return fallbackChatModeLabel;
}
