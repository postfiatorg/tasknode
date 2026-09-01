import { useCallback, useEffect, useRef } from "react";

import {
  createErrorAssistantTurn,
  formatElapsedSeconds,
  normalizeChatMessage,
  replaceTurnById,
} from "../../features/chat/chat-turns.js";
import {
  contextRewriteIsTerminal,
  fetchContextRewriteJob,
} from "./context-rewrite-client.js";

function withJobProgress(assistant, job) {
  if (!assistant || !job) return assistant;
  const metadata = assistant.metadata && typeof assistant.metadata === "object" ? assistant.metadata : {};
  const rewrite = metadata.contextRewrite && typeof metadata.contextRewrite === "object" ? metadata.contextRewrite : {};
  const progress = job.progress && typeof job.progress === "object" ? job.progress : rewrite.progress;
  return {
    ...assistant,
    metadata: {
      ...metadata,
      kind: "context_rewrite",
      contextRewrite: {
        ...rewrite,
        jobId: job.id || rewrite.jobId,
        status: job.status || rewrite.status,
        stage: job.currentStage || rewrite.stage,
        actualCostUsd: job.actualCostUsd ?? rewrite.actualCostUsd,
        maxCostUsd: job.maxCostUsd ?? rewrite.maxCostUsd,
        retryCount: job.retryCount ?? rewrite.retryCount,
        attempt: job.attempt ?? rewrite.attempt,
        stalled: job.stalled === true,
        staleAfter: job.staleAfter || rewrite.staleAfter,
        lastProgressAt: job.lastProgressAt || rewrite.lastProgressAt,
        elapsedSinceProgressMs: job.elapsedSinceProgressMs ?? rewrite.elapsedSinceProgressMs,
        statusMessage: job.statusMessage || rewrite.statusMessage,
        progress,
        trace: Array.isArray(progress?.trace) ? progress.trace : rewrite.trace,
      },
    },
  };
}

export function useContextRewritePolling({
  onChatSettled,
  setSendMessage,
  setStatusTone,
  setTurns,
}) {
  const pollsRef = useRef(new Map());
  const callbacksRef = useRef({ onChatSettled, setSendMessage, setStatusTone, setTurns });

  useEffect(() => {
    callbacksRef.current = { onChatSettled, setSendMessage, setStatusTone, setTurns };
  }, [onChatSettled, setSendMessage, setStatusTone, setTurns]);

  const replaceContextRewriteAssistant = useCallback((pendingId, assistant, startedAt, { pending = false } = {}) => {
    const turn = normalizeChatMessage({
      ...assistant,
      thinking: {
        state: pending ? "running" : "finished",
        duration: pending ? undefined : formatElapsedSeconds(Date.now() - startedAt),
        ...(assistant?.metadata?.thinking || {}),
        ...(assistant?.thinking || {}),
      },
    }, pendingId);
    if (!turn) return;
    callbacksRef.current.setTurns((current) => replaceTurnById(
      current,
      pendingId,
      { ...turn, id: pendingId, pending },
    ));
  }, []);

  const pollContextRewriteJob = useCallback(async (jobId, pendingId, startedAt) => {
    if (!jobId || pollsRef.current.has(jobId)) return;
    async function tick() {
      const callbacks = callbacksRef.current;
      try {
        const result = await fetchContextRewriteJob(jobId);
        if (!result.ok || !result.body?.job) {
          throw new Error(result.body?.message || `Context Rewrite returned HTTP ${result.status}.`);
        }
        const job = result.body.job;
        const stage = job.currentStage || job.status || "running";
        if (job.status === "failed" || job.status === "cancelled") {
          const failureMessage = job.error || result.body?.assistant?.body || "Context Rewrite did not complete.";
          callbacks.setTurns((current) => replaceTurnById(
            current,
            pendingId,
            createErrorAssistantTurn(pendingId, failureMessage, startedAt),
          ));
          callbacks.setSendMessage(failureMessage);
          callbacks.setStatusTone("error");
        } else if (result.body.assistant) {
          replaceContextRewriteAssistant(pendingId, withJobProgress(result.body.assistant, job), startedAt, {
            pending: !contextRewriteIsTerminal(job.status),
          });
          callbacks.setSendMessage(
            job.status === "completed"
              ? "Context Rewrite ready."
              : job.statusMessage || job.progress?.message || `Context Rewrite ${stage.replaceAll("_", " ")}. Check back in this tab.`,
          );
          callbacks.setStatusTone("muted");
        }
        if (contextRewriteIsTerminal(job.status)) {
          const timerId = pollsRef.current.get(jobId);
          if (timerId) window.clearInterval(timerId);
          pollsRef.current.delete(jobId);
          await callbacks.onChatSettled?.();
        }
      } catch (error) {
        callbacks.setSendMessage(error?.message || "Context Rewrite status is unavailable.");
        callbacks.setStatusTone("error");
      }
    }
    const timerId = window.setInterval(tick, 4000);
    pollsRef.current.set(jobId, timerId);
    await tick();
  }, [replaceContextRewriteAssistant]);

  useEffect(() => {
    const polls = pollsRef.current;
    return () => {
      for (const timerId of polls.values()) window.clearInterval(timerId);
      polls.clear();
    };
  }, []);

  return { pollContextRewriteJob, replaceContextRewriteAssistant };
}
