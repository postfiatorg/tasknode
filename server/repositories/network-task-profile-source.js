import { createHash } from "node:crypto";
import { normalizeTaskStatus, taskStatusLabel, taskStatusTab } from "../../shared/task-lifecycle.js";
import { formatTaskTimestamp } from "../../shared/task-time-format.js";

export const networkTaskProfilePromptVersion = "network_task_profile_v2";

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeAccountId(accountId = "") {
  return safeText(accountId, 180);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function digestJson(value) {
  return sha256(JSON.stringify(value));
}

function stableDigestValue(value) {
  if (Array.isArray(value)) return value.map(stableDigestValue);
  if (!value || typeof value !== "object") return value;
  const volatileKeys = new Set(["generated_at", "computed_at"]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !volatileKeys.has(key))
      .map(([key, item]) => [key, stableDigestValue(item)])
  );
}

function oneLine(value = "", max = 320) {
  return safeText(value, max).replace(/\s+/g, " ");
}

function truncateWithEllipsis(value = "", max = 700) {
  const text = oneLine(value, max + 80);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function stripHtmlForPacket(value = "") {
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
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function publicProfileFromRow(row = {}) {
  const metadata = safeObject(row.metadata_json);
  const generatedTask = safeObject(metadata.generatedTask);
  const rewardOutcome = safeObject(row.reward_outcome_payload);
  const rewardScore = safeObject(rewardOutcome.reward_score || rewardOutcome.score);
  const stopPayload = safeObject(row.stop_payload);
  const statusKey = normalizeTaskStatus(row.status);
  return {
    taskId: safeText(row.task_id, 180),
    title: safeText(row.title || generatedTask.title, 240),
    kind: safeText(row.task_kind || generatedTask.task_kind || "task", 80),
    statusKey,
    statusLabel: taskStatusLabel(statusKey),
    tab: taskStatusTab(statusKey),
    description: safeText(row.description || generatedTask.description, 1400),
    rewardOfferPft: numeric(row.reward_offer_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    updatedAt: toIso(row.updated_at || row.last_event_at),
    updatedAtDisplay: formatTaskTimestamp(row.updated_at || row.last_event_at, { locale: "en-US" }),
    rewardOutcome: {
      summary: safeText(
        rewardScore.user_feedback ||
          rewardScore.reason ||
          rewardOutcome.reward_summary ||
          rewardOutcome.user_feedback ||
          rewardOutcome.reason ||
          "",
        900
      ),
      decision: safeText(rewardScore.decision || rewardOutcome.reward_decision || rewardOutcome.decision || "", 80),
    },
    stopOutcome: {
      summary: safeText(
        stopPayload.reason ||
          stopPayload.refusal_reason ||
          stopPayload.refusalReason ||
          stopPayload.note ||
          "",
        600
      ),
    },
  };
}

function isRoutableTask(task = {}) {
  if (!task.taskId || task.statusKey === "unknown") return false;
  return Boolean(task.title || task.description);
}

function taskLine(task = {}) {
  const taskName = task.title || truncateWithEllipsis(task.description, 120);
  const lines = [
    `- Task Name: ${taskName}`,
    `  State: ${task.statusKey || "unknown"}`,
  ];
  if (task.description) lines.push(`  Description: ${truncateWithEllipsis(task.description, 420)}`);
  if (task.rewardActualPft > 0) {
    lines.push(`  Reward: ${task.rewardActualPft} PFT paid`);
  } else if (task.rewardOfferPft > 0) {
    lines.push(`  Reward: ${task.rewardOfferPft} PFT offered`);
  }
  const outcome = task.rewardOutcome?.summary || task.stopOutcome?.summary || "";
  if (outcome) lines.push(`  Outcome: ${truncateWithEllipsis(outcome, 420)}`);
  return lines.join("\n");
}

function groupText(title = "", tasks = [], { empty = "None" } = {}) {
  const items = tasks.map(taskLine).filter(Boolean);
  return [`${title} (${tasks.length})`, items.length ? items.join("\n") : empty].join("\n");
}

export function formatLiveTaskRoutingContext(tasks = []) {
  const normalized = safeArray(tasks).filter(isRoutableTask);
  const proposed = normalized.filter((task) => task.statusKey === "proposed");
  const outstanding = normalized.filter((task) => task.tab === "outstanding" && task.statusKey !== "proposed");
  const verification = normalized.filter((task) => task.tab === "verification");
  const refused = normalized.filter((task) => task.tab === "refused").slice(0, 6);
  const rewarded = normalized.filter((task) => task.tab === "rewarded").slice(0, 6);
  const displayedTotal = proposed.length + outstanding.length + verification.length + refused.length + rewarded.length;
  const text = [
    groupText("Proposed", proposed),
    "",
    groupText("Outstanding", outstanding),
    "",
    groupText("Verification", verification),
    "",
    groupText("Refused", refused),
    "",
    groupText("Rewarded", rewarded),
  ].join("\n");

  return {
    text,
    groups: { proposed, outstanding, verification, refused, rewarded },
    counts: {
      proposed: proposed.length,
      outstanding: outstanding.length,
      verification: verification.length,
      refused: refused.length,
      rewarded: rewarded.length,
      total: displayedTotal,
      available: normalized.length,
    },
  };
}

function profileSnapshotText({ profileInput = {}, latestProfileSnapshot = null } = {}) {
  const metrics = safeObject(profileInput.reward_totals);
  const alignment = safeObject(profileInput.alignment);
  const tier = safeObject(profileInput.contribution_tier);
  const identity = safeObject(profileInput.identity);
  const snapshot = latestProfileSnapshot || {};
  const skills = safeArray(snapshot.skills).join(", ");
  return [
    `Account: ${profileInput.account_id || "unknown"}`,
    `Primary wallet: ${identity.primary_wallet || identity.active_wallet || "not linked"}`,
    snapshot.roleTitle ? `Public role: ${snapshot.roleTitle}` : "",
    snapshot.roleSummary ? `Public role summary: ${snapshot.roleSummary}` : "",
    skills ? `Public skills: ${skills}` : "",
    `Lifetime task rewards: ${numeric(metrics.lifetimeTaskRewardPft)} PFT`,
    `Trailing 30 day rewarded tasks: ${Number(metrics.trailing30dRewardedTasks || 0)}`,
    `Trailing 30 day task rewards: ${numeric(metrics.trailing30dTaskRewardPft)} PFT`,
    alignment.score0To100 !== null && alignment.score0To100 !== undefined
      ? `Alignment score: ${alignment.score0To100}/100`
      : "",
    tier.tier ? `Contribution tier: ${tier.tier} (${tier.basis || "no basis recorded"})` : "",
  ].filter(Boolean).join("\n");
}

export function formatNetworkContextInputs({
  liveTaskContext = null,
  profileInput = null,
  latestProfileSnapshot = null,
} = {}) {
  return [
    "NETWORK CONTEXT INPUTS",
    "",
    "Profile",
    profileSnapshotText({ profileInput, latestProfileSnapshot }),
    "",
    "Task State",
    liveTaskContext?.text || "No task state is available.",
  ].join("\n");
}

export function formatNetworkTaskProfileOutput(output = {}) {
  const currentFocus = safeArray(output.current_focus).map((item) => safeText(item, 360)).filter(Boolean).slice(0, 6);
  const contribution = safeArray(output.primary_contribution_ability).map((item) => safeText(item, 420)).filter(Boolean).slice(0, 6);
  const domain = safeArray(output.domain_expertise).map((item) => safeText(item, 480)).filter(Boolean).slice(0, 10);
  return [
    safeText(output.profile_title, 160) || "Network Task Profile",
    "",
    currentFocus.length ? ["Current focus:", ...currentFocus.map((item) => `- ${item}`)].join("\n") : "",
    contribution.length ? ["Primary contribution ability:", ...contribution.map((item) => `- ${item}`)].join("\n") : "",
    domain.length
      ? ["Companies this User Would Move the Needle At:", ...domain.map((item) => `- ${item}`)].join("\n")
      : "",
  ].filter(Boolean).join("\n\n");
}

export function publicNetworkTaskProfile(row = null) {
  if (!row) return null;
  const output = safeObject(row.output_json);
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status,
    sourcePacketDigest: row.source_packet_digest,
    output,
    outputText: row.output_text || formatNetworkTaskProfileOutput(output),
    provider: row.provider || "",
    model: row.model || "",
    promptVersion: row.prompt_version || networkTaskProfilePromptVersion,
    promptDigest: row.prompt_digest || "",
    usage: row.usage_json || {},
    error: row.error || "",
    createdAt: toIso(row.created_at),
    completedAt: toIso(row.completed_at),
  };
}

export function publicNetworkTaskProfileJob(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    status: row.status,
    reason: row.reason,
    sourcePacketDigest: row.source_packet_digest,
    attemptCount: Number(row.attempt_count || 0),
    lastError: row.last_error || "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function compactTask(task = {}) {
  const outcome = task.rewardOutcome?.summary || task.stopOutcome?.summary || "";
  return {
    title: task.title,
    kind: task.kind,
    status: task.statusKey,
    reward: task.rewardActualPft > 0 ? `${task.rewardActualPft} PFT paid` : `${task.rewardOfferPft} PFT offered`,
    summary: truncateWithEllipsis(task.description, 700),
    outcome: truncateWithEllipsis(outcome, 700),
  };
}

export function buildNetworkTaskProfileSourcePacket({
  accountId = "",
  contextDocument = null,
  memoryContext = null,
  liveTaskContext = null,
  profileInput = null,
  latestProfileSnapshot = null,
} = {}) {
  const now = new Date().toISOString();
  const deepMemories = safeArray(memoryContext?.deepMemories).slice(0, 3);
  const contextText = stripHtmlForPacket(contextDocument?.body || "");
  const networkContextInputsText = formatNetworkContextInputs({
    liveTaskContext,
    profileInput,
    latestProfileSnapshot,
  });
  const allTasks = [
    ...safeArray(liveTaskContext?.groups?.proposed),
    ...safeArray(liveTaskContext?.groups?.outstanding),
    ...safeArray(liveTaskContext?.groups?.verification),
    ...safeArray(liveTaskContext?.groups?.refused),
    ...safeArray(liveTaskContext?.groups?.rewarded),
  ];
  const sourceJson = {
    schema: "pf.memory.network_task_profile_source.v1",
    generated_at: now,
    account_id: safeAccountId(accountId),
    profile_snapshot: profileInput || {},
    latest_public_profile_snapshot: latestProfileSnapshot || null,
    network_context_inputs: {
      text: networkContextInputsText,
      counts: liveTaskContext?.counts || {},
    },
    context_document: {
      title: contextDocument?.title || "Task Node Context",
      revision: Number(contextDocument?.revision || 0),
      updated_at: contextDocument?.updatedAt || null,
      body_text: contextText,
    },
    deep_memory: deepMemories.map((entry) => ({
      created_at: entry.createdAt,
      user_request_summary: entry.userRequestSummary,
      system_response_summary: entry.systemResponseSummary,
      memory_text: entry.memoryText,
    })),
    current_tasks: {
      proposed: safeArray(liveTaskContext?.groups?.proposed).map(compactTask),
      outstanding: safeArray(liveTaskContext?.groups?.outstanding).map(compactTask),
      verification: safeArray(liveTaskContext?.groups?.verification).map(compactTask),
    },
    recently_refused_tasks: safeArray(liveTaskContext?.groups?.refused).slice(0, 6).map(compactTask),
    recently_rewarded_tasks: safeArray(liveTaskContext?.groups?.rewarded).slice(0, 6).map(compactTask),
  };
  const sourceText = [
    "NETWORK TASK PROFILE SOURCE PACKET",
    "",
    "Generated At",
    now,
    "",
    "Account",
    safeAccountId(accountId),
    "",
    "Network Context Inputs",
    networkContextInputsText,
    "",
    "Context Document",
    contextText || "No context document text saved yet.",
    "",
    "Deep Memory",
    deepMemories.length
      ? deepMemories.map((entry, index) => [
        `Deep Memory ${index + 1}`,
        `User: ${safeText(entry.userRequestSummary, 1400)}`,
        `Assistant: ${safeText(entry.systemResponseSummary, 1400)}`,
        `Memory: ${safeText(entry.memoryText, 1800)}`,
      ].join("\n")).join("\n\n")
      : "No deep memory generated yet.",
    "",
    "Recently Refused Tasks",
    formatCompactTasks(liveTaskContext?.groups?.refused, "No recent refused tasks."),
    "",
    "Recently Rewarded Tasks",
    formatCompactTasks(liveTaskContext?.groups?.rewarded, "No recent rewarded tasks."),
  ].join("\n");
  return {
    sourceJson,
    sourceText,
    sourcePacketDigest: digestJson(stableDigestValue(sourceJson)),
    sourceCounts: {
      deepMemoryCount: deepMemories.length,
      contextDocumentCount: contextText ? 1 : 0,
      proposedTaskCount: liveTaskContext?.counts?.proposed || 0,
      outstandingTaskCount: liveTaskContext?.counts?.outstanding || 0,
      verificationTaskCount: liveTaskContext?.counts?.verification || 0,
      refusedTaskCount: liveTaskContext?.counts?.refused || 0,
      rewardedTaskCount: liveTaskContext?.counts?.rewarded || 0,
      totalTaskCount: allTasks.length,
    },
  };
}

function formatCompactTasks(tasks, empty) {
  const compactTasks = safeArray(tasks).slice(0, 6).map(compactTask);
  if (!compactTasks.length) return empty;
  return compactTasks.map((task) => [
    `Task: ${task.title}`,
    `Kind: ${task.kind}`,
    `Status: ${task.status}`,
    `Reward: ${task.reward}`,
    `Summary: ${task.summary}`,
    task.outcome ? `Outcome: ${task.outcome}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}
