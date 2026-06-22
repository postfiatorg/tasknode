import React, { useEffect, useState } from "react";

import { networkTaskEligibilityView } from "./network-task-eligibility-state.js";
import "./network-task-eligibility.css";

function GateRow({ gate, isFirstFailing }) {
  const markClass = gate.passed ? "is-pass" : gate.waiting ? "is-wait" : "is-fail";
  return (
    <li className={`net-elig-gate ${markClass}`}>
      <span aria-hidden="true" className="net-elig-gate-mark">
        {gate.passed ? "✓" : gate.waiting ? "·" : "✕"}
      </span>
      <span>
        <b>{gate.label}</b>
        {gate.detail && <small>{gate.detail}</small>}
        {isFirstFailing && gate.action && (
          <small className="net-elig-gate-next">Next: {gate.action}</small>
        )}
      </span>
    </li>
  );
}

function BlockerRow({ blocker }) {
  return (
    <li>
      <b>{blocker.title}</b>
      <small>
        {blocker.kindLabel} · {blocker.state} · {blocker.accountScoped ? "account-wide" : `wallet ${blocker.scopeLabel}`}
      </small>
    </li>
  );
}

export function NetworkTaskEligibilityPanel({ networkTasks = null }) {
  const view = networkTaskEligibilityView(networkTasks);
  const [open, setOpen] = useState(false);

  // Eligibility details are intentionally disclosure-only; status changes
  // should not auto-open the checklist.
  useEffect(() => {
    setOpen(false);
  }, [view.status]);

  const firstFailingGateId = view.gates.find((gate) => gate.failing)?.id || "";
  const hasDetails = !view.loading && Boolean(
    view.explanation ||
    view.error ||
    view.gates.length ||
    view.blockers.length
  );

  return (
    <section aria-label="Network Task eligibility" className={`net-elig net-elig--${view.tone}`}>
      <div className="net-elig-line">
        <span aria-hidden="true" className="net-elig-dot" />
        <span className="net-elig-label">{view.plainLabel}</span>
        {view.walletAddress && (
          <span className="net-elig-meta">· routing {view.walletLabel}</span>
        )}
        {view.badge?.laneLabel && (
          <span className="net-elig-meta">· {view.badge.laneLabel}</span>
        )}
        {!view.eligible && view.nextAction && (
          <span className="net-elig-next">· {view.nextAction}</span>
        )}
        {hasDetails && (
          <button
            aria-expanded={open}
            className="net-elig-toggle"
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            {open ? "Hide" : "Details"}
          </button>
        )}
      </div>

      {open && (
        <div className="net-elig-details">
          {view.explanation && <p className="net-elig-explain">{view.explanation}</p>}
          {view.error && <p className="net-elig-explain net-elig-error">{view.error}</p>}

          {view.gates.length > 0 && (
            <ul className="net-elig-gates">
              {view.gates.map((gate) => (
                <GateRow gate={gate} isFirstFailing={gate.id === firstFailingGateId} key={gate.id || gate.label} />
              ))}
            </ul>
          )}

          {view.blockers.length > 0 && (
            <div className="net-elig-blockers">
              <span className="net-elig-eyebrow">Capacity blockers</span>
              <ul>
                {view.blockers.map((blocker, index) => (
                  <BlockerRow blocker={blocker} key={`${blocker.key}-${index}`} />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
