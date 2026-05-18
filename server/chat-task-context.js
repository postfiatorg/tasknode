import { getLinkedWallet } from "./runtime-store.js";
import { listTaskState } from "./repositories/tasks.js";
import { loadPrompt, renderPromptTemplate } from "./prompt-registry.js";

const taskContextPrompt = loadPrompt("chat/account_tasks_context_v1.md");
const taskContextTimeoutMs = Math.min(
  Math.max(Number(process.env.TASKNODE_CHAT_TASK_CONTEXT_TIMEOUT_MS) || 300, 50),
  2500
);
const defaultTaskGroupLimit = Math.min(
  Math.max(Number(process.env.TASKNODE_CHAT_TASK_CONTEXT_GROUP_LIMIT) || 6, 0),
  20
);
const defaultRewardedLimit = Math.min(
  Math.max(Number(process.env.TASKNODE_CHAT_TASK_CONTEXT_REWARDED_LIMIT) || 8, 0),
  20
);

function clip(value = "", max = 260) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 15)).trimEnd()} [truncated]`;
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

function formatGroup(tasks = [], { limit = defaultTaskGroupLimit } = {}) {
  const visible = Array.isArray(tasks) ? tasks.slice(0, limit) : [];
  if (visible.length === 0) return "None.";
  const omitted = tasks.length > visible.length ? `\n${tasks.length - visible.length} more task(s) omitted from context.` : "";
  return visible.map(taskLine).join("\n") + omitted;
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
    OUTSTANDING_COUNT: outstanding.length,
    OUTSTANDING_TASKS: formatGroup(outstanding),
    PENDING_VERIFICATION_COUNT: pendingVerification.length,
    PENDING_VERIFICATION_TASKS: formatGroup(pendingVerification),
    REFUSED_COUNT: refused.length,
    REFUSED_TASKS: formatGroup(refused),
    REWARDED_COUNT: rewarded.length,
    REWARDED_TASKS: formatGroup(rewarded, { limit: defaultRewardedLimit }),
  });
}

export async function taskContextForAccount(accountId = "") {
  if (!accountId || process.env.TASKNODE_CHAT_TASK_CONTEXT_ENABLED === "false") return null;
  const contextPromise = (async () => {
    const linkedWallet = getLinkedWallet({ accountId });
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
      return null;
    }
    return result;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    console.warn(`chat task context load failed: ${error?.message || error}`);
    return null;
  }
}
