import { getChatMemoryContext } from "./repositories/chat-memory.js";
import { loadPrompt, renderPromptTemplate } from "./prompt-registry.js";
import { formatChatContextDocument } from "./chat-account-context.js";
import { formatChatTaskContext } from "./chat-task-context.js";
import { formatChatSpiritContext, isChatSpiritEnabled } from "./chat-spirit-context.js";
import { buildMemoryContextStatus, memoryContextIsEmpty } from "./chat-context-status.js";
import { formatSelectedChatPersona } from "./chat-persona-prompts.js";
import { normalizeChatPersona } from "../shared/chat-personas.js";

function boundedEnvInt(value, fallback, min, max) {
  const parsed = Number(value);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(base, min), max);
}

const memoryContextDeepLimit = boundedEnvInt(process.env.TASKNODE_CHAT_MEMORY_CONTEXT_DEEP_LIMIT, 3, 0, 10);
const memoryContextTurnLimit = boundedEnvInt(process.env.TASKNODE_CHAT_MEMORY_CONTEXT_TURN_LIMIT, 36, 0, 72);
const memoryContextTimeoutMs = boundedEnvInt(process.env.TASKNODE_CHAT_MEMORY_CONTEXT_TIMEOUT_MS, 250, 50, 2500);
const memoryContextTurnMaxChars = boundedEnvInt(process.env.TASKNODE_CHAT_MEMORY_CONTEXT_TURN_MAX_CHARS, 1200, 200, 2400);
const memoryContextDeepMaxChars = boundedEnvInt(process.env.TASKNODE_CHAT_MEMORY_CONTEXT_DEEP_MAX_CHARS, 1800, 300, 3000);
const taskNodeInstructionsPrompt = loadPrompt("chat/task_node_instructions_v1.md");
const accountMemoryContextPrompt = loadPrompt("chat/account_memory_context_v1.md");

function formatDeliveryContext(deliveryContext = null) {
  const source = String(deliveryContext?.source || deliveryContext || "").trim();
  if (source !== "telegram_bot") return "";
  return [
    "## Telegram Delivery Contract",
    "You are replying inside the Task Node Telegram bot.",
    "Make the reply short, self-contained, and useful on a phone.",
    "Do not insult, shame, taunt, or perform contempt. Put pressure on the decision or artifact, not on the person.",
    "If the user is showing the product to someone else, be calm, clear, and product-safe.",
    "When any context, memory, task state, or Hive state is available, reference one relevant fact from it. If no useful context is available, say what is missing instead of pretending.",
    "Do not give generic praise. Leave the user sharper about what to do next.",
    "End with exactly one concrete next step, or one clarifying question when the next action is genuinely ambiguous.",
  ].join("\n");
}

function clipMemoryText(value = "", max = 1200) {
  const text = String(value || "").trim().replace(/\n{3,}/g, "\n\n");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 15)).trimEnd()} [truncated]`;
}

function memoryDate(value) {
  if (!value) return "unknown date";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value).slice(0, 40);
  return new Date(parsed).toISOString();
}

export function formatChatMemoryContext(memoryContext = null) {
  const deepMemories = Array.isArray(memoryContext?.deepMemories)
    ? memoryContext.deepMemories.slice(0, memoryContextDeepLimit)
    : [];
  const memories = Array.isArray(memoryContext?.memories)
    ? memoryContext.memories.slice(0, memoryContextTurnLimit)
    : [];

  if (deepMemories.length === 0 && memories.length === 0) return "";

  const deepSection = [];
  const recentSection = [];

  if (deepMemories.length > 0) {
    deepSection.push(
      "<deep_memory>",
      `Last ${deepMemories.length} deep memories, most recent first. Each deep memory includes User, Assistant, and Memory fields.`
    );
    deepMemories.forEach((entry, index) => {
      const title = clipMemoryText(entry.conversationTitle || `Deep memory ${index + 1}`, 120);
      const user = clipMemoryText(entry.userRequestSummary, memoryContextDeepMaxChars);
      const assistant = clipMemoryText(entry.systemResponseSummary, memoryContextDeepMaxChars);
      const memory = clipMemoryText(entry.memoryText, memoryContextDeepMaxChars);
      deepSection.push(
        `Deep Memory ${index + 1} - ${memoryDate(entry.createdAt)} - ${title}`,
        "User:",
        user || "(empty)",
        "Assistant:",
        assistant || "(empty)",
        "Memory:",
        memory || "(empty)"
      );
    });
    deepSection.push("</deep_memory>");
  }

  if (memories.length > 0) {
    recentSection.push(
      "<recent_memories>",
      `Last ${memories.length} memory records, most recent first. These records intentionally include only date and memory.`
    );
    memories.forEach((entry, index) => {
      const memory = clipMemoryText(entry.memoryText, memoryContextTurnMaxChars);
      recentSection.push(
        `Memory ${index + 1} - ${memoryDate(entry.createdAt)}`,
        memory || "(empty)"
      );
    });
    recentSection.push("</recent_memories>");
  }

  return renderPromptTemplate(accountMemoryContextPrompt, {
    DEEP_MEMORY_SECTION: deepSection.join("\n"),
    RECENT_MEMORY_SECTION: recentSection.join("\n"),
  });
}

export function taskNodeInstructions({
  message = "",
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
  persona = "jobs",
} = {}) {
  const formattedContextDocument = formatChatContextDocument(contextDocument);
  const formattedMemory = formatChatMemoryContext(memoryContext);
  const formattedTasks = formatChatTaskContext(taskContext);
  const formattedDelivery = formatDeliveryContext(deliveryContext);
  const normalizedPersona = normalizeChatPersona(persona);
  if (!normalizedPersona) throw new Error("unknown_chat_persona");
  const selectedPersona = formatSelectedChatPersona({
    persona: normalizedPersona,
    message,
    contextDocumentBlock: formattedContextDocument,
    memoryBlock: formattedMemory,
    taskBlock: formattedTasks,
  });
  if (selectedPersona) {
    return [taskNodeInstructionsPrompt, formattedDelivery, selectedPersona]
      .filter(Boolean)
      .join("\n\n");
  }
  if (isChatSpiritEnabled()) {
    return [
      taskNodeInstructionsPrompt,
      formattedDelivery,
      formatChatSpiritContext({
        contextDocumentBlock: formattedContextDocument,
        taskBlock: formattedTasks,
        memoryBlock: formattedMemory,
        jobsEssence,
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return [taskNodeInstructionsPrompt, formattedDelivery, formattedContextDocument, formattedTasks, formattedMemory]
    .filter(Boolean)
    .join("\n\n");
}

export async function chatMemoryContextLoadForAccount(accountId = "") {
  if (!accountId) {
    return {
      context: null,
      status: buildMemoryContextStatus({ state: "skipped" }),
    };
  }

  const contextPromise = getChatMemoryContext({
    accountId,
    deepLimit: memoryContextDeepLimit,
    turnLimit: memoryContextTurnLimit,
  });
  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), memoryContextTimeoutMs);
  });

  try {
    const result = await Promise.race([contextPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    if (result?.timedOut) {
      contextPromise.catch((error) => {
        console.warn(`chat memory context load failed after timeout: ${error?.message || error}`);
      });
      return {
        context: null,
        status: buildMemoryContextStatus({ state: "timeout" }),
      };
    }
    const state = memoryContextIsEmpty(result) ? "empty" : "included";
    return {
      context: result,
      status: buildMemoryContextStatus({ context: result, state }),
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    console.warn(`chat memory context load failed: ${error?.message || error}`);
    return {
      context: null,
      status: buildMemoryContextStatus({ state: "error", error: error?.message || String(error) }),
    };
  }
}

export async function chatMemoryContextForAccount(accountId = "") {
  return (await chatMemoryContextLoadForAccount(accountId)).context;
}
