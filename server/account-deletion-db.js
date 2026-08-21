import { databaseEnabled, transaction } from "./db/pool.js";
import {
  buildAccountDeletionAuditRecord,
  insertAccountDeletionAuditRecord,
} from "./account-deletion-audit.js";

const blockingGrantStatuses = ["processing", "completed", "unknown"];
const retainedAccountTables = ["account_deletion_audit", "billing_accounts", "billing_ledger_entries", "wallet_initiation_grants"];

function quoteIdentifier(value) {
  return `"${String(value || "").replaceAll("\"", "\"\"")}"`;
}

export async function deleteAccountRows(client, { accountId = "" } = {}) {
  const tables = await client.query(
    `SELECT columns.table_name
       FROM information_schema.columns columns
       JOIN information_schema.tables tables
         ON tables.table_schema = columns.table_schema
        AND tables.table_name = columns.table_name
      WHERE columns.table_schema = 'public'
        AND columns.column_name = 'account_id'
        AND tables.table_type = 'BASE TABLE'
        AND columns.table_name <> ALL($1::text[])
      ORDER BY columns.table_name`,
    [retainedAccountTables]
  );
  const changed = {};
  let totalRows = 0;
  for (const table of tables.rows) {
    const result = await client.query(`DELETE FROM ${quoteIdentifier(table.table_name)} WHERE account_id = $1`, [accountId]);
    if (result.rowCount > 0) {
      changed[table.table_name] = result.rowCount;
      totalRows += result.rowCount;
    }
  }
  return { totalRows, tables: changed };
}

export async function deleteAccountDatabaseData({
  account = null,
  accountId = "",
  archiveId = "",
  walletAddress = "",
  ethereumDepositAddress = "",
  actorSessionId = "",
  reason = "user_requested_account_delete",
  databaseReady = databaseEnabled(),
  transactionImpl = transaction,
  insertAuditImpl = insertAccountDeletionAuditRecord,
} = {}) {
  if (!databaseReady) return { enabled: false, skipped: true };
  return transactionImpl(async (client) => {
    const auditRecord = buildAccountDeletionAuditRecord({
      account,
      accountId,
      archiveId,
      walletAddress,
      ethereumDepositAddress,
      reason,
      actorSessionId,
    });
    const deletionAudit = await insertAuditImpl(auditRecord, { client });
    const deletedRows = await deleteAccountRows(client, { accountId });
    const authChallenges = await client.query(
      `DELETE FROM auth_challenges
        WHERE subject_key = $1
           OR payload_json->>'accountId' = $1
           OR payload_json->>'linkAccountId' = $1`,
      [accountId]
    );
    const ledger = await client.query(
      `UPDATE billing_ledger_entries
          SET account_id = $2,
              note = '',
              created_by = 'system',
              conversation_id = NULL,
              model_run_id = NULL,
              response_id = NULL,
              idempotency_key = NULL,
              metadata_json = '{"retainedAfterAccountDeletion":true}'::jsonb
        WHERE account_id = $1`,
      [accountId, archiveId]
    );
    const billingAccount = await client.query(
      "UPDATE billing_accounts SET account_id = $2, status = 'archived', updated_at = now() WHERE account_id = $1",
      [accountId, archiveId]
    );
    const grants = await client.query(
      `UPDATE wallet_initiation_grants
          SET account_id = $4,
              status = CASE WHEN status = ANY($1::text[]) THEN 'failed' ELSE status END,
              trigger_json = NULL,
              error_message = $5,
              updated_at = now()
        WHERE account_id = $2
           OR ($3 <> '' AND wallet_address = $3)
        RETURNING id`,
      [blockingGrantStatuses, accountId, walletAddress || "", archiveId, `account deleted: ${reason}`]
    );
    return {
      enabled: true,
      archiveId,
      deletionAudit: { id: auditRecord.id, inserted: deletionAudit.ok === true },
      deletedRows,
      authChallenges: authChallenges.rowCount,
      billing: { ledgerRows: ledger.rowCount, billingAccounts: billingAccount.rowCount },
      walletInitiationGrants: grants.rowCount,
    };
  });
}
