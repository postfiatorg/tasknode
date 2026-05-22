import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";

export const hiveProjectProductDocPromptVersion = "hive_project_product_doc_v1";

function useDatabase() {
  return databaseEnabled();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function intValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)])
  );
}

function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex");
}

function stringList(value, maxItems = 6, maxText = 500) {
  return safeArray(value)
    .map((item) => safeText(item, maxText))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function normalizeHiveProjectProductDocOutput(output = {}) {
  const input = safeObject(output);
  return {
    title: safeText(input.title, 180),
    summary: safeText(input.summary, 1200),
    project_status: safeText(input.project_status || input.projectStatus, 1800),
    key_points: stringList(input.key_points || input.keyPoints, 8, 700),
    blocked_or_unclear: stringList(input.blocked_or_unclear || input.blockedOrUnclear, 6, 700),
    next_actions: stringList(input.next_actions || input.nextActions, 6, 700),
  };
}

export function publicProjectProductDoc(row = {}) {
  if (!row?.id) return null;
  return {
    id: safeText(row.id, 180),
    projectId: safeText(row.project_id, 180),
    title: safeText(row.title, 180),
    summary: safeText(row.summary, 1200),
    projectStatus: safeText(row.project_status, 1800),
    keyPoints: stringList(row.key_points_json, 8, 700),
    blockedOrUnclear: stringList(row.blocked_or_unclear_json, 6, 700),
    nextActions: stringList(row.next_actions_json, 6, 700),
    sourcePacketDigest: safeText(row.source_packet_digest, 120),
    sourceRefs: safeObject(row.source_refs_json),
    boardManagerRunId: safeText(row.board_manager_run_id, 180),
    provider: safeText(row.provider, 80),
    model: safeText(row.model, 160),
    promptVersion: safeText(row.prompt_version, 120),
    promptDigest: safeText(row.prompt_digest, 120),
    createdAt: iso(row.created_at),
  };
}

export async function getCurrentProjectProductDocs({ projectIds = [] } = {}) {
  if (!useDatabase()) return [];
  const ids = safeArray(projectIds).map((item) => safeText(item, 180)).filter(Boolean);
  if (!ids.length) return [];
  const result = await query(
    `
      SELECT *
      FROM network_project_product_docs
      WHERE project_id = ANY($1::text[])
        AND status = 'current'
        AND superseded_at IS NULL
      ORDER BY project_id ASC, created_at DESC
    `,
    [ids]
  );
  return result.rows.map(publicProjectProductDoc).filter(Boolean);
}

export async function getCurrentProjectProductDoc(projectId = "") {
  const docs = await getCurrentProjectProductDocs({ projectIds: [projectId] });
  return docs[0] || null;
}

function compactProject(row = {}) {
  return {
    id: safeText(row.id, 180),
    type: safeText(row.type, 80),
    title: safeText(row.title, 180),
    summary: safeText(row.summary, 600),
    objective: safeText(row.objective, 900),
    about: safeText(row.about, 2000),
    status: safeText(row.status, 80),
    priority: intValue(row.priority),
    origin: safeText(row.origin, 100),
    proposedBy: safeText(row.proposed_by, 120),
    proposedAt: iso(row.proposed_at),
    phaseLabel: safeText(row.phase_label, 120),
    phaseCurrent: intValue(row.phase_current),
    phaseTotal: intValue(row.phase_total),
    pftRouted: numeric(row.pft_routed),
    taskCount: intValue(row.task_count),
    contributorCount: intValue(row.contributor_count),
    sourceHiveSecretaryReportId: safeText(row.source_hive_secretary_report_id, 180),
    sourceHiveSecretaryReportDigest: safeText(row.source_hive_secretary_report_digest, 180),
    sourceInputs: safeObject(row.source_inputs_json),
    metadata: safeObject(row.metadata_json),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
  };
}

function compactContributor(row = {}) {
  return {
    walletAddress: safeText(row.wallet_address, 120),
    codename: safeText(row.codename, 120),
    archetype: safeText(row.archetype, 180),
    allotted: Boolean(row.allotted),
    cap: intValue(row.cap),
    load: intValue(row.load),
    status: safeText(row.status, 80),
    taskCount: intValue(row.task_count),
    pftEarned: numeric(row.pft_earned),
    roleLabel: safeText(row.role_label, 80),
    updatedAt: iso(row.updated_at),
  };
}

function compactTask(row = {}) {
  return {
    id: safeText(row.id, 180),
    taskId: safeText(row.task_id, 180),
    requestId: safeText(row.request_id, 180),
    title: safeText(row.title, 240),
    state: safeText(row.state, 80),
    assigneeWallet: safeText(row.assignee_wallet, 120),
    rewardPft: numeric(row.reward_pft),
    source: safeText(row.source, 100),
    updatedAt: iso(row.updated_at),
  };
}

function compactActivity(row = {}) {
  return {
    id: safeText(row.id, 180),
    walletAddress: safeText(row.wallet_address, 120),
    action: safeText(row.action, 80),
    taskTitle: safeText(row.task_title, 240),
    pftAmount: row.pft_amount === null || row.pft_amount === undefined ? null : numeric(row.pft_amount),
    routingLabel: safeText(row.routing_label, 120),
    updatedAt: iso(row.updated_at),
    createdAt: iso(row.created_at),
  };
}

function compactSecretary(row = {}) {
  if (!row?.id) return null;
  return {
    id: safeText(row.id, 180),
    sourcePacketDigest: safeText(row.source_packet_digest, 120),
    output: safeObject(row.output_json),
    completedAt: iso(row.completed_at),
  };
}

function compactRecentBoardActions(rows = []) {
  return safeArray(rows).slice(0, 12).map((row) => ({
    runId: safeText(row.run_id, 180),
    action: safeText(row.action, 80),
    targetType: safeText(row.target_type, 120),
    targetId: safeText(row.target_id, 240),
    result: safeObject(row.result_json),
    createdAt: iso(row.created_at),
  }));
}

export async function buildHiveProjectProductDocSourcePacket({
  projectId = "",
  boardSourcePacket = {},
} = {}) {
  if (!useDatabase()) throw new Error("hive_project_product_doc_database_not_configured");
  const normalizedProjectId = safeText(projectId, 180);
  if (!normalizedProjectId) throw new Error("hive_project_product_doc_project_required");

  const [
    projectResult,
    contributorsResult,
    tasksResult,
    activityResult,
    currentDocResult,
    secretaryResult,
    boardActionsResult,
  ] = await Promise.all([
    query("SELECT * FROM network_projects WHERE id = $1 LIMIT 1", [normalizedProjectId]),
    query(
      `
        SELECT *
        FROM network_project_contributors
        WHERE project_id = $1
        ORDER BY sort_order ASC, wallet_address ASC
        LIMIT 24
      `,
      [normalizedProjectId]
    ),
    query(
      `
        SELECT *
        FROM network_project_task_refs
        WHERE project_id = $1
        ORDER BY sort_order ASC, updated_at DESC, id ASC
        LIMIT 40
      `,
      [normalizedProjectId]
    ),
    query(
      `
        SELECT *
        FROM network_project_activity
        WHERE project_id = $1
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 40
      `,
      [normalizedProjectId]
    ),
    query(
      `
        SELECT *
        FROM network_project_product_docs
        WHERE project_id = $1
          AND status = 'current'
          AND superseded_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      [normalizedProjectId]
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
    query(
      `
        SELECT run_id, action, target_type, target_id, result_json, created_at
        FROM board_manager_action_results
        WHERE target_id = $1
           OR result_json->>'projectId' = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 12
      `,
      [normalizedProjectId]
    ),
  ]);

  const project = projectResult.rows[0];
  if (!project?.id) throw new Error("hive_project_product_doc_project_not_found");

  const currentDoc = publicProjectProductDoc(currentDocResult.rows[0]) || null;
  const packetCore = {
    schema: "pf.hive.project_product_doc.source.v1",
    generatedAt: new Date().toISOString(),
    project: compactProject(project),
    contributors: contributorsResult.rows.map(compactContributor),
    taskRefs: tasksResult.rows.map(compactTask),
    activity: activityResult.rows.map(compactActivity),
    latestHiveSecretary: compactSecretary(secretaryResult.rows[0]),
    currentProductDoc: currentDoc,
    recentBoardManagerActions: compactRecentBoardActions(boardActionsResult.rows),
    boardSourcePacket: {
      digest: safeText(boardSourcePacket.sourcePacketDigest, 120),
      trigger: safeText(boardSourcePacket.trigger, 160),
      generatedAt: boardSourcePacket.generatedAt || null,
    },
  };

  return {
    ...packetCore,
    sourcePacketDigest: digestJson({ ...packetCore, generatedAt: "" }),
  };
}

export async function completeHiveProjectProductDoc({
  projectId = "",
  output = {},
  sourcePacket = {},
  sourceRefs = {},
  boardManagerRunId = "",
  provider = "",
  model = "",
  promptVersion = hiveProjectProductDocPromptVersion,
  promptDigest = "",
  usage = {},
} = {}) {
  if (!useDatabase()) throw new Error("hive_project_product_doc_database_not_configured");
  const normalizedProjectId = safeText(projectId, 180);
  if (!normalizedProjectId) throw new Error("hive_project_product_doc_project_required");
  const normalizedOutput = normalizeHiveProjectProductDocOutput(output);
  if (!normalizedOutput.project_status) throw new Error("hive_project_product_doc_status_required");
  const docId = `projectdoc_${randomUUID()}`;

  return transaction(async (client) => {
    const exists = await client.query("SELECT id FROM network_projects WHERE id = $1 LIMIT 1", [normalizedProjectId]);
    if (!exists.rows[0]?.id) throw new Error("hive_project_product_doc_project_not_found");

    await client.query(
      `
        UPDATE network_project_product_docs
        SET status = 'superseded',
            superseded_at = now()
        WHERE project_id = $1
          AND status = 'current'
          AND superseded_at IS NULL
      `,
      [normalizedProjectId]
    );

    const inserted = await client.query(
      `
        INSERT INTO network_project_product_docs (
          id,
          project_id,
          status,
          title,
          summary,
          project_status,
          key_points_json,
          blocked_or_unclear_json,
          next_actions_json,
          source_packet_digest,
          source_packet_json,
          source_refs_json,
          board_manager_run_id,
          provider,
          model,
          prompt_version,
          prompt_digest,
          output_json,
          usage_json
        )
        VALUES (
          $1, $2, 'current', $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb,
          $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb
        )
        RETURNING *
      `,
      [
        docId,
        normalizedProjectId,
        normalizedOutput.title,
        normalizedOutput.summary,
        normalizedOutput.project_status,
        jsonValue(normalizedOutput.key_points),
        jsonValue(normalizedOutput.blocked_or_unclear),
        jsonValue(normalizedOutput.next_actions),
        safeText(sourcePacket.sourcePacketDigest, 120),
        jsonValue(sourcePacket),
        jsonValue({
          project_id: normalizedProjectId,
          hive_secretary_report_id: sourcePacket.latestHiveSecretary?.id || "",
          board_source_packet_digest: sourcePacket.boardSourcePacket?.digest || "",
          ...safeObject(sourceRefs),
        }),
        safeText(boardManagerRunId, 180),
        safeText(provider, 80),
        safeText(model, 160),
        safeText(promptVersion, 120),
        safeText(promptDigest, 120),
        jsonValue(normalizedOutput),
        jsonValue(usage),
      ]
    );

    return {
      ok: true,
      doc: publicProjectProductDoc(inserted.rows[0]),
    };
  });
}
