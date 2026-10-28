import { useEffect, useState } from "react";
import { researchRequest } from "./research-client.js";
import "./research.css";

export function ResearchView() {
  const [eligible, setEligible] = useState(false);
  const [question, setQuestion] = useState("");
  const [budget, setBudget] = useState("1");
  const [job, setJob] = useState(null);
  const [result, setResult] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    researchRequest("/api/validators").then((data) => { if (active) setEligible(data.bindings.length > 0); }).catch((error) => { if (active) setMessage(error.message); });
    researchRequest("/api/index-viewer/catalog").then((data) => { if (active) setCatalog(data.indices.filter((item) => item.tier === "validator")); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const jobId = job?.job_id;
  const terminal = ["completed", "failed"].includes(job?.status);
  useEffect(() => {
    if (!jobId) return undefined;
    let active = true;
    let timer;
    const poll = async () => {
      try {
        const next = await researchRequest(`/api/research/ui/jobs/${jobId}`);
        if (!active) return;
        setJob(next);
        if (next.status === "completed") {
          const report = await researchRequest(`/api/research/ui/jobs/${jobId}/result`);
          if (active) setResult(report);
        } else if (next.status === "failed") setMessage("Research could not complete. Any provider costs are shown in Billing.");
        else timer = setTimeout(poll, 4000);
      } catch (error) { if (active) { setMessage(error.message); timer = setTimeout(poll, 10000); } }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [jobId]);
  return <section className="research-view">
    <header><h1>Research</h1><p>GoodAlexander financial research and models for Post Fiat validators.</p></header>
    {!eligible && <p><a href="#settings/validator">Bind your validator</a> to unlock research and financial models.</p>}
    <div className="research-catalog">{catalog.map((item) => <article className="research-card" key={item.indexId}>
      <h2>{item.title}</h2><p>{item.summary}</p>
      {eligible ? <a href={`/api/research/bundles/${encodeURIComponent(item.indexId)}/index.html`} target="_blank" rel="noreferrer">Open {item.title}</a> : <span>Validator access required</span>}
    </article>)}</div>
    <form className="research-panel" onSubmit={async (event) => {
      event.preventDefault(); setBusy(true); setMessage(""); setResult(null);
      try { setJob(await researchRequest("/api/research/ui/jobs", { method: "POST", body: { question, max_cost_usd: Number(budget), request_id: crypto.randomUUID() } })); }
      catch (error) { setMessage(error.message); } finally { setBusy(false); }
    }}>
      <label>Research question<textarea rows={5} value={question} maxLength={16000} onChange={(event) => setQuestion(event.target.value)} required placeholder="Ask about a company, its management, or its financial history." /></label>
      <label>Maximum cost (USD)<input type="number" min="0.01" max="5" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} required /></label>
      <p>Billed at actual provider cost. At least $0.50 available credit is required. <a href="#settings/billing">Manage credit</a> · <a href="#settings/api-keys">API keys</a></p>
      <button type="submit" disabled={!eligible || busy || Boolean(job && !terminal)}>{busy || (job && !terminal) ? "Researching…" : "Run research"}</button>
    </form>
    <p role="status">{message || (job ? `Research ${job.status}${job.usage ? ` · $${job.usage.total_cost_usd}` : ""}` : "")}</p>
    {result && <article className="research-report"><pre>{result.markdown}</pre></article>}
  </section>;
}
