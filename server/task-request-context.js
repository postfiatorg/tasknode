import { createHash } from "node:crypto";
import { collapseWhitespace, splitWhitespace } from "./inference-text.js";
import { agentDisclosureMetadata } from "./agent-quality-gates.js";
import { NO_TASK_ACCEPT_WINDOW_HOURS as DEFAULT_TASK_ACCEPT_WINDOW_HOURS } from "./task-request-terminal-bundle.js";
import { getContextDocument } from "./repositories/context.js";
import { getChatMemoryContext } from "./repositories/chat-memory.js";
import { getChatMessages, listChatConversations } from "./repositories/chat-billing.js";
import { listTaskState } from "./repositories/tasks.js";
import { contextBodyText } from "./context-line-map.js";
import { contextBudgetMetrics, TASKGEN_CONTEXT_MAX_CHARS } from "../shared/context-budget.js";
const safeText = (value = "", max = 4000) => String(value || "").trim().slice(0, max);
const sha256 = (value = "") => createHash("sha256").update(String(value || ""), "utf8").digest("hex");

function compactText(value = "", max = 1200) {
  return collapseWhitespace(value).slice(0, max);
}

function wordCount(value = "") {
  return splitWhitespace(value).length;
}

function messageProjection(message = {}) {
  return {
    id: safeText(message.id, 180),
    role: message.role === "user" ? "user" : "assistant",
    content: compactText(message.body || message.text || message.content || "", 1600),
    created_at: message.createdAt || message.created_at || null,
  };
}

async function recentChatProjection({ accountId = "", limit = 4 } = {}) {
  const conversations = await listChatConversations({ accountId, limit }).catch(() => []);
  const projected = [];
  for (const conversation of conversations.slice(0, limit)) {
    const messages = await getChatMessages({
      accountId,
      conversationId: conversation.conversationId || conversation.id,
      limit: 8,
    }).catch(() => []);
    projected.push({
      conversation_id: conversation.conversationId || conversation.id || "",
      conversation_title: conversation.title || "New chat",
      updated_at: conversation.updatedAt || null,
      messages: messages.map(messageProjection).filter((item) => item.content),
    });
  }
  return projected;
}

function summarizeRecentChat(chats, userDetailText) {
  const lines = [];
  for (const chat of chats.slice(0, 4)) {
    const title = chat.conversation_title || "New chat";
    const lastUser = [...(chat.messages || [])].reverse().find((item) => item.role === "user")?.content || "";
    const lastAssistant = [...(chat.messages || [])].reverse().find((item) => item.role === "assistant")?.content || "";
    if (lastUser || lastAssistant) {
      lines.push(`${title}: user=${compactText(lastUser, 220)} assistant=${compactText(lastAssistant, 220)}`);
    }
  }
  lines.push(`Explicit task request detail: ${compactText(userDetailText, 500)}`);
  return compactText(lines.join(" "), 1800);
}

function memoryProjection(entry = {}) {
  return {
    kind: safeText(entry.kind || "turn_memory", 80),
    digest: sha256([entry.id, entry.createdAt, entry.memoryText].join(":")).slice(0, 24),
    conversation_title: safeText(entry.conversationTitle || "", 160),
    user: compactText(entry.userRequestSummary || "", 800),
    system: compactText(entry.systemResponseSummary || "", 800),
    memory_text: compactText(entry.memoryText || "", 1400),
    created_at: entry.createdAt || null,
  };
}

function queueProjection(tasks = {}) {
  const project = (items = [], limit = 12) => items.slice(0, limit).map((task) => ({
    task_id: task.taskId || task.fullId || "",
    title: safeText(task.title, 240),
    status: safeText(task.statusKey || task.status, 80),
    reward_pft: task.pft ?? "",
    updated_at: task.updatedAt || null,
  }));
  return {
    outstanding: project(tasks.outstanding || [], 40),
    verification: project(tasks.verification || [], 40),
    refused: project(tasks.refused || [], 10),
    rewarded: project(tasks.rewarded || [], 12),
    summary: [
      `${(tasks.outstanding || []).length} outstanding`,
      `${(tasks.verification || []).length} pending verification`,
      `${(tasks.refused || []).length} refused`,
      `${(tasks.rewarded || []).length} rewarded`,
    ].join("; "),
  };
}

export async function buildRequestBundle({ accountId, walletAddress, request, authorityWallet, agentOrigin = null }) {
  const createdAt = new Date();
  const createdAtIso = createdAt.toISOString();
  const acceptByIso = null; // no accept window (see DEFAULT_TASK_ACCEPT_WINDOW_HOURS)
  const [context, memoryContext, recentChat, taskState] = await Promise.all([
    getContextDocument({ accountId }),
    getChatMemoryContext({ accountId, deepLimit: 3, turnLimit: 36 }),
    recentChatProjection({ accountId, limit: 4 }),
    listTaskState({ accountId, walletAddress }),
  ]);
  const contextBody = String(context?.body || "");
  const contextText = contextBodyText(contextBody);
  const contextBudget = contextBudgetMetrics(contextText, { maxChars: TASKGEN_CONTEXT_MAX_CHARS });
  const recentMemory = (memoryContext.memories || []).map(memoryProjection);
  const deepMemory = (memoryContext.deepMemories || []).map(memoryProjection);
  return {
    schema: "pf.task.request_bundle.v1",
    bundle_id: request.bundleId,
    subject_wallet: walletAddress,
    subject_encryption_pubkey: request.subjectEncryptionPubkey || "",
    created_at: createdAtIso,
    client: {
      name: "tasknodeofficial-web",
      version: "0.1.0",
      source_app: "tasknodeofficial",
      account_id: accountId,
      conversation_id: request.conversationId || null,
      conversation_title: request.sourceConversationTitle,
      ...agentDisclosureMetadata(agentOrigin),
    },
    request: {
      request_id: request.requestId,
      request_text: request.requestText,
      user_detail_text: request.userDetailText,
      requested_task_kind: request.requestedTaskKind,
      source: request.source,
      source_conversation_title: request.sourceConversationTitle,
      attachments: request.attachments.map((attachment) => ({
        name: safeText(attachment?.name, 240),
        mime_type: safeText(attachment?.mimeType, 120),
        size: Number(attachment?.size || 0),
        source: safeText(attachment?.source, 80),
      })),
    },
    recent_chat: {
      conversations: recentChat,
      summary: summarizeRecentChat(recentChat, request.userDetailText),
    },
    memory: {
      deep_memory: deepMemory,
      recent_memory: recentMemory,
    },
    relevant_history: {
      strategy: "app_memory_recent_36_plus_deep_3",
      items: [...deepMemory, ...recentMemory]
        .filter((item) => item.memory_text)
        .map((item) => ({
          kind: item.kind,
          digest: item.digest,
          summary: item.memory_text,
          conversation_title: item.conversation_title,
          created_at: item.created_at,
        })),
    },
    context: {
      primary_context_doc: {
        context_id: context?.id || `ctx_${sha256(accountId).slice(0, 24)}`,
        cid: null,
        digest: `sha256:${sha256(contextBody)}`,
        summary: contextBudget.text,
        revision: Number(context?.revision || 0),
        word_count: wordCount(contextText),
      },
      additional_refs: [],
    },
    task_queue: queueProjection(taskState),
    policy: {
      task_policy_version: "task-policy-minimal-v1",
      reward_policy_version: "reward-policy-minimal-v1",
      generation_policy_version: "taskgen-policy-minimal-v1",
      deadline: {
        accept_by: acceptByIso,
        deadline_at: null,
        accept_window_hours: DEFAULT_TASK_ACCEPT_WINDOW_HOURS,
        source: "no_accept_window",
      },
    },
    wallet: {
      subject_wallet: walletAddress,
      subject_encryption_pubkey: request.subjectEncryptionPubkey || "",
      authority_wallet: authorityWallet || "",
      authority_hint: authorityWallet || "",
      allocation_wallet: "",
    },
    encryption: {
      subject_public_key: request.subjectEncryptionPubkey || "",
      tasknode_service_required: true,
    },
  };
}
