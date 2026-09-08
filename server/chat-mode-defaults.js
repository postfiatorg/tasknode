import { inferenceConfigured } from "./inference.js";

export const fallbackChatModeLabel = "Instant";

export function effectiveDefaultChatMode() {
  if (inferenceConfigured() && process.env.INFERENCE_CHAT_ENABLED !== "false") return "Instant";
  return fallbackChatModeLabel;
}
