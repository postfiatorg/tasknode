import { contextBodyText } from "./context-line-map.js";

export function memoryContextIsEmpty(memoryContext = null) {
  if (!memoryContext) return true;
  const deepMemories = Array.isArray(memoryContext.deepMemories) ? memoryContext.deepMemories : [];
  const memories = Array.isArray(memoryContext.memories) ? memoryContext.memories : [];
  return deepMemories.length === 0 && memories.length === 0;
}

export function taskContextIsEmpty(taskContext = null) {
  if (!taskContext) return true;
  const groups = ["outstanding", "verification", "refused", "rewarded"];
  return groups.every((key) => !Array.isArray(taskContext[key]) || taskContext[key].length === 0);
}

export function contextDocumentIsEmpty(contextDocument = null) {
  if (!contextDocument) return true;
  return !contextBodyText(contextDocument.body || "").trim();
}

export function buildMemoryContextStatus({ context = null, state = "empty", error = "" } = {}) {
  const deepCount = Array.isArray(context?.deepMemories) ? context.deepMemories.length : 0;
  const turnCount = Array.isArray(context?.memories) ? context.memories.length : 0;
  return {
    state,
    included: state === "included",
    deepCount,
    turnCount,
    error: error || undefined,
  };
}

export function buildTaskContextStatus({ context = null, state = "empty", error = "" } = {}) {
  const counts = {
    outstanding: Array.isArray(context?.outstanding) ? context.outstanding.length : 0,
    verification: Array.isArray(context?.verification) ? context.verification.length : 0,
    refused: Array.isArray(context?.refused) ? context.refused.length : 0,
    rewarded: Array.isArray(context?.rewarded) ? context.rewarded.length : 0,
  };
  return {
    state,
    included: state === "included",
    counts,
    syncStatus: context?.sync?.status || undefined,
    error: error || undefined,
  };
}

export function buildContextDocumentStatus({ context = null, state = "empty", error = "" } = {}) {
  const bodyCharacters = contextBodyText(context?.body || "").length;
  return {
    state,
    included: state === "included",
    revision: context?.revision || 0,
    bodyCharacters,
    error: error || undefined,
  };
}

export function buildJobsRetrievalStatus(result = null) {
  if (!result) {
    return { state: "skipped", included: false };
  }
  if (result.reason === "jobs_retrieval_timeout") {
    return { state: "timeout", included: false, reason: result.reason };
  }
  if (result.skipped) {
    return {
      state: "skipped",
      included: false,
      reason: result.reason || "skipped",
    };
  }
  if (result.ok === false) {
    return {
      state: "error",
      included: false,
      reason: result.reason || "retrieval_failed",
    };
  }
  return {
    state: "included",
    included: Boolean(result.text),
    chunkCount: Array.isArray(result.chunks) ? result.chunks.length : 0,
    retrievalId: result.retrievalId || undefined,
  };
}

export function buildChatContextStatus({
  contextDocument = null,
  contextDocumentStatus = null,
  memoryContext = null,
  memoryStatus = null,
  taskContext = null,
  taskStatus = null,
  jobsRetrieval = null,
} = {}) {
  return {
    contextDocument: contextDocumentStatus || buildContextDocumentStatus({
      context: contextDocument,
      state: contextDocumentIsEmpty(contextDocument) ? "empty" : "included",
    }),
    memory: memoryStatus || buildMemoryContextStatus({
      context: memoryContext,
      state: memoryContextIsEmpty(memoryContext) ? "empty" : "included",
    }),
    tasks: taskStatus || buildTaskContextStatus({
      context: taskContext,
      state: taskContextIsEmpty(taskContext) ? "empty" : "included",
    }),
    jobsRetrieval: buildJobsRetrievalStatus(jobsRetrieval),
  };
}
