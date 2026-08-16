const RETRYABLE_ISSUANCE_STATUSES = new Set(["pending", "failed_before_submit"]);
const BLOCKING_ISSUANCE_STATUSES = new Set([
  "processing",
  "processing_pre_submit",
  "submitting",
  "submit_unknown",
  "submitted",
  "cancelled",
]);

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

export function dailyAirdropDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

export function normalizeDailyAirdropIssuanceStatus(rowOrStatus = {}) {
  const row = typeof rowOrStatus === "string" ? { status: rowOrStatus } : rowOrStatus || {};
  const status = safeText(row.status, 80);
  if (
    status === "failed" &&
    !safeText(row.tx_hash || row.txHash, 120) &&
    !(row.submitted_at || row.submittedAt)
  ) {
    return "failed_before_submit";
  }
  if (status === "processing") {
    return row.submission_attempted_at || row.submissionAttemptedAt ? "submit_unknown" : "processing_pre_submit";
  }
  return status || "pending";
}

export function dailyAirdropIssuanceRetryable(rowOrStatus = {}) {
  return RETRYABLE_ISSUANCE_STATUSES.has(normalizeDailyAirdropIssuanceStatus(rowOrStatus));
}

export function dailyAirdropIssuanceBlocksRetry(rowOrStatus = {}) {
  return BLOCKING_ISSUANCE_STATUSES.has(normalizeDailyAirdropIssuanceStatus(rowOrStatus));
}

export function normalizeDailyAirdropIssuance(row = null) {
  if (!row) return null;
  const status = normalizeDailyAirdropIssuanceStatus(row);
  return {
    id: row.id || "",
    accountId: row.account_id || "",
    runId: row.run_id || "",
    runDate: row.run_date ? dailyAirdropDate(row.run_date) : "",
    sourceWallet: row.source_wallet || "",
    recipientWallet: row.recipient_wallet || "",
    amountPft: Number(row.amount_pft || 0),
    amountDrops: row.amount_drops || "",
    status,
    rawStatus: row.status || status,
    sourceCid: row.source_cid || "",
    txHash: row.tx_hash || "",
    ledgerIndex: row.ledger_index || null,
    payloadDigest: row.payload_digest || "",
    errorMessage: row.error_message || "",
    attemptCount: Number(row.attempt_count || 0),
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
    lastErrorCode: row.last_error_code || "",
    lastErrorMessage: row.last_error_message || "",
    submissionAttemptedAt: row.submission_attempted_at ? new Date(row.submission_attempted_at).toISOString() : null,
    signedTxHash: row.signed_tx_hash || "",
    reconciliation: row.reconciliation_json || {},
    reconciledAt: row.reconciled_at ? new Date(row.reconciled_at).toISOString() : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    retryable: dailyAirdropIssuanceRetryable(row),
    blocksRetry: dailyAirdropIssuanceBlocksRetry(row),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
  };
}
