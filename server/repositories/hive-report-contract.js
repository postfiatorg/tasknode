import { markdownHeading, stripBullet } from "../inference-text.js";
import { isWhitespace, replaceCharacterRuns, trimCharacters } from "../../shared/text-protocol.js";
import { databaseEnabled } from "../db/pool.js";

export const hiveReportVersion = "hive_reports.v1";

export const hiveReportTypes = Object.freeze({
  operative: {
    type: "operative",
    label: "Operative",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Per-role operator context, allocation state, and current task descriptions.",
  },
  rewarded_task: {
    type: "rewarded_task",
    label: "Rewarded Task",
    cadenceMs: 20 * 60 * 1000,
    summary: "Last rewarded Network Tasks per verified role, including proposal and reward context.",
  },
  kol: {
    type: "kol",
    label: "KOL",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Marketing state, public amplification evidence, KOL operators, and trajectory.",
    verifier: "kol_link_verifier",
  },
  development: {
    type: "development",
    label: "Development",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Core development state, tasks, repository evidence, and delivery risks.",
    verifier: "dev_repo_verifier",
  },
  qa: {
    type: "qa",
    label: "QA",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Product QA activity, user-flow findings, and suggested improvements.",
  },
  executive: {
    type: "executive",
    label: "Executive",
    cadenceMs: 24 * 60 * 60 * 1000,
    summary: "Project Leader Hive chat over the past 24 hours.",
  },
  hive_intelligence: {
    type: "hive_intelligence",
    label: "Hive Intelligence",
    cadenceMs: 6 * 60 * 60 * 1000,
    summary: "Strategic network intelligence brief synthesized from Hive reports, Harvest Report, Live Task Packet, and Board Secretary memos.",
  },
  board_manager_planning: {
    type: "board_manager_planning",
    label: "Board Manager Planning",
    cadenceMs: 3 * 60 * 60 * 1000,
    summary: "Portfolio-level Board Manager planning loop that ranks boards and recommends add/archive actions from Hive Intelligence and live board state.",
  },
});

export const hiveReportTypeIds = Object.freeze(Object.keys(hiveReportTypes));

export const roleDefinitions = Object.freeze({
  kol: { badgeId: "kol", label: "KOL", reportGroup: "marketing" },
  core_contributor: { badgeId: "core_contributor", label: "Core Contributor", reportGroup: "development" },
  project_leader: { badgeId: "project_leader", label: "Project Leader", reportGroup: "executive" },
  qa_worker: { badgeId: "qa_worker", label: "QA Worker", reportGroup: "qa" },
  expert: { badgeId: "expert", label: "Expert", reportGroup: "expert" },
});

export const activeProjectTaskStatuses = Object.freeze([
  "proposed",
  "accepted",
  "submitted",
  "verification_requested",
  "verification_response_submitted",
  "reward_decided",
]);

export function useDatabase() {
  return databaseEnabled();
}

export function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function firstText(...values) {
  for (const value of values) {
    const text = safeText(value, 500);
    if (text) return text;
  }
  return "";
}

export function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : fallback;
}

export function iso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

export function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

export function tableReportType(type = "") {
  const normalized = safeText(type, 80);
  if (!hiveReportTypes[normalized]) {
    const error = new Error("hive_report_type_invalid");
    error.status = 400;
    throw error;
  }
  return normalized;
}

export function markdownBody(value = "") {
  const body = safeText(value, 250_000);
  if (!body) {
    const error = new Error("hive_report_body_required");
    error.status = 400;
    throw error;
  }
  const first = body.trimStart().slice(0, 1);
  if (first === "{" || first === "[") {
    const error = new Error("hive_report_body_must_be_markdown");
    error.status = 400;
    throw error;
  }
  return body;
}

// Decision labels are a report protocol. Prose is displayed, never classified by keywords.
export function cleanReportDecisionText(value = "") {
  const text = stripBullet(markdownHeading(value) || value);
  return replaceCharacterRuns(text, isWhitespace, " ").trim();
}

export function extractMarkdownHeadingSection(markdown = "", expectedHeading = "") {
  const lines = String(markdown || "").replaceAll("\r\n", "\n").split("\n");
  const expected = String(expectedHeading).toLowerCase().replaceAll("_", " ");
  let found = false;
  let level = 0;
  const section = [];
  for (const line of lines) {
    const heading = markdownHeading(line);
    let depth = 0;
    while (line[depth] === "#") depth += 1;
    if (!found) {
      if (heading.toLowerCase().replaceAll("_", " ") !== expected) continue;
      found = true;
      level = depth;
    } else {
      if (heading && depth <= level) break;
      section.push(line);
    }
  }
  return section.join("\n").trim();
}

export function reportActionDecision(markdown = "", action = "") {
  const actionText = safeText(action, 40).toUpperCase();
  const recommendedActions = extractMarkdownHeadingSection(markdown, "Recommended Actions");
  const section = extractMarkdownHeadingSection(recommendedActions, actionText);
  const lines = section.split("\n").map(cleanReportDecisionText).filter(Boolean);
  const decisions = lines.filter(line => line.startsWith("Decision:")).map(line => line.slice(9).trim());
  // The exact no-action line is part of the original report format. Anything ambiguous stays unknown.
  const legacyNone = lines.length === 1 && lines[0] === "No action recommended.";
  const decision = decisions.length === 1 && ["none", "recommended"].includes(decisions[0]) ? decisions[0] : legacyNone ? "none" : "unknown";
  return {
    action: actionText,
    decision,
    summary: safeText(decision === "none" ? "No action recommended." : lines.find(line => !line.startsWith("Decision:")) || "Open report for decision details.", 260),
  };
}

export function boardManagerReportDecisionSummary(type = "", markdown = "") {
  if (safeText(type, 80) !== "board_manager_planning") return null;
  const addBoard = reportActionDecision(markdown, "ADD_BOARD");
  const archiveBoard = reportActionDecision(markdown, "ARCHIVE_BOARD");
  const unarchiveBoard = reportActionDecision(markdown, "UNARCHIVE_BOARD");
  const noPortfolioAction =
    addBoard.decision === "none" && archiveBoard.decision === "none" && unarchiveBoard.decision === "none";
  const anyRecommended =
    addBoard.decision === "recommended" ||
    archiveBoard.decision === "recommended" ||
    unarchiveBoard.decision === "recommended";
  return {
    type: "board_manager_planning",
    overall: noPortfolioAction
      ? "No board action recommended."
      : anyRecommended
        ? "Board action recommended."
        : "Decision unclear; open report.",
    addBoard,
    archiveBoard,
    unarchiveBoard,
  };
}

export function reportRow(row = {}) {
  const body = row.body_markdown || "";
  return {
    id: safeText(row.id, 180),
    type: safeText(row.type, 80),
    label: hiveReportTypes[row.type]?.label || safeText(row.type, 80),
    version: safeText(row.version, 80),
    generatedAt: iso(row.generated_at),
    bodyMarkdown: body,
    bodyExcerpt: safeText(replaceCharacterRuns(body,isWhitespace," "), 360),
    bodyBytes: Buffer.byteLength(body, "utf8"),
    sourceRunId: safeText(row.source_run_id, 180),
    model: safeText(row.model, 180),
    metadata: safeObject(row.metadata_json),
    decisionSummary: boardManagerReportDecisionSummary(row.type, body),
    verificationCount: Number(row.verification_count || 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export function verificationRow(row = {}) {
  return {
    id: safeText(row.id, 180),
    reportId: safeText(row.report_id, 180),
    phase: safeText(row.phase, 40),
    agent: safeText(row.agent, 120),
    resultSummary: row.result_summary || "",
    verifiedAt: iso(row.verified_at),
    metadata: safeObject(row.metadata_json),
    createdAt: iso(row.created_at),
  };
}
export function identitySummary(accountId = "", fallback = {}, identityByAccount = new Map()) {
  const profile = accountId ? identityByAccount.get(accountId) || {} : {};
  const publicHandle = trimCharacters(safeText(fallback.publicHandle || "", 120),"@",{end:false});
  const providerHandle = trimCharacters(safeText(fallback.providerHandle || "", 120),"@",{end:false});
  const hiveHandle = trimCharacters(safeText(profile.hiveHandle || profile.handle || profile.username || fallback.handle, 120),"@",{end:false});
  const displayName = safeText(
    profile.publicDisplayName ||
      profile.displayName ||
      fallback.displayName ||
      (hiveHandle ? `@${hiveHandle}` : "") ||
      accountId,
    160
  );
  return {
    accountId: safeText(accountId, 180),
    displayName,
    hiveHandle,
    publicHandle,
    providerHandle,
    profileUrl: safeText(fallback.profileUrl, 500),
    primaryProvider: safeText(profile.primaryProvider || fallback.primaryProvider, 80),
  };
}

export function hiveReportIdentityFallbackFromRow(row = {}) {
  const evidence = safeObject(row.evidence_json || row.evidence);
  const metrics = safeObject(row.validated_metrics_json || row.metrics);
  const nestedEvidence = safeObject(evidence.evidence);
  const publicHandle = trimCharacters(firstText(
    row.public_handle,
    row.identity_public_handle,
    evidence.publicHandle,
    nestedEvidence.publicHandle
  ),"@",{end:false});
  const providerHandle = trimCharacters(firstText(
    row.provider_handle,
    row.provider_public_handle,
    evidence.xHandle,
    evidence.githubHandle,
    evidence.handle,
    evidence.username,
    nestedEvidence.xHandle,
    nestedEvidence.githubHandle,
    nestedEvidence.handle,
    nestedEvidence.username,
    metrics.xHandle,
    metrics.githubHandle,
    metrics.handle,
    metrics.username
  ),"@",{end:false});
  return {
    publicHandle,
    providerHandle,
    profileUrl: firstText(row.provider_profile_url, evidence.profileUrl, nestedEvidence.profileUrl),
    handle: publicHandle || providerHandle,
    displayName: firstText(
      evidence.displayName,
      nestedEvidence.displayName,
      evidence.name,
      nestedEvidence.name,
      publicHandle,
      providerHandle
    ),
  };
}
export function roleAccountRow(row = {}, identityByAccount = new Map()) {
  const evidence = safeObject(row.evidence_json);
  const metrics = safeObject(row.validated_metrics_json);
  const fallback = hiveReportIdentityFallbackFromRow(row);
  const identity = identitySummary(row.account_id, fallback, identityByAccount);
  return {
    ...identity,
    walletAddress: safeText(row.wallet_address, 120),
    badgeId: safeText(row.badge_id, 80),
    role: roleDefinitions[row.badge_id]?.label || safeText(row.label || row.badge_id, 120),
    badgeLabel: safeText(row.label, 120),
    verifiedAt: iso(row.updated_at),
    evidence,
    metrics,
  };
}
export function taskRow(row = {}, identityByAccount = new Map()) {
  const metadata = safeObject(row.metadata_json);
  const identity = identitySummary(row.account_id, {
    handle: metadata.hiveHandle || metadata.handle || row.public_handle,
    publicHandle: row.public_handle,
    displayName: metadata.displayName || row.public_handle,
  }, identityByAccount);
  return {
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    accountId: safeText(row.account_id, 180),
    walletAddress: safeText(row.subject_wallet, 120),
    operator: identity,
    roleBadgeId: safeText(row.badge_id, 80),
    role: roleDefinitions[row.badge_id]?.label || safeText(row.badge_label || row.badge_id, 120),
    status: safeText(row.status, 80),
    title: safeText(row.title, 240),
    proposal: safeText(row.description || row.submission_requirement_text, 2200),
    submissionRequirement: safeText(row.submission_requirement_text, 1600),
    taskKind: safeText(row.task_kind, 80),
    rewardOfferPft: numeric(row.reward_offer_pft),
    rewardActualPft: numeric(row.reward_actual_pft),
    updatedAt: iso(row.updated_at),
    lastEventAt: iso(row.last_event_at),
    source: safeText(row.source, 80),
    metadata,
  };
}

export function chatRow(row = {}) {
  return {
    id: safeText(row.id, 180),
    accountId: safeText(row.account_id, 180),
    displayName: safeText(row.display_name, 160),
    body: safeText(row.body, 6000),
    sourceConversationTitle: safeText(row.source_conversation_title, 160),
    createdAt: iso(row.created_at),
    metadata: safeObject(row.metadata_json),
  };
}

export function projectTaskIsActive(task = {}) {
  return activeProjectTaskStatuses.includes(safeText(task.state || task.status, 80).toLowerCase());
}

export function compactProjectTasks(project = {}, limit = 8) {
  const tasks = safeArray(project.tasks);
  const activeTasks = tasks.filter(projectTaskIsActive);
  return (activeTasks.length ? activeTasks : tasks).slice(0, limit).map((task) => ({
    taskId: safeText(task.taskId, 180),
    title: safeText(task.title, 240),
    state: safeText(task.state, 80),
    assigneeAccountId: safeText(task.assigneeAccountId, 180),
    assigneeHandle: safeText(task.assigneeHandle || task.assigneeDisplayName, 160),
    pft: numeric(task.pft),
    updatedAt: iso(task.updatedAt),
  }));
}

export function compactProject(project = {}) {
  const taskCount = Number(project.taskCount || safeArray(project.tasks).length || 0);
  const tasksInFlight = Number(project.tasksInFlight ?? safeArray(project.tasks).filter(projectTaskIsActive).length ?? 0);
  return {
    id: safeText(project.id, 180),
    name: safeText(project.name || project.title, 180),
    type: safeText(project.type, 120),
    status: safeText(project.status, 80),
    priority: Number(project.priority || 0),
    summary: safeText(project.summary || project.objective || project.about, 700),
    taskCount,
    tasksInFlight,
    terminalTaskCount: Number(project.terminalTaskCount || Math.max(0, taskCount - tasksInFlight)),
    contributorCount: Number(project.contributorCount || safeArray(project.contributors).length || 0),
    pftRouted: numeric(project.pft),
    pendingGenerationCount: Number(project.pendingGenerationCount || 0),
    tasks: compactProjectTasks(project, 8),
  };
}
