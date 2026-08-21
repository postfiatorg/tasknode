import { useEffect, useState } from "react";
import { ArrowUpRight, Check, Copy, Flag, X } from "lucide-react";
import { requestJson } from "../../api";
import { transactionExplorerHref } from "../../pftl-explorer.js";
import {
  HIVE_TASK_LIFECYCLE,
  HiveProfileBadge,
  MachineOperatorBadge,
  hasReviewContent,
  hiveTaskLabel,
  hiveTaskLifecycleIndex,
  hiveTaskTone,
  mergeHiveTaskDetail,
  profileHref,
  shortPublicReference,
} from "./HiveProjectPanels.jsx";
import { actionLabel, compactWallet, formatPft, taskNextAction } from "./hive-view-utils.jsx";

export function HiveTaskPopout({ initialTask, onClose, pftlExplorerUrl = "" }) {
  const [mounted, setMounted] = useState(false);
  const [copiedValue, setCopiedValue] = useState("");
  const [loadStatus, setLoadStatus] = useState("loading");
  const [task, setTask] = useState(() => mergeHiveTaskDetail(initialTask));

  useEffect(() => {
    setTask(mergeHiveTaskDetail(initialTask));
    setLoadStatus(initialTask?.taskId ? "loading" : "error");
  }, [initialTask]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setMounted(true));
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    async function loadDetail() {
      if (!initialTask?.taskId) return;
      try {
        const result = await requestJson(`/api/hive/task-detail?taskId=${encodeURIComponent(initialTask.taskId)}`);
        if (cancelled) return;
        if (!result.ok) {
          setLoadStatus("error");
          return;
        }
        setTask(mergeHiveTaskDetail(initialTask, result.body));
        setLoadStatus("ready");
      } catch {
        if (!cancelled) setLoadStatus("error");
      }
    }
    loadDetail();
    return () => {
      cancelled = true;
    };
  }, [initialTask]);

  const reached = hiveTaskLifecycleIndex(task.state);
  const tone = hiveTaskTone(task.state);
  const assignee = task.assignee || null;
  const canLinkAssignee = Boolean(assignee?.accountId && assignee?.hasPublicProfile);
  const OperatorTag = canLinkAssignee ? "a" : "div";
  const operatorProps = canLinkAssignee
    ? {
        href: profileHref(assignee.accountId),
        "aria-label": `Open ${assignee.codename || compactWallet(assignee.wallet)} public profile`,
      }
    : {};
  const review = task.review || null;
  const submissions = Array.isArray(review?.submissions) ? review.submissions : [];
  const evidence = Array.isArray(review?.evidence) ? review.evidence : [];
  const evaluationPackets = Array.isArray(task.evaluationPackets) ? task.evaluationPackets : [];
  const verification = review?.verification || {};
  const outcome = review?.outcome || {};
  const timeline = Array.isArray(task.timeline) && task.timeline.length
    ? task.timeline
    : [{
        action: task.state,
        label: task.nextAction || taskNextAction(task.state),
        time: task.age || "",
        txHash: "",
        cid: "",
      }];
  const rewardEvent = [...timeline].reverse().find((event) =>
    String(event?.action || "").toLowerCase().includes("reward") ||
    String(event?.label || "").toLowerCase().includes("reward")
  ) || {};
  const rewardTxHash = outcome.paymentTxHash || task.proofTxHash || rewardEvent.txHash || "";
  const rewardCid = outcome.paymentCid || task.proofCid || rewardEvent.cid || "";
  const rewardHref = transactionExplorerHref(rewardTxHash, pftlExplorerUrl);

  function copyValue(name, value) {
    const text = String(value || "").trim();
    if (!text) return;
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedValue(name);
    window.setTimeout(() => setCopiedValue((current) => (current === name ? "" : current)), 1400);
  }

  function copyId() {
    copyValue("task-id", task.taskId || task.id);
  }

  return (
    <div className="htp-layer">
      <div className={`htp-wash${mounted ? " is-mounted" : ""}`} onClick={onClose} role="presentation" />
      <section
        aria-labelledby="htp-title"
        aria-modal="true"
        className={`htp-modal${mounted ? " is-mounted" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="htp-header">
          <span className="htp-kicker">
            <Flag size={11} strokeWidth={1.9} />
            {task.kind}
            <i>·</i>
            <span className="htp-kicker-project">{task.project?.name || "Hive project"}</span>
          </span>
          <button className="htp-close" onClick={onClose} type="button">
            <X size={14} strokeWidth={1.8} />
            Close
          </button>
        </header>

        <div className="htp-body">
          <h2 id="htp-title">{task.title}</h2>
          <button className="htp-id" onClick={copyId} type="button">
            {task.taskId || task.id}
            {copiedValue === "task-id" ? <Check size={11} strokeWidth={1.9} /> : <Copy size={11} strokeWidth={1.7} />}
          </button>

          <ol aria-label="Task lifecycle" className="htp-stepper">
            {HIVE_TASK_LIFECYCLE.map((step, index) => {
              const status = index < reached ? "done" : index === reached ? "current" : "todo";
              return (
                <li className={`htp-step is-${status}`} key={step.key}>
                  <span className="htp-step-dot" />
                  <span className="htp-step-label">{step.label}</span>
                  {index < HIVE_TASK_LIFECYCLE.length - 1 && <span className="htp-step-bar" />}
                </li>
              );
            })}
          </ol>

          <div className="htp-stats">
            <div>
              <small>Reward</small>
              <span className="htp-reward">{formatPft(task.pft)}<em>PFT</em></span>
            </div>
            <div>
              <small>Status</small>
              <span className={`htp-state is-${tone}`}>
                <i /> {hiveTaskLabel(task.state)}
              </span>
            </div>
            <div>
              <small>Project</small>
              <span>{task.project?.type || "network"}</span>
            </div>
            <div>
              <small>Last event</small>
              <span>{task.age || (loadStatus === "loading" ? "Loading" : "Indexed")}</span>
            </div>
          </div>

          <section className="htp-section">
            <h3>Routed to</h3>
            {assignee ? (
              <OperatorTag className={`htp-operator${canLinkAssignee ? " is-link" : ""}`} {...operatorProps}>
                <HiveProfileBadge nft={assignee.nft} size={34} variant={assignee.badge} />
                <span className="htp-operator-copy">
                  <strong>{assignee.codename || compactWallet(assignee.wallet)}</strong>
                  <small>{assignee.handle ? `@${assignee.handle} · ` : ""}{compactWallet(assignee.wallet)}</small>
                  <MachineOperatorBadge disclosure={assignee.operatorDisclosure} />
                </span>
                {canLinkAssignee && <ArrowUpRight className="htp-operator-go" size={15} strokeWidth={1.8} />}
              </OperatorTag>
            ) : (
              <div className="htp-operator is-empty">
                <em>Unassigned — open for routing</em>
              </div>
            )}
          </section>

          <section className="htp-section">
            <h3>About this task</h3>
            <p className="htp-summary">{task.summary || task.description || "No public summary has been indexed for this Hive task yet."}</p>
            {task.nextAction && (
              <p className="htp-next"><span>Next</span>{task.nextAction}</p>
            )}
            {loadStatus === "error" && (
              <p className="htp-load-note">The public task-detail projection could not be loaded. Showing the Hive snapshot.</p>
            )}
          </section>

          {hasReviewContent(review) && (
            <section className="htp-section">
              <h3>Work &amp; review</h3>
              <div className="htp-review">
                {submissions.map((submission, index) => (
                  <div className="htp-review-row" key={`${submission.type || "submission"}-${index}`}>
                    <span className="htp-review-tag">{submission.type || "Submission"}</span>
                    <p>{submission.summary}</p>
                  </div>
                ))}
                {evidence.map((item, index) => (
                  <div className="htp-review-row" key={`${item.schema || item.type || "evidence"}-${item.cid || item.txHash || index}`}>
                    <span className="htp-review-tag">{item.type || "Evidence"}</span>
                    {item.excerpt && <p>{item.excerpt}</p>}
                    {item.privateContentHidden && <p className="htp-review-note">Private or encrypted content hidden.</p>}
                    {Array.isArray(item.artifactRefs) && item.artifactRefs.length > 0 && (
                      <div className="htp-review-artifacts">
                        {item.artifactRefs.slice(0, 5).map((artifact, artifactIndex) => (
                          <code key={`${artifact.type || "artifact"}-${artifact.cid || artifact.txHash || artifact.url || artifactIndex}`}>
                            {artifact.type || "artifact"}
                            {artifact.label ? ` · ${artifact.label}` : ""}
                            {artifact.url ? ` · ${shortPublicReference(artifact.url)}` : ""}
                            {artifact.cid ? ` · cid ${shortPublicReference(artifact.cid)}` : ""}
                            {artifact.txHash ? ` · tx ${shortPublicReference(artifact.txHash)}` : ""}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {(verification.request || verification.response) && (
                  <div className="htp-review-row is-verify">
                    <span className="htp-review-tag">Verification</span>
                    {verification.request && <p><strong>Asked.</strong> {verification.request}</p>}
                    {verification.response && <p><strong>Answered.</strong> {verification.response}</p>}
                  </div>
                )}
                {(outcome.decision || outcome.reason || Number(outcome.rewardPft || 0)) && (
                  <div className="htp-review-outcome">
                    <span>{outcome.decision || "Reward outcome"} · {formatPft(outcome.rewardPft)} PFT</span>
                    {outcome.reason && <p>{outcome.reason}</p>}
                    {(rewardTxHash || rewardCid) && (
                      <div className="htp-proof-card">
                        <strong>Reward proof</strong>
                        {rewardTxHash && <code title={rewardTxHash}>tx {rewardTxHash}</code>}
                        {rewardCid && <code title={rewardCid}>cid {rewardCid}</code>}
                        <div>
                          {rewardTxHash && (
                            <button onClick={() => copyValue("reward-tx", rewardTxHash)} type="button">
                              {copiedValue === "reward-tx" ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
                              Copy tx
                            </button>
                          )}
                          {rewardHref && (
                            <a href={rewardHref} rel="noreferrer" target="_blank">
                              <ArrowUpRight size={12} strokeWidth={1.8} />
                              Open tx
                            </a>
                          )}
                          {rewardCid && (
                            <button onClick={() => copyValue("reward-cid", rewardCid)} type="button">
                              {copiedValue === "reward-cid" ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
                              Copy CID
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {evaluationPackets.length > 0 && (
            <section className="htp-section">
              <h3>Evidence evaluation</h3>
              <div className="htp-review">
                {evaluationPackets.slice(0, 3).map((packet) => (
                  <div className="htp-review-row" key={packet.id || `${packet.taskId}-${packet.updatedAt}`}>
                    <span className="htp-review-tag">{packet.packetStatus || "Packet"}</span>
                    <p>{packet.summary}</p>
                    {packet.recommendation && <p><strong>Next.</strong> {packet.recommendation}</p>}
                    {Array.isArray(packet.artifactVerdicts) && packet.artifactVerdicts.length > 0 && (
                      <div className="htp-review-artifacts">
                        {packet.artifactVerdicts.slice(0, 4).map((verdict, index) => (
                          <code key={`${verdict.status || "verdict"}-${verdict.label || index}`}>
                            {verdict.status || "unknown"} · {verdict.label || verdict.artifactType || "artifact"}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="htp-section">
            <h3>Timeline</h3>
            <ul className="htp-timeline">
              {timeline.map((event, index) => (
                <li className={`htp-tl-row is-${hiveTaskTone(event.action)}`} key={`${event.action || "event"}-${event.time || index}`}>
                  <span className="htp-tl-dot" />
                  <span className="htp-tl-copy">
                    <span className="htp-tl-label">{event.label || actionLabel(event.action)}</span>
                    {(event.txHash || event.cid) && (
                      <span className="htp-tl-meta">
                        {event.txHash && <code>tx {shortPublicReference(event.txHash)}</code>}
                        {event.cid && <code>cid {shortPublicReference(event.cid)}</code>}
                      </span>
                    )}
                  </span>
                  <time>{event.time}</time>
                </li>
              ))}
            </ul>
          </section>

          <footer className="htp-foot">
            <p>Public network-task record. Operators are routed by the Board Manager; this view is read-only.</p>
          </footer>
        </div>
      </section>
    </div>
  );
}
