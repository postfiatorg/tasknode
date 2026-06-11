import React, { useEffect, useState } from "react";

import { networkTaskEligibilityView } from "./network-task-eligibility-state.js";
import "./network-task-eligibility.css";

function GateRow({ gate, isFirstFailing }) {
  const markClass = gate.passed ? "is-pass" : gate.waiting ? "is-waiting" : "is-fail";
  return (
    <li className={`network-eligibility-gate ${markClass}`}>
      <span aria-hidden="true" className="network-eligibility-gate-mark">
        {gate.passed ? "✓" : gate.waiting ? "•" : "✕"}
      </span>
      <div>
        <strong>{gate.label}</strong>
        <p>{gate.detail}</p>
        {isFirstFailing && gate.action && (
          <p className="network-eligibility-gate-action">Next: {gate.action}</p>
        )}
      </div>
    </li>
  );
}

function BlockerRow({ blocker }) {
  return (
    <li className="network-eligibility-blocker">
      <strong>{blocker.title}</strong>
      <span>
        {blocker.kindLabel} / {blocker.state} / {blocker.accountScoped ? "account-wide" : `wallet ${blocker.scopeLabel}`}
      </span>
    </li>
  );
}

export function NetworkTaskEligibilityPanel({ networkTasks = null }) {
  const view = networkTaskEligibilityView(networkTasks);
  const [expanded, setExpanded] = useState(view.expandedByDefault);
  const [expandedTouched, setExpandedTouched] = useState(false);

  // Follow the server verdict until the user toggles the panel themselves:
  // it must be visible without interaction whenever the user is not eligible.
  useEffect(() => {
    if (!expandedTouched) setExpanded(view.expandedByDefault);
  }, [expandedTouched, view.expandedByDefault]);

  const firstFailingGateId = view.gates.find((gate) => gate.failing)?.id || "";

  return (
    <section aria-label="Network Task eligibility" className={`network-eligibility-panel tone-${view.tone}`}>
      <button
        aria-expanded={expanded}
        className="network-eligibility-head"
        onClick={() => {
          setExpandedTouched(true);
          setExpanded((current) => !current);
        }}
        type="button"
      >
        <span className="network-eligibility-pill">{view.plainLabel}</span>
        <span className="network-eligibility-head-copy">
          <strong>Network Tasks</strong>
          <span>
            {view.walletAddress ? `Routing wallet ${view.walletLabel}` : view.walletLabel || "Checking routing wallet"}
          </span>
        </span>
        <span aria-hidden="true" className="network-eligibility-caret">{expanded ? "▴" : "▾"}</span>
      </button>

      {expanded && (
        <div className="network-eligibility-body">
          <p className="network-eligibility-summary">{view.explanation}</p>
          {view.error && <p className="network-eligibility-error">{view.error}</p>}
          {!view.loading && view.nextAction && !view.eligible && (
            <p className="network-eligibility-next">{view.nextAction}</p>
          )}

          {view.gates.length > 0 && (
            <ol className="network-eligibility-gates">
              {view.gates.map((gate) => (
                <GateRow gate={gate} isFirstFailing={gate.id === firstFailingGateId} key={gate.id || gate.label} />
              ))}
            </ol>
          )}

          {view.blockers.length > 0 && (
            <div className="network-eligibility-blockers">
              <strong>Capacity blockers</strong>
              <ul>
                {view.blockers.map((blocker) => (
                  <BlockerRow blocker={blocker} key={blocker.key} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
