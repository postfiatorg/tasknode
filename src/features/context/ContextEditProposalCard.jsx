import React from "react";
import { Check, Pencil, X } from "lucide-react";
import "./context-edit.css";

function operationLabel(value = "") {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function lineLabel(proposal = {}) {
  if (proposal.lineStart && proposal.lineEnd) return `Lines ${proposal.lineStart}-${proposal.lineEnd}`;
  if (proposal.lineStart) return `Line ${proposal.lineStart}`;
  if (proposal.targetHeading) return proposal.targetHeading;
  return proposal.anchorType || "Document";
}

function ProposalText({ label, value }) {
  if (!value) return null;
  return (
    <div className="context-edit-proposal-text">
      <span>{label}</span>
      <pre>{value}</pre>
    </div>
  );
}

export function ContextEditProposalCard({
  error = "",
  onApply,
  onReject,
  onRevise,
  proposal = null,
  saving = false,
}) {
  if (!proposal) return null;
  const state = proposal.state || "pending";
  const applied = state === "applied";
  const rejected = state === "rejected";
  const stale = state === "stale";

  return (
    <section className={`context-edit-proposal-card is-${state}`} aria-label="Context edit proposal">
      <header>
        <div>
          <span className="context-edit-eyebrow">Context Edit</span>
          <strong>{operationLabel(proposal.operation)}</strong>
        </div>
        <span className="context-edit-lines">{lineLabel(proposal)}</span>
      </header>
      {proposal.rationale && <p className="context-edit-rationale">{proposal.rationale}</p>}
      <div className="context-edit-proposal-grid">
        <ProposalText label="Current" value={proposal.targetBefore} />
        <ProposalText label="Suggested" value={proposal.targetAfter} />
      </div>
      {error && <p className="context-edit-error">{error}</p>}
      {applied && (
        <p className="context-edit-state">
          Saved as revision {proposal.savedContextRevision || "updated"}.
        </p>
      )}
      {rejected && <p className="context-edit-state">Rejected. The context document was not changed.</p>}
      {stale && <p className="context-edit-state">Stale. Regenerate against the latest context document.</p>}
      {!applied && !rejected && !stale && (
        <footer>
          <button className="context-edit-primary" disabled={saving} onClick={() => onApply?.(proposal)} type="button">
            <Check size={15} strokeWidth={2} />
            {saving ? "Saving" : "Accept edit"}
          </button>
          <button disabled={saving} onClick={() => onRevise?.(proposal)} type="button">
            <Pencil size={14} strokeWidth={1.8} />
            Revise
          </button>
          <button disabled={saving} onClick={() => onReject?.(proposal)} type="button">
            <X size={15} strokeWidth={1.8} />
            Reject
          </button>
        </footer>
      )}
    </section>
  );
}
