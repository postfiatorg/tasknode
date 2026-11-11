import { query, transaction } from '../db/pool.js';

export function validPromptEnvelope(value) {
  return value && value.version === 1 && value.enc === 'AES-256-GCM' &&
    typeof value.iv === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value.iv) && Buffer.from(value.iv, 'base64').length === 12 &&
    typeof value.ciphertext === 'string' && value.ciphertext.length <= 2_000_000 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext) && Buffer.from(value.ciphertext, 'base64').length >= 16 &&
    Object.keys(value).length === 4;
}
export const promptFailure = (error, status = 400) => ({ ok: false, error: `docs_prompt_${error}`, status });
export const promptUuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export async function getPromptKey(accountId) {
  const { rows } = await query("SELECT encrypted_prompt_library_key FROM docs_accounts WHERE account_id=$1 AND status='active'", [accountId]);
  return { ok: true, envelope: rows[0]?.encrypted_prompt_library_key || null };
}
export async function initializePromptKey(accountId, envelope) {
  if (!validPromptEnvelope(envelope)) return promptFailure('envelope_invalid');
  const { rows } = await query(`UPDATE docs_accounts SET encrypted_prompt_library_key=$2::jsonb
    WHERE account_id=$1 AND status='active' AND encrypted_prompt_library_key IS NULL RETURNING account_id`, [accountId, JSON.stringify(envelope)]);
  return rows.length ? { ok: true } : promptFailure('key_exists_or_setup_required', 409);
}
export async function appendPromptEvent(accountId, { eventId, documentId, ciphertext } = {}) {
  if (!promptUuid(eventId) || !promptUuid(documentId) || !validPromptEnvelope(ciphertext)) return promptFailure('event_invalid');
  return transaction(async client => {
    const access = await client.query(`SELECT document_id FROM docs_documents WHERE document_id=$1 AND owner_account_id=$2 AND document_type='prompt' AND status='active' FOR UPDATE`, [documentId, accountId]);
    if (!access.rows.length) return promptFailure('not_found', 404);
    const result = await client.query(`INSERT INTO prompt_history_events(event_id,account_id,document_id,ciphertext)
      VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING created_at`, [eventId,accountId,documentId,JSON.stringify(ciphertext)]);
    if (!result.rows.length) {
      const same = await client.query('SELECT 1 FROM prompt_history_events WHERE event_id=$1 AND account_id=$2 AND document_id=$3 AND ciphertext=$4::jsonb', [eventId, accountId, documentId, JSON.stringify(ciphertext)]);
      if (!same.rows.length) return promptFailure('event_conflict',409);
    }
    await client.query('UPDATE docs_documents SET updated_at=now() WHERE document_id=$1', [documentId]);
    return { ok:true, eventId };
  });
}
export async function listPromptEvents(accountId, after = '') {
  // UUID cursor is stable, insertion-time order; no plaintext filtering on server.
  if (after && !promptUuid(after)) return promptFailure('cursor_invalid');
  const { rows } = await query(`SELECT event_id AS "eventId", document_id AS "documentId", created_at AS "createdAt", ciphertext
    FROM prompt_history_events WHERE account_id=$1 AND ($2::uuid IS NULL OR (created_at,event_id) >
      (SELECT created_at,event_id FROM prompt_history_events WHERE event_id=$2::uuid AND account_id=$1))
    ORDER BY created_at,event_id LIMIT 500`, [accountId, after || null]);
  return { ok:true, events:rows, next: rows.length === 500 ? rows.at(-1).eventId : null };
}
export async function rejectPromptAssistant(accountId, documentId) {
  const { rows } = await query("SELECT 1 FROM docs_documents WHERE document_id=$1 AND document_type='prompt'", [documentId]);
  return rows.length ? promptFailure('assistant_forbidden', 403) : null;
}
