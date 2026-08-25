import { databaseEnabled, transaction } from "./db/pool.js";
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

export async function runDataRetention({
  env = process.env,
  now = Date.now(),
  databaseReady = databaseEnabled(),
  transactionImpl = transaction,
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
  const limit = Math.min(Math.max(Number(batchSize) || 1000, 1), 10_000);
  return transactionImpl(async (client) => {
    const deletedConversationRows = await client.query(
      `SELECT id
         FROM chat_conversations
        WHERE status IN ('deleted', 'hive_disabled')
          AND deleted_at < $1::timestamptz
        ORDER BY deleted_at
        LIMIT $2`,
      [cutoffIso(now, schedule.deletedChatDays), limit]
    );
    const conversationIds = deletedConversationRows.rows.map((row) => row.id).filter(Boolean);
    const database = {};
    database.authSessionsExpired = (await client.query(
      `DELETE FROM auth_sessions
        WHERE expires_at <= $1::timestamptz
           OR revoked_at < $1::timestamptz - interval '7 days'`,
      [new Date(now).toISOString()]
    )).rowCount;
    database.authChallengesExpired = (await client.query(
      `DELETE FROM auth_challenges
        WHERE expires_at <= $1::timestamptz
           OR consumed_at < $1::timestamptz - interval '7 days'
           OR replaced_at < $1::timestamptz - interval '7 days'`,
      [new Date(now).toISOString()]
    )).rowCount;
    database.terminalAuthRequestsExpired = (await client.query(
      `DELETE FROM terminal_auth_requests
        WHERE expires_at <= $1::timestamptz
           OR consumed_at < $1::timestamptz - interval '7 days'`,
      [new Date(now).toISOString()]
    )).rowCount;
    database.terminalSessionsExpired = (await client.query(
      `DELETE FROM terminal_sessions
        WHERE (expires_at IS NOT NULL AND expires_at <= $1::timestamptz)
           OR revoked_at < $1::timestamptz - interval '7 days'`,
      [new Date(now).toISOString()]
    )).rowCount;
    if (conversationIds.length > 0) {
      for (const [name, sql] of [
        ["attachments", "DELETE FROM chat_attachments WHERE conversation_id = ANY($1::text[])"],
        ["memoryJobs", "DELETE FROM chat_memory_jobs WHERE conversation_id = ANY($1::text[])"],
        ["memoryEntries", "DELETE FROM chat_memory_entries WHERE conversation_id = ANY($1::text[])"],
        ["modelRuns", "DELETE FROM chat_model_runs WHERE conversation_id = ANY($1::text[])"],
        ["messages", "DELETE FROM chat_messages WHERE conversation_id = ANY($1::text[])"],
        ["conversations", "DELETE FROM chat_conversations WHERE id = ANY($1::text[])"],
      ]) {
        database[name] = (await client.query(sql, [conversationIds])).rowCount;
      }
    }

    const transientCutoff = cutoffIso(now, schedule.transientJobDays);
    database.memoryJobsExpired = (await client.query(
      "DELETE FROM chat_memory_jobs WHERE status IN ('completed', 'failed', 'skipped') AND updated_at < $1::timestamptz",
      [transientCutoff]
    )).rowCount;
    database.deepMemoryJobsExpired = (await client.query(
      "DELETE FROM chat_deep_memory_jobs WHERE status IN ('completed', 'failed', 'skipped') AND updated_at < $1::timestamptz",
      [transientCutoff]
    )).rowCount;
    database.contextProviderCallsExpired = (await client.query(
      "DELETE FROM context_rewrite_provider_calls WHERE created_at < $1::timestamptz",
      [transientCutoff]
    )).rowCount;
    database.telegramEventsExpired = (await client.query(
      "DELETE FROM telegram_bot_events WHERE created_at < $1::timestamptz",
      [cutoffIso(now, schedule.telegramEventDays)]
    )).rowCount;
    database.observabilityExpired = (await client.query(
      `DELETE FROM user_observability_events
        WHERE retention_until < $1::timestamptz
           OR (retention_until IS NULL AND received_at < $2::timestamptz)`,
      [new Date(now).toISOString(), cutoffIso(now, schedule.observabilityDays)]
    )).rowCount;
    database.collaborationAuditExpired = (await client.query(
      "DELETE FROM collaboration_audit_events WHERE created_at < $1::timestamptz",
      [cutoffIso(now, schedule.collaborationAuditDays)]
    )).rowCount;
    const rateLimitCutoff = cutoffIso(now, schedule.expiredRateLimitDays);
    database.apiRateLimitsExpired = (await client.query(
      "DELETE FROM api_rate_limit_buckets WHERE reset_at < $1::timestamptz",
      [rateLimitCutoff]
    )).rowCount;
    database.agentRateLimitsExpired = (await client.query(
      "DELETE FROM agent_rate_limit_buckets WHERE reset_at < $1::timestamptz",
      [rateLimitCutoff]
    )).rowCount;

    const financialCutoff = cutoffIso(now, schedule.financialRecordDays);
    database.deletedAccountLedgerExpired = (await client.query(
      "DELETE FROM billing_ledger_entries WHERE account_id LIKE 'deleted_account_%' AND created_at < $1::timestamptz",
      [financialCutoff]
    )).rowCount;
    database.deletedAccountBillingExpired = (await client.query(
      "DELETE FROM billing_accounts WHERE status = 'archived' AND updated_at < $1::timestamptz",
      [financialCutoff]
    )).rowCount;
    database.deletedAccountGrantsExpired = (await client.query(
      "DELETE FROM wallet_initiation_grants WHERE account_id LIKE 'deleted_account_%' AND updated_at < $1::timestamptz",
      [financialCutoff]
    )).rowCount;
    database.deletionAuditsExpired = (await client.query(
      "DELETE FROM account_deletion_audit WHERE deleted_at < $1::timestamptz",
      [financialCutoff]
    )).rowCount;

    return { enabled: true, runtimeSecurityStatePurged: true, schedule, database };
  });
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
      await runDataRetention({ env });
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
