import { useCallback, useEffect, useRef } from "react";

import {
  formatElapsedSeconds,
  normalizeChatMessage,
} from "./chat-turns.js";
import { pendingDeepResearchTurns, replaceDeepResearchAssistant } from "./deep-research-turns.js";
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

    const entry = { timer: null, cancelled: false };
    pollsRef.current.set(jobId, entry);
    async function tick() {
      if (entry.cancelled) return;
      const callbacks = callbacksRef.current;
      try {
        const result = await fetchDeepResearchJob(jobId);
        if (entry.cancelled) return;
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
            callbacks.setTurns((current) => replaceDeepResearchAssistant(
              current,
              jobId,
              pendingId,
              { ...turn, pending: !terminal },
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
          entry.cancelled = true;
          pollsRef.current.delete(jobId);
          await callbacks.onChatSettled?.();
        }
      } catch (error) {
        if (entry.cancelled) return;
        callbacks.setSendMessage(error?.message || "Deep Research status is temporarily unavailable.");
        callbacks.setStatusTone("error");
      } finally {
        if (!entry.cancelled) entry.timer = window.setTimeout(tick, 5000);
      }
    }
    await tick();
  }, []);

  useEffect(() => {
    for (const turn of pendingDeepResearchTurns(turns)) {
      const research = turn?.metadata?.deepResearch;
      if (!research?.jobId || deepResearchIsTerminal(research.status)) continue;
      const parsedStartedAt = Date.parse(turn.createdAt || research.startedAt);
      const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
      void pollDeepResearchJob(research.jobId, turn.id, startedAt);
    }
  }, [pollDeepResearchJob, turns]);

  useEffect(() => {
    const polls = pollsRef.current;
    return () => {
      for (const entry of polls.values()) { entry.cancelled = true; window.clearTimeout(entry.timer); }
      polls.clear();
    };
  }, []);

  return { pollDeepResearchJob };
}
