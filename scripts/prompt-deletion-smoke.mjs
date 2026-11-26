import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { encryptPrompt, newLibraryKey } from "../packages/tasknode-cli/lib/prompt-crypto.mjs";

process.env.DATABASE_URL ||= "postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5438/tasknodeofficial";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL).hostname));
process.env.TASKNODE_DATABASE_ENABLED = "true";
const { getPool } = await import("../server/db/pool.js");
const { deleteAccountDatabaseData } = await import("../server/account-deletion-db.js");
const client = await getPool().connect();
const accountId = `prompt-erasure-${randomUUID()}`;
const otherAccountId = `prompt-keeper-${randomUUID()}`;
const ciphertext = await encryptPrompt({ text: "synthetic deletion fixture" }, newLibraryKey());

async function seedPrompt(owner) {
  const documentId = randomUUID();
  await client.query(
    `INSERT INTO docs_documents
    (document_id, owner_account_id, pfdocs_channel_hash, encrypted_metadata, document_type)
    VALUES ($1, $2, $3, $4, 'prompt')`,
    [documentId, owner, randomUUID().replaceAll("-", ""), ciphertext],
  );
  await client.query(
    `INSERT INTO prompt_history_events (event_id, account_id, document_id, ciphertext)
    VALUES ($1, $2, $3, $4)`,
    [randomUUID(), owner, documentId, ciphertext],
  );
  return documentId;
}

async function count(table, column, value) {
  return Number((await client.query(`SELECT count(*) FROM ${table} WHERE ${column} = $1`, [value])).rows[0].count);
}

try {
  await client.query("BEGIN");
  for (const owner of [accountId, otherAccountId]) {
    await client.query(
      `INSERT INTO docs_accounts
      (account_id, pfdocs_account_hash, encrypted_root_key_envelope, envelope_wallet_address)
      VALUES ($1, $1, $2, 'synthetic-local')`,
      [owner, ciphertext],
    );
    await client.query(
      `INSERT INTO prompt_devices
      (device_id, account_id, session_id, public_key, fingerprint, label)
      VALUES ($1, $2, $3, 'synthetic', 'synthetic', 'Deletion smoke')`,
      [randomUUID(), owner, randomUUID()],
    );
  }
  const kept = await seedPrompt(otherAccountId);
  const hardDeleted = await seedPrompt(accountId);
  await client.query("SAVEPOINT update_guard");
  await assert.rejects(
    client.query("UPDATE prompt_history_events SET ciphertext = '{}' WHERE document_id = $1", [hardDeleted]),
    /prompt_history_append_only/,
  );
  await client.query("ROLLBACK TO SAVEPOINT update_guard");
  await assert.rejects(
    client.query("DELETE FROM prompt_history_events WHERE document_id = $1", [hardDeleted]),
    /prompt_history_append_only/,
  );
  await client.query("ROLLBACK TO SAVEPOINT update_guard");
  await client.query("DELETE FROM docs_documents WHERE document_id = $1", [hardDeleted]);
  assert.equal(await count("prompt_history_events", "document_id", hardDeleted), 0);
  const softDeleted = await seedPrompt(accountId);
  await client.query("UPDATE docs_documents SET status = 'deleted' WHERE document_id = $1", [softDeleted]);
  assert.equal(await count("prompt_history_events", "document_id", softDeleted), 0);
  const archived = await seedPrompt(accountId);
  await client.query("UPDATE docs_documents SET status = 'archived' WHERE document_id = $1", [archived]);
  assert.equal(await count("prompt_history_events", "document_id", archived), 1);
  await seedPrompt(accountId);
  const result = await deleteAccountDatabaseData({
    accountId,
    archiveId: `deleted-${randomUUID()}`,
    databaseReady: true,
    transactionImpl: (work) => work(client),
  });
  assert.equal(result.enabled, true);
  for (const table of ["docs_accounts", "prompt_history_events", "prompt_devices"]) {
    assert.equal(await count(table, "account_id", accountId), 0, `${table} erased`);
    assert.ok((await count(table, "account_id", otherAccountId)) > 0, `${table} other account preserved`);
  }
  assert.equal(await count("docs_documents", "owner_account_id", accountId), 0);
  assert.equal(await count("prompt_history_events", "document_id", kept), 1);
  console.log(
    "PASS prompt erasure: full account deletion transaction, history and devices erased, hard/soft document deletion, archive retention, UPDATE/direct DELETE blocked, other account preserved",
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  await getPool().end();
}
