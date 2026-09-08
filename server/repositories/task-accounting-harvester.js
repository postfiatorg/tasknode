import { randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  intValue,
  iso,
  rowToCheckoutEvent,
  rowToHarvest,
  safeObject,
  safeText,
  taskAccountingHarvestOrderSql,
  validateTaskAccountingResolution,
} from "./task-accounting-harvest-contract.js";
import { maybeGenerateTaskAccountingHarvestReport } from "./task-accounting-harvest-report.js";

export {
  taskAccountingHarvestOrderSql,
  taskAccountingHarvestSourcePacket,
  validateTaskAccountingResolution,
} from "./task-accounting-harvest-contract.js";
export {
  getLatestTaskAccountingHarvestReport,
  maybeGenerateTaskAccountingHarvestReport,
} from "./task-accounting-harvest-report.js";

// Legacy harvest history and manual resolution remain available after the poller retirement.
export async function listTaskAccountingHarvests({
  status = "",
  classification = "",
  requiresAction = "",
  resolved = "",
  includeResolved = false,
  limit = 40,
  page = 1,
} = {}) {
  if (!databaseEnabled()) {
    return {
      ok: true,
      harvests: [],
      summary: {
        total: 0,
        queued: 0,
        harvesting: 0,
        harvested: 0,
        failed: 0,
        requiresAction: 0,
        noAction: 0,
      },
      page: 1,
      pageSize: 0,
      hasMore: false,
    };
  }
  const filters = [];
  const params = [];
  const normalizedStatus = safeText(status, 40);
  if (normalizedStatus) {
    params.push(normalizedStatus);
    filters.push(`status = $${params.length}`);
  }
  const normalizedClassification = safeText(classification, 80);
  if (normalizedClassification) {
    params.push(normalizedClassification);
    filters.push(`classification = $${params.length}`);
  }
  const actionFilter = safeText(requiresAction, 20).toLowerCase();
  if (["true", "false"].includes(actionFilter)) {
    params.push(actionFilter === "true");
    filters.push(`requires_action = $${params.length}`);
  }
  const resolvedFilter = safeText(resolved, 20).toLowerCase();
  if (["true", "false"].includes(resolvedFilter)) {
    filters.push(resolvedFilter === "true" ? "resolved_at IS NOT NULL" : "resolved_at IS NULL");
  } else if (includeResolved !== true) {
    filters.push("resolved_at IS NULL");
  }
  const safeLimit = intValue(limit, 40, { min: 1, max: 100 });
  const safePage = intValue(page, 1, { min: 1, max: 1000 });
  const orderSql = taskAccountingHarvestOrderSql({ resolvedFilter });
  params.push(safeLimit + 1, (safePage - 1) * safeLimit);
  const result = await query(
    `
      SELECT
        harvest.*,
        COALESCE(identity.public_handle, '') AS contributor_public_handle,
        COALESCE(hive.display_name, identity.public_handle, '') AS contributor_display_name,
        COALESCE(badges.verified_badges_json, '[]'::jsonb) AS verified_badges_json,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,taskWorkType}',
          harvest.source_packet_json #>> '{task,taskWorkType}',
          ''
        ) AS task_work_type,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,requiredBadgeId}',
          harvest.source_packet_json #>> '{task,requiredBadgeId}',
          ''
        ) AS required_badge_id,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,operatingBadgeId}',
          harvest.source_packet_json #>> '{task,operatingBadgeId}',
          ''
        ) AS operating_badge_id,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,badgeWorkType}',
          harvest.source_packet_json #>> '{task,badgeWorkType}',
          ''
        ) AS badge_work_type,
        COALESCE(
          harvest.source_packet_json #>> '{badgeContext,badgeRewardCapPft}',
          harvest.source_packet_json #>> '{task,badgeRewardCapPft}',
          ''
        ) AS badge_reward_cap_pft
      FROM task_accounting_harvests harvest
      LEFT JOIN LATERAL (
        SELECT display_name
        FROM hive_context_entries entry
        WHERE entry.account_id = harvest.account_id
          AND entry.deleted_at IS NULL
          AND entry.display_name <> ''
        ORDER BY entry.created_at DESC, entry.id DESC
        LIMIT 1
      ) hive ON true
      LEFT JOIN LATERAL (
        SELECT public_handle
        FROM account_identity_approvals approval
        WHERE approval.account_id = harvest.account_id
          AND approval.status = 'active'
          AND approval.public_handle <> ''
          AND approval.revoked_at IS NULL
        ORDER BY approval.updated_at DESC, approval.id DESC
        LIMIT 1
      ) identity ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
          'badgeId', badge.badge_id,
          'label', definition.label,
          'selectedDefault', badge.selected_default
        ) ORDER BY badge.selected_default DESC, badge.updated_at DESC, badge.badge_id ASC) AS verified_badges_json
        FROM account_network_badges badge
        JOIN network_badge_definitions definition
          ON definition.badge_id = badge.badge_id
        WHERE badge.account_id = harvest.account_id
          AND badge.status = 'verified'
          AND badge.revoked_at IS NULL
          AND definition.active = true
          AND (badge.expires_at IS NULL OR badge.expires_at > now())
      ) badges ON true
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY ${orderSql}
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `,
    params
  );
  const summaryResult = await query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'queued')::int AS queued,
      count(*) FILTER (WHERE status = 'harvesting')::int AS harvesting,
      count(*) FILTER (WHERE status = 'harvested')::int AS harvested,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE classification = 'requires_action')::int AS requires_action,
      count(*) FILTER (WHERE classification = 'no_action')::int AS no_action,
      count(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
      count(*) FILTER (WHERE checked_out_at IS NOT NULL AND resolved_at IS NULL)::int AS checked_out
    FROM task_accounting_harvests
  `);
  const summary = summaryResult.rows[0] || {};
  return {
    ok: true,
    harvests: result.rows.slice(0, safeLimit).map(rowToHarvest),
    summary: {
      total: Number(summary.total || 0),
      queued: Number(summary.queued || 0),
      harvesting: Number(summary.harvesting || 0),
      harvested: Number(summary.harvested || 0),
      failed: Number(summary.failed || 0),
      requiresAction: Number(summary.requires_action || 0),
      noAction: Number(summary.no_action || 0),
      resolved: Number(summary.resolved || 0),
      checkedOut: Number(summary.checked_out || 0),
    },
    page: safePage,
    pageSize: safeLimit,
    hasMore: result.rows.length > safeLimit,
  };
}

export async function getTaskAccountingCheckoutAccess({ accountId = "", walletAddress = "" } = {}) {
  const denied = {
    canCheckout: false,
    hasCoreContributorBadge: false,
    hasActiveOrcAgent: false,
  };
  if (!databaseEnabled()) return denied;
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWallet = safeText(walletAddress, 120);
  if (!normalizedAccountId) return denied;
  const badgeResult = await query(
    `
      SELECT 1
      FROM account_network_badges badge
      JOIN network_badge_definitions definition
        ON definition.badge_id = badge.badge_id
      WHERE badge.account_id = $1
        AND badge.badge_id = 'core_contributor'
        AND badge.status = 'verified'
        AND badge.revoked_at IS NULL
        AND definition.active = true
        AND (badge.expires_at IS NULL OR badge.expires_at > now())
      LIMIT 1
    `,
    [normalizedAccountId]
  );
  const hasCoreContributorBadge = Boolean(badgeResult.rows[0]);
  let hasActiveOrcAgent = false;
  if (normalizedWallet) {
    const orcResult = await query(
      `
        SELECT 1
        FROM orc_agents agent
        WHERE agent.account_id = $1
          AND lower(agent.wallet_address) = lower($2)
          AND agent.active = true
          AND lower(agent.status) = 'active'
        LIMIT 1
      `,
      [normalizedAccountId, normalizedWallet]
    );
    hasActiveOrcAgent = Boolean(orcResult.rows[0]);
  }
  return {
    canCheckout: Boolean(hasCoreContributorBadge || hasActiveOrcAgent),
    hasCoreContributorBadge,
    hasActiveOrcAgent,
  };
}

export async function accountHasTaskAccountingCheckoutAccess({ accountId = "", walletAddress = "" } = {}) {
  const access = await getTaskAccountingCheckoutAccess({ accountId, walletAddress });
  return Boolean(access.canCheckout);
}

export async function accountCanResolveCheckedOutTaskAccountingHarvest({
  taskId = "",
  accountId = "",
  walletAddress = "",
} = {}) {
  if (!databaseEnabled()) return false;
  const normalizedTaskId = safeText(taskId, 180);
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWallet = safeText(walletAddress, 120);
  if (!normalizedTaskId || !normalizedAccountId || !normalizedWallet) return false;
  const access = await getTaskAccountingCheckoutAccess({
    accountId: normalizedAccountId,
    walletAddress: normalizedWallet,
  });
  if (!access.canCheckout) return false;
  const result = await query(
    `
      SELECT 1
      FROM task_accounting_harvests
      WHERE task_id = $1
        AND checked_out_by_account_id = $2
        AND lower(checked_out_wallet_address) = lower($3)
        AND resolved_at IS NULL
      LIMIT 1
    `,
    [normalizedTaskId, normalizedAccountId, normalizedWallet]
  );
  return Boolean(result.rows[0]);
}

export async function checkoutTaskAccountingHarvest({
  taskId = "",
  accountId = "",
  walletAddress = "",
  metadata = {},
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedTaskId = safeText(taskId, 180);
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedWallet = safeText(walletAddress, 120);
  if (!normalizedTaskId) return { ok: false, status: 400, error: "task_accounting_harvest_task_required" };
  if (!normalizedAccountId) return { ok: false, status: 401, error: "task_accounting_harvest_checkout_login_required" };
  if (!normalizedWallet) return { ok: false, status: 409, error: "task_accounting_harvest_checkout_wallet_required" };

  return transaction(async (client) => {
    const current = await client.query(
      `
        SELECT *
        FROM task_accounting_harvests
        WHERE task_id = $1
        FOR UPDATE
      `,
      [normalizedTaskId]
    );
    const row = current.rows[0];
    if (!row) return { ok: false, status: 404, error: "task_accounting_harvest_not_found" };
    if (row.resolved_at) {
      return { ok: false, status: 409, error: "task_accounting_harvest_already_resolved" };
    }
    if (row.checked_out_at) {
      const sameAccount = safeText(row.checked_out_by_account_id, 180).toLowerCase() === normalizedAccountId.toLowerCase();
      const sameWallet = safeText(row.checked_out_wallet_address, 120).toLowerCase() === normalizedWallet.toLowerCase();
      if (sameAccount && sameWallet) {
        return { ok: true, alreadyCheckedOut: true, harvest: rowToHarvest(row) };
      }
      return {
        ok: false,
        status: 409,
        error: "task_accounting_harvest_already_checked_out",
        checkout: {
          checkedOutAt: iso(row.checked_out_at),
          accountId: safeText(row.checked_out_by_account_id, 180),
          walletAddress: safeText(row.checked_out_wallet_address, 120),
        },
      };
    }

    const updated = await client.query(
      `
        UPDATE task_accounting_harvests
        SET checked_out_at = now(),
            checked_out_by_account_id = $2,
            checked_out_wallet_address = $3,
            updated_at = now()
        WHERE task_id = $1
        RETURNING *
      `,
      [normalizedTaskId, normalizedAccountId, normalizedWallet]
    );
    const event = await client.query(
      `
        INSERT INTO task_accounting_harvest_checkout_events (
          id,
          task_id,
          event_type,
          account_id,
          wallet_address,
          metadata_json
        )
        VALUES ($1, $2, 'checked_out', $3, $4, $5::jsonb)
        RETURNING *
      `,
      [
        `tah_checkout_${randomUUID().replaceAll("-", "")}`,
        normalizedTaskId,
        normalizedAccountId,
        normalizedWallet,
        JSON.stringify(safeObject(metadata)),
      ]
    );
    return {
      ok: true,
      harvest: rowToHarvest(updated.rows[0]),
      event: rowToCheckoutEvent({
        ...event.rows[0],
        title: updated.rows[0]?.title,
        current_checked_out_at: updated.rows[0]?.checked_out_at,
        current_checkout_account_id: updated.rows[0]?.checked_out_by_account_id,
        current_checkout_wallet_address: updated.rows[0]?.checked_out_wallet_address,
        resolved_at: updated.rows[0]?.resolved_at,
        classification: updated.rows[0]?.classification,
        requires_action: updated.rows[0]?.requires_action,
        action_category: updated.rows[0]?.action_category,
        suggested_action: updated.rows[0]?.suggested_action,
      }),
    };
  });
}

export async function listTaskAccountingHarvestCheckouts({ includeResolved = false, limit = 80, page = 1 } = {}) {
  if (!databaseEnabled()) {
    return { ok: true, events: [], page: 1, pageSize: 0, hasMore: false };
  }
  const safeLimit = intValue(limit, 80, { min: 1, max: 100 });
  const safePage = intValue(page, 1, { min: 1, max: 1000 });
  const result = await query(
    `
      SELECT
        event.*,
        harvest.title,
        harvest.classification,
        harvest.requires_action,
        harvest.action_category,
        harvest.suggested_action,
        harvest.resolved_at,
        harvest.checked_out_at AS current_checked_out_at,
        harvest.checked_out_by_account_id AS current_checkout_account_id,
        harvest.checked_out_wallet_address AS current_checkout_wallet_address
      FROM task_accounting_harvest_checkout_events event
      JOIN task_accounting_harvests harvest
        ON harvest.task_id = event.task_id
      WHERE ($3::boolean = true OR harvest.resolved_at IS NULL)
      ORDER BY event.created_at DESC, event.id DESC
      LIMIT $1
      OFFSET $2
    `,
    [safeLimit + 1, (safePage - 1) * safeLimit, Boolean(includeResolved)]
  );
  return {
    ok: true,
    events: result.rows.slice(0, safeLimit).map(rowToCheckoutEvent),
    page: safePage,
    pageSize: safeLimit,
    hasMore: result.rows.length > safeLimit,
  };
}

export async function resolveTaskAccountingHarvest({
  taskId = "",
  resolvedByAccountId = "",
  outcome = "",
  note = "",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const normalizedTaskId = safeText(taskId, 180);
  const validation = validateTaskAccountingResolution({ outcome, note });
  if (!validation.ok) return { ok: false, status: 400, ...validation };
  const result = await query(
    `
      UPDATE task_accounting_harvests
      SET resolved_at = now(),
          resolved_by_account_id = $2,
          resolution_outcome = $3,
          resolution_note = $4,
          checked_out_at = NULL,
          checked_out_by_account_id = '',
          checked_out_wallet_address = '',
          updated_at = now()
      WHERE task_id = $1
        AND resolved_at IS NULL
      RETURNING *
    `,
    [normalizedTaskId, safeText(resolvedByAccountId, 180), validation.outcome, validation.note]
  );
  if (result.rows[0]) {
    const harvestReport = await maybeGenerateTaskAccountingHarvestReport().catch((error) => ({
      ok: false,
      error: error?.message || "task_accounting_harvest_report_failed",
    }));
    return {
      ok: true,
      harvest: rowToHarvest(result.rows[0]),
      harvestReport: harvestReport?.report || null,
      harvestReportGenerated: Boolean(harvestReport?.generated),
    };
  }
  const exists = await query(
    `
      SELECT resolved_at
      FROM task_accounting_harvests
      WHERE task_id = $1
      LIMIT 1
    `,
    [normalizedTaskId]
  );
  if (exists.rows[0]?.resolved_at) {
    return { ok: false, status: 409, error: "task_accounting_harvest_already_resolved" };
  }
  return { ok: false, status: 404, error: "task_accounting_harvest_not_found" };
}
