import { useCallback, useEffect, useState } from "react";
import {
  decideHiveMindProposal,
  fetchHiveMindCoverage,
  fetchHiveMindInsights,
  fetchHiveMindMatches,
  fetchHiveMindProfile,
  fetchHiveMindProposals,
  fetchHiveMindRoi,
  saveHiveMindProfile,
  sendHiveMindInterviewMessage,
  signClaimPayloadClient,
  startHiveMindInterview,
  submitHiveMindClaim,
} from "./api.js";
import "./hive-mind.css";

const INFO_TYPES = ["operator", "builder", "customer", "trader", "public_data_analyst"];
const RELATIONSHIPS = [
  { id: "public_observer", label: "Public observer / researcher" },
  { id: "operator", label: "Independent node / infrastructure operator" },
  { id: "customer", label: "Customer / user (outside NDA)" },
  { id: "builder", label: "Ecosystem builder / developer" },
  { id: "trader", label: "Market participant / trader" },
  { id: "public_data_analyst", label: "Public-data / on-chain analyst" },
  { id: "current_employee", label: "Current employee (blocked by MNPI policy)" },
  { id: "nda_bound", label: "Bound by NDA / confidentiality (blocked)" },
];

export function HiveMindView({ accountId = "" } = {}) {
  const [tab, setTab] = useState("coverage");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const [coverage, setCoverage] = useState([]);
  const [matches, setMatches] = useState([]);
  const [areasInput, setAreasInput] = useState("solana, ai_compute");
  const [selectedInfoTypes, setSelectedInfoTypes] = useState(["builder", "public_data_analyst"]);
  const [approvedSummary, setApprovedSummary] = useState("");
  const [attributionMode, setAttributionMode] = useState("pseudonym");
  const [profileConfirmed, setProfileConfirmed] = useState(false);

  const [selectedModelId, setSelectedModelId] = useState("SOL");
  const [relationship, setRelationship] = useState("public_observer");
  const [noMnpiAttested, setNoMnpiAttested] = useState(false);
  const [noNdaAttested, setNoNdaAttested] = useState(false);
  const [activeInterview, setActiveInterview] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draftMessage, setDraftMessage] = useState("");
  const [redactedPending, setRedactedPending] = useState("");

  const [claimText, setClaimText] = useState("");
  const [claimEvidence, setClaimEvidence] = useState("");
  const [claimStance, setClaimStance] = useState("refines");
  const [claimCheckable, setClaimCheckable] = useState(true);
  const [claimCheckDate, setClaimCheckDate] = useState("");
  const [claimCheckDesc, setClaimCheckDesc] = useState("");

  const [proposals, setProposals] = useState([]);
  const [insights, setInsights] = useState([]);
  const [roi, setRoi] = useState(null);

  const loadData = useCallback(async () => {
    setErrorMessage("");
    try {
      const [covRes, insRes] = await Promise.all([
        fetchHiveMindCoverage(),
        fetchHiveMindInsights(),
      ]);
      if (covRes?.assets) setCoverage(covRes.assets);
      if (insRes?.insights) setInsights(insRes.insights);

      if (accountId) {
        const [profRes, propRes, roiRes] = await Promise.all([
          fetchHiveMindProfile().catch(() => null),
          fetchHiveMindProposals().catch(() => null),
          fetchHiveMindRoi().catch(() => null),
        ]);
        if (profRes?.profile) {
          setProfileConfirmed(Boolean(profRes.profile.confirmed));
          if (profRes.profile.confirmedAreas?.length) setAreasInput(profRes.profile.confirmedAreas.join(", "));
          if (profRes.profile.confirmedInfoTypes?.length) setSelectedInfoTypes(profRes.profile.confirmedInfoTypes);
          setApprovedSummary(profRes.profile.approvedSummary || "");
          setAttributionMode(profRes.profile.attributionMode || "pseudonym");
        }
        if (propRes?.proposals) setProposals(propRes.proposals);
        if (roiRes?.roi) setRoi(roiRes.roi);
        const matchRes = await fetchHiveMindMatches().catch(() => null);
        if (matchRes?.matches) setMatches(matchRes.matches);
      }
    } catch (error) {
      setErrorMessage(error?.message || "Failed to load Information Hive Mind.");
    }
  }, [accountId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleInfoType = (type) => {
    setSelectedInfoTypes((prev) =>
      prev.includes(type) ? prev.filter((item) => item !== type) : [...prev, type]
    );
  };

  const handleConfirmProfile = async (event) => {
    event.preventDefault();
    setErrorMessage("");
    setStatusMessage("");
    const confirmedAreas = areasInput
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    try {
      await saveHiveMindProfile({
        confirmed: true,
        confirmedAreas,
        confirmedInfoTypes: selectedInfoTypes,
        approvedSummary,
        attributionMode,
      });
      setProfileConfirmed(true);
      setStatusMessage("Knowledge areas confirmed. Private Deep Memory and chats remain strictly excluded.");
      const matchRes = await fetchHiveMindMatches().catch(() => null);
      if (matchRes?.matches) setMatches(matchRes.matches);
    } catch (error) {
      setErrorMessage(error?.message || "Could not save profile.");
    }
  };

  const handleStartInterview = async (modelId = selectedModelId) => {
    setErrorMessage("");
    setStatusMessage("");
    setRedactedPending("");
    try {
      const res = await startHiveMindInterview({
        modelId,
        relationship,
        noMnpiAttested,
        noNdaViolationAttested: noNdaAttested,
      });
      if (!res?.ok) {
        setErrorMessage(res?.reason || res?.error || "Interview blocked by attestation gate.");
        return;
      }
      setActiveInterview(res.interview);
      setMessages([res.agentMessage]);
      setTab("interview");
      setStatusMessage(`Started ${res.interview.accessTier === "member" ? "Member" : "Public-Safe"} interview on ${res.interview.ticker}.`);
    } catch (error) {
      setErrorMessage(error?.message || "Failed to start interview.");
    }
  };

  const handleSendMessage = async (confirmRedacted = false) => {
    if (!activeInterview) return;
    const textToSend = confirmRedacted ? redactedPending : draftMessage;
    if (!textToSend.trim()) return;
    setErrorMessage("");
    setStatusMessage("");
    try {
      const res = await sendHiveMindInterviewMessage({
        interviewId: activeInterview.id,
        message: textToSend,
        confirmRedacted,
      });
      if (res?.decision === "refuse") {
        setDraftMessage("");
        setRedactedPending("");
        setErrorMessage(`${res.message} (Audit hash: ${res.audit?.saltedSha256?.slice(0, 16)}...)`);
        return;
      }
      if (res?.decision === "redact" && res.requiresConfirmation) {
        setRedactedPending(res.redactedPreview);
        setStatusMessage(res.message);
        return;
      }
      setMessages((prev) => [
        ...prev,
        { role: "user", phase: activeInterview.phase, content: textToSend },
        res.agentMessage,
      ]);
      setActiveInterview((prev) => ({
        ...prev,
        phase: res.phase,
        triangulationScore: res.triangulationScore,
      }));
      setDraftMessage("");
      setRedactedPending("");
    } catch (error) {
      setErrorMessage(error?.message || "Failed to send message.");
    }
  };

  const handleSubmitClaim = async (event) => {
    event.preventDefault();
    if (!activeInterview) return;
    setErrorMessage("");
    setStatusMessage("");
    try {
      const clientSignature = await signClaimPayloadClient({
        accountId,
        modelId: activeInterview.modelId,
        claimText,
        stance: claimStance,
        signerKey: `pk_${accountId || "anon"}`,
      });
      const res = await submitHiveMindClaim({
        interviewId: activeInterview.id,
        claimText,
        infoType: selectedInfoTypes[0] || "public_data_analyst",
        stance: claimStance,
        evidenceMechanism: claimEvidence,
        checkable: claimCheckable,
        checkEventDate: claimCheckDate,
        checkEventDescription: claimCheckDesc,
        attributionMode,
        clientSignature,
      });
      if (!res?.ok) {
        setErrorMessage(res?.message || res?.error || "Claim rejected.");
        return;
      }
      setClaimText("");
      setClaimEvidence("");
      setStatusMessage(`Claim ${res.claim.id} signed, clustered (${res.cluster.consensusStatus}), and queued as proposal ${res.proposalId}.`);
      loadData();
    } catch (error) {
      setErrorMessage(error?.message || "Claim submission failed.");
    }
  };

  const handleDecideProposal = async (proposalId, decision) => {
    setErrorMessage("");
    setStatusMessage("");
    try {
      const res = await decideHiveMindProposal({ proposalId, decision });
      if (res?.ok) {
        setStatusMessage(`Proposal ${proposalId} marked ${res.proposal.status}.`);
        loadData();
      }
    } catch (error) {
      setErrorMessage(error?.message || "Proposal decision failed.");
    }
  };

  return (
    <section className="hm-shell">
      <header className="hm-header">
        <div>
          <h2>Information Hive Mind</h2>
          <p className="hm-muted">
            Covered crypto protocols &amp; perp-backed megacap equities · Zero-retention MNPI firewall · Accelerated alpha rewards.
          </p>
        </div>
        <nav className="hm-tabs" aria-label="Information Hive Mind sections">
          {[
            ["coverage", "Coverage & Matches"],
            ["interview", "Company Agent"],
            ["proposals", "Proposals & Insights"],
            ["roi", "Alpha & ROI"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`hm-tab ${tab === id ? "is-active" : ""}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {statusMessage ? <div className="hm-banner is-ok">{statusMessage}</div> : null}
      {errorMessage ? <div className="hm-banner is-error">{errorMessage}</div> : null}

      {tab === "coverage" ? (
        <div className="hm-grid">
          <form className="hm-card" onSubmit={handleConfirmProfile}>
            <h3>1. Confirm Knowledge Areas</h3>
            <p className="hm-muted">
              Only confirmed areas and your approved summary reach company agents — never Deep Memory or private chat.
            </p>
            <label className="hm-field">
              <span>Knowledge tags (comma-separated)</span>
              <input value={areasInput} onChange={(e) => setAreasInput(e.target.value)} />
            </label>
            <div className="hm-chips">
              {INFO_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={`hm-chip ${selectedInfoTypes.includes(type) ? "is-selected" : ""}`}
                  onClick={() => toggleInfoType(type)}
                >
                  {type}
                </button>
              ))}
            </div>
            <label className="hm-field">
              <span>Approved public summary</span>
              <textarea rows={2} value={approvedSummary} onChange={(e) => setApprovedSummary(e.target.value)} />
            </label>
            <label className="hm-field">
              <span>Attribution (pseudonyms hidden from public Hub, known to Task Node ops in v1)</span>
              <select value={attributionMode} onChange={(e) => setAttributionMode(e.target.value)}>
                <option value="pseudonym">Verified Pseudonym</option>
                <option value="handle">Real Handle</option>
                <option value="hive_identity">Minted Pillar 6 Identity</option>
              </select>
            </label>
            <button type="submit" className="hm-btn">
              {profileConfirmed ? "Update Confirmed Areas" : "Confirm Areas & Activate Matching"}
            </button>
          </form>

          <div className="hm-card">
            <h3>2. Covered Universe ({coverage.length}) &amp; Matches ({matches.length})</h3>
            <div className="hm-list">
              {(matches.length > 0 ? matches : coverage).map((item) => {
                const modelId = item.modelId || item.model_id;
                const assetClass = item.assetClass || item.asset_class;
                return (
                  <div key={modelId} className="hm-row">
                    <div>
                      <strong>{item.ticker}</strong> · {item.name}
                      <div className="hm-muted">
                        {assetClass} {item.score ? `· Match ${item.score}` : ""} {item.accessTier ? `· ${item.accessTier}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="hm-btn-secondary"
                      onClick={() => {
                        setSelectedModelId(modelId);
                        setTab("interview");
                      }}
                    >
                      Ask Agent
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {tab === "interview" ? (
        <div className="hm-grid">
          <div className="hm-card">
            <h3>Pre-Interview MNPI &amp; Relationship Attestation</h3>
            <label className="hm-field">
              <span>Covered Asset</span>
              <select value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value)}>
                {coverage.map((a) => (
                  <option key={a.model_id} value={a.model_id}>{a.ticker} — {a.name} ({a.asset_class})</option>
                ))}
              </select>
            </label>
            <label className="hm-field">
              <span>Relationship Declaration</span>
              <select value={relationship} onChange={(e) => setRelationship(e.target.value)}>
                {RELATIONSHIPS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </label>
            <label className="hm-check">
              <input type="checkbox" checked={noMnpiAttested} onChange={(e) => setNoMnpiAttested(e.target.checked)} />
              <span>I attest I will share ZERO material non-public or insider information.</span>
            </label>
            <label className="hm-check">
              <input type="checkbox" checked={noNdaAttested} onChange={(e) => setNoNdaAttested(e.target.checked)} />
              <span>I attest I am not violating any NDA or employer/client confidentiality duty.</span>
            </label>
            <button type="button" className="hm-btn" onClick={() => handleStartInterview(selectedModelId)}>
              Start Two-Phase Interview
            </button>
          </div>

          <div className="hm-card">
            <h3>Company Agent {activeInterview ? `(${activeInterview.ticker} · ${activeInterview.phase})` : ""}</h3>
            <div className="hm-transcript">
              {messages.map((m, idx) => (
                <div key={idx} className={`hm-msg is-${m.role}`}>
                  <span className="hm-msg-role">{m.role === "agent" ? "Agent" : "You"} · {m.phase}</span>
                  <p>{m.content}</p>
                </div>
              ))}
            </div>
            {redactedPending ? (
              <div className="hm-redact-box">
                <p><strong>Redacted Preview:</strong> {redactedPending}</p>
                <button type="button" className="hm-btn" onClick={() => handleSendMessage(true)}>Confirm Redacted Send</button>
              </div>
            ) : null}
            <div className="hm-composer">
              <textarea
                rows={2}
                placeholder="Share verifiable public or market-participant observations only..."
                value={draftMessage}
                onChange={(e) => setDraftMessage(e.target.value)}
                disabled={!activeInterview}
              />
              <button type="button" className="hm-btn" onClick={() => handleSendMessage(false)} disabled={!activeInterview}>
                Send
              </button>
            </div>
          </div>

          {activeInterview ? (
            <form className="hm-card hm-span-2" onSubmit={handleSubmitClaim}>
              <h3>Submit Client-Signed Claim</h3>
              <div className="hm-form-row">
                <label className="hm-field">
                  <span>Stance</span>
                  <select value={claimStance} onChange={(e) => setClaimStance(e.target.value)}>
                    <option value="confirms">Confirms</option>
                    <option value="refines">Refines</option>
                    <option value="challenges">Challenges (Contrarian)</option>
                  </select>
                </label>
                <label className="hm-field">
                  <span>Check Event Date (YYYY-MM-DD)</span>
                  <input value={claimCheckDate} onChange={(e) => setClaimCheckDate(e.target.value)} placeholder="2026-12-15" />
                </label>
                <label className="hm-field">
                  <span>Public Check Event</span>
                  <input value={claimCheckDesc} onChange={(e) => setClaimCheckDesc(e.target.value)} placeholder="Q4 earnings / on-chain release" />
                </label>
              </div>
              <label className="hm-field">
                <span>Structured Claim</span>
                <textarea rows={2} value={claimText} onChange={(e) => setClaimText(e.target.value)} required />
              </label>
              <label className="hm-field">
                <span>Public Evidence / Mechanism</span>
                <textarea rows={2} value={claimEvidence} onChange={(e) => setClaimEvidence(e.target.value)} required />
              </label>
              <label className="hm-check">
                <input type="checkbox" checked={claimCheckable} onChange={(e) => setClaimCheckable(e.target.checked)} />
                <span>Checkable against dated public event (eligible for 2x–5x accelerated alpha bonus)</span>
              </label>
              <button type="submit" className="hm-btn">Sign &amp; Submit Claim</button>
            </form>
          ) : null}
        </div>
      ) : null}

      {tab === "proposals" ? (
        <div className="hm-grid">
          <div className="hm-card">
            <h3>Model-Owner Approval Queue ({proposals.length})</h3>
            {proposals.length === 0 ? <p className="hm-muted">No pending or applied proposals yet.</p> : null}
            {proposals.map((p) => (
              <div key={p.id} className="hm-row">
                <div>
                  <strong>{p.modelId}</strong> · <code>{p.status}</code>
                  <div className="hm-muted">{p.changelogEntry}</div>
                </div>
                {["pending", "escalated_operator"].includes(p.status) ? (
                  <div className="hm-actions">
                    <button type="button" className="hm-btn-secondary" onClick={() => handleDecideProposal(p.id, "approve")}>Approve</button>
                    <button type="button" className="hm-btn-secondary" onClick={() => handleDecideProposal(p.id, "reject")}>Reject</button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="hm-card">
            <h3>Verified Contributor Insights ({insights.length})</h3>
            {insights.length === 0 ? <p className="hm-muted">Applied CHANGELOG citations appear here automatically.</p> : null}
            {insights.map((ins) => (
              <div key={ins.proposalId} className="hm-row">
                <div>
                  <strong>{ins.modelId}</strong> · {ins.consensusStatus} ({ins.corroboratingContributors} contributor(s))
                  <div className="hm-muted">{ins.changelogEntry}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {tab === "roi" ? (
        <div className="hm-card">
          <h3>Accelerated Alpha Rewards &amp; Operator ROI</h3>
          {!roi ? <p className="hm-muted">Sign in to inspect Hive Mind ROI metrics.</p> : (
            <div className="hm-metrics">
              <div className="hm-metric"><span>Total Spend</span><strong>${roi.spend.totalSpendUsd} ({roi.spend.totalSpendPft} PFT)</strong></div>
              <div className="hm-metric"><span>Acceptance Rate</span><strong>{Math.round(roi.efficiency.acceptanceRate * 100)}%</strong></div>
              <div className="hm-metric"><span>Verification Rate</span><strong>{Math.round(roi.efficiency.verificationRate * 100)}%</strong></div>
              <div className="hm-metric"><span>Cost / Verified Insight</span><strong>${roi.efficiency.costPerVerifiedInsightUsd}</strong></div>
              <div className="hm-metric"><span>Avg Alpha Multiplier</span><strong>{roi.efficiency.avgAlphaMultiplier}x</strong></div>
              <div className="hm-metric"><span>Forecast Accuracy Delta</span><strong>{roi.efficiency.avgForecastAccuracyDelta}</strong></div>
              <div className="hm-metric"><span>MNPI Hash-Only Refusals</span><strong>{roi.totals.mnpiRefusalsLoggedHashOnly}</strong></div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
