import {
  normalizeChatAttachments,
  textAttachmentPrompt,
} from "./chat-attachment-utils.js";
import { actualChatCost } from "./chat-router.js";
import { getChatMessagesForWrite } from "./repositories/chat-billing.js";
import { buildBoardManagerSourcePacket } from "./repositories/board-manager.js";
import { buildHiveSecretarySourcePacket } from "./repositories/hive-context.js";
import {
  boardManagerSecretarySourceDigest,
  getCurrentBoardManagerSecretaryPacket,
  getLatestBoardManagerSecretaryPacket,
} from "./board-manager-secretary-packets.js";

const defaultDeepSeekBaseUrl = "https://api.deepseek.com";
const defaultHiveImmediateModel = "deepseek-v4-pro";
const defaultTimeoutMs = 45_000;
const maxHistoryMessages = 10;
const maxSourcePacketCharacters = 14_000;
const maxHiveMindContextCharacters = 18_000;
const maxLiveBoardFactsCharacters = 12_000;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeJson(value, max = 4000) {
  try {
    return safeText(JSON.stringify(value, null, 2), max);
  } catch {
    return "";
  }
}

function taskLine(task = {}) {
  const id = safeText(task.taskId || task.task_id || task.id || "", 180);
  const status = safeText(task.status || task.statusKey || task.state || "", 80);
  const title = safeText(task.title || task.name || id || "Untitled task", 220);
  const reward = Number(task.rewardActualPft ?? task.reward_actual_pft ?? task.rewardOfferPft ?? task.reward_offer_pft ?? task.pft ?? 0);
  const updatedAt = safeText(task.updatedAt || task.updated_at || task.lastEventAt || task.last_event_at || "", 80);
  return [
    `- ${title}`,
    id ? `id=${id}` : "",
    status ? `status=${status}` : "",
    Number.isFinite(reward) && reward > 0 ? `pft=${reward}` : "",
    updatedAt ? `updated=${updatedAt}` : "",
  ].filter(Boolean).join(" | ");
}

function taskGroupLines(label = "", tasks = [], limit = 6) {
  const items = safeArray(tasks).slice(0, limit);
  return [
    `${label} (${safeArray(tasks).length})`,
    items.length ? items.map(taskLine).join("\n") : "- none",
  ].join("\n");
}

function pressureSignalLine(signal = {}) {
  const reasons = safeArray(signal.reasons).map((reason) => safeText(reason, 180)).filter(Boolean).join("; ");
  return [
    `- project=${safeText(signal.projectId || signal.project_id || "", 180) || "unknown"}`,
    `requiresAction=${Boolean(signal.requiresAction)}`,
    `preferred=${safeText(signal.preferredNextAction || signal.preferred_next_action || "", 80) || "none"}`,
    `outstanding=${Boolean(signal.hasOutstandingNetworkTask)}`,
    `pending=${Boolean(signal.hasPendingNetworkTaskGeneration)}`,
    `openFollowupAfterLatestClosure=${Boolean(signal.hasOpenFollowup)}`,
    signal.latestClosureAt ? `latestClosureAt=${signal.latestClosureAt}` : "",
    reasons ? `reasons=${reasons}` : "",
  ].filter(Boolean).join(" | ");
}

function followupLine(followup = {}) {
  return [
    `- id=${safeText(followup.id, 80) || "unknown"}`,
    `status=${safeText(followup.status, 80) || "unknown"}`,
    followup.projectId || followup.project_id ? `project=${safeText(followup.projectId || followup.project_id, 180)}` : "project=global",
    followup.lastSentAt || followup.last_sent_at ? `lastSent=${safeText(followup.lastSentAt || followup.last_sent_at, 80)}` : "",
    followup.createdAt || followup.created_at ? `created=${safeText(followup.createdAt || followup.created_at, 80)}` : "",
    followup.blockerSummary || followup.blocker_summary ? `summary=${safeText(followup.blockerSummary || followup.blocker_summary, 260)}` : "",
  ].filter(Boolean).join(" | ");
}

function recentRunLine(run = {}) {
  return [
    `- id=${safeText(run.id || run.runId || run.run_id, 80) || "unknown"}`,
    `trigger=${safeText(run.trigger, 80) || "unknown"}`,
    `action=${safeText(run.selectedAction || run.selected_action || run.action, 80) || "unknown"}`,
    run.completedAt || run.completed_at ? `completed=${safeText(run.completedAt || run.completed_at, 80)}` : "",
    run.microSummaryText || run.micro_summary_text
      ? `summary=${safeText(run.microSummaryText || run.micro_summary_text, 320)}`
      : "",
  ].filter(Boolean).join(" | ");
}

function deepSeekKey() {
  return process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK || "";
}

export function hiveImmediateResponseStatus() {
  const configured = Boolean(deepSeekKey());
  const explicitlyDisabled =
    process.env.TASKNODE_HIVE_IMMEDIATE_RESPONSE_ENABLED === "false" ||
    process.env.TASKNODE_ENABLE_HIVE_IMMEDIATE_RESPONSE === "false";
  return {
    provider: "deepseek",
    model: hiveImmediateModel(),
    configured,
    enabled: configured && !explicitlyDisabled,
    status: configured && !explicitlyDisabled ? "ready" : configured ? "disabled" : "missing_config",
  };
}

function hiveImmediateModel() {
  return safeText(
    process.env.TASKNODE_HIVE_IMMEDIATE_MODEL ||
      process.env.DEEPSEEK_HIVE_MODEL ||
      process.env.DEEPSEEK_CHAT_MODEL ||
      defaultHiveImmediateModel,
    120
  );
}

function hiveImmediateMaxTokens() {
  const parsed = Number(process.env.TASKNODE_HIVE_IMMEDIATE_MAX_TOKENS || 700);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 120), 1600) : 700;
}

function hiveImmediateReasoningEffort() {
  const value = safeText(process.env.TASKNODE_HIVE_IMMEDIATE_REASONING || "none", 40).toLowerCase();
  return ["low", "medium", "high"].includes(value) ? value : "";
}

function assistantTextFromDeepSeek(body = {}) {
  const choice = body?.choices?.[0] || {};
  const content = choice?.message?.content ?? choice?.delta?.content ?? choice?.text ?? "";
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || part?.content || ""))
      .join("")
      .trim();
  }
  return String(content || "").trim();
}

function usageFromDeepSeek(body = {}) {
  const usage = body?.usage || {};
  const inputTokens = Math.max(0, Number(usage.prompt_tokens || usage.input_tokens || 0));
  const outputTokens = Math.max(0, Number(usage.completion_tokens || usage.output_tokens || 0));
  const totalTokens = Math.max(0, Number(usage.total_tokens || inputTokens + outputTokens));
  const promptCacheHitTokens = Math.max(0, Number(usage.prompt_cache_hit_tokens || 0));
  const promptCacheMissTokens = Math.max(0, Number(usage.prompt_cache_miss_tokens || 0));
  const providerCostUsd = actualChatCost("Discount Thinking", {
    inputTokens,
    outputTokens,
    totalTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
  });
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    promptCacheHitTokens,
    promptCacheMissTokens,
    providerCostUsd,
    costUsd: 0,
  };
}

function attachmentText(attachments = []) {
  return normalizeChatAttachments(attachments)
    .map((attachment) => {
      if (attachment.kind === "text") return textAttachmentPrompt(attachment);
      return `Attached file not sent to DeepSeek API Direct: ${attachment.name} (${attachment.mimeType || attachment.kind}).`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function historyMessagesForPrompt(messages = []) {
  return messages
    .slice(-maxHistoryMessages)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: [message.body || "", attachmentText(message.attachments || [])].filter(Boolean).join("\n\n"),
    }))
    .filter((message) => message.content);
}

function compactLiveBoardFacts(sourcePacket = {}) {
  const packet = safeObject(sourcePacket);
  return {
    sourcePacketDigest: safeText(packet.sourcePacketDigest, 120),
    generatedAt: packet.generatedAt || null,
    freshness: safeObject(packet.freshness),
    boardActionPressure: safeObject(packet.boardActionPressure),
    openFollowups: safeArray(packet.openFollowups).slice(0, 12),
    projectRegistry: safeObject(packet.projectRegistry),
    hiveProjects: safeObject(packet.hiveProjects),
    taskState: safeObject(packet.taskState),
    taskRequests: safeObject(packet.taskRequests),
    networkTaskContent: safeObject(packet.networkTaskContent),
    networkTaskCandidates: safeArray(packet.networkTaskCandidates).slice(0, 12),
    recentBoardManagerRuns: safeArray(packet.recentBoardManagerRuns).slice(0, 10),
  };
}

export function formatLiveBoardFactsForImmediateResponse(sourcePacket = {}) {
  const packet = safeObject(sourcePacket);
  const taskState = safeObject(packet.taskState);
  const networkTaskContent = safeObject(packet.networkTaskContent);
  const pressure = safeObject(packet.boardActionPressure);
  const pressureSummary = safeObject(pressure.summary);
  const pressureSignals = safeArray(pressure.signals);
  const recentTasks = safeArray(taskState.recent);
  const recentRuns = safeArray(packet.recentBoardManagerRuns);
  const openFollowups = safeArray(packet.openFollowups);

  return safeText(
    [
      "LIVE BOARD FACTS - AUTHORITATIVE",
      "Use this section over stale secretary packets, older assistant messages, and older board-manager run summaries when task state conflicts.",
      `Source digest: ${safeText(packet.sourcePacketDigest, 120) || "unknown"}`,
      `Generated at: ${packet.generatedAt || "unknown"}`,
      "",
      "Board pressure",
      [
        `motion=${safeText(pressureSummary.motionState, 80) || "unknown"}`,
        `requiresAction=${Boolean(pressureSummary.requiresAction)}`,
        `activeProjects=${Number(pressureSummary.activeProjectCount || 0)}`,
        `outstandingNetworkTasks=${Number(pressureSummary.outstandingNetworkTaskCount || 0)}`,
        `pendingNetworkTaskGeneration=${Number(pressureSummary.pendingNetworkTaskGenerationCount || 0)}`,
        `eligibleCandidates=${Number(pressureSummary.eligibleCandidateCount || 0)}`,
        `openFollowups=${Number(pressureSummary.openFollowupCount || openFollowups.length || 0)}`,
      ].join(" | "),
      pressureSignals.length
        ? pressureSignals.slice(0, 6).map(pressureSignalLine).join("\n")
        : "- no pressure signals",
      "",
      "Network task state",
      taskGroupLines("Outstanding", networkTaskContent.outstanding, 8),
      taskGroupLines("Pending generation", networkTaskContent.pendingGeneration, 6),
      taskGroupLines("Recently completed/rewarded", networkTaskContent.completed, 8),
      taskGroupLines("Recently stopped/refused", networkTaskContent.stopped, 6),
      "",
      "Recent task projections",
      recentTasks.length ? recentTasks.slice(0, 10).map(taskLine).join("\n") : "- none",
      "",
      "Open follow-ups",
      openFollowups.length ? openFollowups.slice(0, 8).map(followupLine).join("\n") : "- none",
      "",
      "Recent Board Manager runs",
      recentRuns.length ? recentRuns.slice(0, 6).map(recentRunLine).join("\n") : "- none",
    ].join("\n"),
    maxLiveBoardFactsCharacters
  );
}

export function formatHiveMindContextForImmediateResponse({
  boardManagerSourcePacket = null,
  secretaryPacket = null,
  secretaryPacketIsCurrentForSource = false,
} = {}) {
  const sourcePacket = safeObject(boardManagerSourcePacket);
  const secretary = safeObject(secretaryPacket);
  const secretaryText = safeText(secretary.packetText, maxHiveMindContextCharacters);
  const liveFacts = sourcePacket.sourcePacketDigest ? formatLiveBoardFactsForImmediateResponse(sourcePacket) : "";
  const liveFactsJson = sourcePacket.sourcePacketDigest
    ? safeJson(compactLiveBoardFacts(sourcePacket), 4000)
    : "";
  if (!secretaryText && !liveFacts) return "";

  return [
    "HIVE MIND / BOARD MANAGER CONTEXT",
    "",
    liveFacts
      ? [
          liveFacts,
          liveFactsJson ? ["", "Live Board Facts JSON excerpt", liveFactsJson].join("\n") : "",
        ].filter(Boolean).join("\n")
      : "",
    secretaryText
      ? [
          "",
          secretaryPacketIsCurrentForSource
            ? "Compressed Board Manager Secretary Packet - current for live source"
            : "Compressed Board Manager Secretary Packet - stale, use only as background",
          `Packet id: ${safeText(secretary.id, 180) || "unknown"}`,
          `Created at: ${secretary.createdAt || "unknown"}`,
          `Current for live source: ${secretaryPacketIsCurrentForSource ? "yes" : "no, latest available packet plus live board facts below"}`,
          `Secretary source digest: ${safeText(secretary.sourceDigest, 120) || "unknown"}`,
          `Live source digest: ${safeText(sourcePacket.sourcePacketDigest, 120) || "unknown"}`,
          "",
          secretaryText,
        ].join("\n")
      : "No compressed Board Manager Secretary Packet is available yet.",
  ].filter(Boolean).join("\n");
}

async function buildHiveMindContextForImmediateResponse() {
  const boardManagerSourcePacket = await buildBoardManagerSourcePacket({
    trigger: "hive_immediate_response",
    limit: 80,
  });
  const sourceDigest = boardManagerSecretarySourceDigest(boardManagerSourcePacket);
  const currentSecretaryPacket = await getCurrentBoardManagerSecretaryPacket({
    sourceDigest,
  }).catch(() => null);
  const secretaryPacket = currentSecretaryPacket || await getLatestBoardManagerSecretaryPacket().catch(() => null);
  const text = formatHiveMindContextForImmediateResponse({
    boardManagerSourcePacket,
    secretaryPacket,
    secretaryPacketIsCurrentForSource: Boolean(currentSecretaryPacket),
  });
  return {
    text,
    boardManagerSourcePacketDigest: safeText(boardManagerSourcePacket?.sourcePacketDigest || "", 120),
    boardManagerSecretarySourceDigest: sourceDigest,
    boardManagerSecretaryPacketId: safeText(secretaryPacket?.id || "", 180),
    boardManagerSecretaryPacketDigest: safeText(secretaryPacket?.packetDigest || "", 120),
    boardManagerSecretaryPacketCurrentForSource: Boolean(currentSecretaryPacket),
  };
}

function hiveSystemPrompt({ sourcePacket = null, hiveMindContextText = "" } = {}) {
  const packetText = safeText(sourcePacket?.sourceText || "", maxSourcePacketCharacters);
  const boardText = safeText(hiveMindContextText, maxHiveMindContextCharacters);
  return [
    "You are Hive, Task Node's immediate conversational layer for the shared work board.",
    "Reply now in the user's Hive Chat. Be direct, specific, and useful.",
    "The user's message has already been saved into Hive Context for later Board Manager and task-routing decisions.",
    "Use the latest user message, readable attachments, recent Hive Chat history, the current Hive Context packet, and the compressed Hive Mind / Board Manager context.",
    "Live Board Facts are authoritative for current task, reward, follow-up, and Board Manager state. If they conflict with chat history or a stale secretary packet, trust Live Board Facts.",
    "Do not claim that you created, archived, restored, assigned, reviewed, or rewarded anything. Those durable board mutations happen only through Board Manager actions.",
    "If the user is reporting product direction, restate the operational implication and name the next concrete thing to do.",
    "If the user is asking whether context was received, answer from the evidence in the message/attachment context.",
    "If the Hive Mind context is stale, say so only when it matters and lean on the live board facts.",
    "Keep the response concise: usually 2-6 sentences or a short set of bullets.",
    packetText ? ["", "CURRENT HIVE CONTEXT SOURCE PACKET", packetText].join("\n") : "",
    boardText ? ["", boardText].join("\n") : "",
  ].filter(Boolean).join("\n");
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

export async function executeHiveImmediateResponse({
  accountId = "",
  conversationId = "",
  message = "",
  attachments = [],
  sourceEntryId = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const status = hiveImmediateResponseStatus();
  if (!status.enabled) {
    const error = new Error(status.configured ? "hive_immediate_response_disabled" : "hive_immediate_deepseek_not_configured");
    error.status = status.configured ? 503 : 409;
    throw error;
  }
  if (typeof fetchImpl !== "function") {
    const error = new Error("hive_immediate_fetch_unavailable");
    error.status = 500;
    throw error;
  }

  const [historyMessages, sourcePacket, hiveMindContext] = await Promise.all([
    getChatMessagesForWrite({ accountId, conversationId, limit: maxHistoryMessages }).catch(() => []),
    buildHiveSecretarySourcePacket({ limit: 80 }).catch(() => null),
    buildHiveMindContextForImmediateResponse().catch(() => ({
      text: "",
      boardManagerSourcePacketDigest: "",
      boardManagerSecretarySourceDigest: "",
      boardManagerSecretaryPacketId: "",
      boardManagerSecretaryPacketDigest: "",
      boardManagerSecretaryPacketCurrentForSource: false,
    })),
  ]);
  const reasoningEffort = hiveImmediateReasoningEffort();
  const normalizedAttachments = normalizeChatAttachments(attachments);
  const userContent = [
    sourceEntryId ? `Hive Context Entry: ${sourceEntryId}` : "",
    safeText(message, 24_000),
    attachmentText(normalizedAttachments),
  ].filter(Boolean).join("\n\n");
  const requestBody = {
    model: status.model,
    messages: [
      {
        role: "system",
        content: hiveSystemPrompt({
          sourcePacket,
          hiveMindContextText: hiveMindContext.text,
        }),
      },
      ...historyMessagesForPrompt(historyMessages),
      { role: "user", content: userContent },
    ],
    thinking: reasoningEffort ? { type: "enabled" } : { type: "disabled" },
    reasoning_effort: reasoningEffort || undefined,
    max_tokens: hiveImmediateMaxTokens(),
  };
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1000, Number(process.env.TASKNODE_HIVE_IMMEDIATE_TIMEOUT_MS || defaultTimeoutMs))
  );

  try {
    const response = await fetchImpl(`${(process.env.DEEPSEEK_BASE_URL || defaultDeepSeekBaseUrl).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deepSeekKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.message || `Hive DeepSeek HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const text = assistantTextFromDeepSeek(body);
    if (!text) {
      const error = new Error("hive_immediate_empty_response");
      error.status = 502;
      throw error;
    }
    return {
      provider: "deepseek",
      model: safeText(body?.model || status.model, 120),
      responseId: safeText(body?.id || "", 160),
      text,
      usage: usageFromDeepSeek(body),
      sourcePacketDigest: safeText(sourcePacket?.sourcePacketDigest || "", 120),
      boardManagerSourcePacketDigest: hiveMindContext.boardManagerSourcePacketDigest,
      boardManagerSecretarySourceDigest: hiveMindContext.boardManagerSecretarySourceDigest,
      boardManagerSecretaryPacketId: hiveMindContext.boardManagerSecretaryPacketId,
      boardManagerSecretaryPacketDigest: hiveMindContext.boardManagerSecretaryPacketDigest,
      boardManagerSecretaryPacketCurrentForSource: hiveMindContext.boardManagerSecretaryPacketCurrentForSource,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("hive_immediate_deepseek_timeout");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
