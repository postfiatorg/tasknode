import { createHash } from "node:crypto";
import { getContextDocument } from "./repositories/context.js";
import { getChatMessages } from "./repositories/chat-billing.js";
import { chatMemoryContextForAccount } from "./chat-memory-context.js";
import { taskContextForAccount } from "./chat-task-context.js";
import { getActiveContextEditProposal } from "./repositories/context-edit.js";
import { getLatestNetworkTaskProfile } from "./repositories/network-task-profile.js";
import { jobsRetrievalForChat } from "./jobs-corpus.js";

const maxContextChars = Math.min(Math.max(Number(process.env.CONTEXT_REWRITE_CONTEXT_MAX_CHARS) || 1_000_000, 8000), 1_000_000);
const maxChatMessageChars = Math.min(Math.max(Number(process.env.CONTEXT_REWRITE_CHAT_MESSAGE_MAX_CHARS) || 2200, 300), 6000);
const maxMemoryChars = Math.min(Math.max(Number(process.env.CONTEXT_REWRITE_MEMORY_MAX_CHARS) || 30000, 4000), 80000);
const maxTaskChars = Math.min(Math.max(Number(process.env.CONTEXT_REWRITE_TASK_MAX_CHARS) || 32000, 4000), 90000);
const maxProfileChars = Math.min(Math.max(Number(process.env.CONTEXT_REWRITE_PROFILE_MAX_CHARS) || 14000, 2000), 40000);

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stripHtml(value = "") {
  return String(value || "")
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function redactSensitiveText(value = "") {
  return String(value || "")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted_api_key]")
    .replace(/\b(?:0x)?[a-fA-F0-9]{64}\b/g, "[redacted_secret_or_hash]")
    .replace(/\b(seed phrase|recovery phrase|mnemonic|private key|password)\s*[:=]\s*[^\n\r]+/gi, "$1: [redacted]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted_email]");
}

function clip(value = "", max = 4000) {
  const text = redactSensitiveText(stripHtml(value)).trim();
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = Math.max(0, max - head - 32);
  return `${text.slice(0, head).trimEnd()}\n\n[...middle truncated...]\n\n${text.slice(-tail).trimStart()}`;
}

function stateForText(value = "") {
  return String(value || "").trim() ? "present" : "empty";
}

function sourceState(value) {
  if (!value) return "missing";
  if (typeof value === "string") return stateForText(value);
  if (Array.isArray(value)) return value.length ? "present" : "empty";
  if (typeof value === "object") return Object.keys(value).length ? "present" : "empty";
  return "missing";
}

function publicMessageForPacket(message = {}, index = 0) {
  const role = message.role === "assistant" ? "assistant" : message.role === "agent" ? "agent" : "user";
  return {
    index,
    role,
    created_at: message.createdAt || null,
    mode: message.mode || "",
    body: clip(message.body || message.text || "", maxChatMessageChars),
    metadata_kind: message.metadata?.kind || "",
    attachment_count: Array.isArray(message.attachments) ? message.attachments.length : 0,
  };
}

function compactTask(task = {}) {
  return {
    title: clip(task.title || "Untitled task", 180),
    kind: clip(task.kind || task.taskKind || "", 80),
    status: clip(task.status || task.statusLabel || "", 80),
    due: clip(task.due || "", 80),
    description: clip(task.description || "", 700),
    reward: task.rewardActualPft || task.rewardOfferPft || task.pft || "",
    outcome: clip(
      task.rewardOutcome?.summary ||
        task.stopOutcome?.summary ||
        task.verification?.body ||
        task.evidence ||
        "",
      700
    ),
  };
}

function compactTaskContext(taskContext = null) {
  const source = safeObject(taskContext);
  const groups = {};
  for (const key of ["outstanding", "verification", "refused", "rewarded"]) {
    groups[key] = safeArray(source[key]).slice(0, key === "rewarded" ? 18 : 24).map(compactTask);
  }
  return {
    state: sourceState(source),
    sync: safeObject(source.sync),
    groups,
    note: "Task history is evidence for values, capabilities, urgency, and follow-through. It should not be repeated as a ledger in the final document.",
  };
}

function compactMemoryContext(memoryContext = null) {
  const source = safeObject(memoryContext);
  const deepMemories = safeArray(source.deepMemories).slice(0, 5).map((entry) => ({
    date: entry.createdAt || "",
    title: clip(entry.conversationTitle || "", 180),
    user: clip(entry.userRequestSummary || "", 1600),
    assistant: clip(entry.systemResponseSummary || "", 1600),
    memory: clip(entry.memoryText || "", 2200),
  }));
  const memories = safeArray(source.memories).slice(0, 40).map((entry) => ({
    date: entry.createdAt || "",
    memory: clip(entry.memoryText || "", 1200),
  }));
  const packet = {
    state: deepMemories.length || memories.length ? "present" : sourceState(source),
    deep_memories: deepMemories,
    recent_memories: memories,
  };
  const raw = JSON.stringify(packet);
  if (raw.length <= maxMemoryChars) return packet;
  return {
    ...packet,
    recent_memories: memories.slice(0, 16),
    truncation_note: `Memory packet truncated from ${raw.length} characters.`,
  };
}

function compactNetworkProfile(profile = null) {
  if (!profile) return { state: "missing" };
  return {
    state: "present",
    id: profile.id || "",
    completed_at: profile.completedAt || "",
    title: clip(profile.output?.profile_title || profile.output?.profileTitle || "Network Task Profile", 180),
    output_text: clip(profile.outputText || JSON.stringify(profile.output || {}), maxProfileChars),
  };
}

function compactContextEditProposal(proposal = null) {
  if (!proposal) return { state: "missing" };
  return {
    state: "present",
    id: proposal.id,
    operation: proposal.operation,
    rationale: clip(proposal.rationale || "", 1200),
    target_heading: clip(proposal.targetHeading || "", 400),
    state_value: proposal.state,
  };
}

function compactJobsRetrieval(result = null) {
  const chunks = safeArray(result?.chunks).slice(0, 5).map((chunk, index) => ({
    rank: index + 1,
    title: clip(chunk.title || "Jobs corpus excerpt", 180),
    content: clip(chunk.content || "", 1600),
    similarity: chunk.similarity ?? null,
    source_sha256: chunk.sourceSha256 || "",
  }));
  return {
    state: result?.skipped ? "skipped" : result?.ok === false ? "error" : chunks.length ? "present" : "empty",
    reason: result?.reason || "",
    retrieval_id: result?.retrievalId || "",
    query_text: clip(result?.queryText || "", 1200),
    text: clip(result?.text || "", 6000),
    chunks,
  };
}

function truncatePacketSections(packet = {}) {
  const tasksRaw = JSON.stringify(packet.tasks || {});
  if (tasksRaw.length > maxTaskChars) {
    for (const key of Object.keys(packet.tasks.groups || {})) {
      packet.tasks.groups[key] = packet.tasks.groups[key].slice(0, 8);
    }
    packet.tasks.truncation_note = `Task packet truncated from ${tasksRaw.length} characters.`;
  }
  return packet;
}

export function contextRewritePacketDigest(packet = {}) {
  return sha256(stableJson(packet));
}

export async function assembleContextRewriteSourcePacket({
  accountId = "",
  conversationId = "",
  instructionText = "",
} = {}) {
  const [
    contextDocument,
    historyMessages,
    memoryContext,
    taskContext,
    networkProfile,
    activeProposal,
  ] = await Promise.all([
    getContextDocument({ accountId }),
    getChatMessages({ accountId, conversationId, limit: 48 }).catch(() => []),
    chatMemoryContextForAccount(accountId).catch(() => null),
    taskContextForAccount(accountId).catch(() => null),
    getLatestNetworkTaskProfile({ accountId }).catch(() => null),
    getActiveContextEditProposal({ accountId, conversationId }).catch(() => null),
  ]);

  const jobsResult = await jobsRetrievalForChat({
    message: instructionText,
    contextDocument,
    memoryContext,
    taskContext,
  }).catch((error) => ({
    ok: false,
    skipped: true,
    reason: error?.message || "jobs_retrieval_failed",
    chunks: [],
    text: "",
  }));

  const cleanContextBody = redactSensitiveText(stripHtml(contextDocument?.body || "")).trim();
  const contextBody = cleanContextBody.length <= maxContextChars
    ? cleanContextBody
    : clip(contextDocument?.body || "", maxContextChars);
  const packet = truncatePacketSections({
    schema: "context_rewrite.source_packet.v1",
    generated_at: new Date().toISOString(),
    account_hash: sha256(accountId).slice(0, 24),
    conversation_hash: sha256(conversationId).slice(0, 24),
    instruction: {
      state: stateForText(instructionText),
      body: clip(instructionText, 8000),
    },
    current_context: {
      state: stateForText(contextDocument?.body || ""),
      id: contextDocument?.id || "",
      title: contextDocument?.title || "Task Node Context",
      revision: Number(contextDocument?.revision || 0),
      updated_at: contextDocument?.updatedAt || null,
      body_sha256: sha256(contextDocument?.body || ""),
      body: contextBody,
      truncation_note: cleanContextBody.length > contextBody.length
        ? `Context body truncated to ${contextBody.length} characters.`
        : "",
    },
    chat: {
      state: historyMessages.length ? "present" : "empty",
      message_count: historyMessages.length,
      messages: historyMessages.slice(-48).map(publicMessageForPacket),
    },
    memory: compactMemoryContext(memoryContext),
    tasks: compactTaskContext(taskContext),
    network_task_profile: compactNetworkProfile(networkProfile),
    active_context_refine_proposal: compactContextEditProposal(activeProposal),
    jobs_retrieval: compactJobsRetrieval(jobsResult),
    packet_notes: [
      "Final output must be a human-readable Markdown context document.",
      "Do not repeat task history as a task ledger.",
      "Do not expose internal scores or score improvements to the user.",
      "Do not auto-save or replace the user's current context document.",
    ],
  });

  const digest = contextRewritePacketDigest(packet);
  return {
    packet,
    digest,
    contextDocument,
    jobsRetrieval: packet.jobs_retrieval,
  };
}
