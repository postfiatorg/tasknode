import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newLibraryKey, encryptPrompt } from "../packages/tasknode-cli/lib/prompt-crypto.mjs";
process.env.DATABASE_URL ||= "postgres://tasknodeofficial:tasknodeofficial@127.0.0.1:5438/tasknodeofficial";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL).hostname));
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.DATABASE_POOL_MAX = "1";
const { query, getPool, transaction } = await import("../server/db/pool.js");
const { appendPromptEvent, listPromptEvents, validPromptEnvelope } = await import(
  "../server/repositories/prompt-history.js"
);
try {
  await query(`CREATE TEMP TABLE docs_accounts(account_id text, status text DEFAULT 'active')`);
  await query(
    `CREATE TEMP TABLE docs_documents(document_id uuid PRIMARY KEY,owner_account_id text,document_type text CHECK(document_type='rich_text'),status text DEFAULT 'active',updated_at timestamptz,pfdocs_channel_hash text,encrypted_metadata jsonb)`,
  );
  let migration = await readFile(new URL("../server/db/migrations/160_prompt_documents.sql", import.meta.url), "utf8");
  migration = migration
    .replace("CREATE TABLE prompt_history_events", "CREATE TEMP TABLE prompt_history_events")
    .replaceAll("FUNCTION prompt_history_append_only", "FUNCTION pg_temp.prompt_history_append_only");
  await query(migration);
  await query("INSERT INTO docs_accounts(account_id) VALUES('alice')");
  const id = randomUUID();
  await query("INSERT INTO docs_documents(document_id,owner_account_id,document_type) VALUES($1,'alice','prompt')", [
    id,
  ]);
  const ciphertext = await encryptPrompt(
    { kind: "version_saved", text: "SYNTHETIC_PROMPT_CANARY_441" },
    newLibraryKey(),
  );
  const input = { eventId: randomUUID(), documentId: id, ciphertext };
  assert.equal((await appendPromptEvent("alice", input)).ok, true);
  assert.equal((await appendPromptEvent("alice", input)).ok, true);
  assert.equal((await appendPromptEvent("bob", { ...input, eventId: randomUUID() })).status, 404);
  assert.equal(
    (
      await appendPromptEvent("alice", {
        ...input,
        ciphertext: await encryptPrompt({ different: true }, newLibraryKey()),
      })
    ).status,
    409,
  );
  assert.equal(validPromptEnvelope({ ...ciphertext, text: "plaintext" }), false);
  assert.equal((await listPromptEvents("alice")).events.length, 1);
  assert.equal((await listPromptEvents("bob")).events.length, 0);
  const dump = await query("SELECT * FROM prompt_history_events");
  assert.deepEqual(Object.keys(dump.rows[0]).sort(), [
    "account_id",
    "ciphertext",
    "created_at",
    "document_id",
    "event_id",
  ]);
  assert.ok(!JSON.stringify(dump.rows).includes("SYNTHETIC_PROMPT_CANARY_441"));
  await assert.rejects(
    transaction((client) => client.query("UPDATE prompt_history_events SET ciphertext=$1", [{}])),
    /prompt_history_append_only/,
  );
  await assert.rejects(
    transaction((client) => client.query("DELETE FROM prompt_history_events")),
    /prompt_history_append_only/,
  );
  const { createAgentPromptDocument } = await import("../server/repositories/prompt-documents.js");
  const createdId = randomUUID();
  const registration = {
    documentId: createdId,
    channelHash: "1".repeat(32),
    encryptedMetadata: ciphertext,
    initialEvent: { eventId: randomUUID(), ciphertext },
  };
  assert.equal((await createAgentPromptDocument("alice", registration)).ok, true);
  assert.equal((await query("SELECT 1 FROM prompt_history_events WHERE document_id = $1", [createdId])).rows.length, 1);
  const rejectedId = randomUUID();
  await assert.rejects(
    createAgentPromptDocument("alice", {
      ...registration,
      documentId: rejectedId,
      channelHash: "2".repeat(32),
    }),
    /creation_event_conflict/,
  );
  assert.equal((await query("SELECT 1 FROM docs_documents WHERE document_id = $1", [rejectedId])).rows.length, 0);
  console.log(
    "PASS prompt history: ciphertext-only columns, envelope validation, tenant isolation, append-only, retry idempotency, atomic creation rollback",
  );
} finally {
  await getPool().end();
}
