import { randomUUID } from "node:crypto";
import { appendChatTurn, getChatMessages } from "./repositories/chat-billing.js";
import { enqueueChatMemoryJob } from "./repositories/chat-memory.js";
import { getContextDocument, saveContextDocument } from "./repositories/context.js";
import {
  createContextEditProposal,
  getActiveContextEditProposal,
  getContextEditProposal,
  markContextEditProposalApplied,
  markContextEditProposalRejected,
} from "./repositories/context-edit.js";
import { chatMemoryContextForAccount } from "./chat-memory-context.js";
import { taskContextForAccount } from "./chat-task-context.js";
import { chatExecutionStatus, executeOpenAi } from "./chat-router.js";
import {
  contextEditPromptSha256,
  contextEditPromptVersion,
  contextEditResponseFormat,
  renderContextEditPrompt,
} from "./context-edit-prompts.js";
import {
  applyContextEditProposalToDocument,
  parseContextEditOutput,
} from "./context-edit-proposals.js";
import { contextDocumentPacket } from "./context-line-map.js";

export const contextEditMode = "context_edit";
const contextEditChatMode = "Frontier Thinking";

function enqueueMemoryForTurn({ accountId, conversationId, persisted }) {
  if (!accountId || !persisted?.user?.id || !persisted?.assistant?.id) return;
  enqueueChatMemoryJob({
    accountId,
    conversationId,
    userMessageId: persisted.user.id,
    assistantMessageId: persisted.assistant.id,
  }).catch((error) => {
    console.warn(`context edit memory enqueue failed: ${error?.message || error}`);
  });
}

function proposalMetadata(proposal = null) {
  if (!proposal) return null;
  return {
    id: proposal.id,
    state: proposal.state,
    operation: proposal.operation,
    anchorType: proposal.anchorType,
    lineStart: proposal.lineStart,
    lineEnd: proposal.lineEnd,
    targetHeading: proposal.targetHeading,
    targetBefore: proposal.targetBefore,
    targetAfter: proposal.targetAfter,
    rationale: proposal.rationale,
    risk: proposal.risk,
    savedContextRevision: proposal.savedContextRevision,
    appliedAt: proposal.appliedAt,
    rejectedAt: proposal.rejectedAt,
  };
}

export function isContextEditPayload(payload = {}) {
  return payload?.contextMode === contextEditMode || payload?.mode === contextEditMode;
}

export async function executeContextEditChat({
  accountId = "",
  message,
  conversationId = "dev",
  attachments = [],
  contextDocument,
  memoryContext,
  taskContext,
  contextStatus,
} = {}) {
  const status = chatExecutionStatus(contextEditChatMode);
  if (!status.enabled) {
    const error = new Error(status.configured ? "chat_provider_disabled" : "chat_provider_not_configured");
    error.status = status.configured ? 503 : 409;
    error.provider = status.provider;
    throw error;
  }

  const [historyMessages, resolvedContext, resolvedMemory, resolvedTasks, activeProposal] = await Promise.all([
    getChatMessages({ accountId, conversationId }),
    contextDocument === undefined ? getContextDocument({ accountId }) : contextDocument,
    memoryContext === undefined ? chatMemoryContextForAccount(accountId) : memoryContext,
    taskContext === undefined ? taskContextForAccount(accountId) : taskContext,
    getActiveContextEditProposal({ accountId, conversationId }),
  ]);
  const instructions = renderContextEditPrompt({
    contextDocument: resolvedContext,
    memoryContext: resolvedMemory,
    taskContext: resolvedTasks,
    historyMessages,
    activeProposal,
    userRequest: message,
  });
  const contextPacket = contextDocumentPacket(resolvedContext);

  const result = await executeOpenAi({
    mode: contextEditChatMode,
    model: status.model,
    message,
    conversationId,
    attachments,
    historyMessages,
    instructionsOverride: instructions,
    responseFormat: contextEditResponseFormat(),
    toolsEnabled: false,
  });
  const parsed = parseContextEditOutput(result.text);
  const proposalId = parsed.proposal ? `ctxedit_${randomUUID()}` : "";
  const userMessageId = `msg_${randomUUID()}_context_edit_user`;
  const assistantMessageId = `msg_${randomUUID()}_context_edit_assistant`;
  const storedProposal = parsed.proposal
    ? await createContextEditProposal({
        id: proposalId,
        accountId,
        conversationId,
        assistantMessageId,
        baseContextRevision: resolvedContext?.revision || 0,
        baseBodySha256: contextPacket.bodySha256,
        ...parsed.proposal,
        metadata: {
          promptVersion: contextEditPromptVersion,
          promptSha256: contextEditPromptSha256,
          activeProposalId: activeProposal?.id || "",
        },
      })
    : null;
  const assistantBody = parsed.response || (storedProposal ? "I prepared one context edit." : "I need one clarification.");
  const resolvedContextStatus = {
    ...(contextStatus || {}),
    contextMode: contextEditMode,
    jobsRetrieval: contextStatus?.jobsRetrieval || { state: "skipped", included: false, reason: "context_edit" },
  };
  const persisted = await appendChatTurn({
    accountId,
    conversationId,
    mode: contextEditChatMode,
    provider: result.provider,
    model: result.model,
    responseId: result.responseId,
    userMessage: message,
    assistantMessage: assistantBody,
    userMessageId,
    assistantMessageId,
    userMetadata: { kind: contextEditMode },
    assistantMetadata: {
      kind: contextEditMode,
      state: parsed.state,
      promptVersion: contextEditPromptVersion,
      promptSha256: contextEditPromptSha256,
      contextEdit: {
        state: parsed.state,
        proposal: proposalMetadata(storedProposal),
      },
    },
    runMetadata: { contextMode: contextEditMode, contextStatus: resolvedContextStatus },
    attachments,
    usage: result.usage,
  });
  enqueueMemoryForTurn({ accountId, conversationId, persisted });
  return {
    ...result,
    text: assistantBody,
    ...persisted,
    contextStatus: resolvedContextStatus,
  };
}

export async function applyContextEditProposal({
  accountId = "",
  proposalId = "",
} = {}) {
  const proposal = await getContextEditProposal({ accountId, proposalId });
  if (!proposal) {
    const error = new Error("context_edit_proposal_not_found");
    error.status = 404;
    throw error;
  }
  if (proposal.state !== "pending") {
    const error = new Error("context_edit_proposal_not_pending");
    error.status = 409;
    throw error;
  }

  const document = await getContextDocument({ accountId });
  const patched = applyContextEditProposalToDocument({ document, proposal });
  const saved = await saveContextDocument({
    accountId,
    title: patched.title,
    body: patched.body,
    source: "context_edit_chat_mode",
    provenance: {
      proposalId: proposal.id,
      conversationId: proposal.conversationId,
      assistantMessageId: proposal.assistantMessageId,
      baseContextRevision: proposal.baseContextRevision,
      baseBodySha256: proposal.baseBodySha256,
    },
  });

  if (!saved.ok) {
    const error = new Error(saved.error || "context_edit_save_failed");
    error.status = saved.status || 500;
    throw error;
  }

  const updatedProposal = await markContextEditProposalApplied({
    accountId,
    proposalId: proposal.id,
    savedContextRevision: saved.document?.revision,
    savedContextDocumentId: saved.document?.id,
    savedContextHash: patched.bodySha256,
  });
  return { proposal: updatedProposal, document: saved.document };
}

export async function rejectContextEditProposal({ accountId = "", proposalId = "" } = {}) {
  const proposal = await markContextEditProposalRejected({ accountId, proposalId });
  if (!proposal) {
    const error = new Error("context_edit_proposal_not_found");
    error.status = 404;
    throw error;
  }
  return { proposal };
}
