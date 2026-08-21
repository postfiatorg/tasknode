import assert from "node:assert/strict";
import { exportRuntimeAccountDataForState } from "../server/account-export-state.js";
import { exportAccountDatabaseData } from "../server/account-export.js";
import { deleteAccountDatabaseData } from "../server/account-deletion-db.js";
import { buildAccountDeletionAuditRecord } from "../server/account-deletion-audit.js";

const accountId = "acct_data_subject";
const otherAccountId = "acct_other_user";
const runtimeExport = exportRuntimeAccountDataForState({
  accountId,
  safeId: (value) => value,
  state: {
    accounts: {
      [accountId]: { id: accountId, primaryEmailCanonical: "subject@example.test" },
      [otherAccountId]: { id: otherAccountId, primaryEmailCanonical: "other@example.test" },
    },
    accountWallets: { [accountId]: { accountId, address: "rSubject" } },
    conversationMeta: {
      subject_chat: { accountId, title: "Subject" },
      other_chat: { accountId: otherAccountId, title: "Other" },
    },
    conversations: {
      subject_chat: [{ role: "user", body: "subject body" }],
      other_chat: [{ role: "user", body: "other body" }],
    },
    ledgerEntries: [{ accountId, note: "subject charge" }, { accountId: otherAccountId, note: "other charge" }],
  },
});
assert.equal(runtimeExport.account.id, accountId);
assert.deepEqual(Object.keys(runtimeExport.conversations), ["subject_chat"]);
assert.equal(JSON.stringify(runtimeExport).includes("other@example.test"), false);
assert.equal(JSON.stringify(runtimeExport).includes("other body"), false);

const exportQueries = [];
const databaseExport = await exportAccountDatabaseData({
  accountId,
  databaseReady: true,
  transactionImpl: async (work) => work({
    query: async (sql, params = []) => {
      exportQueries.push({ sql, params });
      if (sql.includes("information_schema.columns")) {
        return { rows: [
          { table_name: "auth_sessions", column_names: ["token_hash", "account_id", "expires_at"] },
          { table_name: "chat_messages", column_names: ["id", "account_id", "body"] },
          { table_name: "context_documents", column_names: ["id", "account_id", "body"] },
        ] };
      }
      if (sql.includes('"auth_sessions"')) return { rows: [{ account_id: accountId, expires_at: "2026-08-16T00:00:00Z" }] };
      if (sql.includes('"chat_messages"')) return { rows: [{ account_id: accountId, body: "full chat" }] };
      if (sql.includes('"context_documents"')) return { rows: [{ account_id: accountId, body: "full context" }] };
      throw new Error(`unexpected export query: ${sql}`);
    },
  }),
});
assert.equal(databaseExport.totalRows, 3);
assert.equal(databaseExport.tables.chat_messages[0].body, "full chat");
const sessionExportQuery = exportQueries.find((entry) => entry.sql.includes('"auth_sessions"'));
assert.ok(sessionExportQuery);
assert.doesNotMatch(sessionExportQuery.sql, /token_hash/);
assert.deepEqual(exportQueries.slice(1).map((entry) => entry.params), [[accountId], [accountId], [accountId]]);

const deletionQueries = [];
const deletion = await deleteAccountDatabaseData({
  account: {
    providerIdentityHashes: ["identity_provider_hash"],
    providers: [{ provider: "github", providerUserIdHash: "identity_provider_hash", username: "private-name" }],
    primaryEmailHash: "identity_email_hash",
    profile: { displayName: "Private Name" },
  },
  accountId,
  archiveId: "deleted_account_subject",
  actorSessionId: "secret-session-token",
  walletAddress: "rSubjectWallet",
  ethereumDepositAddress: "0xSubjectDeposit",
  reason: "user typed private text into reason",
  databaseReady: true,
  insertAuditImpl: async (record) => {
    assert.equal(JSON.stringify(record).includes("private-name"), false);
    assert.equal(JSON.stringify(record).includes("Private Name"), false);
    return { ok: true };
  },
  transactionImpl: async (work) => work({
    query: async (sql, params = []) => {
      deletionQueries.push({ sql, params });
      if (sql.includes("information_schema.columns")) {
        assert.deepEqual(params[0], ["account_deletion_audit", "billing_accounts", "billing_ledger_entries", "wallet_initiation_grants"]);
        return { rows: [{ table_name: "chat_messages" }, { table_name: "context_documents" }] };
      }
      return { rows: [], rowCount: sql.startsWith("DELETE") || sql.includes("UPDATE") ? 1 : 0 };
    },
  }),
});
assert.equal(deletion.deletedRows.totalRows, 2);
assert.equal(deletion.authChallenges, 1);
assert.equal(deletionQueries.filter((entry) => entry.sql.startsWith("DELETE FROM")).length, 3);
assert.equal(deletionQueries.some((entry) => entry.sql.includes("DELETE FROM auth_challenges")), true);
assert.equal(deletionQueries.some((entry) => /UPDATE\s+"?(chat_messages|context_documents)/.test(entry.sql)), false);
const ledgerScrub = deletionQueries.find((entry) => entry.sql.includes("UPDATE billing_ledger_entries"));
assert.match(ledgerScrub.sql, /note = ''/);
assert.match(ledgerScrub.sql, /metadata_json = '\{"retainedAfterAccountDeletion":true\}'::jsonb/);
const grantScrub = deletionQueries.find((entry) => entry.sql.includes("UPDATE wallet_initiation_grants"));
assert.match(grantScrub.sql, /trigger_json = NULL/);

const audit = buildAccountDeletionAuditRecord({
  account: {
    providerIdentityHashes: ["identity_provider_hash"],
    providers: [{ provider: "github", providerUserIdHash: "identity_provider_hash", username: "private-name" }],
    primaryEmailHash: "identity_email_hash",
    profile: { displayName: "Private Name" },
  },
  accountId,
  archiveId: "deleted_account_subject",
  actorSessionId: "secret-session-token",
  walletAddress: "rSubjectWallet",
  ethereumDepositAddress: "0xSubjectDeposit",
  reason: "private free-form reason",
});
const serializedAudit = JSON.stringify(audit);
for (const forbidden of [accountId, "secret-session-token", "rSubjectWallet", "0xSubjectDeposit", "private-name", "Private Name", "private free-form reason"]) {
  assert.equal(serializedAudit.includes(forbidden), false, `deletion audit retained ${forbidden}`);
}
assert.equal(audit.reason, "user_requested_account_delete");
assert.equal(audit.metadata.schemaVersion, 2);

console.log("account data export and deletion lifecycle smoke ok");
