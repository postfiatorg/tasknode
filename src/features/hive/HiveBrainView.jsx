import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, RefreshCw, X } from "lucide-react";
import { requestJson } from "../../api";
import hiveActiveProjectsPrompt from "../../../prompts/hive/hive_active_projects_v1.md?raw";
import hiveDecisionAgentPrompt from "../../../prompts/hive/hive_decision_agent_v1.md?raw";
import hiveSecretaryPrompt from "../../../prompts/hive/hive_secretary_v1.md?raw";
import taskAccountingHarvesterPrompt from "../../../prompts/hive/task_accounting_harvester_v1.md?raw";
import "./hive.css";

const reportTabs = [
  {
    id: "operative",
    type: "operative",
    label: "Operative",
    title: "Operative report",
    cadence: "24h",
    summary: "Per-role operator context, allocation state, and current task descriptions.",
  },
  {
    id: "rewarded",
    type: "rewarded_task",
    label: "Rewarded tasks",
    title: "Rewarded task report",
    cadence: "20m",
    summary: "Last rewarded Network Tasks per verified role, including proposal and reward context.",
  },
  {
    id: "kol",
    type: "kol",
    label: "KOL",
    title: "KOL report",
    cadence: "daily",
    summary: "Marketing state, public amplification evidence, KOL operators, and trajectory.",
    verifier: "kol_link_verifier",
  },
  {
    id: "dev",
    type: "development",
    label: "Development",
    title: "Development report",
    cadence: "24h",
    summary: "Core development state, tasks, repository evidence, and delivery risks.",
    verifier: "dev_repo_verifier",
  },
  {
    id: "qa",
    type: "qa",
    label: "QA",
    title: "QA report",
    cadence: "24h",
    summary: "Product QA activity, user-flow findings, and suggested improvements.",
  },
  {
    id: "exec",
    type: "executive",
    label: "Executive",
    title: "Executive report",
    cadence: "24h",
    summary: "Project Leader Hive chat over the past 24 hours.",
  },
];

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "harvests", label: "Harvests", cadence: "rewarded" },
  { id: "docs", label: "Docs", cadence: "system" },
  ...reportTabs,
];

const decisionActions = [
  "create_task",
  "message_user",
  "cancel_task",
  "create_board",
  "archive_board",
  "refresh_board",
  "do_nothing",
];

const reportPromptByType = {
  rewarded_task: [
    "Group by role. For each role, summarize the last rewarded Network Tasks available in the packet.",
    "For each task include task id, title, operator, proposal/evidence gist, actual reward, and why it matters.",
  ],
  operative: [
    "Group operators by KOL, Core Contributor, QA Worker, Expert, and Project Leader where present.",
    "For each person include profile context, whether they currently have a task, and 1-2 sentences on what they appear to be doing.",
  ],
  kol: [
    "Summarize marketing/amplification state, KOL operators, public artifacts, key rewarded tasks, and trajectory.",
    "List every public link you rely on so the link-verifier can check it.",
  ],
  development: [
    "Summarize core development work, active code tasks, rewarded code tasks, repository evidence, and delivery risks.",
    "List repository, PR, issue, or commit links you rely on so the repo-verifier can check them.",
  ],
  qa: [
    "Write this as a product QA document: observed issues, suggested improvements, evidence from rewarded QA tasks, and Hive chat feedback.",
    "Separate confirmed findings from ideas or thin reports.",
  ],
  executive: [
    "Assemble Project Leader Hive chat from the last 24h into an executive brief.",
    "Preserve who said what, project implications, unresolved decisions, and concrete next actions.",
  ],
};

const reportWriterSystemPrompt = [
  "You are the Task Node Hive Reports writer.",
  "Your output is a prose operating report for a human operator.",
  "Never output raw JSON as the report body.",
  "Do not claim actions were executed; report only observed evidence.",
].join("\n");

function reportPromptText(tab = {}) {
  return [
    `Report type: ${tab.label || tab.type}`,
    `Purpose: ${tab.summary || "Hive operating report."}`,
    "Write a human-readable Markdown document. Do not output JSON.",
    "Start with one H1. Use short sections, bullets, and concise evidence references.",
    "Include relevant counts and KPIs when present in the source packet.",
    "Call out uncertainty and missing evidence instead of inventing facts.",
    "Projects are dynamic; do not assume a fixed project list.",
    "Do not change or recommend reward policy, clawbacks, bans, or enforcement execution.",
    ...(reportPromptByType[tab.type] || []),
    "This is the initial phase. Produce the best report possible from the source packet.",
  ].join("\n");
}

const boardSystemDocs = [
  {
    title: "Hive Secretary",
    badge: "Secretary",
    cadence: "context job",
    provider: "OpenAI Responses",
    model: "gpt-5.5-pro",
    promptPath: "prompts/hive/hive_secretary_v1.md",
    prompt: hiveSecretaryPrompt,
    reads: "Hive Context source packets.",
    writes: "Structured Hive Secretary reports, then queues the active-project planner.",
    body: "The first summarizer in the board chain. It converts raw Hive context into project signals, network implications, open questions, and next system focus.",
  },
  {
    title: "Active Project Planner",
    badge: "Project planner",
    cadence: "after secretary",
    provider: "OpenAI Responses",
    model: "gpt-5.5-pro",
    promptPath: "prompts/hive/hive_active_projects_v1.md",
    prompt: hiveActiveProjectsPrompt,
    reads: "Hive Secretary report packets.",
    writes: "The current active project cards shown on the Hive board.",
    body: "Turns secretary signals into a small dynamic set of projects with objective, status, phase, rationale, task count, contributor count, and PFT routed.",
  },
  {
    title: "Report Builder",
    badge: "Reports",
    cadence: "20m / 24h",
    provider: "OpenRouter Chat Completions",
    model: "z-ai/glm-5.2",
    promptPath: "server/hive-report-provider.js generated prompt",
    prompt: reportWriterSystemPrompt,
    reads: "Verified badges, live task state, rewarded task history, Hive chat, and dynamic projects.",
    writes: "Six human-readable Markdown reports used as primary Decision Agent inputs.",
    body: "This replaces raw packet reading with operator-readable reports. KOL and Development reports run a verifier pass before the final report is stored.",
  },
  {
    title: "Task Accounting Harvester",
    badge: "Harvester",
    cadence: "after reward",
    provider: "OpenRouter Chat Completions",
    model: "deepseek/deepseek-v4-pro",
    promptPath: "prompts/hive/task_accounting_harvester_v1.md",
    prompt: taskAccountingHarvesterPrompt,
    reads: "Rewarded Network Task projections, task proposal text, reward event references, and submission requirements.",
    writes: "task_accounting_harvests rows classified as requires_action or no_action, with suggested action text.",
    body: "The accounting pass that replaced Orc-owned rewarded-task triage. It harvests every completed Network Task after reward and marks whether anything needs follow-up.",
  },
  {
    title: "Decision Agent",
    badge: "Router",
    cadence: "periodic tick",
    provider: "OpenRouter Chat Completions",
    model: "z-ai/glm-5.2",
    promptPath: "prompts/hive/hive_decision_agent_v1.md",
    prompt: hiveDecisionAgentPrompt,
    reads: "The six reports, live task state, board discussions, idle eligible contributors, and dedup index.",
    writes: "One guarded board action plus explanation, options considered, and audit metadata.",
    body: "The active board brain. It can create tasks, message users, cancel tasks, create/archive boards, or do nothing. Mutations still pass through guardrails and the adapter.",
  },
];

function validProjectDocument(document) {
  return Boolean(
    document &&
      typeof document === "object" &&
      !Array.isArray(document) &&
      document.projects &&
      typeof document.projects === "object" &&
      !Array.isArray(document.projects) &&
      Array.isArray(document.projectIds)
  );
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatAction(value = "") {
  return String(value || "pending")
    .split("_")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function formatTime(value = "") {
  if (!value) return "unknown";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

function relativeTime(value = "") {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value ? formatTime(value) : "unknown";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function formatBytes(value = 0) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function compactNumber(value = 0) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "0";
  if (Math.abs(numeric) >= 1_000_000) return `${(numeric / 1_000_000).toFixed(1)}M`;
  if (Math.abs(numeric) >= 1_000) return `${(numeric / 1_000).toFixed(1)}K`;
  return String(Math.round(numeric));
}

function compactWallet(value = "") {
  const text = String(value || "").trim();
  if (text.length <= 14) return text || "unknown";
  return `${text.slice(0, 6)}...${text.slice(-6)}`;
}

function parseMarkdownBlocks(markdown = "") {
  const lines = String(markdown || "").split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (!list?.items?.length) return;
    blocks.push(list);
    list = null;
  };
  const flushCode = () => {
    if (!code) return;
    blocks.push({ type: "code", text: code.lines.join("\n") });
    code = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      flushParagraph();
      flushList();
      if (code) flushCode();
      else code = { lines: [] };
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: Math.min(heading[1].length, 4), text: heading[2] });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (bullet || ordered) {
      flushParagraph();
      const type = ordered ? "ordered" : "unordered";
      if (!list || list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((bullet || ordered)[1]);
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();
  flushCode();
  return blocks;
}

function Badge({ children, variant = "gray" }) {
  return <span className={`hive-brain-badge is-${variant}`}>{children}</span>;
}

function Status({ children, type = "" }) {
  const normalized = String(type || children || "").toLowerCase().replace(/_/g, "-");
  return <span className={`hive-brain-status is-${normalized}`}>{children}</span>;
}

function Kpi({ accent = false, label, sub = "", value }) {
  return (
    <div className="hive-brain-kpi">
      <div className="hive-brain-kpi-label">{label}</div>
      <div className={`hive-brain-kpi-value ${accent ? "is-accent" : ""}`}>{value}</div>
      {sub && <div className="hive-brain-kpi-sub">{sub}</div>}
    </div>
  );
}

function MarkdownReportBody({ markdown = "" }) {
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);
  if (!blocks.length) {
    return <div className="hive-report-body hive-report-markdown"><p>Report body unavailable.</p></div>;
  }
  return (
    <div className="hive-report-body hive-report-markdown">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          const Heading = `h${Math.min(Math.max(block.level + 1, 3), 5)}`;
          return <Heading key={`${block.type}-${index}`}>{block.text}</Heading>;
        }
        if (block.type === "code") return <pre key={`${block.type}-${index}`}>{block.text}</pre>;
        if (block.type === "ordered") {
          return (
            <ol key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{item}</li>)}
            </ol>
          );
        }
        if (block.type === "unordered") {
          return (
            <ul key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${index}-${itemIndex}`}>{item}</li>)}
            </ul>
          );
        }
        return <p key={`${block.type}-${index}`}>{block.text}</p>;
      })}
    </div>
  );
}

function reportExcerpt(report = {}) {
  return report.bodyExcerpt || report.bodyMarkdownExcerpt || "Open the report for the full markdown briefing.";
}

function decisionSummary(detail = null) {
  const run = detail?.run || {};
  const guardrail = run.guardrailResult || {};
  const result = run.result || {};
  const execution = result.executionResult || result;
  if (run.reasoningText) return run.reasoningText;
  if (execution.reason) return execution.reason;
  if (guardrail.blocked) return "Guardrails blocked this action before mutation.";
  if (guardrail.ok) return "Guardrails passed for this decision.";
  return "The Decision Agent has not recorded a plain-English summary for this run yet.";
}

function decisionResult(detail = null) {
  const run = detail?.run || {};
  const guardrail = run.guardrailResult || {};
  const reasons = safeArray(guardrail.reasons);
  const result = run.result || {};
  const execution = result.executionResult || result;
  return [
    guardrail.ok ? "Guardrails passed." : guardrail.blocked ? "Guardrails blocked execution." : "Guardrail status unknown.",
    reasons.length ? `Reasons: ${reasons.join(", ")}.` : "",
    execution.executed === true ? "Mutation executed through the guarded adapter." : "",
    execution.executed === false ? "No mutation executed." : "",
    execution.reason ? `Result reason: ${execution.reason}.` : "",
  ].filter(Boolean).join(" ");
}

function flattenLiveTasks(projectDocument = null) {
  const projects = projectDocument?.projects || {};
  return Object.values(projects)
    .flatMap((project) =>
      safeArray(project.tasks).map((task) => ({
        ...task,
        project: project.name || project.id || "Project",
      }))
    )
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""))
    .slice(0, 7);
}

function DecisionCard({ detail, loading }) {
  const run = detail?.run || {};
  const action = run.selectedAction || run.status || "pending";
  const options = safeArray(run.optionsConsidered);
  const chips = [
    `Guardrail · ${run.guardrailResult?.ok ? "ok" : run.guardrailResult?.blocked ? "blocked" : "unknown"}`,
    `Reports · ${safeArray(run.inputReportIds).length}`,
    `Candidates · ${run.taskStatusSnapshot?.idleEligibleContributorCount || 0}`,
  ];
  return (
    <div className="hive-brain-card hive-brain-decision-card">
      <div className="hive-brain-decision-top">
        <Badge variant="action">Hive Decision · router</Badge>
        <Badge variant={run.guardrailResult?.blocked ? "amber" : "blue"}>{formatAction(action)}</Badge>
        <span className="hive-brain-grow" />
        <span>{loading ? "Loading run" : `Cycle · ${relativeTime(run.startedAt)}`}</span>
      </div>
      <div className="hive-brain-decision-body">
        <h2>{run.selectedAction ? `${formatAction(run.selectedAction)} selected` : "Latest Decision Agent run"}</h2>
        <div className="hive-brain-who">
          {run.model || "model unknown"} · {run.shadow ? "shadow" : "active"} · {formatTime(run.startedAt)}
        </div>
        <p>{decisionSummary(detail)}</p>
        <p>{decisionResult(detail)}</p>
        <div className="hive-brain-stat-row">
          {chips.map((chip) => <span className="hive-brain-pill" key={chip}>{chip}</span>)}
        </div>
        <div className="hive-brain-actions">
          <span className="hive-brain-action-label">Decision space</span>
          {decisionActions.map((item) => (
            <span className={`hive-brain-action ${item === run.selectedAction ? "is-chosen" : ""}`} key={item}>
              {formatAction(item)}{item === run.selectedAction ? " ✓" : ""}
            </span>
          ))}
        </div>
        {options.length > 0 && (
          <div className="hive-brain-option-strip">
            {options.slice(0, 4).map((option, index) => (
              <article key={`${option.action || "option"}-${index}`}>
                <strong>{formatAction(option.action || `Option ${index + 1}`)}</strong>
                <span>{option.summary || option.rejectedBecause || "No option summary recorded."}</span>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DecisionLog({ runs = [], selectedRunId = "", onSelectRun }) {
  return (
    <div className="hive-brain-card hive-brain-pad hive-brain-log">
      <div className="hive-brain-section-label">Recent decisions</div>
      <div className="hive-brain-section-sub">Every Decision Agent action, auditable.</div>
      {runs.map((run) => (
        <button
          className={`hive-brain-log-row ${selectedRunId === run.id ? "is-active" : ""}`}
          key={run.id}
          onClick={() => onSelectRun(run.id)}
          type="button"
        >
          <span>{relativeTime(run.startedAt)}</span>
          <strong>{formatAction(run.selectedAction || run.status)}</strong>
          <em>{run.reasoningText || (run.guardrailResult?.blocked ? "blocked by guardrail" : run.status)}</em>
        </button>
      ))}
      {!runs.length && <div className="hive-brain-empty">No Decision Agent runs have been recorded yet.</div>}
    </div>
  );
}

function LiveTaskTable({ projectDocument = null, status = "loading" }) {
  const tasks = useMemo(() => flattenLiveTasks(projectDocument), [projectDocument]);
  return (
    <div className="hive-brain-card">
      <div className="hive-brain-table-head">
        <div className="hive-brain-section-label">Live task status</div>
        <div className="hive-brain-section-sub">Real-time task rows from the Hive project document.</div>
      </div>
      <div className="hive-brain-table-wrap">
        <table className="hive-brain-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Operative</th>
              <th>Project</th>
              <th>Status</th>
              <th className="is-num">Reward</th>
              <th className="is-num">When</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.id || task.taskId}>
                <td>{task.title || task.taskId || "Untitled task"}</td>
                <td>{task.assigneeHandle || task.assigneeDisplayName || task.assignee || "Unassigned"}</td>
                <td className="is-muted">{task.project}</td>
                <td><Status type={task.state}>{formatAction(task.state)}</Status></td>
                <td className="is-pft">{compactNumber(task.pft)}</td>
                <td className="is-num is-muted">{task.age || relativeTime(task.updatedAt || task.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {status === "loading" && <div className="hive-brain-empty">Loading live task status.</div>}
        {status === "error" && <div className="hive-brain-empty">Live task status is unavailable.</div>}
        {status === "ready" && !tasks.length && <div className="hive-brain-empty">No live task rows are available.</div>}
      </div>
    </div>
  );
}

function HarvestOutputRow({ harvest, onResolve }) {
  const classification = harvest.classification || harvest.status || "not_harvested";
  const isResolved = Boolean(harvest.resolved || harvest.resolvedAt);
  const confidence = Number(harvest.confidence || 0);
  const confidenceLabel = confidence > 0 ? `${Math.round(confidence * 100)}% confidence` : "confidence pending";
  const contributor = harvest.contributor || {};
  const badgeContext = harvest.badgeContext || {};
  const verifiedBadges = safeArray(contributor.verifiedBadges);
  const contributorLabel = contributor.publicHandle
    ? `@${String(contributor.publicHandle).replace(/^@+/, "")}`
    : contributor.displayName || compactWallet(contributor.walletAddress || harvest.walletAddress);
  const requiredBadgeLabel = badgeContext.requiredBadgeId
    ? `${formatAction(badgeContext.requiredBadgeId)}${badgeContext.requiredBadgeSource === "inferred" ? " (inferred)" : ""}`
    : "unknown";
  const summaryText = isResolved
    ? harvest.resolutionNote || harvest.assessmentSummary || harvest.lastError || "Resolved harvest row."
    : harvest.assessmentSummary || harvest.lastError || "Harvest output pending.";
  return (
    <details className="hive-brain-harvest-output">
      <summary>
        <div>
          <strong>{harvest.title || "Untitled rewarded task"}</strong>
          <span>{summaryText}</span>
        </div>
        <div className="hive-brain-harvest-output-meta">
          <Status type={classification}>{formatAction(classification)}</Status>
          {isResolved && <Status type="resolved">Resolved</Status>}
          <em>{compactNumber(harvest.rewardActualPft || harvest.rewardOfferPft)} PFT</em>
        </div>
      </summary>
      <div className="hive-brain-harvest-output-body">
        <div className="hive-brain-harvest-output-grid">
          <span><small>Task</small><code>{harvest.taskId}</code></span>
          <span><small>Contributor</small><strong>{contributorLabel}</strong></span>
          <span><small>Wallet</small><code>{compactWallet(contributor.walletAddress || harvest.walletAddress)}</code></span>
          <span><small>Verified badges</small><strong>{verifiedBadges.length ? verifiedBadges.map((badge) => badge.label || formatAction(badge.badgeId)).join(", ") : "none"}</strong></span>
          <span><small>Badge required for this work</small><strong>{requiredBadgeLabel}</strong></span>
          <span><small>Work type</small><strong>{formatAction(badgeContext.taskWorkType || badgeContext.badgeWorkType || "unknown")}</strong></span>
          <span><small>Category</small><strong>{formatAction(harvest.actionCategory || "none")}</strong></span>
          <span><small>Rewarded</small><strong>{relativeTime(harvest.rewardedAt)}</strong></span>
          <span><small>Harvested</small><strong>{relativeTime(harvest.completedAt || harvest.updatedAt)}</strong></span>
          {isResolved && <span><small>Resolved</small><strong>{relativeTime(harvest.resolvedAt)}</strong></span>}
          <span><small>Model</small><strong>{harvest.model || "pending"}</strong></span>
          <span><small>Confidence</small><strong>{confidenceLabel}</strong></span>
        </div>
        <div className="hive-brain-harvest-output-copy">
          <article>
            <small>Assessment</small>
            <p>{harvest.assessmentSummary || "No assessment summary has been recorded yet."}</p>
          </article>
          <article>
            <small>Suggested action</small>
            <p>{harvest.suggestedAction || "No suggested action recorded yet."}</p>
          </article>
          {isResolved && (
            <article>
              <small>Resolution comment</small>
              <p>{harvest.resolutionNote || "Resolved without a comment."}</p>
            </article>
          )}
        </div>
        <div className="hive-brain-harvest-actions">
          <button
            disabled={isResolved}
            onClick={() => onResolve?.(harvest)}
            type="button"
          >
            {isResolved ? "Resolved" : "Mark resolved"}
          </button>
        </div>
      </div>
    </details>
  );
}

function HarvestResolveDialog({
  busy = false,
  error = "",
  harvest = null,
  note = "",
  onCancel,
  onNoteChange,
  onSubmit,
}) {
  const textareaRef = useRef(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [harvest?.taskId]);

  if (!harvest) return null;
  return (
    <div className="htp-layer hive-harvest-resolve-layer">
      <div className="htp-wash is-mounted" onClick={busy ? undefined : onCancel} role="presentation" />
      <section
        aria-labelledby="hive-harvest-resolve-title"
        aria-modal="true"
        className="htp-modal is-mounted hive-harvest-resolve-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="htp-header">
          <span className="htp-kicker">
            <CheckCircle2 size={12} strokeWidth={2} />
            Resolve harvest
          </span>
          <button className="htp-close" disabled={busy} onClick={onCancel} type="button">
            <X size={14} strokeWidth={1.8} />
            Close
          </button>
        </header>
        <form className="hive-harvest-resolve-form" onSubmit={onSubmit}>
          <div>
            <h2 id="hive-harvest-resolve-title">Mark resolved</h2>
            <p>{harvest.title || harvest.taskId || "Untitled rewarded task"}</p>
          </div>
          <label>
            <span>Resolution comment</span>
            <textarea
              maxLength={1000}
              onChange={(event) => onNoteChange?.(event.target.value)}
              placeholder="What changed, where it was tracked, or why this harvest is no longer actionable."
              ref={textareaRef}
              value={note}
            />
          </label>
          {error && <div className="hive-harvest-resolve-error">{error}</div>}
          <footer>
            <button disabled={busy} onClick={onCancel} type="button">Cancel</button>
            <button disabled={busy} type="submit">
              {busy ? "Saving..." : "Resolve"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function HarvestPanel({
  harvests = [],
  onResolve,
  resolvedHarvests = [],
  resolvedStatus = "loading",
  summary = {},
  status = "loading",
}) {
  return (
    <section className="hive-brain-panel">
      <div className="hive-brain-panel-head">
        <h2>Task Accounting Harvester</h2>
        <div>
          <Badge variant="gray">DeepSeek V4 Pro</Badge>
          <span>{summary.harvested || 0} harvested</span>
          <span>{summary.queued || 0} queued</span>
          <span>{summary.requiresAction || 0} actionable</span>
          <span>{summary.resolved || 0} resolved</span>
        </div>
      </div>
      <div className="hive-brain-card hive-brain-pad hive-brain-harvest-summary">
        <div>
          <div className="hive-brain-section-label">Accounting purpose</div>
          <p className="hive-brain-body-copy">
            Every rewarded Network Task gets one post-reward harvest. The output is an accounting label:
            no action when the task is self-contained, or requires action when the rewarded packet contains a bug,
            feature request, release communication, routing issue, or other concrete follow-up.
          </p>
        </div>
        <div className="hive-brain-tag-row">
          <span>{summary.total || 0} total</span>
          <span>{summary.noAction || 0} no action</span>
          <span>{summary.failed || 0} failed</span>
        </div>
      </div>
      <div className="hive-brain-card hive-brain-harvest-card">
        <div className="hive-brain-table-head">
          <div className="hive-brain-section-label">Unresolved rewarded Network Task harvests</div>
          <div className="hive-brain-section-sub">Each open output expands into the accounting assessment, suggested follow-up, and resolve action.</div>
        </div>
        <div className="hive-brain-harvest-output-list">
          {harvests.map((harvest) => <HarvestOutputRow harvest={harvest} key={harvest.taskId} onResolve={onResolve} />)}
          {status === "loading" && <div className="hive-brain-empty">Loading harvest queue.</div>}
          {status === "error" && <div className="hive-brain-empty">Task Accounting harvests are unavailable.</div>}
          {status === "ready" && !harvests.length && <div className="hive-brain-empty">No unresolved rewarded Network Task harvests are available.</div>}
        </div>
      </div>
      <div className="hive-brain-card hive-brain-harvest-card">
        <div className="hive-brain-table-head">
          <div className="hive-brain-section-label">Resolved history</div>
          <div className="hive-brain-section-sub">Resolved harvest rows stay visible here with the operator comment used to close them.</div>
        </div>
        <div className="hive-brain-harvest-output-list">
          {resolvedHarvests.map((harvest) => <HarvestOutputRow harvest={harvest} key={harvest.taskId} onResolve={onResolve} />)}
          {resolvedStatus === "loading" && <div className="hive-brain-empty">Loading resolved harvest history.</div>}
          {resolvedStatus === "error" && <div className="hive-brain-empty">Resolved harvest history is unavailable.</div>}
          {resolvedStatus === "ready" && !resolvedHarvests.length && <div className="hive-brain-empty">No resolved harvest rows yet.</div>}
        </div>
      </div>
    </section>
  );
}

function ReportsGrid({ latestByType, onOpenReport }) {
  return (
    <div>
      <div className="hive-brain-section-label">Reports & generations</div>
      <div className="hive-brain-section-sub">Six human-readable reports feed the Decision Agent. Click any report to read it.</div>
      <div className="hive-brain-report-grid">
        {reportTabs.map((tab) => {
          const report = latestByType.get(tab.type);
          return (
            <button className="hive-brain-report-card" key={tab.id} onClick={() => onOpenReport(tab.id)} type="button">
              <div className="hive-brain-report-card-top">
                <span>{tab.title}</span>
                <Badge variant={report ? "gray" : "red"}>{report ? tab.cadence : "missing"}</Badge>
              </div>
              <div className="hive-brain-report-take">
                {report ? reportExcerpt(report) : "No report generated yet."}
              </div>
              <div className="hive-brain-report-foot">
                <span>{report ? `Updated ${relativeTime(report.generatedAt)}` : "Not generated"}</span>
                <strong>Open →</strong>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OverviewPanel({
  decisionDetail,
  decisionLoading,
  latestByType,
  onOpenReport,
  projectDocument,
  projectStatus,
  runs,
  selectedRunId,
  onSelectRun,
}) {
  return (
    <section className="hive-brain-panel">
      <div className="hive-brain-stack">
        <DecisionCard detail={decisionDetail} loading={decisionLoading} />
        <div className="hive-brain-grid2">
          <DecisionLog runs={runs} selectedRunId={selectedRunId} onSelectRun={onSelectRun} />
          <div className="hive-brain-card hive-brain-pad">
            <div className="hive-brain-section-label">Hive discussion → decisions</div>
            <div className="hive-brain-section-sub">Live operator context is now consumed through reports, not raw JSON packets.</div>
            <p className="hive-brain-body-copy">
              Hive Brain shows the decision layer in plain English: the latest report set, the Decision Agent action,
              guardrail result, and the live task state it is routing against.
            </p>
            <div className="hive-brain-tag-row">
              <span>Reports first</span>
              <span>Guarded actions</span>
              <span>No raw packet view</span>
            </div>
          </div>
        </div>
        <LiveTaskTable projectDocument={projectDocument} status={projectStatus} />
        <ReportsGrid latestByType={latestByType} onOpenReport={onOpenReport} />
      </div>
    </section>
  );
}

function PromptDisclosure({ label, path, prompt }) {
  return (
    <details className="hive-brain-prompt-block">
      <summary>
        <span>{label}</span>
        <code>{path}</code>
      </summary>
      <pre>{String(prompt || "").trim() || "Prompt unavailable."}</pre>
    </details>
  );
}

function SystemDocCard({ doc }) {
  return (
    <article className="hive-brain-card hive-brain-system-card">
      <div className="hive-brain-system-card-top">
        <Badge variant="blue">{doc.badge}</Badge>
        <span>{doc.cadence}</span>
      </div>
      <h3>{doc.title}</h3>
      <p>{doc.body}</p>
      <div className="hive-brain-system-meta">
        <span><small>Provider</small><strong>{doc.provider}</strong></span>
        <span><small>Model</small><strong>{doc.model}</strong></span>
        <span><small>Reads</small><strong>{doc.reads}</strong></span>
        <span><small>Writes</small><strong>{doc.writes}</strong></span>
      </div>
      <PromptDisclosure label={`${doc.title} prompt`} path={doc.promptPath} prompt={doc.prompt} />
    </article>
  );
}

function ReportPromptCard({ tab }) {
  const writerPrompt = [
    "SYSTEM",
    reportWriterSystemPrompt,
    "",
    "USER INSTRUCTIONS",
    reportPromptText(tab),
    "",
    "SOURCE PACKET",
    "The worker appends compacted live Hive report source data as JSON.",
  ].join("\n");
  return (
    <article className="hive-brain-card hive-brain-system-card">
      <div className="hive-brain-system-card-top">
        <Badge variant={tab.verifier ? "action" : "gray"}>{tab.verifier ? "Verified" : "Report"}</Badge>
        <span>{tab.cadence}</span>
      </div>
      <h3>{tab.title}</h3>
      <p>{tab.summary}</p>
      <div className="hive-brain-system-meta">
        <span><small>Provider</small><strong>OpenRouter Chat Completions</strong></span>
        <span><small>Model</small><strong>z-ai/glm-5.2</strong></span>
        <span><small>Output</small><strong>Human-readable Markdown</strong></span>
        <span><small>Verifier</small><strong>{tab.verifier || "none"}</strong></span>
      </div>
      <PromptDisclosure
        label={`${tab.label} writer prompt`}
        path="server/hive-report-provider.js reportInstructions()"
        prompt={writerPrompt}
      />
      {tab.verifier && (
        <details className="hive-brain-prompt-block">
          <summary>
            <span>{tab.verifier}</span>
            <code>server/hive-report-provider.js</code>
          </summary>
          <pre>{tab.type === "kol"
            ? [
                "Deterministic verifier, not an LLM prompt.",
                "",
                "1. Extract public links from the KOL report, KOL rewarded tasks, and KOL role source packet.",
                "2. Check up to 20 links for reachability.",
                "3. Store a Markdown verification summary with confirmed and unverified links.",
                "4. Feed that summary into the final report pass.",
              ].join("\n")
            : [
                "Deterministic verifier, not an LLM prompt.",
                "",
                "1. Extract postfiatorg GitHub links from the Development report and core contributor task packets.",
                "2. Check up to 20 repository, PR, issue, or commit links for reachability.",
                "3. Query GitHub for recent visible postfiatorg issue/PR activity.",
                "4. Store a Markdown verification summary and feed it into the final report pass.",
              ].join("\n")}</pre>
        </details>
      )}
    </article>
  );
}

function SystemDocsPanel() {
  const flow = [
    ["01", "Hive Context", "Operator chat, task state, role badges, projects, and network evidence enter the board memory layer."],
    ["02", "Secretary", "The Hive Secretary summarizes the context into structured project signals."],
    ["03", "Projects + Reports", "The project planner refreshes board cards while six report secretaries produce human-readable Markdown."],
    ["04", "Verification", "KOL links and development repo references get deterministic checks before final reports are stored."],
    ["05", "Task Accounting", "Rewarded Network Tasks are harvested after reward into action/no-action accounting rows."],
    ["06", "Decision Agent", "The router reads reports, live task state, discussions, candidates, and dedup data before one guarded action."],
  ];
  return (
    <section className="hive-brain-panel">
      <div className="hive-brain-stack">
        <div className="hive-brain-card hive-brain-system-hero">
          <div>
            <div className="hive-brain-section-label">Current board secretary system</div>
            <h2>Reports first, then one guarded decision.</h2>
            <p>
              Hive Brain is the operator-facing audit surface for the current board stack. The system turns raw Hive
              context into project cards and six Markdown reports, verifies the evidence that can be checked
              mechanically, then asks the Decision Agent for a single auditable action.
            </p>
          </div>
          <div className="hive-brain-system-summary">
            <span><strong>4</strong><small>LLM stages</small></span>
            <span><strong>6</strong><small>report secretaries</small></span>
            <span><strong>2</strong><small>deterministic verifiers</small></span>
            <span><strong>1</strong><small>guarded action</small></span>
          </div>
        </div>

        <div className="hive-brain-system-flow">
          {flow.map(([number, title, body]) => (
            <article className="hive-brain-card" key={number}>
              <span>{number}</span>
              <strong>{title}</strong>
              <p>{body}</p>
            </article>
          ))}
        </div>

        <div>
          <div className="hive-brain-section-label">Secretaries, agents, and prompts</div>
          <div className="hive-brain-section-sub">Current production path only. Prompt blocks are collapsed until opened.</div>
          <div className="hive-brain-system-grid">
            {boardSystemDocs.map((doc) => <SystemDocCard doc={doc} key={doc.title} />)}
          </div>
        </div>

        <div>
          <div className="hive-brain-section-label">Report secretaries</div>
          <div className="hive-brain-section-sub">Each report has its own instructions and cadence, but shares the same report writer provider.</div>
          <div className="hive-brain-system-grid">
            {reportTabs.map((tab) => <ReportPromptCard key={tab.id} tab={tab} />)}
          </div>
        </div>
      </div>
    </section>
  );
}

function VerificationPipe({ detail }) {
  const verifications = safeArray(detail?.verifications);
  const phases = verifications.length
    ? verifications.slice(0, 3).map((verification, index) => ({
        number: index + 1,
        title: verification.phase || `Phase ${index + 1}`,
        meta: verification.agent || "verification agent",
        stamp: verification.verifiedAt ? `Recorded ${relativeTime(verification.verifiedAt)}` : "Recorded",
      }))
    : [
        { number: 1, title: "Initial report", meta: "Human-readable markdown generated from live Hive data.", stamp: "Generated" },
        { number: 2, title: "Agent verification", meta: "Verifier output is recorded when available.", stamp: "Pending" },
        { number: 3, title: "Final report", meta: "Report feeds the Decision Agent.", stamp: "Active" },
      ];
  return (
    <div className="hive-brain-pipe">
      {phases.map((phase) => (
        <div className="hive-brain-step" key={`${phase.number}-${phase.title}`}>
          <span>{phase.number}</span>
          <strong>{phase.title}</strong>
          <small>{phase.meta}</small>
          <em>{phase.stamp}</em>
        </div>
      ))}
    </div>
  );
}

function ReportPanel({ detail, loading, tab }) {
  const report = detail?.report || {};
  return (
    <section className="hive-brain-panel">
      <div className="hive-brain-panel-head">
        <h2>{tab.title}</h2>
        <div>
          <Badge variant="gray">Every {tab.cadence}</Badge>
          <span>Generated {report.generatedAt ? relativeTime(report.generatedAt) : "unknown"}</span>
          <span>{report.bodyBytes ? `${formatBytes(report.bodyBytes)} markdown` : "markdown report"}</span>
        </div>
      </div>
      <VerificationPipe detail={detail} />
      <div className="hive-brain-card hive-brain-report-document">
        {loading && !detail ? (
          <div className="hive-brain-empty">Loading report detail.</div>
        ) : detail?.ok ? (
          <>
            <div className="hive-brain-table-head">
              <div className="hive-brain-section-label">Final report → Decision Agent</div>
              <div className="hive-brain-section-sub">{report.model || "model unknown"} · {formatTime(report.generatedAt)}</div>
            </div>
            <MarkdownReportBody markdown={report.bodyMarkdown || ""} />
          </>
        ) : (
          <div className="hive-brain-empty">No {tab.title.toLowerCase()} is available yet.</div>
        )}
      </div>
    </section>
  );
}

export function HiveBrainView() {
  const [activeTab, setActiveTab] = useState("overview");
  const [reports, setReports] = useState([]);
  const [reportDetail, setReportDetail] = useState(null);
  const [reportStatus, setReportStatus] = useState("loading");
  const [reportDetailStatus, setReportDetailStatus] = useState("idle");
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [decisionDetail, setDecisionDetail] = useState(null);
  const [decisionDetailStatus, setDecisionDetailStatus] = useState("idle");
  const [harvests, setHarvests] = useState([]);
  const [resolvedHarvests, setResolvedHarvests] = useState([]);
  const [harvestSummary, setHarvestSummary] = useState({});
  const [harvestStatus, setHarvestStatus] = useState("loading");
  const [resolvedHarvestStatus, setResolvedHarvestStatus] = useState("loading");
  const [harvestResolveDraft, setHarvestResolveDraft] = useState(null);
  const [harvestResolveError, setHarvestResolveError] = useState("");
  const [resolvingHarvestId, setResolvingHarvestId] = useState("");
  const [projectDocument, setProjectDocument] = useState(null);
  const [projectStatus, setProjectStatus] = useState("loading");
  const lastGoodProjectDocument = useRef(null);
  const projectRequestSeq = useRef(0);

  const latestByType = useMemo(() => {
    const entries = new Map();
    for (const report of reports) {
      if (report?.type && !entries.has(report.type)) entries.set(report.type, report);
    }
    return entries;
  }, [reports]);
  const activeReportTab = reportTabs.find((tab) => tab.id === activeTab) || null;
  const activeReport = activeReportTab ? latestByType.get(activeReportTab.type) : null;
  const readyTypeCount = reportTabs.filter((tab) => latestByType.has(tab.type)).length;
  const newestReport = reports[0] || null;
  const latestRun = runs[0] || {};
  const projectStats = projectDocument?.stats || {};

  const loadReports = useCallback(async () => {
    setReportStatus("loading");
    try {
      const result = await requestJson("/api/hive/reports?limit=60");
      if (!result.ok) throw new Error(result.body?.message || `Hive reports failed with HTTP ${result.status}`);
      setReports(result.body?.reports || []);
      setReportStatus("ready");
    } catch {
      setReports([]);
      setReportStatus("error");
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const result = await requestJson("/api/hive/decision/runs?limit=12&action=all");
      if (!result.ok) throw new Error(result.body?.message || `Decision Agent runs failed with HTTP ${result.status}`);
      const nextRuns = result.body?.runs || [];
      setRuns(nextRuns);
      setSelectedRunId((current) => current || nextRuns[0]?.id || "");
    } catch {
      setRuns([]);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const requestSeq = projectRequestSeq.current + 1;
    projectRequestSeq.current = requestSeq;
    const canApply = () => projectRequestSeq.current === requestSeq;
    if (!lastGoodProjectDocument.current) setProjectStatus("loading");
    try {
      const result = await requestJson("/api/hive/projects");
      if (!canApply()) return;
      if (!result.ok) throw new Error(result.body?.message || `Hive projects failed with HTTP ${result.status}`);
      const nextDocument = result.body?.document || null;
      if (!validProjectDocument(nextDocument)) throw new Error("Hive projects returned an invalid document.");
      lastGoodProjectDocument.current = nextDocument;
      setProjectDocument(nextDocument);
      setProjectStatus("ready");
    } catch {
      if (!canApply()) return;
      if (lastGoodProjectDocument.current) {
        setProjectDocument(lastGoodProjectDocument.current);
        setProjectStatus("ready");
        return;
      }
      setProjectDocument(null);
      setProjectStatus("error");
    }
  }, []);

  const loadHarvests = useCallback(async () => {
    setHarvestStatus("loading");
    setResolvedHarvestStatus("loading");
    try {
      const [activeResult, resolvedResult] = await Promise.all([
        requestJson("/api/hive/brain/harvests?resolved=false&limit=80"),
        requestJson("/api/hive/brain/harvests?resolved=true&limit=40"),
      ]);
      if (!activeResult.ok) throw new Error(activeResult.body?.message || `Task Accounting harvests failed with HTTP ${activeResult.status}`);
      if (!resolvedResult.ok) throw new Error(resolvedResult.body?.message || `Resolved Task Accounting harvests failed with HTTP ${resolvedResult.status}`);
      setHarvests(activeResult.body?.harvests || []);
      setResolvedHarvests(resolvedResult.body?.harvests || []);
      setHarvestSummary(activeResult.body?.summary || resolvedResult.body?.summary || {});
      setHarvestStatus("ready");
      setResolvedHarvestStatus("ready");
    } catch {
      setHarvests([]);
      setResolvedHarvests([]);
      setHarvestSummary({});
      setHarvestStatus("error");
      setResolvedHarvestStatus("error");
    }
  }, []);

  const openResolveHarvest = useCallback((harvest = null) => {
    if (!harvest?.taskId) return;
    setHarvestResolveError("");
    setHarvestResolveDraft({ harvest, note: "" });
  }, []);

  const closeResolveHarvest = useCallback(() => {
    if (resolvingHarvestId) return;
    setHarvestResolveDraft(null);
    setHarvestResolveError("");
  }, [resolvingHarvestId]);

  const updateResolveNote = useCallback((note = "") => {
    setHarvestResolveDraft((current) => current ? { ...current, note } : current);
    setHarvestResolveError("");
  }, []);

  const submitResolveHarvest = useCallback(async (event) => {
    event?.preventDefault?.();
    const taskId = harvestResolveDraft?.harvest?.taskId || "";
    if (!taskId) return;
    const note = String(harvestResolveDraft?.note || "").trim() || "Resolved from Hive Brain.";
    setResolvingHarvestId(taskId);
    setHarvestResolveError("");
    try {
      const result = await requestJson(`/api/hive/brain/harvests/${encodeURIComponent(taskId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ note }),
      });
      if (!result.ok) throw new Error(result.body?.message || `Resolve failed with HTTP ${result.status}`);
      setHarvests((current) => current.filter((harvest) => harvest.taskId !== taskId));
      if (result.body?.harvest) {
        setResolvedHarvests((current) => [result.body.harvest, ...current.filter((harvest) => harvest.taskId !== taskId)]);
      }
      setHarvestResolveDraft(null);
      loadHarvests();
    } catch (error) {
      setHarvestResolveError(error?.message || "Unable to mark this harvest resolved.");
    } finally {
      setResolvingHarvestId("");
    }
  }, [harvestResolveDraft, loadHarvests]);

  const refreshAll = useCallback(() => {
    loadReports();
    loadRuns();
    loadProjects();
    loadHarvests();
  }, [loadHarvests, loadProjects, loadReports, loadRuns]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!selectedRunId) {
      setDecisionDetail(null);
      return undefined;
    }
    let cancelled = false;
    setDecisionDetailStatus("loading");
    requestJson(`/api/hive/decision/run/${encodeURIComponent(selectedRunId)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `Decision Agent run failed with HTTP ${result.status}`);
        setDecisionDetail(result.body || null);
        setDecisionDetailStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setDecisionDetail(null);
          setDecisionDetailStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!activeReport?.id) {
      setReportDetail(null);
      return undefined;
    }
    let cancelled = false;
    setReportDetailStatus("loading");
    requestJson(`/api/hive/reports/${encodeURIComponent(activeReport.id)}`)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) throw new Error(result.body?.message || `Hive report failed with HTTP ${result.status}`);
        setReportDetail(result.body || null);
        setReportDetailStatus("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setReportDetail(null);
          setReportDetailStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeReport?.id]);

  const openTab = useCallback((tabId) => {
    setActiveTab(tabId);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  return (
    <div className="route-scroll hive-route">
      <div className="hive-brain-page">
        <div className="hive-brain-toolbar">
          <span>Synced {newestReport ? relativeTime(newestReport.generatedAt) : "unknown"}</span>
          <button className="hive-brain-refresh" onClick={refreshAll} type="button">
            <RefreshCw size={13} strokeWidth={2.2} />
            Refresh
          </button>
        </div>

        <header className="hive-brain-head">
          <div>
            <div className="hive-brain-eyebrow"><span />Live · Auditable</div>
            <h1>Hive Brain</h1>
            <p>
              The decision layer for the network. Reports flow up from every role, the Decision Agent reads them,
              and routes work with every action shown in plain English.
            </p>
          </div>
          <div className="hive-brain-head-meta">
            <div>Decision Agent <b>{latestRun.startedAt ? `ran ${relativeTime(latestRun.startedAt)}` : "not loaded"}</b></div>
            <div>Latest action <b>{formatAction(latestRun.selectedAction || latestRun.status)}</b></div>
            <div>Report set <b>{readyTypeCount}/6 ready</b></div>
          </div>
        </header>

        <div className="hive-brain-kpis">
          <Kpi label="Report types" sub={reportStatus === "error" ? "load failed" : "primary inputs"} value={`${readyTypeCount}/6`} />
          <Kpi label="Recent reports" sub="loaded" value={reports.length} />
          <Kpi label="Active projects" sub={projectStatus === "error" ? "unavailable" : "routing boards"} value={projectStatus === "ready" ? projectStats.activeProjects || 0 : "—"} />
          <Kpi label="Open tasks" sub="active rows" value={projectStatus === "ready" ? projectStats.tasksInFlight || 0 : "—"} />
          <Kpi label="Actionable harvests" sub={harvestStatus === "error" ? "load failed" : "reward accounting"} value={harvestStatus === "ready" ? harvestSummary.requiresAction || 0 : "—"} />
          <Kpi accent label="PFT routed" sub="project total" value={projectStatus === "ready" ? compactNumber(projectStats.pftRouted) : "—"} />
          <Kpi label="Decisions loaded" sub={latestRun.startedAt ? relativeTime(latestRun.startedAt) : "none"} value={runs.length} />
        </div>

        <nav className="hive-brain-tabs" aria-label="Hive Brain reports">
          {tabs.map((tab) => (
            <button
              className={`hive-brain-tab ${activeTab === tab.id ? "is-active" : ""}`}
              key={tab.id}
              onClick={() => openTab(tab.id)}
              type="button"
            >
              {tab.label}
              {tab.cadence && <span>{tab.cadence}</span>}
            </button>
          ))}
        </nav>

        {activeTab === "overview" ? (
          <OverviewPanel
            decisionDetail={decisionDetail}
            decisionLoading={decisionDetailStatus === "loading"}
            latestByType={latestByType}
            onOpenReport={openTab}
            onSelectRun={setSelectedRunId}
            projectDocument={projectDocument}
            projectStatus={projectStatus}
            runs={runs}
            selectedRunId={selectedRunId}
          />
        ) : activeTab === "harvests" ? (
          <HarvestPanel
            harvests={harvests}
            onResolve={openResolveHarvest}
            resolvedHarvests={resolvedHarvests}
            resolvedStatus={resolvedHarvestStatus}
            status={harvestStatus}
            summary={harvestSummary}
          />
        ) : activeTab === "docs" ? (
          <SystemDocsPanel />
        ) : (
          <ReportPanel
            detail={reportDetail}
            loading={reportDetailStatus === "loading"}
            tab={activeReportTab}
          />
        )}
        <HarvestResolveDialog
          busy={Boolean(resolvingHarvestId)}
          error={harvestResolveError}
          harvest={harvestResolveDraft?.harvest || null}
          note={harvestResolveDraft?.note || ""}
          onCancel={closeResolveHarvest}
          onNoteChange={updateResolveNote}
          onSubmit={submitResolveHarvest}
        />
      </div>
    </div>
  );
}
