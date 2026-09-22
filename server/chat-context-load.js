import { chatContextDocumentLoadForAccount } from "./chat-account-context.js";
import { chatMemoryContextLoadForAccount } from "./chat-memory-context.js";
import { chatTaskContextLoadForAccount } from "./chat-task-context.js";
import { buildChatContextStatus, buildTaskContextStatus } from "./chat-context-status.js";
import { teamContextForPrompt } from "./repositories/team-context.js";
import { loadChatTaskActivity, taskContextFromActivity } from "./chat-task-activity.js";

function contextDocumentWithTeamContext(contextDocument = null, teamContextText = "") {
  if (!teamContextText) return contextDocument;
  return {
    ...(contextDocument || {}),
    id: contextDocument?.id || "generated-team-context",
    title: contextDocument?.title || "Task Node Context",
    revision: contextDocument?.revision || 0,
    updatedAt: contextDocument?.updatedAt || new Date().toISOString(),
    body: [String(contextDocument?.body || "").trim(), teamContextText].filter(Boolean).join("\n\n"),
    teamContextIncluded: true,
  };
}

export async function loadChatExecutionContext(accountId = "", {
  loadDocument = chatContextDocumentLoadForAccount,
  loadMemory = chatMemoryContextLoadForAccount,
  loadTasks = chatTaskContextLoadForAccount,
  loadTeam = teamContextForPrompt,
  loadActivity = loadChatTaskActivity,
} = {}) {
  // Load the bounded prompt inputs before the expensive generated-Team report.
  // Do not run the Tasks UI's eligibility/forensics aggregation on every chat.
  const [contextDocumentLoad, memoryLoad, activityLoad] = await Promise.all([
    loadDocument(accountId),
    loadMemory(accountId),
    loadActivity(accountId),
  ]);
  const activityContext = activityLoad.context ? taskContextFromActivity(activityLoad.context) : null;
  const [taskLoad, teamLoad] = await Promise.all([
    activityContext
      ? { context: activityContext, status: buildTaskContextStatus({ context: activityContext, state: "included" }) }
      : loadTasks(accountId),
    loadTeam(accountId).catch((error) => ({
      state: { status: "error", includeInPersonalContext: false, lastError: error?.message || String(error) },
      text: "",
    })),
  ]);

  const contextDocument = contextDocumentWithTeamContext(contextDocumentLoad.context, teamLoad.text);
  const taskContext = activityLoad.context
    ? { ...(taskLoad.context || { activityOnly: true }), activity: activityLoad.context }
    : taskLoad.context;
  const taskStatus = {
    ...taskLoad.status,
    ...(activityLoad.context ? { state: "included", included: true } : {}),
    projectionState: taskLoad.status.state,
    activity: activityLoad.status,
    activityTaskCount: activityLoad.context?.members.reduce((total, member) => total + member.tasks.length, 0) || 0,
  };
  const contextStatus = buildChatContextStatus({
    contextDocument,
    contextDocumentStatus: contextDocumentLoad.status,
    memoryContext: memoryLoad.context,
    memoryStatus: memoryLoad.status,
    taskContext,
    taskStatus,
  });
  contextStatus.teamContext = {
    state: teamLoad.state?.includeInPersonalContext === true ? teamLoad.state?.status || "pending" : "disabled",
    included: Boolean(teamLoad.text),
    memberCount: Array.isArray(teamLoad.state?.members) ? teamLoad.state.members.length : 0,
    generatedAt: teamLoad.state?.generatedAt || undefined,
    error: teamLoad.state?.lastError || undefined,
  };

  return {
    contextDocument,
    memoryContext: memoryLoad.context,
    taskContext,
    teamContext: teamLoad.state,
    contextStatus,
  };
}
