import { loadPrompt, renderPromptTemplate } from "./prompt-registry.js";
import { getContextDocument } from "./repositories/context.js";
import { contextBodyText } from "./context-line-map.js";
import { buildContextDocumentStatus, contextDocumentIsEmpty } from "./chat-context-status.js";
import { MODEL_CONTEXT_MAX_CHARS } from "../shared/context-budget.js";

const accountContextPrompt = loadPrompt("chat/account_context_document_v1.md");
const contextDocumentMaxChars = Math.min(
  Math.max(Number(process.env.TASKNODE_CHAT_CONTEXT_DOCUMENT_MAX_CHARS) || MODEL_CONTEXT_MAX_CHARS, 1000),
  MODEL_CONTEXT_MAX_CHARS
);
const contextDocumentTimeoutMs = Math.min(
  Math.max(Number(process.env.TASKNODE_CHAT_CONTEXT_DOCUMENT_TIMEOUT_MS) || 1000, 50),
  2500
);

function clipContextDocumentText(value = "") {
  const text = contextBodyText(value).split(String.fromCharCode(0)).join("").trim();
  if (text.length <= contextDocumentMaxChars) return text;
  return `${text.slice(0, Math.max(0, contextDocumentMaxChars - 15)).trimEnd()} [truncated]`;
}

export function formatChatContextDocument(document = null) {
  const body = clipContextDocumentText(document?.body || "");
  if (!body) return "";

  return renderPromptTemplate(accountContextPrompt, {
    TITLE: document?.title || "Task Node Context",
    REVISION: document?.revision || 0,
    UPDATED_AT: document?.updatedAt || document?.updated_at || "unknown",
    BODY: body,
  });
}

export async function chatContextDocumentLoadForAccount(accountId = "") {
  if (!accountId) {
    return {
      context: null,
      status: buildContextDocumentStatus({ state: "skipped" }),
    };
  }

  const documentPromise = getContextDocument({ accountId });
  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), contextDocumentTimeoutMs);
  });

  try {
    const result = await Promise.race([documentPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    if (result?.timedOut) {
      documentPromise.catch((error) => {
        console.warn(`chat context document load failed after timeout: ${error?.message || error}`);
      });
      return {
        context: null,
        status: buildContextDocumentStatus({ state: "timeout" }),
      };
    }
    const state = contextDocumentIsEmpty(result) ? "empty" : "included";
    return {
      context: result,
      status: buildContextDocumentStatus({ context: result, state }),
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    console.warn(`chat context document load failed: ${error?.message || error}`);
    return {
      context: null,
      status: buildContextDocumentStatus({ state: "error", error: error?.message || String(error) }),
    };
  }
}

export async function chatContextDocumentForAccount(accountId = "") {
  return (await chatContextDocumentLoadForAccount(accountId)).context;
}
