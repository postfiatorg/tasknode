import { databaseEnabled, query, transaction } from "../db/pool.js";
import { listPublicAccountWalletIdentities } from "./account-profiles.js";
import { publicReducerEvent } from "../task-forensics-format.js";
import { taskRewardOutcome } from "../task-reward-outcome.js";
import { discoverableMemberProfileIds } from "./directory-leaderboard.js";
import { listMachineOperatorDisclosures } from "./capability-profiles.js";
import { listEvidenceEvaluationPackets } from "./evidence-evaluation-packets.js";
import { listHiveProjectComments } from "./hive-context.js";
import { latestHiveProjectPlanningState } from "./hive-project-planning.js";
import { getCurrentHiveBoardSecretaryMemos } from "./hive-board-secretary.js";
import { getCurrentProjectProductDocs } from "./hive-project-product-docs.js";
import { deriveNetworkTaskStatusPacketFromRow } from "./network-task-status.js";

import {
  documentFromRows,
  enrichTaskWithWalletIdentity,
  hiveWalletAccountsFromRows,
  hiveWalletsFromRows,
  mergeWalletIdentityLists,
  publicIdentityNft,
  publicTask,
  projectNextTask,
  safeArray,
  safeObject,
  safeText,
  taskNextAction,
  typeLabel,
  viewerContext,
  walletIdentityKey,
  walletIdentityMap,
} from "./hive-project-projection.js";
import {
  publicAssigneeNft,
  publicEvidenceRows,
  publicRewardOutcome,
  publicSummaryText,
  publicSubmissionSummaries,
  publicTimelineRows,
  publicVerificationSummary,
} from "./hive-task-evidence-projection.js";

function useDatabase() {
  return databaseEnabled();
}

async function publicWalletIdentityForWallet(wallet = "", accountId = "") {
  const key = walletIdentityKey(wallet);
  if (!key) return null;
  const walletIdentities = mergeWalletIdentityLists(
    (await listPublicAccountWalletIdentities()).filter((identity) =>
      walletIdentityKey(identity.walletAddress || identity.wallet_address || identity.wallet) === key
    ),
    await resolveHivePublicWalletIdentities({
      wallets: [wallet],
      walletAccounts: accountId ? [{ walletAddress: wallet, accountId }] : [],
    })
  );
  const publicProfileIds = await discoverableMemberProfileIds(
    Array.from(new Set(walletIdentities.map((identity) => safeText(identity.accountId || identity.account_id, 180)).filter(Boolean)))
  );
  const operatorDisclosures = await listMachineOperatorDisclosures({
    accountIds: Array.from(new Set(walletIdentities.map((identity) => safeText(identity.accountId || identity.account_id, 180)).filter(Boolean))),
  }).catch(() => ({}));
  return walletIdentityMap(walletIdentities, publicProfileIds, operatorDisclosures).get(key) || null;
}

async function recommendedProfilesReady(queryImpl = query) {
  const result = await queryImpl("SELECT to_regclass('public.recommended_connection_profiles') AS profile_table");
  return Boolean(result.rows[0]?.profile_table);
}

export async function resolveHivePublicWalletIdentities({
  wallets = [],
  walletAccounts = [],
  queryImpl = query,
  databaseReady = useDatabase(),
} = {}) {
  const uniqueWallets = Array.from(new Set(safeArray(wallets).map((wallet) => safeText(wallet, 160)).filter(Boolean)));
  const accountPairs = safeArray(walletAccounts)
    .map((pair) => ({
      walletAddress: safeText(pair.walletAddress || pair.wallet_address || pair.wallet, 160),
      accountId: safeText(pair.accountId || pair.account_id, 180),
    }))
    .filter((pair) => pair.walletAddress && pair.accountId);
  const pairWallets = accountPairs.map((pair) => pair.walletAddress);
  const allWallets = Array.from(new Set([...uniqueWallets, ...pairWallets]));
  if (!allWallets.length || !databaseReady || !await recommendedProfilesReady(queryImpl)) return [];
  const result = await queryImpl(
    `
      WITH input_wallet_accounts AS (
        SELECT wallet_address, account_id, ordinal::integer AS source_rank
        FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS input(wallet_address, account_id, ordinal)
        WHERE wallet_address <> ''
          AND account_id <> ''
      ),
      profile_wallet_accounts AS (
        SELECT wallet_address,
               account_id,
               1000000 AS source_rank
        FROM recommended_connection_profiles
        WHERE wallet_address = ANY($3::text[])
          AND wallet_address <> ''
          AND account_id <> ''
      ),
      wallet_accounts AS (
        SELECT DISTINCT ON (lower(wallet_address))
               wallet_address,
               account_id
        FROM (
          SELECT * FROM input_wallet_accounts
          UNION ALL
          SELECT * FROM profile_wallet_accounts
        ) matches
        ORDER BY lower(wallet_address), source_rank ASC, account_id ASC
      )
      SELECT wallet_account.wallet_address,
             wallet_account.account_id,
             COALESCE(NULLIF(latest_handle.public_handle, ''), NULLIF(profile.hive_handle, ''), '') AS hive_handle,
             CASE
               WHEN COALESCE(latest_handle.public_handle, profile.hive_handle, '') <> ''
                 THEN '@' || regexp_replace(COALESCE(latest_handle.public_handle, profile.hive_handle), '^@+', '')
               ELSE COALESCE(NULLIF(profile.display_name, ''), '')
             END AS display_name,
             COALESCE(NULLIF(profile.display_name, ''), '') AS public_display_name,
             COALESCE(hero_nft.title, '') AS hero_nft_title,
             COALESCE(hero_nft.status, '') AS hero_nft_status,
             COALESCE(hero_nft.image_cid, '') AS hero_nft_image_cid,
             COALESCE(hero_nft.image_gateway_url, '') AS hero_nft_image_gateway_url
      FROM wallet_accounts wallet_account
      JOIN recommended_connection_profiles profile
        ON profile.account_id = wallet_account.account_id
       AND profile.visibility = 'public'
       AND profile.discoverable = true
       AND profile.disabled_at IS NULL
      LEFT JOIN LATERAL (
        SELECT event.public_handle
        FROM user_observability_events event
        WHERE event.account_id = wallet_account.account_id
          AND event.public_handle <> ''
        ORDER BY event.occurred_at DESC, event.id DESC
        LIMIT 1
      ) latest_handle ON true
      LEFT JOIN LATERAL (
        SELECT id, title, status, image_cid, image_gateway_url, selected, created_at, updated_at
        FROM profile_nfts nft
        WHERE nft.account_id = wallet_account.account_id
          AND lower(nft.status) IN ('minted', 'prepared', 'generated')
          AND (
            COALESCE(nft.image_gateway_url, '') <> ''
            OR COALESCE(nft.image_cid, '') <> ''
          )
        ORDER BY
          nft.selected DESC,
          nft.created_at DESC NULLS LAST,
          nft.updated_at DESC NULLS LAST,
          nft.id DESC
        LIMIT 1
      ) hero_nft ON true
      ORDER BY wallet_account.wallet_address ASC
    `,
    [
      accountPairs.map((pair) => pair.walletAddress),
      accountPairs.map((pair) => pair.accountId),
      allWallets,
    ]
  );
  return result.rows
    .map((row) => ({
      accountId: safeText(row.account_id, 180),
      walletAddress: safeText(row.wallet_address, 160),
      displayName: safeText(row.display_name, 120),
      hiveHandle: safeText(row.hive_handle, 80).replace(/^@+/, ""),
      publicDisplayName: safeText(row.public_display_name, 120),
      publicAliases: row.hive_handle ? [{
        provider: "hive",
        label: "Hive",
        handle: safeText(row.hive_handle, 80).replace(/^@+/, ""),
        verified: false,
      }] : [],
      publicTrustBadges: [],
      nft: publicIdentityNft(row),
    }))
    .filter((identity) => identity.accountId && identity.walletAddress && identity.displayName);
}

export const publicHiveTaskDetailFields = [
  "ok",
  "task.id",
  "task.taskId",
  "task.requestId",
  "task.title",
  "task.state",
  "task.assignee",
  "task.assigneeAccountId",
  "task.assigneeHasPublicProfile",
  "task.assigneeHandle",
  "task.assigneeDisplayName",
  "task.assigneeOperatorDisclosure.isMachineOperator",
  "task.assigneeOperatorDisclosure.label",
  "task.assigneeOperatorDisclosure.kind",
  "task.pft",
  "task.nextAction",
  "task.age",
  "task.source",
  "task.createdAt",
  "task.updatedAt",
  "task.proofTxHash",
  "task.proofCid",
  "task.assigneeNft.title",
  "task.assigneeNft.status",
  "task.assigneeNft.imageCid",
  "task.assigneeNft.imageGatewayUrl",
  "task.statusPacket.schema",
  "task.statusPacket.allocationState",
  "task.statusPacket.taskState",
  "task.statusPacket.rewardMovement",
  "task.statusPacket.repairRequired",
  "task.statusPacket.repairReason",
  "task.kind",
  "task.summary",
  "task.description",
  "task.project.id",
  "task.project.name",
  "task.project.type",
  "review.submissions[].type",
  "review.submissions[].summary",
  "review.evidence[].type",
  "review.evidence[].schema",
  "review.evidence[].excerpt",
  "review.evidence[].artifactRefs[].type",
  "review.evidence[].artifactRefs[].label",
  "review.evidence[].artifactRefs[].url",
  "review.evidence[].artifactRefs[].cid",
  "review.evidence[].artifactRefs[].txHash",
  "review.evidence[].time",
  "review.evidence[].cid",
  "review.evidence[].txHash",
  "review.evidence[].privateContentHidden",
  "review.verification.request",
  "review.verification.response",
  "review.outcome.decision",
  "review.outcome.rewardPft",
  "review.outcome.reason",
  "review.outcome.paymentTxHash",
  "review.outcome.paymentCid",
  "review.outcome.paymentObservedAt",
  "evaluationPackets[].id",
  "evaluationPackets[].taskId",
  "evaluationPackets[].projectId",
  "evaluationPackets[].packetStatus",
  "evaluationPackets[].evaluatorId",
  "evaluationPackets[].summary",
  "evaluationPackets[].recommendation",
  "evaluationPackets[].sourceDigest",
  "evaluationPackets[].counts.verified",
  "evaluationPackets[].counts.self_attested",
  "evaluationPackets[].counts.unverified",
  "evaluationPackets[].artifactVerdicts[].artifactType",
  "evaluationPackets[].artifactVerdicts[].resolver",
  "evaluationPackets[].artifactVerdicts[].status",
  "evaluationPackets[].artifactVerdicts[].label",
  "evaluationPackets[].artifactVerdicts[].reason",
  "evaluationPackets[].artifactVerdicts[].cid",
  "evaluationPackets[].artifactVerdicts[].txHash",
  "evaluationPackets[].createdAt",
  "evaluationPackets[].updatedAt",
  "timeline[].action",
  "timeline[].label",
  "timeline[].time",
  "timeline[].txHash",
  "timeline[].cid",
];

export function publicHiveTaskDetailFieldsForPayload(value, path = "") {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((item) => publicHiveTaskDetailFieldsForPayload(item, `${path}[]`))));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([key]) => key !== "publicFields");
    if (!entries.length) return path ? [path] : [];
    return Array.from(new Set(entries.flatMap(([key, child]) => publicHiveTaskDetailFieldsForPayload(child, path ? `${path}.${key}` : key))));
  }
  return path ? [path] : [];
}

function publicHiveTaskFromProjection(row = {}) {
  const projected = publicTask({
    ...row,
    project_id: row.project_id,
    projected_status: row.status,
    projected_title: row.title,
    projected_subject_wallet: row.subject_wallet,
    projected_reward_pft: row.status === "rewarded" ? row.reward_actual_pft : row.reward_offer_pft,
    projected_updated_at: row.updated_at,
  });
  return {
    ...projected,
    assigneeNft: publicAssigneeNft(projected.assigneeNft),
    kind: projected.source === "task_projections" ? "Network task" : "Network task",
    summary: publicSummaryText(row.description || row.submission_requirement_text || "", 1200),
    description: publicSummaryText(row.description || "", 1600),
    project: {
      id: safeText(row.project_id, 180),
      name: safeText(row.project_title, 180),
      type: typeLabel(row.project_type),
    },
  };
}

export async function getPublicHiveTaskDetail({ taskId = "", queryImpl = query, databaseReady = useDatabase() } = {}) {
  const normalizedTaskId = safeText(taskId, 180);
  if (!normalizedTaskId) {
    return {
      ok: false,
      status: 400,
      error: "hive_task_id_required",
      message: "A taskId query parameter is required.",
    };
  }
  if (!databaseReady) {
    return {
      ok: false,
      status: 503,
      error: "database_not_configured",
      message: "Hive task detail requires the database-backed task projection.",
    };
  }

  const taskResult = await queryImpl(
    `
      SELECT projection.*,
             refs.project_id,
             project.title AS project_title,
             project.type AS project_type,
             alloc.id AS allocation_id,
             alloc.allocation_status,
             alloc.generated_task_id AS allocation_generated_task_id,
             alloc.task_request_id AS allocation_task_request_id,
             job.id AS generation_job_id,
             job.status AS generation_job_status,
             job.task_id AS generation_job_task_id,
             job.request_id AS generation_job_request_id,
             job.offer_cid AS generation_job_offer_cid,
             job.offer_tx_hash AS generation_job_offer_tx_hash,
             job.last_error AS generation_job_last_error
      FROM network_project_task_refs refs
      JOIN network_projects project
        ON project.id = refs.project_id
      JOIN task_projections projection
        ON projection.task_id = refs.task_id
      LEFT JOIN LATERAL (
        SELECT candidate.*
        FROM (
          SELECT job.*, 0 AS match_rank
          FROM network_task_generation_jobs job
          WHERE job.task_id = projection.task_id
          UNION ALL
          SELECT job.*, 1 AS match_rank
          FROM network_task_generation_jobs job
          WHERE projection.request_id <> ''
            AND job.request_id = projection.request_id
          UNION ALL
          SELECT job.*, 2 AS match_rank
          FROM network_task_generation_jobs job
          WHERE refs.metadata_json->>'generation_job_id' <> ''
            AND job.id = refs.metadata_json->>'generation_job_id'
        ) candidate
        ORDER BY candidate.match_rank ASC,
                 candidate.updated_at DESC NULLS LAST,
                 candidate.id DESC
        LIMIT 1
      ) job ON true
      LEFT JOIN LATERAL (
        SELECT candidate.*
        FROM (
          SELECT alloc.*, 0 AS match_rank
          FROM network_task_allocations alloc
          WHERE alloc.generated_task_id = projection.task_id
          UNION ALL
          SELECT alloc.*, 1 AS match_rank
          FROM network_task_allocations alloc
          WHERE projection.request_id <> ''
            AND alloc.task_request_id = projection.request_id
          UNION ALL
          SELECT alloc.*, 2 AS match_rank
          FROM network_task_allocations alloc
          WHERE job.allocation_id <> ''
            AND alloc.id = job.allocation_id
        ) candidate
        ORDER BY candidate.match_rank ASC,
                 candidate.updated_at DESC NULLS LAST,
                 candidate.id DESC
        LIMIT 1
      ) alloc ON true
      WHERE refs.task_id = $1
        AND refs.task_id <> ''
      LIMIT 1
    `,
    [normalizedTaskId]
  );
  const row = taskResult.rows[0] || null;
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: "hive_task_not_found",
      message: "No public Hive task projection was found for this task.",
    };
  }

  const eventsResult = await queryImpl(
    `
      SELECT *
      FROM task_events
      WHERE task_id = $1
      ORDER BY occurred_at ASC, id ASC
      LIMIT 200
    `,
    [normalizedTaskId]
  );
  const timeline = eventsResult.rows.map((eventRow, index) => publicReducerEvent(eventRow, index));
  const publicTimeline = publicTimelineRows(eventsResult.rows);
  const task = publicHiveTaskFromProjection(row);
  task.statusPacket = deriveNetworkTaskStatusPacketFromRow(row);
  enrichTaskWithWalletIdentity(task, await publicWalletIdentityForWallet(task.assignee, task.assigneeAccountId));
  const metadata = safeObject(row.metadata_json);
  const submissions = publicSubmissionSummaries(metadata);
  const evidence = publicEvidenceRows(timeline);
  const verification = publicVerificationSummary(timeline) || { request: "", response: "" };
  const outcome = publicRewardOutcome(taskRewardOutcome({
    offeredPft: row.reward_offer_pft,
    task,
    timeline,
  }));
  const evaluationPackets = await listEvidenceEvaluationPackets({
    taskIds: [normalizedTaskId],
    limit: 6,
    queryImpl,
    databaseReady,
  }).catch(() => []);

  const response = {
    ok: true,
    task,
    review: {
      submissions,
      evidence,
      verification,
      outcome,
    },
    evaluationPackets,
    timeline: publicTimeline.length
      ? publicTimeline
      : [{
          action: task.state,
          label: taskNextAction(task.state),
          time: task.updatedAt || task.createdAt || "",
          txHash: "",
          cid: "",
        }],
  };
  return {
    ...response,
    publicFields: publicHiveTaskDetailFieldsForPayload(response),
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

export async function getHiveProjectsDocument({
  includeEmptyActive = false,
  viewerAccountId = "",
  viewerWalletAddress = "",
} = {}) {
  if (!useDatabase()) {
    return documentFromRows({ includeEmptyActive });
  }
  const [projectsResult, contributorsResult, tasksResult, activityResult, pendingGenerationResult, secretaryResult] = await Promise.all([
    query(
      `
        SELECT *
        FROM network_projects
        WHERE status IN ('active', 'paused', 'archived')
          AND (
            status = 'active'
            OR metadata_json->>'operator_pinned' = 'true'
            OR metadata_json->>'operator_pin' = 'true'
            OR metadata_json->>'board_pinned' = 'true'
            OR metadata_json->>'pin_source' = 'operator'
            OR EXISTS (
              SELECT 1
              FROM network_project_contributors contributor
              WHERE contributor.project_id = network_projects.id
                AND contributor.status <> 'archived'
            )
            OR EXISTS (
              SELECT 1
              FROM network_project_task_refs refs
              JOIN task_projections projection
                ON projection.task_id = refs.task_id
              WHERE refs.project_id = network_projects.id
                AND refs.task_id <> ''
            )
            OR EXISTS (
              SELECT 1
              FROM network_task_generation_jobs job
              WHERE job.project_id = network_projects.id
                AND job.status IN ('queued', 'running', 'generated')
            )
          )
        ORDER BY priority ASC, title ASC
      `
    ),
    query(
      `
        SELECT *
        FROM network_project_contributors
        WHERE status <> 'archived'
          AND project_id IN (SELECT id FROM network_projects WHERE status <> 'archived')
        ORDER BY project_id ASC, sort_order ASC, wallet_address ASC
      `
    ),
    query(
      `
        SELECT refs.*,
               projection.status AS projected_status,
               projection.status AS status,
               projection.title AS projected_title,
               projection.account_id AS projected_account_id,
               projection.subject_wallet AS projected_subject_wallet,
               projection.task_kind AS task_kind,
               projection.reward_offer_pft AS reward_offer_pft,
               projection.reward_actual_pft AS reward_actual_pft,
               projection.event_count AS event_count,
               projection.last_event_tx_hash AS last_event_tx_hash,
               projection.last_event_cid AS last_event_cid,
               projection.metadata_json AS metadata_json,
               CASE
                 WHEN projection.status = 'rewarded' THEN projection.reward_actual_pft
                 ELSE projection.reward_offer_pft
               END AS projected_reward_pft,
               projection.updated_at AS projected_updated_at,
               alloc.id AS allocation_id,
               alloc.allocation_status,
               alloc.generated_task_id AS allocation_generated_task_id,
               alloc.task_request_id AS allocation_task_request_id,
               job.id AS generation_job_id,
               job.status AS generation_job_status,
               job.task_id AS generation_job_task_id,
               job.request_id AS generation_job_request_id,
               job.offer_cid AS generation_job_offer_cid,
               job.offer_tx_hash AS generation_job_offer_tx_hash,
               job.last_error AS generation_job_last_error,
               nft.title AS assignee_nft_title,
               nft.status AS assignee_nft_status,
               nft.image_cid AS assignee_nft_image_cid,
               nft.image_gateway_url AS assignee_nft_image_gateway_url
        FROM network_project_task_refs refs
        JOIN task_projections projection
          ON projection.task_id = refs.task_id
        LEFT JOIN LATERAL (
          SELECT candidate.*
          FROM (
            SELECT job.*, 0 AS match_rank
            FROM network_task_generation_jobs job
            WHERE job.task_id = projection.task_id
            UNION ALL
            SELECT job.*, 1 AS match_rank
            FROM network_task_generation_jobs job
            WHERE projection.request_id <> ''
              AND job.request_id = projection.request_id
            UNION ALL
            SELECT job.*, 2 AS match_rank
            FROM network_task_generation_jobs job
            WHERE refs.metadata_json->>'generation_job_id' <> ''
              AND job.id = refs.metadata_json->>'generation_job_id'
          ) candidate
          ORDER BY candidate.match_rank ASC,
                   candidate.updated_at DESC NULLS LAST,
                   candidate.id DESC
          LIMIT 1
        ) job ON true
        LEFT JOIN LATERAL (
          SELECT candidate.*
          FROM (
            SELECT alloc.*, 0 AS match_rank
            FROM network_task_allocations alloc
            WHERE alloc.generated_task_id = projection.task_id
            UNION ALL
            SELECT alloc.*, 1 AS match_rank
            FROM network_task_allocations alloc
            WHERE projection.request_id <> ''
              AND alloc.task_request_id = projection.request_id
            UNION ALL
            SELECT alloc.*, 2 AS match_rank
            FROM network_task_allocations alloc
            WHERE job.allocation_id <> ''
              AND alloc.id = job.allocation_id
          ) candidate
          ORDER BY candidate.match_rank ASC,
                   candidate.updated_at DESC NULLS LAST,
                   candidate.id DESC
          LIMIT 1
        ) alloc ON true
        LEFT JOIN LATERAL (
          SELECT id, title, status, image_cid, image_gateway_url, selected, created_at, updated_at
          FROM profile_nfts
          WHERE wallet_address = COALESCE(NULLIF(projection.subject_wallet, ''), refs.assignee_wallet)
            AND wallet_address <> ''
            AND status IN ('minted', 'prepared', 'generated')
            AND (
              COALESCE(image_gateway_url, '') <> ''
              OR COALESCE(image_cid, '') <> ''
            )
          ORDER BY
            selected DESC,
            created_at DESC NULLS LAST,
            updated_at DESC NULLS LAST,
            id DESC
          LIMIT 1
        ) nft ON true
        WHERE refs.task_id <> ''
          AND refs.project_id IN (SELECT id FROM network_projects WHERE status <> 'archived')
        ORDER BY refs.project_id ASC, refs.sort_order ASC, refs.id ASC
      `
    ),
    query(
      `
        SELECT *
        FROM network_project_activity
        WHERE project_id IN (SELECT id FROM network_projects WHERE status <> 'archived')
        ORDER BY project_id ASC, sort_order ASC, id ASC
      `
    ),
    query(
      `
        SELECT project_id, count(*)::int AS pending_generation_count
        FROM network_task_generation_jobs
        WHERE status IN ('queued', 'running', 'generated')
          AND project_id IN (SELECT id FROM network_projects WHERE status <> 'archived')
        GROUP BY project_id
        ORDER BY project_id ASC
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
  const boardSecretaryMemos = await getCurrentHiveBoardSecretaryMemos({
    projectIds: projectsResult.rows.map((row) => row.id),
  }).catch(() => []);
  const projectCommentsByProject = await listHiveProjectComments({
    projectIds: projectsResult.rows.map((row) => row.id),
    limitPerProject: 6,
  }).catch(() => ({}));
  const projectPlanning = await latestHiveProjectPlanningState().catch(() => null);
  const walletIdentities = mergeWalletIdentityLists(
    await listPublicAccountWalletIdentities(),
    await resolveHivePublicWalletIdentities({
      wallets: hiveWalletsFromRows({
        contributorRows: contributorsResult.rows,
        taskRows: tasksResult.rows,
        activityRows: activityResult.rows,
      }),
      walletAccounts: hiveWalletAccountsFromRows({
        taskRows: tasksResult.rows,
      }),
    })
  );
  const identityAccountIds = Array.from(new Set(walletIdentities.map((identity) => safeText(identity.accountId || identity.account_id, 180)).filter(Boolean)));
  const publicProfileIds = await discoverableMemberProfileIds(identityAccountIds);
  const operatorDisclosures = await listMachineOperatorDisclosures({ accountIds: identityAccountIds }).catch(() => ({}));

  return documentFromRows({
    projectRows: projectsResult.rows,
    contributorRows: contributorsResult.rows,
    taskRows: tasksResult.rows,
    activityRows: activityResult.rows,
    pendingGenerationRows: pendingGenerationResult.rows,
    projectCommentsByProject,
    productDocs,
    boardSecretaryMemos,
    latestSecretary: secretaryResult.rows[0] || null,
    projectPlanning,
    walletIdentities,
    publicProfileIds,
    operatorDisclosures,
    includeEmptyActive,
    viewerAccountId,
    viewerWalletAddress,
  });
}

export function applyHiveProjectsViewerContext(document = {}, {
  viewerAccountId = "",
  viewerWalletAddress = "",
} = {}) {
  const viewer = viewerContext({ accountId: viewerAccountId, walletAddress: viewerWalletAddress });
  if (!viewer.accountId && !viewer.walletAddress) return document;
  const sourceProjects = safeObject(document.projects);
  const projects = { ...sourceProjects };
  for (const projectId of safeArray(document.projectIds)) {
    const project = sourceProjects[projectId];
    if (!project) continue;
    projects[projectId] = {
      ...project,
      nextTask: projectNextTask(project, viewer),
    };
  }
  return {
    ...document,
    projects,
  };
}

export const hiveProjectsDocumentForTests = documentFromRows;
