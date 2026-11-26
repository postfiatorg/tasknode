import { query, transaction } from "../db/pool.js";
import {
  promptFailure,
  promptUuid,
  validPromptEnvelope,
  validPromptCreationEvent,
  insertPromptCreationEvent,
} from "./prompt-history.js";

export async function listPromptDocuments(accountId) {
  const { rows } = await query(
    `SELECT document_id AS "documentId", pfdocs_channel_hash AS "channelHash",
            encrypted_metadata AS "encryptedMetadata", updated_at AS "updatedAt"
       FROM docs_documents
      WHERE owner_account_id = $1 AND document_type = 'prompt' AND status = 'active'
      ORDER BY created_at`,
    [accountId],
  );
  return { ok: true, documents: rows };
}

export async function createAgentPromptDocument(accountId, body) {
  if (
    !promptUuid(body.documentId) ||
    !/^[a-f0-9]{32}$/.test(body.channelHash || "") ||
    !validPromptEnvelope(body.encryptedMetadata)
  ) {
    return promptFailure("document_invalid");
  }
  if (!validPromptCreationEvent(body.initialEvent)) return promptFailure("creation_event_invalid");
  return transaction(async (client) => {
    const account = await client.query(
      "SELECT 1 FROM docs_accounts WHERE account_id = $1 AND status = 'active' FOR UPDATE",
      [accountId],
    );
    if (!account.rows.length) return promptFailure("setup_required", 409);
    const count = await client.query(
      "SELECT count(*)::int AS count FROM docs_documents WHERE owner_account_id = $1 AND status NOT IN ('deleted', 'deleting')",
      [accountId],
    );
    if (count.rows[0].count >= 100) return promptFailure("document_limit", 409);
    await client.query(
      `INSERT INTO docs_documents (document_id, owner_account_id, pfdocs_channel_hash, encrypted_metadata, document_type)
       VALUES ($1, $2, $3, $4::jsonb, 'prompt')`,
      [body.documentId, accountId, body.channelHash, JSON.stringify(body.encryptedMetadata)],
    );
    await insertPromptCreationEvent(client, accountId, body.documentId, body.initialEvent);
    return { ok: true, documentId: body.documentId };
  });
}
