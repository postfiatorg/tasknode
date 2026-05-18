import { looksLikeContextHtml } from "../shared/context-html.js";
import { loadPrompt, renderPromptTemplate } from "./prompt-registry.js";
import { getContextDocument } from "./repositories/context.js";

const accountContextPrompt = loadPrompt("chat/account_context_document_v1.md");
const contextDocumentMaxChars = Math.min(
  Math.max(Number(process.env.TASKNODE_CHAT_CONTEXT_DOCUMENT_MAX_CHARS) || 50_000, 1000),
  50_000
);
const contextDocumentTimeoutMs = Math.min(
  Math.max(Number(process.env.TASKNODE_CHAT_CONTEXT_DOCUMENT_TIMEOUT_MS) || 1000, 50),
  2500
);

function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function contextBodyText(value = "") {
  const raw = String(value || "");
  if (!looksLikeContextHtml(raw)) return raw.trim();

  return decodeHtmlEntities(
    raw
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*\/(p|div|h[1-6]|li|blockquote|pre|tr|table|ul|ol)\s*>/gi, "\n")
      .replace(/<\s*li\s*>/gi, "- ")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

export async function chatContextDocumentForAccount(accountId = "") {
  if (!accountId) return null;

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
      return null;
    }
    return result;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    console.warn(`chat context document load failed: ${error?.message || error}`);
    return null;
  }
}
