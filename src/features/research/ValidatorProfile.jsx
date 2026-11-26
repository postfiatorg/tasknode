import { useEffect, useState } from "react";
import { Server, ArrowUpRight } from "lucide-react";
import { researchRequest } from "./research-client.js";
import { validatorDate, validatorNetworkLabel } from "../../../shared/validator-display.js";
import { EligibilityProgress } from "./ValidatorRewards.jsx";

export function ValidatorProfileBanner({ session }) {
  const accountId = session?.accountId;
  const bindings = session?.validator?.bindings || [];
  const membership = JSON.stringify(bindings);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (accountId && bindings.length) {
      researchRequest("/api/validators").then(status => {
        if (active) { setSaved({ accountId, membership, status }); setError(""); }
      }).catch(() => { if (active) setError("Participation history is temporarily unavailable."); });
    }
    return () => { active = false; };
  }, [accountId, membership, bindings.length]);
  if (!bindings.length) return null;
  const status = saved?.accountId === accountId && saved?.membership === membership ? saved.status : null;
  return <section className="validator-profile-banner" aria-label="Your validators">
    <header><h2><Server size={20} aria-hidden="true" /> You are a validator</h2><a href="#settings/validator">Rewards & settings <ArrowUpRight size={14} /></a></header>
    {status ? status.bindings.map(binding => <div className="validator-profile-binding" key={binding.id}>
      <strong>{validatorNetworkLabel(binding.network)} · linked {validatorDate(binding.bound_at)}</strong>
      <code>{binding.validator_id || binding.master_public_key}</code><EligibilityProgress eligibility={binding.eligibility} />
    </div>) : <p>{error || "Loading your validator participation…"}</p>}
  </section>;
}

export function ValidatorProfileCard({ bindings = [] }) {
  return <a className="pf-badge validator-profile-card" href="#settings/validator">
    <span className="pf-badge-icon"><Server size={18} aria-hidden="true" /></span><div>
      <div className="pf-badge-title"><strong>Validator</strong><span className={`pf-badge-status${bindings.length ? " is-active" : ""}`}>{bindings.length ? "Connected" : "Connect"}</span></div>
      <p>Link your validator. Earn $20/month in Task Node credit when eligible.</p>
    </div><ArrowUpRight size={16} aria-hidden="true" />
  </a>;
}
