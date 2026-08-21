import { getLinkedWallet } from "./repositories/account-wallets.js";
import { listTaskState } from "./repositories/tasks.js";
import { loadPrompt, renderPromptTemplate } from "./prompt-registry.js";
import { buildTaskContextStatus, taskContextIsEmpty } from "./chat-context-status.js";

const taskContextPrompt = loadPrompt("chat/account_tasks_context_v1.md");
const taskContextTimeoutMs = Math.min(
  Math.max(Number(process.env.TASKNODE_CHAT_TASK_CONTEXT_TIMEOUT_MS) || 300, 50),
  2500
);
const refusedTaskLimit = 10;
const rewardedTaskLimit = 12;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clip(value = "", max = 260) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 15)).trimEnd()} [truncated]`;
}

function formatPftAmount(value = 0) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return `${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} PFT`;
}

function formatReward(task) {
  const pft = Number(task?.pft || 0);
  return Number.isFinite(pft) && pft > 0 ? `${pft} PFT` : "reward not shown";
}

function taskLine(task, index) {
  const title = clip(task?.title || "Untitled task", 120);
  const kind = clip(task?.kind || "Task", 60);
  const status = clip(task?.status || "Unknown", 80);
  const due = clip(task?.due || "No deadline", 80);
  const taskId = clip(task?.fullId || task?.taskId || task?.id || "", 100);
  const description = clip(task?.description || "", 280);
  const evidence = clip(task?.verification?.body || "", 260);
  const steps = Array.isArray(task?.steps)
    ? task.steps.map((step) => clip(step, 160)).filter(Boolean).slice(0, 3)
    : [];
  const lines = [
    `${index + 1}. ${title} [${kind}; ${status}; ${formatReward(task)}; due=${due}${taskId ? `; id=${taskId}` : ""}]`,
  ];
  if (description) lines.push(`   Description: ${description}`);
  if (steps.length) lines.push(`   Steps: ${steps.join(" | ")}`);
  if (evidence) lines.push(`   Evidence: ${evidence}`);
  return lines.join("\n");
}

function formatGroup(tasks = [], { limit = Infinity } = {}) {
  const source = Array.isArray(tasks) ? tasks : [];
  const visible = Number.isFinite(limit) ? source.slice(0, limit) : source;
  if (visible.length === 0) return "None.";
  const omitted = source.length > visible.length ? `\n${source.length - visible.length} more task(s) omitted from context.` : "";
  return visible.map(taskLine).join("\n") + omitted;
}

function formatBadgeLine(badge = {}) {
  const badgeId = clip(badge.badgeId || badge.badge_id || "", 80);
  const label = clip(badge.label || badge.badgeLabel || badgeId || "Badge", 120);
  const cap = formatPftAmount(badge.maxPayoutPft || badge.max_payout_pft || badge.badgeRewardCapPft || 0);
  const workTypes = safeArray(badge.allowedWorkTypes || badge.allowed_work_types)
    .map((item) => clip(item, 80))
    .filter(Boolean)
    .slice(0, 8);
  return [
    `- ${label}${badgeId ? ` (${badgeId})` : ""}`,
    cap ? `cap=${cap}` : "",
    workTypes.length ? `work_types=${workTypes.join(", ")}` : "",
  ].filter(Boolean).join("; ");
}

function formatGateLine(gate = {}) {
  return [
    `- ${clip(gate.label || gate.id || "Eligibility gate", 120)}`,
    `status=${clip(gate.status || "unknown", 80)}`,
    gate.detail ? `detail=${clip(gate.detail, 220)}` : "",
    gate.action ? `action=${clip(gate.action, 180)}` : "",
  ].filter(Boolean).join("; ");
}

function formatCapacityBlockerLine(blocker = {}) {
  return [
    `- ${clip(blocker.title || blocker.taskId || blocker.generationJobId || "Network Task", 140)}`,
    blocker.taskId ? `task=${clip(blocker.taskId, 120)}` : "",
    blocker.state || blocker.allocationStatus ? `state=${clip(blocker.state || blocker.allocationStatus, 80)}` : "",
    blocker.rewardOfferPft ? `offer=${formatPftAmount(blocker.rewardOfferPft)}` : "",
    blocker.acceptBy ? `accept_by=${clip(blocker.acceptBy, 80)}` : "",
    blocker.deadlineAt ? `deadline=${clip(blocker.deadlineAt, 80)}` : "",
  ].filter(Boolean).join("; ");
}

function formatNetworkTaskEligibility(networkTasks = null) {
  if (!networkTasks || typeof networkTasks !== "object") {
    return [
      "<network_task_eligibility>",
      "Status: unavailable.",
      "Use generic Network Task guidance only; do not claim the user's badge or routing state is known.",
      "</network_task_eligibility>",
    ].join("\n");
  }
  const badgeEligibility = safeObject(networkTasks.badgeEligibility);
  const verifiedBadges = safeArray(badgeEligibility.verifiedBadges);
  const verifiedBadgeIds = safeArray(badgeEligibility.verifiedBadgeIds).map((item) => clip(item, 80)).filter(Boolean);
  const gates = safeArray(networkTasks.gates);
  const blockers = safeArray(safeObject(networkTasks.capacity).blockers);
  const allowedWorkTypes = safeArray(badgeEligibility.allowedWorkTypes).map((item) => clip(item, 100)).filter(Boolean);
  const badgeLines = verifiedBadges.length
    ? verifiedBadges.map(formatBadgeLine)
    : verifiedBadgeIds.length
      ? verifiedBadgeIds.map((badgeId) => `- ${badgeId}`)
      : ["- None verified."];
  const gateLines = gates.length ? gates.map(formatGateLine) : ["- No eligibility gates returned."];
  const blockerLines = blockers.length ? blockers.map(formatCapacityBlockerLine) : ["- None."];
  return [
    "<network_task_eligibility>",
    "Use this section when explaining why the user is or is not getting Network Tasks. Do not invent badges, roles, task capacity, or eligibility gates beyond this data.",
    `Status: ${clip(networkTasks.status || "unknown", 80)} (${clip(networkTasks.label || "Network Task eligibility", 120)})`,
    networkTasks.summary ? `Summary: ${clip(networkTasks.summary, 320)}` : "",
    networkTasks.nextAction ? `Next action: ${clip(networkTasks.nextAction, 220)}` : "",
    networkTasks.manualRequestCopy ? `Manual request note: ${clip(networkTasks.manualRequestCopy, 260)}` : "",
    `Requires verified operating badge: ${networkTasks.policy?.requiresNetworkTaskOperatingBadge === true ? "yes" : "unknown"}`,
    `Badge status: ${clip(badgeEligibility.status || "unknown", 80)}`,
    badgeEligibility.summary ? `Badge summary: ${clip(badgeEligibility.summary, 260)}` : "",
    badgeEligibility.defaultBadge ? `Default badge: ${clip(badgeEligibility.defaultBadge, 80)}` : "",
    allowedWorkTypes.length ? `Allowed work types: ${allowedWorkTypes.join(", ")}` : "",
    "Verified contributor badges:",
    badgeLines.join("\n"),
    "Eligibility gates:",
    gateLines.join("\n"),
    "Network Task capacity blockers:",
    blockerLines.join("\n"),
    "</network_task_eligibility>",
  ].filter(Boolean).join("\n");
}

export function formatChatTaskContext(taskContext = null) {
  if (!taskContext) return "";
  const outstanding = Array.isArray(taskContext.outstanding) ? taskContext.outstanding : [];
  const pendingVerification = Array.isArray(taskContext.verification) ? taskContext.verification : [];
  const refused = Array.isArray(taskContext.refused) ? taskContext.refused : [];
  const rewarded = Array.isArray(taskContext.rewarded) ? taskContext.rewarded : [];
  const sync = taskContext.sync || {};
  const syncLine = [
    `status=${clip(sync.status || "unknown", 80)}`,
    `source=${clip(sync.source || "task_projections", 80)}`,
    `projection_count=${Number(sync.projectionCount || 0)}`,
    sync.lastSyncedAt ? `last_synced_at=${clip(sync.lastSyncedAt, 80)}` : "",
  ].filter(Boolean).join("; ");

  return renderPromptTemplate(taskContextPrompt, {
    SYNC_LINE: syncLine,
    NETWORK_TASK_ELIGIBILITY: formatNetworkTaskEligibility(taskContext.networkTasks),
    OUTSTANDING_COUNT: outstanding.length,
    OUTSTANDING_TASKS: formatGroup(outstanding),
    PENDING_VERIFICATION_COUNT: pendingVerification.length,
    PENDING_VERIFICATION_TASKS: formatGroup(pendingVerification),
    REFUSED_COUNT: refused.length,
    REFUSED_TASKS: formatGroup(refused, { limit: refusedTaskLimit }),
    REWARDED_COUNT: rewarded.length,
    REWARDED_TASKS: formatGroup(rewarded, { limit: rewardedTaskLimit }),
  });
}

export async function chatTaskContextLoadForAccount(accountId = "") {
  if (!accountId || process.env.TASKNODE_CHAT_TASK_CONTEXT_ENABLED === "false") {
    return {
      context: null,
      status: buildTaskContextStatus({ state: "disabled" }),
    };
  }

  const contextPromise = (async () => {
    const linkedWallet = await getLinkedWallet({ accountId });
    return listTaskState({
      accountId,
      walletAddress: linkedWallet.status === "linked" ? linkedWallet.address || "" : "",
    });
  })();
  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), taskContextTimeoutMs);
  });

  try {
    const result = await Promise.race([contextPromise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    if (result?.timedOut) {
      contextPromise.catch((error) => {
        console.warn(`chat task context load failed after timeout: ${error?.message || error}`);
      });
      return {
        context: null,
        status: buildTaskContextStatus({ state: "timeout" }),
      };
    }
    const state = taskContextIsEmpty(result) ? "empty" : "included";
    return {
      context: result,
      status: buildTaskContextStatus({ context: result, state }),
    };
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    console.warn(`chat task context load failed: ${error?.message || error}`);
    return {
      context: null,
      status: buildTaskContextStatus({ state: "error", error: error?.message || String(error) }),
    };
  }
}

export async function taskContextForAccount(accountId = "") {
  return (await chatTaskContextLoadForAccount(accountId)).context;
}
