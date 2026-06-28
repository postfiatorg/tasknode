import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, RefreshCw, UserCheck, X } from "lucide-react";
import { requestJson } from "../../api";
import { normalizeHiveReportMarkdown, parseMarkdownBlocks } from "./hive-report-markdown";
import hiveActiveProjectsPrompt from "../../../prompts/hive/hive_active_projects_v1.md?raw";
import hiveDecisionAgentPrompt from "../../../prompts/hive/hive_decision_agent_v1.md?raw";
import hiveSecretaryPrompt from "../../../prompts/hive/hive_secretary_v1.md?raw";
import taskAccountingHarvesterPrompt from "../../../prompts/hive/task_accounting_harvester_v1.md?raw";
import "./hive.css";

const reportTabs = [
  {
    id: "intelligence",
    type: "hive_intelligence",
    label: "Intelligence",
    title: "Hive Intelligence report",
    cadence: "6h",
    summary: "Strategic Hive Mind brief synthesizing all reports into PFT value judgments and action recommendations.",
  },
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

const harvestResolutionOutcomes = [
  { id: "fixed", label: "Fixed" },
  { id: "already_fixed", label: "Already fixed" },
  { id: "not_a_bug", label: "Not a bug" },
  { id: "duplicate", label: "Duplicate" },
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
  hive_intelligence: [
    "Write a strategic intelligence brief for the Hive Mind, not a status report.",
    "The north star is increasing the value of PFT, the Post Fiat cryptocurrency and base reward asset of the Hive Mind.",
    "Ground the analysis in reward value: if PFT is being paid for work that is unlikely to increase PFT value, say so plainly and recommend corrective action.",
    "Reference operators by handle, wallet, and account when available in the packet.",
    "Stay within roughly 2-3 single-spaced pages. Be concise but do not truncate the brief or end with an unfinished section.",
    "Use these top-level sections in this order:",
    "A] Classification: state exactly `Public, Hive Mind`.",
    "B] Title and Key Question: make the title/key question reflect the current network state and dynamics around increasing PFT Network value.",
    "C] BLUF / Key Judgments: bullets that state the bottom-line assessment and so-what. Each judgment must include a confidence level (High, Moderate, or Low), probability language (almost certainly, likely, unlikely, etc.), and the main source of uncertainty.",
    "D] Scope / Note / Context: describe which reports flowed into the intelligence brief: Operative, Rewarded Task, KOL, Development, QA, Executive, Harvest Report, Live Task Packet, and Board Secretary memos.",
    "E] Discussion / Analysis: build a logical argument from the packet evidence. Clearly distinguish confirmed fact, analytic estimate, and assumption. Include objections, rebuttals, or alternative hypotheses where material.",
    "F] Implications / Outlook: consequences, second/third-order effects, what to watch, what could change the conclusion, and concrete actions in the available action space.",
    "Available action space is: deploy tasks to members, send messages to people, or recommend founder-level changes to Task Node or other network assets.",
    "Concrete task deployment or reassignment recommendations must obey SOURCE PACKET taskRoutingConstraints. If a task has requiredBadgeId or operatingBadgeId, recommend only operators listed in that task's eligibleReplacementOperators or in eligibleOperatorsByBadge for the required badge.",
    "Never infer task eligibility from profile text, point-person status, prior rewarded tasks, skills, wallet history, or general operator quality. If a high-quality operator lacks the required badge, recommend a message, a new correctly scoped task, or a founder-level badge/policy change instead of assigning the task to them.",
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
    "Do not recommend clawbacks, bans, or enforcement execution. Reward routing, task strategy, and founder-level network recommendations are allowed when tied to evidence.",
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
    reads: "Verified badges, live task state, rewarded task history, Hive chat, dynamic projects, Harvest Report, Live Task Packet, and Board Secretary memos.",
    writes: "Human-readable Markdown reports used as primary Decision Agent inputs, including the 6-hour Hive Intelligence Report.",
    body: "This replaces raw packet reading with operator-readable reports. KOL and Development reports run a verifier pass before the final report is stored; Hive Intelligence synthesizes the report set into strategy.",
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
    reads: "The Hive report set, live task state, board discussions, idle eligible contributors, and dedup index.",
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

function timestampMs(value = "") {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
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

function sameText(left = "", right = "") {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
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
        if (block.type === "rule") return <hr key={`${block.type}-${index}`} />;
        if (block.type === "code") return <pre key={`${block.type}-${index}`}>{block.text}</pre>;
        if (block.type === "table") {
          const columnCount = Math.max(block.header.length, ...block.rows.map((row) => row.length));
          const cellsFor = (row) => Array.from({ length: columnCount }, (_, cellIndex) => row[cellIndex] || "");
          return (
            <div className="hive-report-table-wrap" key={`${block.type}-${index}`}>
              <table>
                <thead>
                  <tr>
                    {cellsFor(block.header).map((cell, cellIndex) => <th key={`${index}-head-${cellIndex}`}>{cell}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${index}-row-${rowIndex}`}>
                      {cellsFor(row).map((cell, cellIndex) => <td key={`${index}-${rowIndex}-${cellIndex}`}>{cell}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
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

function cleanInlineMarkdown(value = "") {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#+\s+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactReportExcerpt(value = "", max = 280) {
  const text = cleanInlineMarkdown(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function metadataOnlyExcerpt(value = "") {
  const text = cleanInlineMarkdown(value);
  return Boolean(text) && /^(generated|report type|phase|scope|report date|report generated)\b/i.test(text);
}

function tableExcerpt(block = {}, heading = "") {
  const rows = Array.isArray(block.rows) ? block.rows.slice(0, 4) : [];
  if (!rows.length) return "";
  const header = Array.isArray(block.header) ? block.header : [];
  const pairs = rows.map((row) => {
    const cells = Array.isArray(row) ? row : [];
    if (header.length === 2 && /^metric$/i.test(header[0] || "") && /^value$/i.test(header[1] || "")) {
      return `${cells[0] || "Metric"}: ${cells[1] || "unknown"}`;
    }
    return cells.slice(0, 3).filter(Boolean).join(" / ");
  }).filter(Boolean);
  if (!pairs.length) return "";
  return compactReportExcerpt([heading, pairs.join("; ")].filter(Boolean).join(": "));
}

function reportExcerpt(report = {}) {
  const source = report.bodyMarkdown || report.bodyExcerpt || report.bodyMarkdownExcerpt || "";
  const blocks = parseMarkdownBlocks(source);
  let latestHeading = "";
  for (const block of blocks) {
    if (block.type === "heading") {
      latestHeading = cleanInlineMarkdown(block.text);
      continue;
    }
    if (block.type === "paragraph") {
      const text = compactReportExcerpt(block.text);
      if (text && !metadataOnlyExcerpt(text)) return text;
      continue;
    }
    if (block.type === "unordered" || block.type === "ordered") {
      const text = compactReportExcerpt((block.items || []).slice(0, 3).join("; "));
      if (text) return text;
      continue;
    }
    if (block.type === "table") {
      const text = tableExcerpt(block, latestHeading);
      if (text) return text;
    }
  }
  return compactReportExcerpt(normalizeHiveReportMarkdown(source)) || "Open the report for the full markdown briefing.";
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

function sortResolvedHarvests(harvests = []) {
  return safeArray(harvests)
    .slice()
    .sort((left, right) =>
      timestampMs(right.resolvedAt || right.updatedAt || right.completedAt) -
        timestampMs(left.resolvedAt || left.updatedAt || left.completedAt) ||
      String(right.taskId || "").localeCompare(String(left.taskId || ""))
    );
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

function LiveTaskPacketTaskList({ empty = "None.", tasks = [] }) {
  const rows = safeArray(tasks);
  if (!rows.length) return <div className="hive-brain-live-task-empty">{empty}</div>;
  return (
    <div className="hive-brain-live-task-list">
      {rows.map((task) => (
        <div className="hive-brain-live-task-row" key={task.taskId || `${task.title}-${task.updatedAt}`}>
          <div>
            <strong>{task.title || task.taskId || "Untitled Network Task"}</strong>
            <span>
              {task.projectTitle && <em>{task.projectTitle}</em>}
              {task.taskId && <code>{task.taskId}</code>}
            </span>
          </div>
          <div>
            <Status type={task.status}>{formatAction(task.status)}</Status>
            <b>{compactNumber(task.rewardActualPft || task.rewardOfferPft)} PFT</b>
            <small>{relativeTime(task.updatedAt || task.lastEventAt)}</small>
          </div>
        </div>
      ))}
    </div>
  );
}

function LiveTaskPacketProfile({ profile = null }) {
  const skills = safeArray(profile?.skills).filter(Boolean);
  if (!profile?.roleTitle && !profile?.roleSummary && !skills.length && !profile?.usefulTo) {
    return (
      <div className="hive-brain-live-profile is-missing">
        No completed public profile description card is available for this account.
      </div>
    );
  }
  return (
    <div className="hive-brain-live-profile">
      {profile.roleTitle && <strong>{profile.roleTitle}</strong>}
      {profile.roleSummary && <p>{profile.roleSummary}</p>}
      {skills.length > 0 && (
        <div className="hive-brain-live-skills">
          {skills.map((skill) => <span key={skill}>{skill}</span>)}
        </div>
      )}
      {profile.usefulTo && <p><b>Best fit:</b> {profile.usefulTo}</p>}
    </div>
  );
}

function LiveTaskPacketContributor({ contributor = {}, index = 0 }) {
  const label = contributor.handle
    ? `@${String(contributor.handle).replace(/^@+/, "")}`
    : contributor.displayName || contributor.accountId || compactWallet(contributor.walletAddress);
  const badges = safeArray(contributor.badges);
  const taskCount = safeArray(contributor.proposals).length +
    safeArray(contributor.outstanding).length +
    safeArray(contributor.rewarded).length;
  return (
    <details className="hive-brain-live-contributor" open={index < 3}>
      <summary>
        <div>
          <strong>Contributor {index + 1}: {label}</strong>
          <span>
            {contributor.accountId && <code>{contributor.accountId}</code>}
            {contributor.walletAddress && <code>{contributor.walletAddress}</code>}
          </span>
        </div>
        <div>
          <Badge variant={taskCount ? "gray" : "amber"}>{taskCount} tasks</Badge>
          <Badge variant={badges.length ? "blue" : "gray"}>{badges.length ? badges.join(", ") : "No badges"}</Badge>
        </div>
      </summary>
      <div className="hive-brain-live-contributor-body">
        <details open>
          <summary>Network Task Assigned Proposal</summary>
          <LiveTaskPacketTaskList tasks={contributor.proposals} />
        </details>
        <details open>
          <summary>Network Task Outstanding</summary>
          <LiveTaskPacketTaskList tasks={contributor.outstanding} />
        </details>
        <details>
          <summary>Last 5 Rewarded Network Tasks</summary>
          <LiveTaskPacketTaskList tasks={contributor.rewarded} />
        </details>
        <details>
          <summary>Contributor Description Card</summary>
          <LiveTaskPacketProfile profile={contributor.profile} />
        </details>
      </div>
    </details>
  );
}

function LiveTaskPacketCard({ packet = null, status = "loading", onRefresh }) {
  const generatedLabel = packet?.generatedAt ? formatTime(packet.generatedAt) : "not generated";
  const contributors = safeArray(packet?.contributors);
  return (
    <div className="hive-brain-card hive-brain-live-task-packet">
      <div className="hive-brain-live-task-packet-head">
        <div>
          <div className="hive-brain-section-label">Live Task Packet</div>
          <div className="hive-brain-section-sub">
            Plain-English contributor packet from task, profile, and badge rows. Refreshes every 30 seconds.
          </div>
        </div>
        <div className="hive-brain-live-task-packet-meta">
          <span>{generatedLabel}</span>
          <button onClick={onRefresh} type="button">
            <RefreshCw size={13} strokeWidth={2} />
            Refresh
          </button>
        </div>
      </div>
      {status === "loading" && !packet?.text && <div className="hive-brain-empty">Loading Live Task Packet.</div>}
      {status === "error" && !packet?.text && <div className="hive-brain-empty">Live Task Packet is unavailable.</div>}
      {contributors.length > 0 && (
        <div className="hive-brain-live-contributors">
          {contributors.map((contributor, index) => (
            <LiveTaskPacketContributor
              contributor={contributor}
              index={index}
              key={contributor.key || contributor.accountId || contributor.walletAddress || index}
            />
          ))}
        </div>
      )}
      {status === "ready" && packet && !contributors.length && (
        <div className="hive-brain-empty">No assigned or recently rewarded Network Task contributors are available.</div>
      )}
      {packet?.text && (
        <details className="hive-brain-live-raw">
          <summary>Plain text packet</summary>
          <pre>{packet.text}</pre>
        </details>
      )}
    </div>
  );
}

function HarvestOutputRow({
  checkoutBusy = false,
  harvest,
  onCheckout,
  onResolve,
  permissions = {},
}) {
  const classification = harvest.classification || harvest.status || "not_harvested";
  const isResolved = Boolean(harvest.resolved || harvest.resolvedAt);
  const checkout = harvest.checkout || {};
  const checkoutWallet = checkout.walletAddress || harvest.checkedOutWalletAddress || "";
  const checkoutAccountId = checkout.accountId || harvest.checkedOutByAccountId || "";
  const isCheckedOut = Boolean(checkout.checkedOut || checkout.checkedOutAt || harvest.checkedOutAt);
  const checkedOutByYou = isCheckedOut && sameText(checkoutWallet, permissions.walletAddress);
  const checkoutLabel = isCheckedOut
    ? checkedOutByYou ? "Checked out to you" : "Checked out"
    : !permissions.canCheckout
      ? permissions.reason === "linked_wallet_required" ? "Link wallet to check out" : "Core contributor only"
      : checkoutBusy ? "Checking out..." : "Check out";
  const checkoutDisabled = checkoutBusy || isResolved || isCheckedOut || !permissions.canCheckout;
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
          <div className="hive-brain-harvest-title-row">
            <strong>{harvest.title || "Untitled rewarded task"}</strong>
            {harvest.taskId && <code className="hive-brain-harvest-task-id">{harvest.taskId}</code>}
          </div>
          <span>{summaryText}</span>
        </div>
        <div className="hive-brain-harvest-output-meta">
          <Status type={classification}>{formatAction(classification)}</Status>
          {isCheckedOut && <Status type="checked-out">Checked out</Status>}
          {isResolved && <Status type="resolved">Resolved</Status>}
          {isResolved && <span className="hive-brain-harvest-output-time">Resolved {relativeTime(harvest.resolvedAt)}</span>}
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
          {isCheckedOut && <span><small>Checked out</small><strong>{relativeTime(checkout.checkedOutAt || harvest.checkedOutAt)}</strong></span>}
          {isCheckedOut && <span><small>Checkout wallet</small><code>{compactWallet(checkoutWallet)}</code></span>}
          {isCheckedOut && <span><small>Checkout account</small><code>{checkoutAccountId || "unknown"}</code></span>}
          {isResolved && <span><small>Resolved</small><strong>{relativeTime(harvest.resolvedAt)}</strong></span>}
          {isResolved && harvest.resolutionOutcome && <span><small>Outcome</small><strong>{formatAction(harvest.resolutionOutcome)}</strong></span>}
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
          {!isResolved && (
            <button
              className="is-secondary"
              disabled={checkoutDisabled}
              onClick={() => onCheckout?.(harvest)}
              type="button"
            >
              <UserCheck size={13} strokeWidth={2.1} />
              {checkoutLabel}
            </button>
          )}
          <button
            disabled={isResolved}
            onClick={() => onResolve?.(harvest)}
            type="button"
          >
            {isResolved ? "Resolved" : "Close"}
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
  outcome = "",
  onCancel,
  onNoteChange,
  onOutcomeChange,
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
            Close harvest
          </span>
          <button className="htp-close" disabled={busy} onClick={onCancel} type="button">
            <X size={14} strokeWidth={1.8} />
            Close
          </button>
        </header>
        <form className="hive-harvest-resolve-form" onSubmit={onSubmit}>
          <div>
            <h2 id="hive-harvest-resolve-title">Close only after proof</h2>
            <p>{harvest.title || harvest.taskId || "Untitled rewarded task"}</p>
          </div>
          <label>
            <span>Outcome</span>
            <select
              onChange={(event) => onOutcomeChange?.(event.target.value)}
              value={outcome}
            >
              <option value="">Choose real outcome</option>
              {harvestResolutionOutcomes.map((item) => (
                <option key={item.id} value={item.id}>{item.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Closeout comment</span>
            <textarea
              maxLength={6000}
              onChange={(event) => onNoteChange?.(event.target.value)}
              placeholder="State the actual fix/proof, existing duplicate, or why it was not a bug. QA packets do not count."
              ref={textareaRef}
              value={note}
            />
          </label>
          {error && <div className="hive-harvest-resolve-error">{error}</div>}
          <footer>
            <button disabled={busy} onClick={onCancel} type="button">Cancel</button>
            <button disabled={busy} type="submit">
              {busy ? "Saving..." : "Close"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function HarvestCheckoutLog({ events = [], status = "loading" }) {
  return (
    <div className="hive-brain-card hive-brain-harvest-card">
      <div className="hive-brain-table-head">
        <div className="hive-brain-section-label">Active checkouts</div>
        <div className="hive-brain-section-sub">Unresolved harvest rows currently owned for follow-up.</div>
      </div>
      <div className="hive-brain-checkout-log">
        {events.map((event) => (
          <div className="hive-brain-checkout-row" key={event.id || `${event.taskId}-${event.createdAt}`}>
            <div>
              <strong>{event.title || event.taskId || "Untitled harvest"}</strong>
              <span>{compactWallet(event.walletAddress)} checked out {relativeTime(event.createdAt)}</span>
            </div>
            <div>
              {event.current && <Status type="checked-out">Current</Status>}
              {event.resolved && <Status type="resolved">Resolved</Status>}
              <code>{event.taskId}</code>
            </div>
          </div>
        ))}
        {status === "loading" && <div className="hive-brain-empty">Loading checkout log.</div>}
        {status === "error" && <div className="hive-brain-empty">Checkout log is unavailable.</div>}
        {status === "ready" && !events.length && <div className="hive-brain-empty">No unresolved harvest rows are checked out right now.</div>}
      </div>
    </div>
  );
}

function HarvestPanel({
  checkoutError = "",
  checkoutLog = [],
  checkoutStatus = "loading",
  checkingOutHarvestId = "",
  harvests = [],
  onCheckout,
  onResolve,
  permissions = {},
  resolvedHarvests = [],
  resolvedStatus = "loading",
  summary = {},
  status = "loading",
}) {
  const sortedResolvedHarvests = sortResolvedHarvests(resolvedHarvests);
  return (
    <section className="hive-brain-panel">
      <div className="hive-brain-panel-head">
        <h2>Task Accounting Harvester</h2>
        <div>
          <Badge variant="gray">DeepSeek V4 Pro</Badge>
          <span>{summary.harvested || 0} harvested</span>
          <span>{summary.queued || 0} queued</span>
          <span>{summary.requiresAction || 0} actionable</span>
          <span>{summary.checkedOut || 0} checked out</span>
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
      {checkoutError && <div className="hive-harvest-resolve-error hive-harvest-checkout-error">{checkoutError}</div>}
      <div className="hive-brain-card hive-brain-harvest-card">
        <div className="hive-brain-table-head">
          <div className="hive-brain-section-label">Unresolved rewarded Network Task harvests</div>
          <div className="hive-brain-section-sub">Each open output expands into the accounting assessment, suggested follow-up, and resolve action.</div>
        </div>
        <div className="hive-brain-harvest-output-list">
          {harvests.map((harvest) => (
            <HarvestOutputRow
              checkoutBusy={checkingOutHarvestId === harvest.taskId}
              harvest={harvest}
              key={harvest.taskId}
              onCheckout={onCheckout}
              onResolve={onResolve}
              permissions={permissions}
            />
          ))}
          {status === "loading" && <div className="hive-brain-empty">Loading harvest queue.</div>}
          {status === "error" && <div className="hive-brain-empty">Task Accounting harvests are unavailable.</div>}
          {status === "ready" && !harvests.length && <div className="hive-brain-empty">No unresolved rewarded Network Task harvests are available.</div>}
        </div>
      </div>
      <HarvestCheckoutLog events={checkoutLog} status={checkoutStatus} />
      <div className="hive-brain-card hive-brain-harvest-card">
        <div className="hive-brain-table-head">
          <div className="hive-brain-section-label">Resolved history</div>
          <div className="hive-brain-section-sub">Resolved harvest rows stay visible here with the operator comment used to close them.</div>
        </div>
        <div className="hive-brain-harvest-output-list">
          {sortedResolvedHarvests.map((harvest) => (
            <HarvestOutputRow
              harvest={harvest}
              key={harvest.taskId}
              onResolve={onResolve}
              permissions={permissions}
            />
          ))}
          {resolvedStatus === "loading" && <div className="hive-brain-empty">Loading resolved harvest history.</div>}
          {resolvedStatus === "error" && <div className="hive-brain-empty">Resolved harvest history is unavailable.</div>}
          {resolvedStatus === "ready" && !resolvedHarvests.length && <div className="hive-brain-empty">No resolved harvest rows yet.</div>}
        </div>
      </div>
    </section>
  );
}

function HarvestReportCard({ packet = null, status = "loading", onRefresh }) {
  const report = packet?.report || null;
  const pending = Boolean(packet?.pending);
  const resolvedUntilNext = Number(packet?.resolvedUntilNextReport || 0);
  return (
    <div className="hive-brain-card hive-brain-harvest-report-card">
      <div className="hive-brain-live-task-packet-head">
        <div>
          <div className="hive-brain-section-label">Harvest Report</div>
          <div className="hive-brain-section-sub">
            Plain-English report from resolved harvest history. Regenerates every 3 resolved harvests.
          </div>
        </div>
        <div className="hive-brain-live-task-packet-meta">
          <span>{report?.generatedAt ? `Updated ${relativeTime(report.generatedAt)}` : pending ? "pending" : "not generated"}</span>
          <button onClick={onRefresh} type="button">
            <RefreshCw size={13} strokeWidth={2} />
            Refresh
          </button>
        </div>
      </div>
      {status === "loading" && !report && <div className="hive-brain-empty">Loading Harvest Report.</div>}
      {status === "error" && !report && <div className="hive-brain-empty">Harvest Report is unavailable.</div>}
      {status === "ready" && !report && (
        <div className="hive-brain-empty">
          {pending
            ? `Harvest Report will generate after ${resolvedUntilNext || 3} more resolved harvest${resolvedUntilNext === 1 ? "" : "s"}.`
            : "No Harvest Report has been generated yet."}
        </div>
      )}
      {report?.bodyMarkdown && (
        <div className="hive-brain-harvest-report-body">
          <MarkdownReportBody markdown={report.bodyMarkdown} />
        </div>
      )}
    </div>
  );
}

function ReportsGrid({ harvestReport, harvestReportStatus, latestByType, onOpenHarvestReport, onOpenReport }) {
  const report = harvestReport?.report || null;
  const pending = Boolean(harvestReport?.pending);
  const resolvedUntilNext = Number(harvestReport?.resolvedUntilNextReport || 0);
  return (
    <div>
      <div className="hive-brain-section-label">Reports & generations</div>
      <div className="hive-brain-section-sub">Human-readable reports and generated digests. Click any report to read it.</div>
      <div className="hive-brain-report-grid">
        <button className="hive-brain-report-card" onClick={onOpenHarvestReport} type="button">
          <div className="hive-brain-report-card-top">
            <span>Harvest report</span>
            <Badge variant={report ? "gray" : pending ? "amber" : "red"}>
              {report ? "every 3" : pending ? "pending" : "missing"}
            </Badge>
          </div>
          <div className="hive-brain-report-take">
            {report
              ? reportExcerpt(report)
              : harvestReportStatus === "loading"
                ? "Loading Harvest Report."
                : pending
                  ? `Harvest Report will generate after ${resolvedUntilNext || 3} more resolved harvest${resolvedUntilNext === 1 ? "" : "s"}.`
                  : "No Harvest Report generated yet."}
          </div>
          <div className="hive-brain-report-foot">
            <span>{report ? `Updated ${relativeTime(report.generatedAt)}` : "Not generated"}</span>
            <strong>Open →</strong>
          </div>
        </button>
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
  harvestReport,
  harvestReportStatus,
  latestByType,
  liveTaskPacket,
  liveTaskPacketStatus,
  onOpenReport,
  onRefreshHarvestReport,
  onRefreshLiveTaskPacket,
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
        <LiveTaskPacketCard
          packet={liveTaskPacket}
          status={liveTaskPacketStatus}
          onRefresh={onRefreshLiveTaskPacket}
        />
        <ReportsGrid
          harvestReport={harvestReport}
          harvestReportStatus={harvestReportStatus}
          latestByType={latestByType}
          onOpenHarvestReport={() => onOpenReport("harvest-report")}
          onOpenReport={onOpenReport}
        />
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
    ["03", "Projects + Reports", "The project planner refreshes board cards while seven report secretaries produce human-readable Markdown."],
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
              context into project cards and seven Markdown reports, verifies the evidence that can be checked
              mechanically, then asks the Decision Agent for a single auditable action.
            </p>
          </div>
          <div className="hive-brain-system-summary">
            <span><strong>4</strong><small>LLM stages</small></span>
            <span><strong>7</strong><small>report secretaries</small></span>
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
  const [harvestCheckoutLog, setHarvestCheckoutLog] = useState([]);
  const [harvestCheckoutStatus, setHarvestCheckoutStatus] = useState("loading");
  const [harvestPermissions, setHarvestPermissions] = useState({});
  const [harvestSummary, setHarvestSummary] = useState({});
  const [harvestStatus, setHarvestStatus] = useState("loading");
  const [resolvedHarvestStatus, setResolvedHarvestStatus] = useState("loading");
  const [harvestReport, setHarvestReport] = useState(null);
  const [harvestReportStatus, setHarvestReportStatus] = useState("loading");
  const [checkingOutHarvestId, setCheckingOutHarvestId] = useState("");
  const [harvestCheckoutError, setHarvestCheckoutError] = useState("");
  const [harvestResolveDraft, setHarvestResolveDraft] = useState(null);
  const [harvestResolveError, setHarvestResolveError] = useState("");
  const [resolvingHarvestId, setResolvingHarvestId] = useState("");
  const [projectDocument, setProjectDocument] = useState(null);
  const [projectStatus, setProjectStatus] = useState("loading");
  const [liveTaskPacket, setLiveTaskPacket] = useState(null);
  const [liveTaskPacketStatus, setLiveTaskPacketStatus] = useState("loading");
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
      const result = await requestJson("/api/hive/reports?limit=60&includeLatestByType=true");
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

  const loadLiveTaskPacket = useCallback(async () => {
    setLiveTaskPacketStatus("loading");
    try {
      const result = await requestJson("/api/hive/brain/live-task-packet?limit=24");
      if (!result.ok) throw new Error(result.body?.message || `Live Task Packet failed with HTTP ${result.status}`);
      setLiveTaskPacket(result.body?.packet || null);
      setLiveTaskPacketStatus("ready");
    } catch {
      setLiveTaskPacketStatus("error");
    }
  }, []);

  const loadHarvestReport = useCallback(async () => {
    setHarvestReportStatus("loading");
    try {
      const result = await requestJson("/api/hive/brain/harvest-report");
      if (!result.ok) throw new Error(result.body?.message || `Harvest Report failed with HTTP ${result.status}`);
      setHarvestReport(result.body || null);
      setHarvestReportStatus("ready");
    } catch {
      setHarvestReportStatus("error");
    }
  }, []);

  const loadHarvests = useCallback(async () => {
    setHarvestStatus("loading");
    setResolvedHarvestStatus("loading");
    setHarvestCheckoutStatus("loading");
    try {
      const [activeResult, resolvedResult, checkoutResult] = await Promise.all([
        requestJson("/api/hive/brain/harvests?resolved=false&limit=80"),
        requestJson("/api/hive/brain/harvests?resolved=true&limit=40"),
        requestJson("/api/hive/brain/harvest-checkouts?limit=80"),
      ]);
      if (!activeResult.ok) throw new Error(activeResult.body?.message || `Task Accounting harvests failed with HTTP ${activeResult.status}`);
      if (!resolvedResult.ok) throw new Error(resolvedResult.body?.message || `Resolved Task Accounting harvests failed with HTTP ${resolvedResult.status}`);
      if (!checkoutResult.ok) throw new Error(checkoutResult.body?.message || `Task Accounting checkout log failed with HTTP ${checkoutResult.status}`);
      setHarvests(activeResult.body?.harvests || []);
      setResolvedHarvests(resolvedResult.body?.harvests || []);
      setHarvestCheckoutLog(checkoutResult.body?.events || []);
      setHarvestPermissions(activeResult.body?.permissions || checkoutResult.body?.permissions || {});
      setHarvestSummary(activeResult.body?.summary || resolvedResult.body?.summary || {});
      setHarvestStatus("ready");
      setResolvedHarvestStatus("ready");
      setHarvestCheckoutStatus("ready");
    } catch {
      setHarvests([]);
      setResolvedHarvests([]);
      setHarvestCheckoutLog([]);
      setHarvestPermissions({});
      setHarvestSummary({});
      setHarvestStatus("error");
      setResolvedHarvestStatus("error");
      setHarvestCheckoutStatus("error");
    }
  }, []);

  const checkoutHarvest = useCallback(async (harvest = null) => {
    const taskId = harvest?.taskId || "";
    if (!taskId || checkingOutHarvestId) return;
    setCheckingOutHarvestId(taskId);
    setHarvestCheckoutError("");
    try {
      const result = await requestJson(`/api/hive/brain/harvests/${encodeURIComponent(taskId)}/checkout`, {
        method: "POST",
      });
      if (!result.ok) throw new Error(result.body?.message || `Checkout failed with HTTP ${result.status}`);
      if (result.body?.permissions) setHarvestPermissions(result.body.permissions);
      if (result.body?.harvest) {
        setHarvests((current) => current.map((row) => row.taskId === taskId ? result.body.harvest : row));
      }
      if (result.body?.event) {
        setHarvestCheckoutLog((current) => [result.body.event, ...current.filter((event) => event.id !== result.body.event.id)]);
      }
      loadHarvests();
    } catch (error) {
      setHarvestCheckoutError(error?.message || "Unable to check out this harvest row.");
    } finally {
      setCheckingOutHarvestId("");
    }
  }, [checkingOutHarvestId, loadHarvests]);

  const openResolveHarvest = useCallback((harvest = null) => {
    if (!harvest?.taskId) return;
    setHarvestResolveError("");
    setHarvestResolveDraft({ harvest, note: "", outcome: "" });
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

  const updateResolveOutcome = useCallback((outcome = "") => {
    setHarvestResolveDraft((current) => current ? { ...current, outcome } : current);
    setHarvestResolveError("");
  }, []);

  const submitResolveHarvest = useCallback(async (event) => {
    event?.preventDefault?.();
    const taskId = harvestResolveDraft?.harvest?.taskId || "";
    if (!taskId) return;
    const note = String(harvestResolveDraft?.note || "").trim();
    const outcome = String(harvestResolveDraft?.outcome || "").trim();
    if (!outcome) {
      setHarvestResolveError("Choose the real closeout outcome before closing this harvest row.");
      return;
    }
    if (!note) {
      setHarvestResolveError("Add the fix/proof or not-a-bug explanation before closing this harvest row.");
      return;
    }
    setResolvingHarvestId(taskId);
    setHarvestResolveError("");
    try {
      const result = await requestJson(`/api/hive/brain/harvests/${encodeURIComponent(taskId)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ note, outcome }),
      });
      if (!result.ok) throw new Error(result.body?.message || `Resolve failed with HTTP ${result.status}`);
      setHarvests((current) => current.filter((harvest) => harvest.taskId !== taskId));
      if (result.body?.harvest) {
        setResolvedHarvests((current) => [result.body.harvest, ...current.filter((harvest) => harvest.taskId !== taskId)]);
      }
      if (result.body?.harvestReport) {
        setHarvestReport({ ok: true, report: result.body.harvestReport });
        setHarvestReportStatus("ready");
      }
      setHarvestResolveDraft(null);
      loadHarvestReport();
      loadHarvests();
    } catch (error) {
      setHarvestResolveError(error?.message || "Unable to mark this harvest resolved.");
    } finally {
      setResolvingHarvestId("");
    }
  }, [harvestResolveDraft, loadHarvestReport, loadHarvests]);

  const refreshAll = useCallback(() => {
    loadReports();
    loadRuns();
    loadProjects();
    loadLiveTaskPacket();
    loadHarvestReport();
    loadHarvests();
  }, [loadHarvestReport, loadHarvests, loadLiveTaskPacket, loadProjects, loadReports, loadRuns]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      loadLiveTaskPacket();
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [loadLiveTaskPacket]);

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
            <div>Report set <b>{readyTypeCount}/{reportTabs.length} ready</b></div>
          </div>
        </header>

        <div className="hive-brain-kpis">
          <Kpi label="Report types" sub={reportStatus === "error" ? "load failed" : "primary inputs"} value={`${readyTypeCount}/${reportTabs.length}`} />
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
            harvestReport={harvestReport}
            harvestReportStatus={harvestReportStatus}
            latestByType={latestByType}
            liveTaskPacket={liveTaskPacket}
            liveTaskPacketStatus={liveTaskPacketStatus}
            onOpenReport={openTab}
            onRefreshHarvestReport={loadHarvestReport}
            onRefreshLiveTaskPacket={loadLiveTaskPacket}
            onSelectRun={setSelectedRunId}
            runs={runs}
            selectedRunId={selectedRunId}
          />
        ) : activeTab === "harvest-report" ? (
          <section className="hive-brain-panel">
            <HarvestReportCard
              packet={harvestReport}
              status={harvestReportStatus}
              onRefresh={loadHarvestReport}
            />
          </section>
        ) : activeTab === "harvests" ? (
          <HarvestPanel
            checkoutError={harvestCheckoutError}
            checkoutLog={harvestCheckoutLog}
            checkoutStatus={harvestCheckoutStatus}
            checkingOutHarvestId={checkingOutHarvestId}
            harvests={harvests}
            onCheckout={checkoutHarvest}
            onResolve={openResolveHarvest}
            permissions={harvestPermissions}
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
          outcome={harvestResolveDraft?.outcome || ""}
          onCancel={closeResolveHarvest}
          onNoteChange={updateResolveNote}
          onOutcomeChange={updateResolveOutcome}
          onSubmit={submitResolveHarvest}
        />
      </div>
    </div>
  );
}
