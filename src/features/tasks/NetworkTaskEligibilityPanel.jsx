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
  const details = [
    blocker.kindLabel,
    blocker.state,
    blocker.taskId,
    blocker.rewardLabel,
    blocker.acceptByDisplay ? `Accept by ${blocker.acceptByDisplay}` : "",
    blocker.deadlineDisplay ? `Deadline ${blocker.deadlineDisplay}` : "",
    blocker.accountScoped ? "account-wide" : `wallet ${blocker.scopeLabel}`,
  ].filter(Boolean);
  return (
    <li>
      <b>{blocker.title}</b>
      <small>{details.join(" · ")}</small>
    </li>
  );
}

export function NetworkTaskEligibilityPanel({ activeTask = null, networkTasks = null, onOpenActiveTask = null }) {
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
              {activeTask && typeof onOpenActiveTask === "function" && (
                <div className="net-elig-actions">
                  <button onClick={onOpenActiveTask} type="button">
                    Open active Network task
                  </button>
                  <small>Submit evidence or close the blocker from the task detail.</small>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
