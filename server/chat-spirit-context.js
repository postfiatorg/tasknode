import { loadPrompt, promptDigest, renderPromptTemplate } from "./prompt-registry.js";

const defaultChatSpiritPrompt = "chat/jobs_standard_chat_codex_style_draft.md";
const jobsRetrievalPlaceholder =
  "No retrieved Jobs corpus chunks are available for this turn. Use the operating prompt and the supplied Task Node context.";
const userMessagePointer =
  "The current user message is supplied separately as the provider user message. Do not duplicate or quote it from this slot.";

let cachedPrompt = null;
let cachedPromptPath = null;

export function isChatSpiritEnabled() {
  const value = String(process.env.TASKNODE_CHAT_SPIRIT_ENABLED || "true").trim().toLowerCase();
  return !["0", "false", "off", "disabled"].includes(value);
}

export function chatSpiritPromptPath() {
  return process.env.TASKNODE_CHAT_SPIRIT_PROMPT || defaultChatSpiritPrompt;
}

function chatSpiritPrompt() {
  const promptPath = chatSpiritPromptPath();
  if (cachedPrompt && cachedPromptPath === promptPath) return cachedPrompt;
  cachedPrompt = loadPrompt(promptPath);
  cachedPromptPath = promptPath;
  return cachedPrompt;
}

export function chatSpiritMetadata() {
  const prompt = chatSpiritPrompt();
  return {
    enabled: isChatSpiritEnabled(),
    path: chatSpiritPromptPath(),
    digest: promptDigest(prompt),
  };
}

export function formatChatSpiritContext({
  contextDocumentBlock = "",
  taskBlock = "",
  memoryBlock = "",
  jobsEssence = "",
  userMessage = "",
} = {}) {
  if (!isChatSpiritEnabled()) return "";

  const currentPlate = [taskBlock, memoryBlock].filter(Boolean).join("\n\n");
  return renderPromptTemplate(chatSpiritPrompt(), {
    CONTEXT_DOCUMENT: contextDocumentBlock,
    CURRENT_PLATE: currentPlate,
    RELEVANT_JOBS_ESSENCE_FROM_VECTOR_DB: jobsEssence || jobsRetrievalPlaceholder,
    USER_MESSAGE: userMessage || userMessagePointer,
  });
}
