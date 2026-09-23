import { databaseEnabled, query, transaction } from "./db/pool.js";
import {
  pruneExpiredEmailChallenges,
  pruneExpiredOAuthStates,
  pruneExpiredSessions,
  pruneExpiredTerminalAuthRequests,
  pruneExpiredTerminalSessions,
  pruneExpiredWalletChallenges,
} from "./runtime-store.js";

const dayMs = 86_400_000;

function boundedDays(value, fallback, min = 1, max = 3650) {
  const parsed = Number(value);
  return Math.min(Math.max(Number.isFinite(parsed) ? Math.round(parsed) : fallback, min), max);
}

function cutoffIso(now, days) {
  return new Date(now - days * dayMs).toISOString();
}

export function retentionSchedule(env = process.env) {
  return {
    deletedChatDays: boundedDays(env.TASKNODE_RETENTION_DELETED_CHAT_DAYS, 30),
    transientJobDays: boundedDays(env.TASKNODE_RETENTION_TRANSIENT_JOB_DAYS, 30),
    telegramEventDays: boundedDays(env.TASKNODE_RETENTION_TELEGRAM_EVENT_DAYS, 30),
    observabilityDays: boundedDays(env.TASKNODE_RETENTION_OBSERVABILITY_DAYS, 90),
    collaborationAuditDays: boundedDays(env.TASKNODE_RETENTION_COLLABORATION_AUDIT_DAYS, 365),
    financialRecordDays: boundedDays(env.TASKNODE_RETENTION_FINANCIAL_RECORD_DAYS, 2555, 365),
    expiredRateLimitDays: boundedDays(env.TASKNODE_RETENTION_RATE_LIMIT_DAYS, 2),
  };
}

// Tables are purged independently in bounded batches. One slow or failing table
// must not roll back the others, and no single statement may approach the
// statement timeout however large the backlog has grown.
function retentionRules(schedule, now) {
  const at = new Date(now).toISOString();
  const transient = cutoffIso(now, schedule.transientJobDays);
  const financial = cutoffIso(now, schedule.financialRecordDays);
  return [
    ["authSessionsExpired", "auth_sessions", "expires_at <= $1::timestamptz OR revoked_at < $1::timestamptz - interval '7 days'", [at]],
    ["authChallengesExpired", "auth_challenges", "expires_at <= $1::timestamptz OR consumed_at < $1::timestamptz - interval '7 days' OR replaced_at < $1::timestamptz - interval '7 days'", [at]],
    ["terminalAuthRequestsExpired", "terminal_auth_requests", "expires_at <= $1::timestamptz OR consumed_at < $1::timestamptz - interval '7 days'", [at]],
    ["terminalSessionsExpired", "terminal_sessions", "(expires_at IS NOT NULL AND expires_at <= $1::timestamptz) OR revoked_at < $1::timestamptz - interval '7 days'", [at]],
    ["memoryJobsExpired", "chat_memory_jobs", "status IN ('completed', 'failed', 'skipped') AND updated_at < $1::timestamptz", [transient]],
    ["deepMemoryJobsExpired", "chat_deep_memory_jobs", "status IN ('completed', 'failed', 'skipped') AND updated_at < $1::timestamptz", [transient]],
    ["contextProviderCallsExpired", "context_rewrite_provider_calls", "created_at < $1::timestamptz", [transient]],
    // Readers use only the current memo per board; superseded and failed memos carry full source packets.
    ["boardSecretaryMemosExpired", "hive_board_secretary_memos", "status IN ('superseded', 'failed') AND generated_at < $1::timestamptz", [transient]],
    ["telegramEventsExpired", "telegram_bot_events", "created_at < $1::timestamptz", [cutoffIso(now, schedule.telegramEventDays)]],
    ["observabilityExpired", "user_observability_events", "retention_until < $1::timestamptz OR (retention_until IS NULL AND received_at < $2::timestamptz)", [at, cutoffIso(now, schedule.observabilityDays)]],
    ["collaborationAuditExpired", "collaboration_audit_events", "created_at < $1::timestamptz", [cutoffIso(now, schedule.collaborationAuditDays)]],
    ["apiRateLimitsExpired", "api_rate_limit_buckets", "reset_at < $1::timestamptz", [cutoffIso(now, schedule.expiredRateLimitDays)]],
    ["agentRateLimitsExpired", "agent_rate_limit_buckets", "reset_at < $1::timestamptz", [cutoffIso(now, schedule.expiredRateLimitDays)]],
    ["deletedAccountLedgerExpired", "billing_ledger_entries", "account_id LIKE 'deleted_account_%' AND created_at < $1::timestamptz", [financial]],
    ["deletedAccountBillingExpired", "billing_accounts", "status = 'archived' AND updated_at < $1::timestamptz", [financial]],
    ["deletedAccountGrantsExpired", "wallet_initiation_grants", "account_id LIKE 'deleted_account_%' AND updated_at < $1::timestamptz", [financial]],
    ["deletionAuditsExpired", "account_deletion_audit", "deleted_at < $1::timestamptz", [financial]],
  ];
}

async function deleteInBatches(queryImpl, table, where, params, limit) {
  let total = 0;
  for (let round = 0; round < 1000; round += 1) {
    const { rowCount = 0 } = await queryImpl(
      `DELETE FROM ${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${table} WHERE ${where} LIMIT ${limit}))`,
      params
    );
    total += rowCount;
    if (rowCount < limit) break;
  }
  return total;
}

async function purgeDeletedConversations({ transactionImpl, cutoff, limit }) {
  const totals = {};
  for (let round = 0; round < 1000; round += 1) {
    const batch = await transactionImpl(async (client) => {
      const ids = (await client.query(
        `SELECT id FROM chat_conversations
          WHERE status IN ('deleted', 'hive_disabled') AND deleted_at < $1::timestamptz
          ORDER BY deleted_at LIMIT $2`,
        [cutoff, limit]
      )).rows.map((row) => row.id).filter(Boolean);
      if (ids.length === 0) return 0;
      for (const [name, sql] of [
        ["attachments", "DELETE FROM chat_attachments WHERE conversation_id = ANY($1::text[])"],
        ["memoryJobs", "DELETE FROM chat_memory_jobs WHERE conversation_id = ANY($1::text[])"],
        ["memoryEntries", "DELETE FROM chat_memory_entries WHERE conversation_id = ANY($1::text[])"],
        ["modelRuns", "DELETE FROM chat_model_runs WHERE conversation_id = ANY($1::text[])"],
        ["messages", "DELETE FROM chat_messages WHERE conversation_id = ANY($1::text[])"],
        ["conversations", "DELETE FROM chat_conversations WHERE id = ANY($1::text[])"],
      ]) {
        totals[name] = (totals[name] || 0) + (await client.query(sql, [ids])).rowCount;
      }
      return ids.length;
    });
    if (batch < limit) break;
  }
  return totals;
}

export async function runDataRetention({
  env = process.env,
  now = Date.now(),
  databaseReady = databaseEnabled(),
  transactionImpl = transaction,
  queryImpl = query,
  batchSize = 1000,
} = {}) {
  pruneExpiredSessions();
  pruneExpiredEmailChallenges();
  pruneExpiredOAuthStates();
  pruneExpiredWalletChallenges();
  pruneExpiredTerminalAuthRequests();
  pruneExpiredTerminalSessions();
  if (!databaseReady) return { enabled: false, runtimeSecurityStatePurged: true, database: {} };

  const schedule = retentionSchedule(env);
  const limit = Math.min(Math.max(Math.round(Number(batchSize)) || 1000, 1), 10_000);
  const database = {};
  const errors = {};
  try {
    Object.assign(database, await purgeDeletedConversations({ transactionImpl, cutoff: cutoffIso(now, schedule.deletedChatDays), limit }));
  } catch (error) {
    errors.conversations = error?.message || String(error);
  }
  for (const [name, table, where, params] of retentionRules(schedule, now)) {
    try {
      database[name] = await deleteInBatches(queryImpl, table, where, params, limit);
    } catch (error) {
      errors[name] = error?.message || String(error);
    }
  }
  return { enabled: true, runtimeSecurityStatePurged: true, schedule, database, errors };
}

export function startDataRetentionWorker({
  env = process.env,
  enabled = env.TASKNODE_DATA_RETENTION_WORKER_ENABLED !== "false" && (env.TASKNODE_ENV === "production" || env.NODE_ENV === "production"),
  intervalMs = Number(env.TASKNODE_DATA_RETENTION_INTERVAL_MS || 6 * 60 * 60 * 1000),
  initialDelayMs = Number(env.TASKNODE_DATA_RETENTION_INITIAL_DELAY_MS || 60_000),
  logger = console,
} = {}) {
  if (!enabled) return { started: false, reason: "disabled" };
  const safeInterval = Math.min(Math.max(intervalMs, 5 * 60_000), 7 * dayMs);
  const safeInitialDelay = Math.min(Math.max(initialDelayMs, 1000), safeInterval);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDataRetention({ env });
      const failed = Object.keys(result.errors || {});
      (failed.length ? logger.warn : logger.log)?.call(logger, "data_retention_completed", { deleted: result.database, errors: result.errors });
    } catch (error) {
      logger.warn?.("data_retention_failed", { error: error?.message || String(error) });
    } finally {
      running = false;
    }
  };
  const initialTimer = setTimeout(tick, safeInitialDelay);
  const timer = setInterval(tick, safeInterval);
  return { started: true, stop: () => { clearTimeout(initialTimer); clearInterval(timer); } };
}
