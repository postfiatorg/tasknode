import React, { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Flag,
  Link2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { formatTaskTimestamp } from "../../../shared/task-time-format";
import { truncateCid } from "../context/context-view-utils.jsx";

function statusTone(value = "") {
  const lower = String(value || "").toLowerCase();
  if (lower.includes("reward") || lower.includes("paid") || lower.includes("accepted")) return "green";
  if (lower.includes("verification") || lower.includes("submit")) return "blue";
  if (lower.includes("proposed") || lower.includes("requested")) return "amber";
  if (lower.includes("reject") || lower.includes("refuse") || lower.includes("cancel")) return "red";
  return "neutral";
}

function schemaTag(schema = "") {
  if (schema.includes("submission") || schema.includes("verification_response")) return "Submission";
  if (schema.includes("reward")) return "Reward";
  if (schema.includes("update")) return "Update";
  return "";
}

function eventTime(event = {}) {
  return formatTaskTimestamp(event.observedAt || event.occurredAt || event.createdAt);
}

function shortStep(label = "") {
  const lower = String(label || "").toLowerCase();
  if (lower.includes("offered")) return "Offered";
  if (lower.includes("accepted")) return "Accepted";
  if (lower.includes("evidence submitted")) return "Submitted";
  if (lower.includes("verification requested")) return "V. requested";
  if (lower.includes("verification response")) return "V. response";
  if (lower.includes("decision")) return "Decided";
  if (lower.includes("paid")) return "Paid";
  if (lower.includes("refused")) return "Refused";
  return label.replace(/^Task\s+/i, "").slice(0, 14);
}

function valueFromDetails(details = [], labels = []) {
  const wanted = new Set(labels.map((label) => label.toLowerCase()));
  return details.find((detail) => wanted.has(String(detail.label || "").toLowerCase()))?.value || "";
}

function Pill({ children, tone = "neutral" }) {
  return (
    <span className={`task-forensics-pill is-${tone}`}>
      <span />
      {children}
    </span>
  );
}

function Mono({ children }) {
  if (!children) return null;
  return <code className="task-forensics-mono">{children}</code>;
}

function CopyButton({ copiedValue, name, onCopy, title = "Copy", value }) {
  const text = String(value || "");
  if (!text) return null;
  return (
    <button className="task-forensics-copy-button" onClick={() => onCopy(name, text)} title={title} type="button">
      {copiedValue === name ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
    </button>
  );
}

function ProofFooter({ copiedValue, event, index, onCopy, rawOpen, onToggleRaw }) {
  return (
    <div className="task-forensics-proof-footer">
      <Link2 size={12} strokeWidth={1.6} />
      <Mono>{truncateCid(event.cid || "")}</Mono>
      {event.cid && <CopyButton copiedValue={copiedValue} name={`event-cid-${index}`} onCopy={onCopy} value={event.cid} />}
      {event.txHash && <span aria-hidden="true">·</span>}
      <Mono>{truncateCid(event.txHash || "")}</Mono>
      {event.txHash && <CopyButton copiedValue={copiedValue} name={`event-tx-${index}`} onCopy={onCopy} value={event.txHash} />}
      {event.rawPayload && (
        <button className="task-forensics-raw-toggle" onClick={onToggleRaw} type="button">
          Raw payload {rawOpen ? <ChevronDown size={12} strokeWidth={1.6} /> : <ChevronRight size={12} strokeWidth={1.6} />}
        </button>
      )}
    </div>
  );
}

function Lifecycle({ timeline }) {
  if (!timeline.length) return null;
  return (
    <section className="task-forensics-lifecycle">
      <header>
        <span><Clock size={14} strokeWidth={1.6} />Lifecycle</span>
        <small>{timeline.length} indexed stages</small>
      </header>
      <div className="task-forensics-lifecycle-track">
        {timeline.map((event, index) => (
          <React.Fragment key={event.id || `${event.label}-${index}`}>
            <div className="task-forensics-lifecycle-step">
              <span />
              <small>{shortStep(event.label)}</small>
            </div>
            {index < timeline.length - 1 && <div className="task-forensics-lifecycle-line" />}
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}

function ProofAnchors({ copiedValue, forensics, onCopy, timeline }) {
  return (
    <section className="task-forensics-proof-card">
      <header>
        <span><ShieldCheck size={14} strokeWidth={1.6} />Proof anchors</span>
        <small>{timeline.length} events indexed</small>
      </header>
      <div>
        <TaskAuditValue copiedValue={copiedValue} label="Request bundle" name="request-cid" onCopy={onCopy} value={forensics.requestBundleCid} />
        <TaskAuditValue copiedValue={copiedValue} label="Context CID" name="context-cid" onCopy={onCopy} value={forensics.contextCid} />
        <TaskAuditValue copiedValue={copiedValue} label="Last CID" name="last-cid" onCopy={onCopy} value={forensics.lastEventCid} />
        <TaskAuditValue copiedValue={copiedValue} label="Last transaction" name="last-tx" onCopy={onCopy} value={forensics.lastEventTxHash} />
      </div>
    </section>
  );
}

function TaskForensicsIntegrityNotice({ integrity = {} }) {
  if (!integrity.projectionBehindCachedPointer) return null;
  const latest = integrity.latestCachedPointer || {};
  const projection = integrity.projectionLastEvent || {};
  return (
    <div className="task-forensics-notice is-amber">
      <strong>Projection behind chain pointer</strong>
      <p>
        The indexed projection has not caught up to the newest cached PFTL pointer yet.
        {latest.txHash || latest.cid ? " The chain cache already has a newer proof anchor than the forensics timeline shows." : ""}
        {projection.status ? ` Current projection status: ${projection.status}.` : ""}
      </p>
      {(latest.txHash || latest.cid) && (
        <div className="task-missing-schemas">
          {latest.txHash && <code>{latest.txHash}</code>}
          {latest.cid && <code>{latest.cid}</code>}
        </div>
      )}
    </div>
  );
}

function TaskForensicsNotice({ state }) {
  const missingSchemas = Array.isArray(state?.missingSchemas) ? state.missingSchemas : [];
  return (
    <div className={`task-forensics-notice is-${statusTone(state?.severity || "neutral")}`}>
      <strong>{state?.label || "Task review state"}</strong>
      {state?.body && <p>{state.body}</p>}
      {missingSchemas.length > 0 && (
        <div className="task-missing-schemas" aria-label="Missing expected schemas">
          {missingSchemas.map((schema) => <code key={schema}>{schema}</code>)}
        </div>
      )}
    </div>
  );
}

function DetailQuote({ detail, index, onCopy, copiedValue }) {
  const value = String(detail.value || "");
  if (!value) return null;
  const long = value.length > 420;
  return (
    <div className={`task-forensics-quote${long ? " is-long" : ""}`}>
      <span>{detail.label}</span>
      {long ? (
        <details>
          <summary>{value.slice(0, 260)}...</summary>
          <p>{value}</p>
        </details>
      ) : (
        <p>{value}</p>
      )}
      <button
        aria-label={`Copy ${detail.label}`}
        onClick={() => onCopy(`detail-${index}-${detail.label}`, value)}
        title={`Copy ${detail.label}`}
        type="button"
      >
        {copiedValue === `detail-${index}-${detail.label}` ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
      </button>
    </div>
  );
}

function TaskForensicsEvent({ copiedValue, event, index, onCopy }) {
  const [rawOpen, setRawOpen] = useState(false);
  const details = Array.isArray(event.details) ? event.details : [];
  const rawPayload = event.rawPayload && typeof event.rawPayload === "object" ? event.rawPayload : null;
  const transition = valueFromDetails(details, ["Transition", "Status after", "Phase", "Reward tier", "Reward paid"]);
  const tag = schemaTag(event.schema);
  const time = eventTime(event);

  return (
    <article className="task-forensics-event">
      <div className={`task-forensics-event-dot is-${statusTone(event.label || event.schema)}`}>{index + 1}</div>
      <div className="task-forensics-event-card">
        <header>
          <div>
            <strong>{event.label}</strong>
            {tag && <Pill tone={statusTone(tag)}>{tag}</Pill>}
          </div>
          <Mono>{event.schema}</Mono>
        </header>
        <div className="task-forensics-when">
          {time && <span>{time}</span>}
          {event.ledgerIndex !== null && event.ledgerIndex !== undefined && <span>Ledger {event.ledgerIndex}</span>}
          {event.memoIndex !== null && event.memoIndex !== undefined && <span>Memo {event.memoIndex}</span>}
          {event.pointerKind && <span>{event.pointerKind}</span>}
        </div>
        <p>
          {valueFromDetails(details, ["What happened"]) || event.summary || "Indexed PFTL task pointer."}
          {transition && <> <Pill tone={statusTone(transition)}>{transition}</Pill></>}
        </p>
        {details.length > 0 && (
          <div className="task-forensics-detail-list">
            {details
              .filter((detail) => String(detail.label || "").toLowerCase() !== "what happened")
              .slice(0, 8)
              .map((detail, detailIndex) => (
                <DetailQuote
                  copiedValue={copiedValue}
                  detail={detail}
                  index={`${index}-${detailIndex}`}
                  key={`${detail.label}-${detailIndex}`}
                  onCopy={onCopy}
                />
              ))}
          </div>
        )}
        <ProofFooter
          copiedValue={copiedValue}
          event={event}
          index={index}
          onCopy={onCopy}
          onToggleRaw={() => setRawOpen((open) => !open)}
          rawOpen={rawOpen}
        />
        {rawOpen && rawPayload && (
          <pre className="task-forensics-raw-payload">{JSON.stringify(rawPayload, null, 2)}</pre>
        )}
      </div>
    </article>
  );
}

function ProofIndex({ cids, copiedValue, onCopy, reducerEvents, transactions }) {
  const [open, setOpen] = useState(true);
  if (!cids.length && !transactions.length && !reducerEvents.length) return null;
  return (
    <section className="task-forensics-proof-index">
      <button onClick={() => setOpen((value) => !value)} type="button">
        <span>Full proof index</span>
        <small>
          All CIDs, transactions, and reducer events
          {open ? <ChevronDown size={12} strokeWidth={1.6} /> : <ChevronRight size={12} strokeWidth={1.6} />}
        </small>
      </button>
      {open && (
        <div className="task-forensics-proof-columns">
          {cids.length > 0 && (
            <TaskProofColumn copiedValue={copiedValue} label="CIDs · IPFS payloads" namePrefix="cid" onCopy={onCopy} rows={cids} valueKey="cid" />
          )}
          {transactions.length > 0 && (
            <TaskProofColumn copiedValue={copiedValue} label="Transactions · on-chain" namePrefix="tx" onCopy={onCopy} rows={transactions} valueKey="txHash" />
          )}
          {reducerEvents.length > 0 && (
            <div className="task-forensics-proof-column">
              <h4>Projection reducer</h4>
              <div className="task-reducer-events">
                {reducerEvents.map((event, index) => (
                  <span key={event.id || `${event.schema}-${index}`}>{event.label}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function TaskProofColumn({ copiedValue, label, namePrefix, onCopy, rows, valueKey }) {
  return (
    <div className="task-forensics-proof-column">
      <h4>{label}</h4>
      {rows.map((entry) => {
        const value = entry[valueKey];
        return (
          <TaskAuditValue
            copiedValue={copiedValue}
            key={`${entry.label}-${value}`}
            label={entry.label}
            name={`${namePrefix}-${entry.label}-${value}`}
            onCopy={onCopy}
            value={value}
          />
        );
      })}
    </div>
  );
}

function TaskAuditValue({ copiedValue, label, name, onCopy, value }) {
  const text = String(value || "");
  if (!text) return null;
  return (
    <button className="task-audit-value" onClick={() => onCopy(name, text)} type="button">
      <span>{label}</span>
      <code title={text}>{truncateCid(text)}</code>
      {copiedValue === name ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
    </button>
  );
}

export function TaskForensicsPanel({ copiedValue, detail, error, loading, onCopy }) {
  const forensics = detail?.forensics || {};
  const pointerTimeline = Array.isArray(forensics.timeline) ? forensics.timeline : [];
  const cids = Array.isArray(forensics.cids) ? forensics.cids : [];
  const transactions = Array.isArray(forensics.transactions) ? forensics.transactions : [];
  const reducerEvents = Array.isArray(forensics.reducerEvents) ? forensics.reducerEvents : [];
  const timeline = pointerTimeline.length ? pointerTimeline : reducerEvents;
  const integrity = forensics.integrity || {};
  const expectedEvents = Number(forensics.eventCount || integrity.expectedEventCount || 0);

  if (loading) {
    return (
      <div className="task-empty-panel">
        <RefreshCw size={18} strokeWidth={1.8} />
        Loading indexed task events.
      </div>
    );
  }

  if (error) {
    return (
      <div className="task-empty-panel is-error">
        <Flag size={18} strokeWidth={1.8} />
        Task detail could not be loaded: {error}
      </div>
    );
  }

  return (
    <div className="task-forensics-panel">
      <Lifecycle timeline={timeline} />
      <ProofAnchors copiedValue={copiedValue} forensics={forensics} onCopy={onCopy} timeline={timeline} />
      <TaskForensicsIntegrityNotice integrity={integrity} />
      {forensics.reviewState && <TaskForensicsNotice state={forensics.reviewState} />}
      <div className="task-forensics-note">
        <strong>How to read this</strong>
        <p>
          Each row below is a PFTL transaction pointer. CID and transaction are the on-chain proof anchors;
          readable fields come from the decrypted IPFS payload when the Task Node service key can read it.
        </p>
        <p>
          <code>TASK_UPDATE</code> is a state transition. <code>TASK_SUBMISSION</code> is initial evidence or verification evidence.
        </p>
      </div>
      <section className="task-forensics-section">
        <div className="task-forensics-section-head">
          <h3>Action timeline</h3>
          <span>{timeline.length ? `${timeline.length}${expectedEvents ? ` / ${expectedEvents}` : ""}` : expectedEvents || 0} events</span>
        </div>
        {timeline.length > 0 ? (
          <div className="task-forensics-list">
            {timeline.map((event, index) => (
              <TaskForensicsEvent
                copiedValue={copiedValue}
                event={event}
                index={index}
                key={event.id || `${event.schema}-${event.txHash}-${index}`}
                onCopy={onCopy}
              />
            ))}
          </div>
        ) : (
          <p className="task-forensics-empty">
            {expectedEvents > 0
              ? `${expectedEvents} events are counted on the projection, but no event rows were returned.`
              : "No indexed task events have been projected yet."}
          </p>
        )}
      </section>
      <ProofIndex cids={cids} copiedValue={copiedValue} onCopy={onCopy} reducerEvents={reducerEvents} transactions={transactions} />
    </div>
  );
}
