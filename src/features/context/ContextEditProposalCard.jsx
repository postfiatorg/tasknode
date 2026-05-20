import React, { useMemo, useState } from "react";
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

function splitLines(value = "") {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  return text ? text.split("\n") : [];
}

function countLabel(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function proposalTitle(proposal = {}) {
  if (proposal.targetHeading) return `Refining ${proposal.targetHeading}`;
  if (proposal.operation === "replace_document") return "Rewriting the context document";
  if (proposal.operation === "append_document") return "Adding to the context document";
  return "Sharpening this context section";
}

function DiffLine({ kind, line, number }) {
  const empty = line === "";
  return (
    <div className={`context-edit-diff-line is-${kind}${empty ? " is-empty" : ""}`}>
      <span className="context-edit-line-number">{empty ? "" : number}</span>
      <span className="context-edit-line-copy">
        {!empty && <span className="context-edit-sign">{kind === "before" ? "-" : "+"}</span>}
        <span>{line || " "}</span>
      </span>
    </div>
  );
}

function DiffPane({ kind, label, lines }) {
  if (lines.length === 0) return null;
  return (
    <section className="context-edit-diff-pane">
      <header>
        <span className={`context-edit-pane-dot is-${kind}`} />
        <strong>{label}</strong>
        <small>{countLabel(lines.length, "line")}</small>
      </header>
      <div className="context-edit-diff-lines">
        {lines.map((line, index) => (
          <DiffLine kind={kind} key={`${kind}-${index}-${line}`} line={line} number={index + 1} />
        ))}
      </div>
    </section>
  );
}

function ModeTab({ active, children, onClick }) {
  return (
    <button
      aria-pressed={active}
      className={active ? "is-active" : ""}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
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
  const [mode, setMode] = useState("side");
  const safeProposal = proposal || {};
  const state = safeProposal.state || "pending";
  const applied = state === "applied";
  const rejected = state === "rejected";
  const stale = state === "stale";
  const beforeLines = useMemo(() => splitLines(safeProposal.targetBefore), [safeProposal.targetBefore]);
  const afterLines = useMemo(() => splitLines(safeProposal.targetAfter), [safeProposal.targetAfter]);
  const showBefore = beforeLines.length > 0 && mode !== "after";
  const showAfter = afterLines.length > 0;
  const canSideBySide = beforeLines.length > 0 && afterLines.length > 0;
  if (!proposal) return null;

  return (
    <section className={`context-edit-proposal-card is-${state}`} aria-label="Context edit proposal">
      <header className="context-edit-card-head">
        <div>
          <span className="context-edit-eyebrow">Context Edit · {operationLabel(proposal.operation)}</span>
          <strong>{proposalTitle(proposal)}</strong>
          {proposal.rationale && <p>{proposal.rationale}</p>}
        </div>
        <div className="context-edit-card-status">
          <span>{applied ? `Revision ${proposal.savedContextRevision || "saved"}` : lineLabel(proposal)}</span>
          <small className={applied ? "is-saved" : rejected ? "is-rejected" : stale ? "is-stale" : ""}>
            {applied ? "Saved" : rejected ? "Rejected" : stale ? "Stale" : "Awaiting review"}
          </small>
        </div>
      </header>

      <div className="context-edit-pathbar">
        <span>context.md</span>
        <small>{lineLabel(proposal)}</small>
        {canSideBySide && (
          <div className="context-edit-mode-tabs">
            <ModeTab active={mode === "side"} onClick={() => setMode("side")}>Side-by-side</ModeTab>
            <ModeTab active={mode === "inline"} onClick={() => setMode("inline")}>Inline</ModeTab>
            <ModeTab active={mode === "after"} onClick={() => setMode("after")}>After only</ModeTab>
          </div>
        )}
      </div>

      <div className={`context-edit-proposal-grid is-${mode}`}>
        {showBefore && <DiffPane kind="before" label="Before - Current" lines={beforeLines} />}
        {showBefore && showAfter && mode === "side" && <div className="context-edit-divider" aria-hidden="true" />}
        {showAfter && <DiffPane kind="after" label="After - Suggested" lines={afterLines} />}
      </div>

      <div className="context-edit-summary">
        <span>What changed</span>
        {beforeLines.length > 0 && <em className="is-removed">{countLabel(beforeLines.length, "line")} removed</em>}
        {afterLines.length > 0 && <em className="is-added">{countLabel(afterLines.length, "line")} added</em>}
        {proposal.risk && <em>Risk: {proposal.risk}</em>}
        <em>{operationLabel(proposal.operation)}</em>
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
          <span>Awaiting your call.</span>
          <div>
            <button className="context-edit-ghost" disabled={saving} onClick={() => onReject?.(proposal)} type="button">
              <X size={15} strokeWidth={1.8} />
              Discard
            </button>
            <button disabled={saving} onClick={() => onRevise?.(proposal)} type="button">
              <Pencil size={14} strokeWidth={1.8} />
              Refine
            </button>
            <button className="context-edit-primary" disabled={saving} onClick={() => onApply?.(proposal)} type="button">
              <Check size={15} strokeWidth={2} />
              {saving ? "Saving" : "Accept & save"}
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}
