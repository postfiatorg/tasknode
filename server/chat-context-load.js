import { chatContextDocumentLoadForAccount } from "./chat-account-context.js";
import { chatMemoryContextLoadForAccount } from "./chat-memory-context.js";
import { chatTaskContextLoadForAccount } from "./chat-task-context.js";
import { buildChatContextStatus } from "./chat-context-status.js";
import { teamContextForPrompt } from "./repositories/team-context.js";

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

export async function loadChatExecutionContext(accountId = "") {
  const [contextDocumentLoad, memoryLoad, taskLoad, teamLoad] = await Promise.all([
    chatContextDocumentLoadForAccount(accountId),
    chatMemoryContextLoadForAccount(accountId),
    chatTaskContextLoadForAccount(accountId),
    teamContextForPrompt(accountId).catch((error) => ({
      state: { status: "error", includeInPersonalContext: false, lastError: error?.message || String(error) },
      text: "",
    })),
  ]);

  const contextDocument = contextDocumentWithTeamContext(contextDocumentLoad.context, teamLoad.text);
  const contextStatus = buildChatContextStatus({
    contextDocument,
    contextDocumentStatus: contextDocumentLoad.status,
    memoryContext: memoryLoad.context,
    memoryStatus: memoryLoad.status,
    taskContext: taskLoad.context,
    taskStatus: taskLoad.status,
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
    taskContext: taskLoad.context,
    teamContext: teamLoad.state,
    contextStatus,
  };
}
