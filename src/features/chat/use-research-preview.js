import { useEffect, useRef, useState } from "react";
import { previewDeepResearch } from "./deep-research-client.js";
import { defaultChatResearchBudget } from "../../../shared/chat-research.js";

export function useResearchPreview({ accountId, conversationKey, question, enabled, availableCreditUsd, explicitBudget }) {
  const [saved, setSaved] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const current = useRef({ accountId, question, enabled });
  const busy = useRef(false);
  const submission = useRef(null);
  useEffect(() => { current.current = { accountId, question, enabled }; }, [accountId, question, enabled]);
  const preview = enabled && saved?.accountId === accountId && saved?.question === question ? saved.preview : null;
  const budget = explicitBudget === null ? defaultChatResearchBudget(preview?.availableCreditUsd ?? availableCreditUsd, preview?.mode) : Number(explicitBudget);
  async function prepare() {
    if (busy.current) return false;
    if (!question) { setError("Enter a research question first."); return false; }
    if (preview && Date.parse(preview.expires_at) > Date.now() + 30000) {
      if (!Number.isFinite(budget) || budget < 0.05 || budget > 10 || Number(budget.toFixed(6)) !== budget) {
        setError("Choose a maximum between $0.05 and $10, with at most six decimal places."); return false;
      }
      return true;
    }
    busy.current = true; setLoading(true); setError("");
    try {
      const response = await previewDeepResearch(question);
      if (!response.ok || !response.body?.preview) throw Error(response.body?.message || "Research preview is unavailable. Try again.");
      const latest = current.current;
      if (latest.enabled && latest.accountId === accountId && latest.question === question) {
        setSaved({ accountId, question, preview: response.body.preview });
      }
    } catch (error) { setError(error.message || "Research preview is unavailable. Try again."); }
    finally { busy.current = false; setLoading(false); }
    return false;
  }
  function requestId(createId) {
    const identity = JSON.stringify([accountId, conversationKey, question, preview?.mode, budget]);
    if (submission.current?.identity !== identity) submission.current = { identity, id: createId() };
    return submission.current.id;
  }
  function reset() { submission.current = null; setSaved(null); setError(""); }
  return { preview, budget, loading, error, prepare, requestId, reset };
}
