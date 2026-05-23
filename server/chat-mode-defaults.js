function hasOpenAi() {
  return Boolean(process.env.OPENAI_API_KEY);
}

function hasOpenRouter() {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENROUTER);
}

function openRouterChatEnabled() {
  const explicitlyDisabled =
    process.env.OPENROUTER_CHAT_ENABLED === "false" ||
    process.env.TASKNODE_ENABLE_OPENROUTER_CHAT === "false";
  return hasOpenRouter() && !explicitlyDisabled;
}

export const fallbackChatModeLabel = "Private Instant";

export function effectiveDefaultChatMode() {
  if (hasOpenAi()) return "Frontier Instant";
  if (openRouterChatEnabled()) return "Private Instant";
  if (hasOpenRouter()) return "Private Instant";
  return fallbackChatModeLabel;
}
