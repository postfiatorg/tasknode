import { query } from "../db/pool.js";

// Folder names, hierarchy, and document placements are encrypted by the browser.
// Compare-and-swap prevents a stale tab from overwriting newer organization.
export async function updateDocsLibrary({ accountId, encryptedLibraryMetadata, expectedVersion } = {}) {
  const envelope = encryptedLibraryMetadata;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
      !envelope || envelope.version !== 1 || envelope.enc !== "AES-256-GCM" ||
      typeof envelope.iv !== "string" || Buffer.from(envelope.iv, "base64").length !== 12 ||
      typeof envelope.ciphertext !== "string" || envelope.ciphertext.length > 350_000 ||
      Buffer.from(envelope.ciphertext, "base64").length < 16 ||
      Object.keys(envelope).some((key) => !["version", "enc", "iv", "ciphertext"].includes(key))) {
    return { ok: false, status: 400, error: "docs_library_metadata_invalid" };
  }
  const result = await query(
    `UPDATE docs_accounts
        SET encrypted_library_metadata = $2::jsonb,
            library_metadata_version = library_metadata_version + 1,
            updated_at = now()
      WHERE account_id = $1 AND library_metadata_version = $3 AND status = 'active'
      RETURNING library_metadata_version`,
    [accountId, JSON.stringify(envelope), expectedVersion]
  );
  if (!result.rows.length) return { ok: false, status: 409, error: "docs_library_conflict" };
  return { ok: true, version: result.rows[0].library_metadata_version };
}
