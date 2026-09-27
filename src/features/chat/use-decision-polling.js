import { useEffect, useRef } from "react";
import { normalizeChatMessage, replaceTurnById } from "./chat-turns.js";
import { decisionIsTerminal, fetchDecisionJob } from "./decisions-client.js";

export function useDecisionPolling({ accountId, conversationId, turns, setTurns, setSendMessage, setStatusTone, onChatSettled }) {
  const callbacks = useRef({ setTurns, setSendMessage, setStatusTone, onChatSettled });
  useEffect(() => { callbacks.current = { setTurns, setSendMessage, setStatusTone, onChatSettled }; },
    [setTurns, setSendMessage, setStatusTone, onChatSettled]);
  const jobs = JSON.stringify(turns.filter(turn => turn.role === "assistant" && turn.metadata?.decision?.jobId
    && !decisionIsTerminal(turn.metadata.decision.status)).map(turn => [turn.metadata.decision.jobId, turn.id]));
  useEffect(() => {
    let disposed = false;
    const timers = new Set();
    async function poll(jobId, turnId) {
      try {
        const result = await fetchDecisionJob(jobId);
        if (disposed) return;
        if (!result.ok || !result.body?.job) throw new Error(result.body?.message || "Decision progress is temporarily unavailable.");
        const { job, assistant } = result.body;
        const done = decisionIsTerminal(job.status);
        if (assistant) {
          const next = normalizeChatMessage(assistant, turnId);
          if (next) callbacks.current.setTurns(current => replaceTurnById(current, turnId, { ...next, id: turnId, pending: !done }));
        }
        if (done) {
          callbacks.current.setSendMessage(job.status === "completed" ? "Decision report ready." : job.error || "The decision did not complete.");
          callbacks.current.setStatusTone(job.status === "failed" ? "error" : "muted");
          await callbacks.current.onChatSettled?.();
          return;
        }
      } catch (failure) {
        if (disposed) return;
        callbacks.current.setSendMessage(failure.message || "Decision progress is temporarily unavailable. Reconnecting…");
        callbacks.current.setStatusTone("error");
      }
      if (!disposed) {
        const timer = window.setTimeout(() => { timers.delete(timer); void poll(jobId, turnId); }, 10_000);
        timers.add(timer);
      }
    }
    for (const [jobId, turnId] of JSON.parse(jobs)) void poll(jobId, turnId);
    return () => { disposed = true; for (const timer of timers) window.clearTimeout(timer); };
  }, [accountId, conversationId, jobs]);
}
