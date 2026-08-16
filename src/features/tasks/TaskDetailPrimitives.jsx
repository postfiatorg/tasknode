import { ArrowRight, Check, ChevronDown, ChevronUp, Copy, ExternalLink } from "lucide-react";
import { transactionExplorerHref } from "../../pftl-explorer.js";
import {
  normalizeTaskStatus,
  statusSlug,
  taskLifecycleActions,
} from "../../../shared/task-lifecycle";

export function TaskStatusGlyph({ statusKey }) {
  const normalized = normalizeTaskStatus(statusKey);
  if (["refused", "rejected", "cancelled"].includes(normalized)) {
    return (
      <svg className="task-status-x" width="11" height="11" viewBox="0 0 11 11" aria-hidden="true">
        <path d="M2 2 L9 9 M9 2 L2 9" strokeLinecap="round" />
      </svg>
    );
  }
  return <span className={`task-status-glyph is-${statusSlug(normalized)}`} aria-hidden="true" />;
}

export function taskDetailCacheKey({
  accountId = "",
  linkedWalletAddress = "",
  task = {},
  taskVersion = "",
} = {}) {
  const taskId = taskIdentityKey(task);
  if (!taskId || typeof window === "undefined") return "";
  return [
    "tasknode.taskDetail.v1",
    accountId || "account",
    linkedWalletAddress || "wallet",
    taskId,
    taskVersion || "version",
  ].join(":");
}

export function cachedTaskDetailFromTask(task = {}, {
  linkedWalletAddress = "",
} = {}) {
  if (!task?.taskId && !task?.fullId && !task?.id) return null;
  return {
    ok: true,
    partial: true,
    source: "task_list_projection",
    task,
    wallets: {
      user: linkedWalletAddress || "",
      authority: task?.metadata?.authorityWallet || "",
      allocation: task?.metadata?.allocationWallet || "",
    },
    actions: taskLifecycleActions(task.statusKey || task.status),
    submission: {
      summaries: [],
      generatedTask: task?.metadata?.generatedTask || {},
      verificationPolicy: task?.verificationPolicy || task?.verification?.policy || {},
    },
    currentVerificationRequest: null,
    rewardOutcome: null,
    forensics: {
      source: task?.source || "task_list_projection",
      eventCount: Number(task?.metadata?.eventCount || 0),
      requestBundleCid: task?.requestBundleCid || "",
      contextCid: task?.contextCid || "",
      lastEventTxHash: task?.txHash || "",
      lastEventCid: "",
      cids: [],
      transactions: task?.txHash ? [{ txHash: task.txHash, label: "Latest task event" }] : [],
      timeline: [],
      pointerEvents: [],
      reducerEvents: [],
      reviewState: null,
      integrity: {
        expectedEventCount: Number(task?.metadata?.eventCount || 0),
        pointerEventCount: 0,
        reducerEventCount: 0,
        renderedEventCount: 0,
        missingTimelineRows: false,
        pendingReducerCount: 0,
        processingReducerCount: 0,
        failedReducerCount: 0,
        failedReducerExamples: [],
        latestReducerUpdatedAt: null,
        latestReducerProcessedAt: null,
        latestCachedPointer: null,
        projectionBehindCachedPointer: false,
        projectionLastEvent: {
          txHash: task?.txHash || "",
          cid: "",
          status: task?.statusKey || task?.status || "",
          eventCount: Number(task?.metadata?.eventCount || 0),
        },
      },
    },
    sync: {
      updatedAt: task?.updatedAt || null,
      lastEventAt: task?.lastEventAt || null,
      requiresRefresh: false,
      nextPollMs: null,
      refreshReason: "",
    },
  };
}

export function readCachedTaskDetail(cacheKey = "", fallback = null) {
  if (!cacheKey || typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(cacheKey) || "null");
    if (parsed?.task) return parsed;
  } catch {
    // Ignore cache parse failures; the task list projection is the fallback.
  }
  return fallback;
}

export function writeCachedTaskDetail(cacheKey = "", detail = null) {
  if (!cacheKey || !detail?.task || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(cacheKey, JSON.stringify(detail));
  } catch {
    // Detail cache is a UX optimization; actions still use server config.
  }
}

export function TaskSection({ children, last, title }) {
  return (
    <section className={last ? "task-section last" : "task-section"}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function TaskDot() {
  return <span className="task-meta-dot" aria-hidden="true">.</span>;
}

export function SectionLabel({ title, meta, action }) {
  return (
    <div className="task-section-label">
      <div>
        <span>{title}</span>
        {meta && (
          <>
            <TaskDot />
            <small>{meta}</small>
          </>
        )}
      </div>
      {action}
    </div>
  );
}

export function ToggleTextButton({ expanded, onClick }) {
  const Icon = expanded ? ChevronUp : ChevronDown;
  return (
    <button className="task-text-toggle" onClick={onClick} type="button">
      {expanded ? "Hide" : "Show"}
      <Icon size={12} strokeWidth={1.5} />
    </button>
  );
}

export function TaskWorkflowNotice({ notice, onAction }) {
  if (!notice) return null;
  return (
    <section className={`task-workflow-notice is-${notice.tone || "success"}`} role="status">
      <span className="task-workflow-notice-icon" aria-hidden="true">
        <Check size={14} strokeWidth={2} />
      </span>
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.body}</p>
        {notice.detail && <small>{notice.detail}</small>}
      </div>
      {notice.actionLabel && onAction && (
        <button className="dark-pill" onClick={onAction} type="button">
          {notice.actionLabel}
          <ArrowRight size={14} strokeWidth={2} />
        </button>
      )}
    </section>
  );
}

export function TaskWorkflowSteps({ ariaLabel = "Task workflow progress", className = "", steps = [] }) {
  if (!steps.length) return null;
  const classes = ["task-workflow-steps", className].filter(Boolean).join(" ");
  return (
    <ol aria-label={ariaLabel} className={classes}>
      {steps.map((step) => (
        <li
          aria-current={step.state === "current" ? "step" : undefined}
          className={`is-${step.state || "pending"}`}
          key={step.key}
        >
          <span className="task-workflow-step-dot" aria-hidden="true">
            {step.state === "complete" ? <Check size={11} strokeWidth={2.2} /> : null}
          </span>
          <span className="task-workflow-step-copy">
            <strong>{step.label}</strong>
            <small>{step.detail}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function formatPftValue(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toLocaleString(undefined, {
    maximumFractionDigits: parsed % 1 === 0 ? 0 : 6,
    minimumFractionDigits: 0,
  });
}

export function formatReviewMetric(value) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  return String(value);
}

export function formatIndexedEventCopy(count = 0) {
  const parsed = Math.max(0, Number(count || 0));
  return `${parsed.toLocaleString()} indexed ${parsed === 1 ? "event" : "events"}`;
}

export function shortProofValue(value = "") {
  const text = String(value || "").trim();
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-8)}`;
}

export function taskVersionKey(task = {}) {
  return [
    task.taskId || task.fullId || task.id || "",
    task.statusKey || task.status || "",
    task.updatedAt || "",
    task.lastEventAt || "",
    task.txHash || "",
    task.metadata?.eventCount || "",
  ].join("|");
}

export function taskIdentityKey(task = {}) {
  return String(task?.taskId || task?.fullId || task?.id || "").trim();
}

export function TaskRewardOutcome({ copiedValue = "", onCopy, onSelectForensics, outcome, pftlExplorerUrl = "" }) {
  if (!outcome) return null;
  const rewardPft = Number(outcome.rewardPft || 0);
  const offeredPft = Number(outcome.offeredPft || 0);
  const paymentTxHash = String(outcome.paymentTxHash || outcome.rewardTxHash || outcome.txHash || "").trim();
  const paymentCid = String(outcome.paymentCid || outcome.rewardCid || outcome.cid || "").trim();
  const paymentHref = transactionExplorerHref(paymentTxHash, pftlExplorerUrl);
  const rows = [
    ["Decision", outcome.decision],
    ["Reward outcome", `${formatPftValue(rewardPft)} PFT`],
    offeredPft > 0 && offeredPft !== rewardPft
      ? ["Original offer", `${formatPftValue(offeredPft)} PFT`]
      : null,
    ["Completion", formatReviewMetric(outcome.completion)],
    ["Evidence quality", formatReviewMetric(outcome.evidenceQuality)],
  ].filter((row) => row && Boolean(String(row[1] || "").trim()));

  return (
    <section className={`task-reward-outcome is-${statusSlug(outcome.status)}`}>
      <div className="task-reward-outcome-head">
        <span>Reward outcome</span>
        <strong>{outcome.title || "Reward outcome"}</strong>
        <p>{outcome.summary || "The reward outcome has been indexed on-chain."}</p>
      </div>
      {rows.length > 0 && (
        <dl className="task-reward-outcome-grid">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {outcome.reason && (
        <div className="task-reward-outcome-text">
          <span>Verifier reason</span>
          <p>{outcome.reason}</p>
        </div>
      )}
      {outcome.userFeedback && (
        <div className="task-reward-outcome-text">
          <span>What to fix</span>
          <p>{outcome.userFeedback}</p>
        </div>
      )}
      {(paymentTxHash || paymentCid) && (
        <div className="task-reward-proof">
          <span>Reward proof</span>
          <p>Reward paid. View proof, copy the reward transaction, or open the on-chain record.</p>
          <div className="task-reward-proof-values">
            {paymentTxHash && <code title={paymentTxHash}>tx {paymentTxHash}</code>}
            {paymentCid && <code title={paymentCid}>cid {paymentCid}</code>}
          </div>
          <div className="task-reward-proof-actions">
            <button onClick={() => onSelectForensics?.()} type="button">
              View proof
              <ArrowRight size={12} strokeWidth={1.6} />
            </button>
            {paymentTxHash && (
              <button onClick={() => onCopy?.("reward-tx", paymentTxHash)} type="button">
                {copiedValue === "reward-tx" ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
                Copy tx
              </button>
            )}
            {paymentHref && (
              <a href={paymentHref} rel="noreferrer" target="_blank">
                <ExternalLink size={12} strokeWidth={1.8} />
                Open tx
              </a>
            )}
            {paymentCid && (
              <button onClick={() => onCopy?.("reward-cid", paymentCid)} type="button">
                {copiedValue === "reward-cid" ? <Check size={12} strokeWidth={1.8} /> : <Copy size={12} strokeWidth={1.8} />}
                Copy CID
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function TaskDetailLoadingPanel() {
  return (
    <section className="task-detail-loading" aria-live="polite">
      <span />
      <p>Loading task detail</p>
    </section>
  );
}

export function TaskCurrentVerificationPanel({ request }) {
  if (!request?.body && !request?.reason) return null;
  const rows = [
    request.type ? ["Evidence type", request.type] : null,
    request.assessment ? ["Assessment", request.assessment] : null,
    request.eventId ? ["Request event", request.eventId] : null,
  ].filter(Boolean);
  return (
    <section className="task-current-requirement">
      <div className="task-current-requirement-head">
        <span>Verification requested</span>
        <strong>Submit verification evidence</strong>
      </div>
      {request.body && <p>{request.body}</p>}
      {request.reason && (
        <div className="task-current-requirement-reason">
          <span>Why this was requested</span>
          <p>{request.reason}</p>
        </div>
      )}
      {rows.length > 0 && (
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function TaskOriginalContext({ displayTask, expanded, onToggle, steps, verification }) {
  return (
    <section className="task-original-context">
      <SectionLabel
        title="Original task"
        meta={displayTask.lastEventAtDisplay || displayTask.updatedAtDisplay || ""}
        action={<ToggleTextButton expanded={expanded} onClick={onToggle} />}
      />
      <p className="task-original-summary">
        {displayTask.description || "Original task details are indexed in the task offer."}
      </p>
      {expanded && (
        <div className="task-original-context-body">
        <TaskSection title="Description">
          <p>{displayTask.description}</p>
        </TaskSection>
        {steps.length > 0 && (
          <TaskSection title="Steps">
            <ol>
              {steps.map((step, index) => (
                <li key={`${index}-${step}`}>
                  <span>{index + 1}</span>
                  <p>{step}</p>
                </li>
              ))}
            </ol>
          </TaskSection>
        )}
        <TaskSection last title="Initial evidence requirement">
          <strong>{verification.title || "Submit evidence"}</strong>
          <p>{verification.body || "Submit evidence that satisfies the task requirement."}</p>
        </TaskSection>
      </div>
      )}
    </section>
  );
}
