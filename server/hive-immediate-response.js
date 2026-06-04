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
import {
  buildHiveAccountLiveState,
  formatHiveAccountLiveStateForPrompt,
} from "./repositories/hive-account-live-state.js";

const defaultDeepSeekBaseUrl = "https://api.deepseek.com";
const defaultHiveImmediateModel = "deepseek-v4-pro";
const defaultTimeoutMs = 45_000;
const defaultHiveImmediateMaxTokens = 1600;
const maxHiveImmediateMaxTokens = 4096;
const maxHistoryMessages = 10;
const maxSourcePacketCharacters = 14_000;
const maxHiveMindContextCharacters = 18_000;
const maxLiveBoardFactsCharacters = 12_000;
const maxAccountLiveStateCharacters = 10_000;

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

function taskOwnerAccountId(task = {}) {
  return safeText(
    task.candidateAccountId ||
      task.candidate_account_id ||
      task.accountId ||
      task.account_id ||
      task.assigneeAccountId ||
      task.assignee_account_id ||
      "",
    180
  );
}

function taskOwnerWallet(task = {}) {
  return safeText(
    task.candidateWalletAddress ||
      task.candidate_wallet_address ||
      task.subjectWallet ||
      task.subject_wallet ||
      task.assigneeWallet ||
      task.assignee_wallet ||
      "",
    120
  );
}

function taskMatchesRequestingIdentity(task = {}, { requestingAccountId = "", requestingWalletAddress = "" } = {}) {
  const account = safeText(requestingAccountId, 180);
  const wallet = safeText(requestingWalletAddress, 120);
  const ownerAccountId = taskOwnerAccountId(task);
  const ownerWallet = taskOwnerWallet(task);
  return Boolean((account && ownerAccountId === account) || (wallet && ownerWallet === wallet));
}

function taskLine(task = {}, { requestingAccountId = "", requestingWalletAddress = "" } = {}) {
  const id = safeText(task.taskId || task.task_id || task.id || "", 180);
  const status = safeText(task.status || task.statusKey || task.state || "", 80);
  const title = safeText(task.title || task.name || id || "Untitled task", 220);
  const reward = Number(task.rewardActualPft ?? task.reward_actual_pft ?? task.rewardOfferPft ?? task.reward_offer_pft ?? task.pft ?? 0);
  const updatedAt = safeText(task.updatedAt || task.updated_at || task.lastEventAt || task.last_event_at || "", 80);
  const ownerAccountId = taskOwnerAccountId(task);
  const ownerWallet = taskOwnerWallet(task);
  const normalizedRequestingAccountId = safeText(requestingAccountId, 180);
  const normalizedRequestingWalletAddress = safeText(requestingWalletAddress, 120);
  return [
    `- ${title}`,
    id ? `id=${id}` : "",
    status ? `status=${status}` : "",
    ownerAccountId ? `ownerAccount=${ownerAccountId}` : "",
    ownerWallet ? `ownerWallet=${ownerWallet}` : "",
    normalizedRequestingAccountId && ownerAccountId
      ? `requesting_user=${ownerAccountId === normalizedRequestingAccountId ? "yes" : "no"}`
      : "",
    normalizedRequestingWalletAddress && ownerWallet
      ? `requesting_wallet=${ownerWallet === normalizedRequestingWalletAddress ? "yes" : "no"}`
      : "",
    Number.isFinite(reward) && reward > 0 ? `pft=${reward}` : "",
    updatedAt ? `updated=${updatedAt}` : "",
  ].filter(Boolean).join(" | ");
}

function taskGroupLines(label = "", tasks = [], limit = 6, options = {}) {
  const items = safeArray(tasks).slice(0, limit);
  return [
    `${label} (${safeArray(tasks).length})`,
    items.length ? items.map((task) => taskLine(task, options)).join("\n") : "- none",
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

function followupLine(followup = {}, { requestingAccountId = "" } = {}) {
  const accountId = safeText(followup.accountId || followup.account_id || "", 180);
  const normalizedRequestingAccountId = safeText(requestingAccountId, 180);
  return [
    `- id=${safeText(followup.id, 80) || "unknown"}`,
    accountId ? `account=${accountId}` : "",
    normalizedRequestingAccountId && accountId
      ? `requesting_user=${accountId === normalizedRequestingAccountId ? "yes" : "no"}`
      : "",
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

function candidateMatchesRequestingIdentity(candidate = {}, {
  requestingAccountId = "",
  requestingWalletAddress = "",
} = {}) {
  const account = safeText(requestingAccountId, 180);
  const wallet = safeText(requestingWalletAddress, 120);
  const candidateAccount = safeText(candidate.accountId || candidate.account_id || "", 180);
  const candidateWallet = safeText(candidate.walletAddress || candidate.wallet_address || "", 120);
  return Boolean((account && candidateAccount === account) || (wallet && candidateWallet === wallet));
}

function candidateLine(candidate = {}, { requestingAccountId = "", requestingWalletAddress = "" } = {}) {
  const account = safeText(candidate.accountId || candidate.account_id || "", 180);
  const wallet = safeText(candidate.walletAddress || candidate.wallet_address || "", 120);
  const profile = safeText(candidate.profileId || candidate.profile_id || "", 180);
  const normalizedRequestingAccountId = safeText(requestingAccountId, 180);
  const normalizedRequestingWalletAddress = safeText(requestingWalletAddress, 120);
  return [
    `- account=${account || "unknown"}`,
    wallet ? `wallet=${wallet}` : "",
    profile ? `profile=${profile}` : "",
    normalizedRequestingAccountId && account
      ? `requesting_user=${account === normalizedRequestingAccountId ? "yes" : "no"}`
      : "",
    normalizedRequestingWalletAddress && wallet
      ? `requesting_wallet=${wallet === normalizedRequestingWalletAddress ? "yes" : "no"}`
      : "",
  ].filter(Boolean).join(" | ");
}

function requestingUserScopedBoardFacts({
  networkTaskContent = {},
  taskState = {},
  networkTaskCandidates = [],
  openFollowups = [],
  requestingAccountId = "",
  requestingWalletAddress = "",
} = {}) {
  const normalizedRequestingAccountId = safeText(requestingAccountId, 180);
  const normalizedRequestingWalletAddress = safeText(requestingWalletAddress, 120);
  if (!normalizedRequestingAccountId && !normalizedRequestingWalletAddress) {
    return [
      "Requesting user scoped board facts",
      "- requestingAccountId=unknown",
      "- requestingWallet=unknown",
      "- No account id or wallet was supplied. Do not personalize shared tasks, follow-ups, capacity, or blockers.",
    ].join("\n");
  }
  const allNetworkTasks = [
    ...safeArray(networkTaskContent.outstanding),
    ...safeArray(networkTaskContent.pendingGeneration),
    ...safeArray(networkTaskContent.completed),
    ...safeArray(networkTaskContent.stopped),
    ...safeArray(safeObject(taskState).recent),
  ];
  const userTasks = allNetworkTasks.filter((task) =>
    taskMatchesRequestingIdentity(task, {
      requestingAccountId: normalizedRequestingAccountId,
      requestingWalletAddress: normalizedRequestingWalletAddress,
    })
  );
  const userCandidates = safeArray(networkTaskCandidates).filter((candidate) =>
    candidateMatchesRequestingIdentity(candidate, {
      requestingAccountId: normalizedRequestingAccountId,
      requestingWalletAddress: normalizedRequestingWalletAddress,
    })
  );
  const userFollowups = safeArray(openFollowups).filter((followup) =>
    normalizedRequestingAccountId &&
      safeText(followup.accountId || followup.account_id || "", 180) === normalizedRequestingAccountId
  );
  return [
    "Requesting user scoped board facts",
    `- requestingAccountId=${normalizedRequestingAccountId || "unknown"}`,
    `- requestingWallet=${normalizedRequestingWalletAddress || "unknown"}`,
    userCandidates.length
      ? ["Confirmed eligible candidate row for requesting user", userCandidates.slice(0, 3).map((candidate) => candidateLine(candidate, { requestingAccountId: normalizedRequestingAccountId, requestingWalletAddress: normalizedRequestingWalletAddress })).join("\n")].join("\n")
      : "- No eligible candidate row for the requesting account/wallet appears in the live board facts.",
    userTasks.length
      ? ["Confirmed tasks for requesting user", userTasks.slice(0, 6).map((task) => taskLine(task, { requestingAccountId: normalizedRequestingAccountId, requestingWalletAddress: normalizedRequestingWalletAddress })).join("\n")].join("\n")
      : "- No confirmed tasks for the requesting account in the live board facts.",
    userFollowups.length
      ? ["Confirmed open follow-ups for requesting user", userFollowups.slice(0, 4).map((followup) => followupLine(followup, { requestingAccountId: normalizedRequestingAccountId })).join("\n")].join("\n")
      : "- No confirmed open follow-up for the requesting account in the live board facts.",
    "Do not tell the requesting user that they personally have a task, capacity blocker, or open follow-up unless it is listed above or the latest user message says so.",
  ].join("\n");
}

function networkTaskRoutingPolicyForPrompt() {
  return [
    "NETWORK TASK ROUTING POLICY - AUTHORITATIVE",
    "- The Request task button creates user-requested personal task proposals. It is not the way to request a Network Task.",
    "- Network Tasks are generated by Hive Board Manager when an active network project needs work and an eligible candidate is available.",
    "- Eligibility gates: signed-in Task Node account, linked PFT wallet, linked wallet indexed as an active user wallet, completed Network Diagnostic Report, and no outstanding or pending Network Task already consuming capacity.",
    "- Personal, engineering, proposed, refused, and rewarded non-network tasks can inform routing judgment, but they do not hard-block Network Task eligibility.",
    "- Do not tell a user that completing personal or engineering tasks is required to become eligible for Network Tasks, puts them first in line, or is the fastest path to Network Tasks. That is not the routing policy.",
    "- Do not say another contributor's outstanding Network Task globally prevents this user from receiving a Network Task. Capacity is candidate-specific unless Live Board Facts show a requesting_user/requesting_wallet capacity blocker for this account.",
    "- If Live Board Facts show other contributors have outstanding Network Tasks, describe that as shared board motion, not as this user's blocker.",
    "- If no Network Task is available for this user, distinguish the cause: missing eligibility row, no active project need, project already has enough live motion, or a user-specific capacity blocker shown in Requesting user scoped board facts.",
    "- When a user asks for tasks, say what Hive can and cannot do: Hive Chat can explain status, the Request task button can create personal task proposals, and only Board Manager can route project-linked Network Tasks.",
    "- Current contributor means an account/wallet currently assigned to live project-linked work or a project contributor row. It is not a permanent role and it is not earned by vague waiting.",
    "- If the requesting user is not listed as an eligible candidate in Live Board Facts, say that plainly and name the likely missing gates; do not claim a specific missing gate unless the context proves it.",
    "- If the requesting user is eligible but no task is assigned, say they are available for Board Manager routing and explain that assignment waits for a project need.",
  ].join("\n");
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
  const parsed = Number(process.env.TASKNODE_HIVE_IMMEDIATE_MAX_TOKENS || defaultHiveImmediateMaxTokens);
  return Number.isFinite(parsed)
    ? Math.min(Math.max(Math.floor(parsed), 120), maxHiveImmediateMaxTokens)
    : defaultHiveImmediateMaxTokens;
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

function linkedAliasLine(alias = {}) {
  const label = safeText(alias.label || alias.provider || alias.id || "", 80);
  const username = safeText(alias.username || alias.handle || "", 120);
  const displayName = safeText(alias.displayName || "", 120);
  const status = safeText(alias.status || "", 80);
  return [
    `- ${label || "provider"}`,
    username ? `username=${username}` : "",
    displayName ? `display=${displayName}` : "",
    status ? `status=${status}` : "",
  ].filter(Boolean).join(" | ");
}

function formatRequestingUserForImmediateResponse({
  accountId = "",
  conversationId = "",
  requestingUser = null,
} = {}) {
  const user = safeObject(requestingUser);
  const identityProfile = safeObject(user.identityProfile || user.identity || {});
  const normalizedAccountId = safeText(accountId || user.accountId || identityProfile.accountId, 180);
  const hiveHandle = safeText(user.hiveHandle || identityProfile.hiveHandle, 120);
  const walletAddress = safeText(user.walletAddress || user.linkedWalletAddress || "", 120);
  const displayName = safeText(
    user.displayName ||
      identityProfile.displayName ||
      user.publicDisplayName ||
      identityProfile.publicDisplayName ||
      hiveHandle ||
      normalizedAccountId,
    160
  );
  const primaryProvider = safeText(user.primaryProvider, 80);
  const aliases = safeArray(user.aliases || identityProfile.aliases).slice(0, 8);
  return [
    "REQUESTING USER - AUTHORITATIVE",
    "This is the account that sent the latest Hive Chat message. Use this identity for second-person statements.",
    `Account ID: ${normalizedAccountId || "unknown"}`,
    `Conversation ID: ${safeText(conversationId, 180) || "unknown"}`,
    walletAddress ? `Linked wallet: ${walletAddress}` : "",
    displayName ? `Display: ${displayName}` : "",
    hiveHandle ? `Hive handle: @${hiveHandle.replace(/^@+/, "")}` : "",
    primaryProvider ? `Primary provider: ${primaryProvider}` : "",
    aliases.length ? ["Linked aliases", aliases.map(linkedAliasLine).join("\n")].join("\n") : "",
    "Second-person boundary: say 'you' only for facts tied to this account id, this conversation, the account-scoped Hive Context packet, or the latest user message. Shared board facts about other accounts must be described as shared board state or other contributors.",
  ].filter(Boolean).join("\n");
}

export function formatLiveBoardFactsForImmediateResponse(sourcePacket = {}, {
  requestingAccountId = "",
  requestingWalletAddress = "",
} = {}) {
  const packet = safeObject(sourcePacket);
  const normalizedRequestingAccountId = safeText(requestingAccountId, 180);
  const normalizedRequestingWalletAddress = safeText(requestingWalletAddress, 120);
  const taskState = safeObject(packet.taskState);
  const networkTaskContent = safeObject(packet.networkTaskContent);
  const pressure = safeObject(packet.boardActionPressure);
  const pressureSummary = safeObject(pressure.summary);
  const pressureSignals = safeArray(pressure.signals);
  const recentTasks = safeArray(taskState.recent);
  const recentRuns = safeArray(packet.recentBoardManagerRuns);
  const openFollowups = safeArray(packet.openFollowups);
  const networkTaskCandidates = safeArray(packet.networkTaskCandidates);

  return safeText(
    [
      "LIVE BOARD FACTS - AUTHORITATIVE",
      "These are shared board facts. Use this section over stale secretary packets, older assistant messages, and older board-manager run summaries when task state conflicts.",
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
      requestingUserScopedBoardFacts({
        networkTaskContent,
        taskState,
        networkTaskCandidates,
        openFollowups,
        requestingAccountId: normalizedRequestingAccountId,
        requestingWalletAddress: normalizedRequestingWalletAddress,
      }),
      "",
      "Eligible routing candidates",
      networkTaskCandidates.length
        ? networkTaskCandidates.slice(0, 8).map((candidate) => candidateLine(candidate, { requestingAccountId: normalizedRequestingAccountId, requestingWalletAddress: normalizedRequestingWalletAddress })).join("\n")
        : "- none",
      "",
      "Network task state",
      taskGroupLines("Outstanding", networkTaskContent.outstanding, 8, { requestingAccountId: normalizedRequestingAccountId, requestingWalletAddress: normalizedRequestingWalletAddress }),
      taskGroupLines("Pending generation", networkTaskContent.pendingGeneration, 6, { requestingAccountId: normalizedRequestingAccountId, requestingWalletAddress: normalizedRequestingWalletAddress }),
      taskGroupLines("Recently completed/rewarded", networkTaskContent.completed, 8, { requestingAccountId: normalizedRequestingAccountId, requestingWalletAddress: normalizedRequestingWalletAddress }),
      taskGroupLines("Recently stopped/refused", networkTaskContent.stopped, 6, { requestingAccountId: normalizedRequestingAccountId, requestingWalletAddress: normalizedRequestingWalletAddress }),
      "",
      "Recent task projections",
      recentTasks.length ? recentTasks.slice(0, 10).map((task) => taskLine(task, { requestingAccountId: normalizedRequestingAccountId, requestingWalletAddress: normalizedRequestingWalletAddress })).join("\n") : "- none",
      "",
      "Open follow-ups",
      openFollowups.length ? openFollowups.slice(0, 8).map((followup) => followupLine(followup, { requestingAccountId: normalizedRequestingAccountId })).join("\n") : "- none",
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
  requestingAccountId = "",
  requestingWalletAddress = "",
} = {}) {
  const sourcePacket = safeObject(boardManagerSourcePacket);
  const secretary = safeObject(secretaryPacket);
  const secretaryText = safeText(secretary.packetText, maxHiveMindContextCharacters);
  const liveFacts = sourcePacket.sourcePacketDigest
    ? formatLiveBoardFactsForImmediateResponse(sourcePacket, { requestingAccountId, requestingWalletAddress })
    : "";
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

async function buildHiveMindContextForImmediateResponse({
  requestingAccountId = "",
  requestingWalletAddress = "",
} = {}) {
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
    requestingAccountId,
    requestingWalletAddress,
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

function hiveSystemPrompt({
  sourcePacket = null,
  accountLiveStateText = "",
  hiveMindContextText = "",
  requestingUserText = "",
} = {}) {
  const packetText = safeText(sourcePacket?.sourceText || "", maxSourcePacketCharacters);
  const accountStateText = safeText(accountLiveStateText, maxAccountLiveStateCharacters);
  const boardText = safeText(hiveMindContextText, maxHiveMindContextCharacters);
  const userText = safeText(requestingUserText, 4000);
  return [
    "You are Hive, Task Node's immediate conversational layer for the shared work board.",
    "Reply now in the user's Hive Chat. Be direct, specific, and useful.",
    "The user's message has already been saved into Hive Context for later Board Manager and task-routing decisions.",
    "Use the latest user message, readable attachments, recent Hive Chat history, the requesting user's Hive Context packet, and the compressed Hive Mind / Board Manager context.",
    "The requesting-user block is authoritative for who is speaking. Do not infer the speaker from global Hive Context, Board Manager runs, or another contributor's task rows.",
    "Account Live State is the first source of truth for the requesting user's current tasks, follow-ups, refusals, rewards, and explicit reward constraints.",
    "Live Board Facts are authoritative for current task, reward, follow-up, and Board Manager state. If they conflict with chat history or a stale secretary packet, trust Live Board Facts.",
    "Live Board Facts are shared board facts. Only describe a task, follow-up, capacity blocker, or reward as the user's own when it is marked requesting_user=yes or appears in the Requesting user scoped board facts section.",
    "If Account Live State conflicts with Live Board Facts, chat history, or compressed secretary packets about this account, trust Account Live State and explain the conflict only if it changes the answer.",
    "For Network Task eligibility and contributor questions, use the Network Task Routing Policy section instead of improvising a social or reputation ladder.",
    "Never use personal tasks as the answer to a Network Task eligibility question. Personal tasks can be useful work, but they are not Network Tasks and they are not a prerequisite for Network Task routing.",
    "Do not claim that you created, archived, restored, assigned, reviewed, or rewarded anything. Those durable board mutations happen only through Board Manager actions.",
    "If the user is reporting product direction, restate the operational implication and name the next concrete thing to do.",
    "If the user is asking whether context was received, answer from the evidence in the message/attachment context.",
    "If the Hive Mind context is stale, say so only when it matters and lean on the live board facts.",
    "Keep the response concise: usually 2-6 sentences or a short set of bullets.",
    userText ? ["", userText].join("\n") : "",
    accountStateText ? ["", accountStateText].join("\n") : "",
    ["", networkTaskRoutingPolicyForPrompt()].join("\n"),
    packetText ? ["", "REQUESTING USER HIVE CONTEXT SOURCE PACKET", "This packet is scoped to the requesting account, not the entire Hive.", packetText].join("\n") : "",
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
  requestingUser = null,
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

  const normalizedAccountId = safeText(accountId, 180);
  const requestingWalletAddress = safeText(
    safeObject(requestingUser).walletAddress || safeObject(requestingUser).linkedWalletAddress || "",
    120
  );
  const [historyMessages, sourcePacket, accountLiveState, hiveMindContext] = await Promise.all([
    getChatMessagesForWrite({ accountId: normalizedAccountId, conversationId, limit: maxHistoryMessages }).catch(() => []),
    buildHiveSecretarySourcePacket({ limit: 80, accountId: normalizedAccountId }).catch(() => null),
    buildHiveAccountLiveState({
      accountId: normalizedAccountId,
      walletAddress: requestingWalletAddress,
      limit: 12,
    }).catch((error) => ({
      ok: false,
      status: "query_failed",
      error: safeText(error?.message || String(error), 600),
      accountId: normalizedAccountId,
      walletAddress: requestingWalletAddress,
      snapshotAt: new Date().toISOString(),
      networkTasks: [],
      openFollowups: [],
      recentBoardMessages: [],
      routingConstraints: {},
      digest: "",
    })),
    buildHiveMindContextForImmediateResponse({
      requestingAccountId: normalizedAccountId,
      requestingWalletAddress,
    }).catch(() => ({
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
  const requestingUserText = formatRequestingUserForImmediateResponse({
    accountId: normalizedAccountId,
    conversationId,
    requestingUser,
  });
  const userContent = [
    sourceEntryId ? `Hive Context Entry: ${sourceEntryId}` : "",
    normalizedAccountId ? `Requesting account: ${normalizedAccountId}` : "",
    requestingWalletAddress ? `Requesting wallet: ${requestingWalletAddress}` : "",
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
          accountLiveStateText: formatHiveAccountLiveStateForPrompt(accountLiveState),
          hiveMindContextText: hiveMindContext.text,
          requestingUserText,
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
      accountLiveStateDigest: safeText(accountLiveState?.digest || "", 120),
      accountLiveStateSnapshotAt: safeText(accountLiveState?.snapshotAt || "", 80),
      accountLiveStateStatus: safeText(accountLiveState?.status || "", 80),
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
