import { readChatTaskActivity } from "./repositories/chat-task-activity.js";
import { loadPrompt, renderPromptTemplate } from "./prompt-registry.js";
import { taskStatusTab } from "../shared/task-lifecycle.js";

const activityPrompt = loadPrompt("chat/task_activity_context_v1.md");

export function formatChatTaskActivity(activity = null) {
  if (!activity) return "";
  return renderPromptTemplate(activityPrompt, { ACTIVITY_JSON: JSON.stringify(activity) });
}

export function taskContextFromActivity(activity) {
  const groups = { outstanding: [], verification: [], refused: [], rewarded: [] };
  for (const task of activity.members.find((member) => member.self)?.tasks || []) {
    (groups[taskStatusTab(task.status)] || groups.outstanding).push(task);
  }
  return { ...groups, activityOnly: true, activity, sync: { status: "current", source: activity.source, lastSyncedAt: activity.capturedAt } };
}

export async function loadChatTaskActivity(accountId = "", {
  readActivity = readChatTaskActivity,
  timeoutMs = 10000,
} = {}) {
  if (!accountId || process.env.TASKNODE_CHAT_TASK_CONTEXT_ENABLED === "false") {
    return { context: null, status: { state: "disabled", included: false } };
  }
  let timer;
  try {
    const context = await Promise.race([
      readActivity({ accountId }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("task_activity_timeout")), timeoutMs);
      }),
    ]);
    return { context, status: { state: context ? "included" : "unavailable", included: Boolean(context), capturedAt: context?.capturedAt } };
  } catch (error) {
    return { context: null, status: { state: error.message === "task_activity_timeout" ? "timeout" : "error", included: false } };
  } finally {
    clearTimeout(timer);
  }
}
