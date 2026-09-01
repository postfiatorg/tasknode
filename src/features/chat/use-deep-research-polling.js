import { useCallback, useEffect, useRef } from "react";

import {
  formatElapsedSeconds,
  normalizeChatMessage,
  replaceTurnById,
} from "./chat-turns.js";
import {
  deepResearchIsTerminal,
  fetchDeepResearchJob,
} from "./deep-research-client.js";

export function useDeepResearchPolling({
  onChatSettled,
  setSendMessage,
  setStatusTone,
  setTurns,
  turns,
}) {
  const pollsRef = useRef(new Map());
  const callbacksRef = useRef({ onChatSettled, setSendMessage, setStatusTone, setTurns });

  useEffect(() => {
    callbacksRef.current = { onChatSettled, setSendMessage, setStatusTone, setTurns };
  }, [onChatSettled, setSendMessage, setStatusTone, setTurns]);

  const pollDeepResearchJob = useCallback(async (jobId, pendingId, startedAt) => {
    if (!jobId || !pendingId || pollsRef.current.has(jobId)) return;

    async function tick() {
      const callbacks = callbacksRef.current;
      try {
        const result = await fetchDeepResearchJob(jobId);
        if (!result.ok || !result.body?.job) {
          throw new Error(result.body?.message || `Deep Research returned HTTP ${result.status}.`);
        }
        const job = result.body.job;
        const terminal = deepResearchIsTerminal(job.status);
        if (result.body.assistant) {
          const assistant = result.body.assistant;
          const turn = normalizeChatMessage({
            ...assistant,
            thinking: {
              state: terminal ? "finished" : "running",
              duration: terminal ? formatElapsedSeconds(Date.now() - startedAt) : undefined,
              ...(assistant?.metadata?.thinking || {}),
              ...(assistant?.thinking || {}),
            },
          }, pendingId);
          if (turn) {
            callbacks.setTurns((current) => replaceTurnById(
              current,
              pendingId,
              { ...turn, id: pendingId, pending: !terminal },
            ));
          }
        }
        if (job.status === "failed") {
          callbacks.setSendMessage(job.error || "Deep Research did not complete.");
          callbacks.setStatusTone("error");
        } else if (job.status === "cancelled") {
          callbacks.setSendMessage("Deep Research cancelled.");
          callbacks.setStatusTone("muted");
        } else {
          const stage = String(job.stage || job.status || "running").replaceAll("_", " ");
          callbacks.setSendMessage(
            job.status === "completed"
              ? "Deep Research report ready."
              : `Deep Research ${stage}. You can leave and return.`,
          );
          callbacks.setStatusTone("muted");
        }
        if (terminal) {
          const timerId = pollsRef.current.get(jobId);
          if (timerId) window.clearInterval(timerId);
          pollsRef.current.delete(jobId);
          await callbacks.onChatSettled?.();
        }
      } catch (error) {
        callbacks.setSendMessage(error?.message || "Deep Research status is temporarily unavailable.");
        callbacks.setStatusTone("error");
      }
    }

    const timerId = window.setInterval(tick, 5000);
    pollsRef.current.set(jobId, timerId);
    await tick();
  }, []);

  useEffect(() => {
    for (const turn of turns) {
      const research = turn?.metadata?.deepResearch;
      if (!research?.jobId || deepResearchIsTerminal(research.status)) continue;
      const parsedStartedAt = Date.parse(turn.createdAt);
      const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
      void pollDeepResearchJob(research.jobId, turn.id, startedAt);
    }
  }, [pollDeepResearchJob, turns]);

  useEffect(() => {
    const polls = pollsRef.current;
    return () => {
      for (const timerId of polls.values()) window.clearInterval(timerId);
      polls.clear();
    };
  }, []);

  return { pollDeepResearchJob };
}
