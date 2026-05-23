import { databaseEnabled, query, transaction } from "../db/pool.js";
import { latestHiveProjectPlanningState } from "./hive-project-planning.js";
import { getCurrentProjectProductDocs } from "./hive-project-product-docs.js";

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function intValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function formatProjectDate(value) {
  if (!value) return "";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return safeText(value, 80);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(parsed));
}

function toIso(value) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : safeText(value, 80);
}

function timestampMs(value = "") {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function typeLabel(value = "") {
  return safeText(value, 80)
    .split("_")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function compactWallet(wallet = "") {
  const normalized = safeText(wallet, 120);
  if (normalized.length <= 12) return normalized || "Operator";
  return `${normalized.slice(0, 6)}...${normalized.slice(-5)}`;
}

function publicProject(row = {}) {
  const phase = row.phase_label || (row.phase_current && row.phase_total ? `${row.phase_current} of ${row.phase_total}` : "");
  return {
    id: row.id,
    name: safeText(row.title, 180),
    type: typeLabel(row.type),
    typeKey: safeText(row.type, 80),
    summary: safeText(row.summary, 600),
    objective: safeText(row.objective, 800),
    about: safeText(row.about, 1800),
    status: safeText(row.status, 80),
    priority: intValue(row.priority),
    origin: safeText(row.origin, 100),
    proposedBy: safeText(row.proposed_by, 120) || "hive",
    proposed: formatProjectDate(row.proposed_at),
    phase,
    phaseCurrent: intValue(row.phase_current),
    phaseTotal: intValue(row.phase_total),
    pft: numeric(row.pft_routed),
    taskCount: intValue(row.task_count),
    contributorCount: intValue(row.contributor_count),
    sourceHiveSecretaryReportId: safeText(row.source_hive_secretary_report_id, 180),
    sourceHiveSecretaryReportDigest: safeText(row.source_hive_secretary_report_digest, 180),
    sourceInputs: safeObject(row.source_inputs_json),
    contributors: [],
    tasks: [],
    activity: [],
  };
}

function publicContributor(row = {}) {
  return {
    wallet: safeText(row.wallet_address, 120),
    codename: safeText(row.codename, 120),
    archetype: safeText(row.archetype, 180),
    badge: intValue(row.badge_variant),
    allotted: Boolean(row.allotted),
    cap: intValue(row.cap),
    load: intValue(row.load),
    status: safeText(row.status, 80) || "active",
    tasks: intValue(row.task_count),
    pft: numeric(row.pft_earned),
    lastActive: safeText(row.last_active_label, 80),
    role: safeText(row.role_label, 80),
  };
}

function publicTask(row = {}) {
  const assigneeNft = safeText(row.assignee_nft_image_cid || row.assignee_nft_image_gateway_url, 500)
    ? {
        title: safeText(row.assignee_nft_title, 160),
        status: safeText(row.assignee_nft_status, 80),
        imageCid: safeText(row.assignee_nft_image_cid, 180),
        imageGatewayUrl: safeText(row.assignee_nft_image_gateway_url, 500),
      }
    : null;
  return {
    id: safeText(row.id, 180),
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    title: safeText(row.title, 240),
    state: safeText(row.state, 80) || "proposed",
    assignee: safeText(row.assignee_wallet, 120),
    pft: numeric(row.reward_pft),
    age: safeText(row.age_label, 80),
    source: safeText(row.source, 100),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    assigneeNft,
  };
}

function publicActivity(row = {}) {
  return {
    id: safeText(row.id, 180),
    projectId: safeText(row.project_id, 180),
    wallet: safeText(row.wallet_address, 120),
    action: safeText(row.action, 80),
    task: safeText(row.task_title, 240),
    time: safeText(row.time_label, 80),
    pft: row.pft_amount === null || row.pft_amount === undefined ? null : numeric(row.pft_amount),
    routing: safeText(row.routing_label, 120),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function operatorMap(projects = {}) {
  const operators = {};
  for (const project of Object.values(projects)) {
    for (const contributor of safeArray(project.contributors)) {
      if (!contributor.wallet || operators[contributor.wallet]) continue;
      operators[contributor.wallet] = {
        codename: contributor.codename || "Operator",
        archetype: contributor.archetype || "",
        badge: contributor.badge || 0,
        allotted: Boolean(contributor.allotted),
        cap: contributor.cap || 0,
        load: contributor.load || 0,
        status: contributor.status || "active",
        nft: contributor.nft || null,
      };
    }
  }
  return operators;
}

function deriveContributorFromTask(task = {}) {
  const wallet = safeText(task.assignee, 120);
  if (!wallet) return null;
  const taskState = safeText(task.state, 80).toLowerCase();
  const paidPft = taskState === "rewarded" ? numeric(task.pft) : 0;
  const activeLoad = ["proposed", "accepted", "submitted", "verification_requested", "verification_response_submitted"].includes(taskState) ? 1 : 0;
  return {
    wallet,
    codename: compactWallet(wallet),
    archetype: "Network task contributor",
    badge: 0,
    allotted: true,
    cap: Math.max(1, activeLoad),
    load: activeLoad,
    status: "active",
    tasks: 1,
    pft: paidPft,
    lastActive: task.age || "recently",
    role: "contributor",
    nft: task.assigneeNft || null,
  };
}

function mergeContributor(left = {}, right = {}) {
  const pft = numeric(left.pft) + numeric(right.pft);
  const tasks = intValue(left.tasks) + intValue(right.tasks);
  const load = intValue(left.load) + intValue(right.load);
  const cap = Math.max(intValue(left.cap), intValue(right.cap), load, 1);
  return {
    ...left,
    codename: left.codename || right.codename,
    archetype: left.archetype || right.archetype,
    badge: intValue(left.badge) || intValue(right.badge),
    allotted: Boolean(left.allotted || right.allotted),
    cap,
    load,
    status: left.status || right.status || "active",
    tasks,
    pft,
    lastActive: left.lastActive || right.lastActive,
    role: left.role || right.role,
    nft: left.nft || right.nft || null,
  };
}

function actionForTaskState(state = "") {
  const normalized = safeText(state, 80).toLowerCase();
  if (normalized === "verification_response_submitted") return "verification_response_submitted";
  if (normalized === "reward_decided") return "reward_decided";
  if (normalized === "rewarded") return "rewarded";
  if (normalized === "cancelled") return "cancelled";
  if (normalized === "rejected") return "rejected";
  if (normalized === "expired") return "expired";
  if (normalized === "refused") return "refused";
  if (normalized === "verification_requested") return "verification_requested";
  if (normalized === "submitted") return "submitted";
  if (normalized === "accepted") return "accepted";
  return "proposed";
}

function deriveActivityFromTask(project = {}, task = {}) {
  if (!task.taskId) return null;
  const action = actionForTaskState(task.state);
  return {
    id: `project_task_activity_${task.taskId}`,
    projectId: project.id,
    wallet: task.assignee,
    action,
    task: task.title,
    time: task.age || "",
    pft: action === "rewarded" ? numeric(task.pft) : null,
    routing: task.requestId ? `request ${task.requestId}` : "",
    project: project.name,
    derived: true,
    createdAt: task.createdAt || "",
    updatedAt: task.updatedAt || task.createdAt || "",
  };
}

function populateDerivedProjectRollups(projects = {}) {
  for (const project of Object.values(projects)) {
    const byWallet = new Map(safeArray(project.contributors).map((contributor) => [contributor.wallet, contributor]));
    for (const task of safeArray(project.tasks)) {
      const contributor = deriveContributorFromTask(task);
      if (contributor) {
        byWallet.set(contributor.wallet, byWallet.has(contributor.wallet)
          ? mergeContributor(byWallet.get(contributor.wallet), contributor)
          : contributor);
      }
      const hasActivity = safeArray(project.activity).some((entry) => entry.task === task.title && entry.action === actionForTaskState(task.state));
      if (!hasActivity) {
        const activity = deriveActivityFromTask(project, task);
        if (activity) project.activity.push(activity);
      }
    }
    project.contributors = Array.from(byWallet.values()).sort((left, right) => {
      if (Boolean(right.allotted) !== Boolean(left.allotted)) return right.allotted ? 1 : -1;
      if (numeric(right.pft) !== numeric(left.pft)) return numeric(right.pft) - numeric(left.pft);
      return safeText(left.wallet).localeCompare(safeText(right.wallet));
    });
    project.tasks = safeArray(project.tasks).sort((left, right) =>
      timestampMs(right.updatedAt || right.createdAt) - timestampMs(left.updatedAt || left.createdAt) ||
      safeText(right.id).localeCompare(safeText(left.id))
    );
    project.activity = safeArray(project.activity).sort((left, right) =>
      timestampMs(right.updatedAt || right.createdAt) - timestampMs(left.updatedAt || left.createdAt) ||
      safeText(right.id).localeCompare(safeText(left.id))
    );
  }
}

function documentFromRows({
  projectRows = [],
  contributorRows = [],
  taskRows = [],
  activityRows = [],
  productDocs = [],
  latestSecretary = null,
  projectPlanning = null,
} = {}) {
  const projects = Object.fromEntries(projectRows.map((row) => {
    const project = publicProject(row);
    return [project.id, project];
  }));

  for (const row of contributorRows) {
    const project = projects[row.project_id];
    if (project) project.contributors.push(publicContributor(row));
  }
  for (const row of taskRows) {
    const project = projects[row.project_id];
    if (project) project.tasks.push(publicTask(row));
  }
  for (const row of activityRows) {
    const project = projects[row.project_id];
    if (project) project.activity.push(publicActivity(row));
  }
  for (const doc of safeArray(productDocs)) {
    const project = projects[doc.projectId];
    if (project) project.productDocument = doc;
  }
  populateDerivedProjectRollups(projects);

  const projectIds = Object.values(projects)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))
    .map((project) => project.id);
  const operators = operatorMap(projects);
  const routingFeed = Object.values(projects)
    .flatMap((project) =>
      safeArray(project.activity).map((entry) => ({
        ...entry,
        project: project.name,
      }))
    )
    .sort((left, right) =>
      timestampMs(right.updatedAt || right.createdAt) - timestampMs(left.updatedAt || left.createdAt) ||
      safeText(right.id).localeCompare(safeText(left.id))
    )
    .slice(0, 12);
  const activeOperators = Object.values(operators).filter((operator) => operator.status === "active").length;
  const tasksInFlight = Object.values(projects).reduce((sum, project) => sum + (project.taskCount || project.tasks.length), 0);
  const pftRouted = Object.values(projects).reduce((sum, project) => sum + numeric(project.pft), 0);

  return {
    generatedAt: new Date().toISOString(),
    projectIds,
    projects,
    operators,
    routingFeed,
    stats: {
      activeProjects: projectIds.length,
      operatorsOnline: activeOperators,
      tasksInFlight,
      pftRouted,
    },
    secretaryInput: latestSecretary
      ? {
          id: latestSecretary.id,
          completedAt: latestSecretary.completed_at,
          digest: latestSecretary.source_packet_digest,
          title: latestSecretary.output_json?.title || "Hive Secretary Report",
        }
      : null,
    projectPlanning,
  };
}

export async function syncNetworkProjectsWithLatestHiveSecretary() {
  if (!useDatabase()) return { ok: true, skipped: true, reason: "database_not_configured" };
  return transaction(async (client) => {
    const latest = await client.query(
      `
        SELECT id, source_packet_digest, output_json, completed_at
        FROM hive_secretary_reports
        WHERE status = 'completed'
          AND superseded_at IS NULL
        ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
      `
    );
    const report = latest.rows[0] || null;
    if (!report?.id) return { ok: true, updated: 0, reason: "no_hive_secretary_report" };
    const updated = await client.query(
      `
        UPDATE network_projects
        SET source_hive_secretary_report_id = $1,
            source_hive_secretary_report_digest = $2,
            source_inputs_json = jsonb_set(
              COALESCE(source_inputs_json, '{}'::jsonb),
              '{hive_secretary}',
              $3::jsonb,
              true
            ),
            updated_at = now()
        WHERE status = 'active'
          AND origin = 'system_seed'
          AND (
            source_hive_secretary_report_id <> $1
            OR source_hive_secretary_report_digest <> $2
          )
      `,
      [
        report.id,
        safeText(report.source_packet_digest, 180),
        JSON.stringify({
          report_id: report.id,
          source_packet_digest: report.source_packet_digest,
          completed_at: report.completed_at,
          title: report.output_json?.title || "Hive Secretary Report",
        }),
      ]
    );
    return { ok: true, updated: updated.rowCount || 0, reportId: report.id };
  });
}

export async function getHiveProjectsDocument() {
  if (!useDatabase()) {
    return documentFromRows({});
  }
  const [projectsResult, contributorsResult, tasksResult, activityResult, secretaryResult] = await Promise.all([
    query(
      `
        SELECT *
        FROM network_projects
        WHERE status = 'active'
        ORDER BY priority ASC, title ASC
      `
    ),
    query(
      `
        SELECT *
        FROM network_project_contributors
        ORDER BY project_id ASC, sort_order ASC, wallet_address ASC
      `
    ),
    query(
      `
        SELECT refs.*,
               nft.title AS assignee_nft_title,
               nft.status AS assignee_nft_status,
               nft.image_cid AS assignee_nft_image_cid,
               nft.image_gateway_url AS assignee_nft_image_gateway_url
        FROM network_project_task_refs refs
        LEFT JOIN LATERAL (
          SELECT title, status, image_cid, image_gateway_url, selected, updated_at
          FROM profile_nfts
          WHERE wallet_address = refs.assignee_wallet
            AND wallet_address <> ''
            AND status IN ('minted', 'prepared', 'generated')
            AND (
              COALESCE(image_gateway_url, '') <> ''
              OR COALESCE(image_cid, '') <> ''
            )
          ORDER BY
            selected DESC,
            CASE status
              WHEN 'minted' THEN 0
              WHEN 'prepared' THEN 1
              ELSE 2
            END ASC,
            updated_at DESC
          LIMIT 1
        ) nft ON true
        ORDER BY refs.project_id ASC, refs.sort_order ASC, refs.id ASC
      `
    ),
    query(
      `
        SELECT *
        FROM network_project_activity
        ORDER BY project_id ASC, sort_order ASC, id ASC
      `
    ),
    query(
      `
        SELECT id, source_packet_digest, output_json, completed_at
        FROM hive_secretary_reports
        WHERE status = 'completed'
          AND superseded_at IS NULL
        ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
        LIMIT 1
      `
    ),
  ]);
  const productDocs = await getCurrentProjectProductDocs({
    projectIds: projectsResult.rows.map((row) => row.id),
  });
  const projectPlanning = await latestHiveProjectPlanningState().catch(() => null);

  return documentFromRows({
    projectRows: projectsResult.rows,
    contributorRows: contributorsResult.rows,
    taskRows: tasksResult.rows,
    activityRows: activityResult.rows,
    productDocs,
    latestSecretary: secretaryResult.rows[0] || null,
    projectPlanning,
  });
}
