import { Server, ArrowUpRight } from "lucide-react";
import { validatorDate, validatorNetworkLabel, validatorRewardMonth } from "../../../shared/validator-display.js";
import "./validator-status.css";

export function EligibilityProgress({ eligibility }) {
  if (!eligibility) return <p>Loading participation…</p>;
  const { daysObserved, requiredDays, participation, state, nextCheckDate } = eligibility;
  const label = { on_track: "On track", building_history: "Building history", below_threshold: "Below 95%", unavailable: "History unavailable" }[state];
  return <div className="validator-eligibility">
    <strong className={`validator-state is-${state}`}>{label}</strong>
    <div className="validator-metrics">
      <div><strong>{daysObserved} / {requiredDays}</strong><span>days observed · last 30 UTC days</span>
        <progress aria-label="Observed days toward eligibility" value={Math.min(daysObserved, requiredDays)} max={requiredDays} /></div>
      <div><strong>{participation === null ? "—" : `${(participation * 100).toFixed(3)}%`}</strong><span>mean participation · 95% required</span></div>
    </div>
    <p>{eligibility.reason}</p><small>Next check: {validatorDate(nextCheckDate)} UTC</small>
  </div>;
}

export function ValidatorRewardHistory({ entries = [] }) {
  if (!entries.length) return <p className="validator-history-empty">No rewards paid yet. Eligibility is checked on the first UTC day of each month.</p>;
  return <div className="validator-history-scroll"><table className="validator-history">
    <thead><tr><th scope="col">Month</th><th scope="col">Credit</th><th scope="col">Status</th></tr></thead>
    <tbody>{entries.map((entry, index) => <tr key={entry.id || index}>
      <td>{validatorRewardMonth(entry.month)}</td><td>${Number(entry.amountUsd || 0).toFixed(2)}</td>
      <td>{entry.status === "paid" ? `Paid · ${validatorDate(entry.paidAt)}` : entry.status === "not_eligible" ? "Not eligible" : "No payment recorded"}
        {entry.reason && <small>{entry.reason}</small>}</td>
    </tr>)}</tbody>
  </table></div>;
}

export function ValidatorBindingCard({ binding }) {
  return <article className="research-card validator-reward-card" aria-label={`${validatorNetworkLabel(binding.network)} rewards`}>
    <div className="validator-card-heading"><Server size={20} aria-hidden="true" /><h3>{validatorNetworkLabel(binding.network)}</h3><span>$20 / month</span></div>
    <code className="research-wrap">{binding.validator_id || binding.master_public_key}</code>
    <small>Linked {validatorDate(binding.bound_at)} UTC</small>
    <EligibilityProgress eligibility={binding.eligibility} />
    <h4>Reward history</h4><ValidatorRewardHistory entries={binding.rewardHistory} />
    {binding.network === "l1-devnet" && <details><summary>Public validator identity</summary>
      <p>{binding.chain_id}</p><code className="research-wrap">{binding.ml_dsa_public_key}</code>
    </details>}
  </article>;
}

export function ValidatorCreditBalance({ availableCreditUsd }) {
  return <a className="validator-credit" href="#settings/billing"><div><small>Available Task Node credit</small>
    <strong>${Number(availableCreditUsd || 0).toFixed(2)}</strong></div><span>View Billing <ArrowUpRight size={15} aria-hidden="true" /></span></a>;
}
