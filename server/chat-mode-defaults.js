import { ambientConfigured } from "./ambient-inference.js";

export const fallbackChatModeLabel = "Instant";

export function effectiveDefaultChatMode() {
  if (ambientConfigured() && process.env.AMBIENT_CHAT_ENABLED !== "false") return "Instant";
  return fallbackChatModeLabel;
}
