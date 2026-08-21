import { createHash, randomBytes, randomUUID } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import {
  getAccountIdentityProfile,
  getAccountProfileVisibility,
  listDiscoverableAccountWalletIdentities,
} from "./account-profiles.js";
import { getLinkedWallet as getDurableLinkedWallet } from "./account-wallets.js";
import { accountMessageKey, publicKeyBase64FromMessageKey } from "../context-publish.js";
import { nonFixtureTaskProjectionSql } from "./task-projection-integrity.js";
import { consumeCollaborationProof } from "./collaboration-proofs.js";
import { buildCollaborationIdentitySuggestions } from "./collaboration-identity-suggestions.js";

export {
  collaborationChallengePayload,
  consumeCollaborationProof,
  createCollaborationChallenge,
  stableCollaborationJson,
} from "./collaboration-proofs.js";
export { buildCollaborationIdentitySuggestions } from "./collaboration-identity-suggestions.js";

const inviteTtlMs = 14 * 24 * 60 * 60_000;
const defaultDocsStorageLimit = 50 * 1024 * 1024;
function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function ensureDatabase() {
  if (databaseEnabled()) return;
  const error = new Error("collaboration_database_not_configured");
  error.code = "collaboration_database_not_configured";
  error.status = 503;
  throw error;
}

async function linkedWalletForAccount(accountId = "") {
  const wallet = await getDurableLinkedWallet({ accountId: safeText(accountId, 180) });
  return wallet?.status === "linked" ? wallet : null;
}

async function publicIdentity(accountId = "") {
  const [resolvedIdentity, visibility] = await Promise.all(
    [getAccountIdentityProfile({ accountId }), getAccountProfileVisibility({ accountId })]
  );
  const identity = resolvedIdentity || {};
  return {
    accountId,
    hiveHandle: safeText(identity.hiveHandle, 80),
    displayName: safeText(
      identity.publicDisplayName ||
        (identity.hiveHandle ? `@${identity.hiveHandle}` : "") ||
        "Task Node member",
      120
    ),
    publicAliases: safeArray(identity.publicAliases),
    publicTrustBadges: safeArray(identity.publicTrustBadges),
    discoverable: visibility.discoverable === true && visibility.visibility !== "private",
  };
}
async function identityDocument(accountId = "", { includeWallet = true } = {}) {
  const identity = await publicIdentity(accountId);
  const wallet = includeWallet ? await linkedWalletForAccount(accountId) : null;
  return {
    ...identity,
    walletAddress: wallet?.address || "",
  };
}

export async function docsIdentityForAccount(accountId = "") {
  return identityDocument(accountId);
}

export async function auditCollaborationEvent(args = {}) {
  return audit(args);
}

async function audit({
  accountId,
  eventType,
  subjectAccountId = null,
  resourceType,
  resourceId,
  resultStatus = "ok",
  metadata = {},
  client = null,
} = {}) {
  const executor = client || { query };
  await executor.query(
    `INSERT INTO collaboration_audit_events (
       event_id, account_id, event_type, subject_account_id,
       resource_type, resource_id, result_status, metadata_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      randomUUID(),
      safeText(accountId, 180),
      safeText(eventType, 120),
      subjectAccountId ? safeText(subjectAccountId, 180) : null,
      safeText(resourceType, 80),
      safeText(resourceId, 240),
      safeText(resultStatus, 80),
      JSON.stringify(safeObject(metadata)),
    ]
  );
}

export async function resolveCollaborationIdentity({ viewerAccountId = "", input = "" } = {}) {
  const needle = safeText(input, 180);
  if (!needle) return { ok: false, status: 400, error: "collaboration_identity_required" };
  const normalizedHandle = needle.replace(/^@+/, "").toLowerCase();
  const identities = await listDiscoverableAccountWalletIdentities();
  let match = identities.find((entry) => safeText(entry.hiveHandle, 80).toLowerCase() === normalizedHandle);
  if (!match && /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(needle)) {
    match = identities.find((entry) => entry.walletAddress === needle);
  }
  if (!match || match.accountId === viewerAccountId) {
    return { ok: false, status: 404, error: "collaboration_identity_not_found" };
  }
  return {
    ok: true,
    identity: await identityDocument(match.accountId),
  };
}

export async function suggestCollaborationIdentities({ viewerAccountId = "", input = "", limit = 8 } = {}) {
  ensureDatabase();
  const recent = await query(
    `SELECT recipient_account_id, max(updated_at) AS last_shared_at
       FROM docs_access_grants
      WHERE owner_account_id = $1
      GROUP BY recipient_account_id
      ORDER BY last_shared_at DESC
      LIMIT 20`,
    [viewerAccountId]
  );
  return {
    ok: true,
    suggestions: buildCollaborationIdentitySuggestions({
      identities: await listDiscoverableAccountWalletIdentities(),
      input,
      limit,
      recentAccountIds: recent.rows.map((row) => row.recipient_account_id),
      viewerAccountId,
    }),
  };
}

export async function recipientEncryptionIdentity({ accountId = "" } = {}) {
  const wallet = await getDurableLinkedWallet({ accountId });
  if (!wallet?.address) return { ok: false, status: 409, error: "recipient_wallet_required" };
  let publicKey = safeText(wallet.tasknodeEncryptionPubkey, 500);
  if (!publicKey) {
    const messageKey = await accountMessageKey(wallet.address).catch(() => "");
    if (messageKey) publicKey = publicKeyBase64FromMessageKey(messageKey);
  }
  if (!publicKey) return { ok: false, status: 409, error: "recipient_encryption_key_required" };
  return {
    ok: true,
    accountId,
    walletAddress: wallet.address,
    encryptionPublicKey: publicKey,
    identity: await identityDocument(accountId),
  };
}

function docsAccountDocument(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    status: row.status,
    encryptedRootKeyEnvelope: row.encrypted_root_key_envelope,
    envelopeWalletAddress: row.envelope_wallet_address,
    envelopeKeyVersion: Number(row.envelope_key_version || 1),
    storageLimitBytes: Number(row.storage_limit_bytes || defaultDocsStorageLimit),
    storageUsedBytes: Number(row.storage_used_bytes || 0),
    initializedAt: toIso(row.initialized_at),
    updatedAt: toIso(row.updated_at),
  };
}

export async function getDocsAccount({ accountId = "" } = {}) {
  ensureDatabase();
  const result = await query(`SELECT * FROM docs_accounts WHERE account_id = $1`, [accountId]);
  return docsAccountDocument(result.rows[0]);
}

export async function setupDocsAccount({ accountId = "", encryptedRootKeyEnvelope = {}, proof = {} } = {}) {
  ensureDatabase();
  const envelope = safeObject(encryptedRootKeyEnvelope);
  if (!envelope.ciphertext || !safeArray(envelope.recipients).length) {
    return { ok: false, status: 400, error: "docs_root_key_envelope_invalid" };
  }
  const payload = { encryptedRootKeyEnvelope: envelope };
  return transaction(async (client) => {
    const verified = await consumeCollaborationProof({
      client,
      accountId,
      action: "docs_setup",
      payload,
      proof,
    });
    const existing = await client.query(`SELECT account_id FROM docs_accounts WHERE account_id = $1`, [accountId]);
    if (existing.rows.length) {
      return { ok: false, status: 409, error: "docs_already_initialized" };
    }
    const accountHash = sha256(`${accountId}:${randomBytes(24).toString("hex")}`);
    const inserted = await client.query(
      `INSERT INTO docs_accounts (
         account_id, pfdocs_account_hash, encrypted_root_key_envelope,
         envelope_wallet_address, storage_limit_bytes
       ) VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING *`,
      [accountId, accountHash, JSON.stringify(envelope), verified.walletAddress, defaultDocsStorageLimit]
    );
    await audit({
      accountId,
      eventType: "docs.account_initialized",
      resourceType: "docs_account",
      resourceId: accountId,
      metadata: { walletAddressHash: sha256(verified.walletAddress) },
      client,
    });
    return { ok: true, account: docsAccountDocument(inserted.rows[0]) };
  });
}

async function documentRow(row, viewerAccountId) {
  const owned = row.owner_account_id === viewerAccountId;
  return {
    documentId: row.document_id,
    channelHash: row.pfdocs_channel_hash,
    ownerAccountId: row.owner_account_id,
    owner: await identityDocument(row.owner_account_id),
    owned,
    documentType: row.document_type,
    status: row.status,
    encryptedMetadata: owned ? row.encrypted_metadata : null,
    encryptedCapabilityEnvelope: owned ? null : row.encrypted_capability_envelope,
    accessRole: owned ? "owner" : row.access_role,
    grantStatus: owned ? null : row.grant_status,
    collaboratorCount: Number(row.collaborator_count || 0),
    taskIds: safeArray(row.task_ids),
    storageBytes: Number(row.storage_bytes || 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    archivedAt: toIso(row.archived_at),
  };
}

export async function listDocs({ accountId = "" } = {}) {
  ensureDatabase();
  const [accountResult, documentsResult, pendingResult, outgoingSharesResult] = await Promise.all([
    query(`SELECT * FROM docs_accounts WHERE account_id = $1`, [accountId]),
    query(
      `SELECT d.*,
              g.access_role,
              g.status AS grant_status,
              g.encrypted_capability_envelope,
              (SELECT count(*) FROM docs_access_grants active_g
               WHERE active_g.document_id = d.document_id AND active_g.status = 'accepted')::int AS collaborator_count,
              COALESCE((SELECT jsonb_agg(link.task_id ORDER BY link.created_at DESC)
                        FROM docs_task_links link WHERE link.document_id = d.document_id), '[]'::jsonb) AS task_ids
       FROM docs_documents d
       LEFT JOIN docs_access_grants g
         ON g.document_id = d.document_id
        AND g.recipient_account_id = $1
        AND g.status = 'accepted'
       WHERE (d.owner_account_id = $1 OR g.grant_id IS NOT NULL)
         AND d.status <> 'deleted'
       ORDER BY d.updated_at DESC, d.document_id DESC
       LIMIT 200`,
      [accountId]
    ),
    query(
      `SELECT g.*, d.document_type, d.owner_account_id, d.updated_at AS document_updated_at
       FROM docs_access_grants g
       JOIN docs_documents d ON d.document_id = g.document_id
       WHERE g.recipient_account_id = $1 AND g.status = 'pending'
       ORDER BY g.created_at DESC`,
      [accountId]
    ),
    query(
      `SELECT grant_id, document_id, recipient_account_id, access_role, status, created_at, updated_at
         FROM docs_access_grants
        WHERE owner_account_id = $1
          AND status IN ('pending', 'accepted')
        ORDER BY updated_at DESC, grant_id DESC`,
      [accountId]
    ),
  ]);
  const outgoingSharesByDocument = new Map();
  for (const row of outgoingSharesResult.rows) {
    const current = outgoingSharesByDocument.get(row.document_id) || [];
    current.push({
      grantId: row.grant_id,
      recipientAccountId: row.recipient_account_id,
      recipient: await identityDocument(row.recipient_account_id),
      accessRole: row.access_role,
      status: row.status,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    });
    outgoingSharesByDocument.set(row.document_id, current);
  }
  const documents = await Promise.all(documentsResult.rows.map(async (row) => {
    const document = await documentRow(row, accountId);
    return {
      ...document,
      shares: document.owned ? outgoingSharesByDocument.get(document.documentId) || [] : [],
    };
  }));
  const pendingShares = await Promise.all(pendingResult.rows.map(async (row) => ({
    grantId: row.grant_id,
    documentId: row.document_id,
    ownerAccountId: row.owner_account_id,
    owner: await identityDocument(row.owner_account_id),
    accessRole: row.access_role,
    encryptedCapabilityEnvelope: row.encrypted_capability_envelope,
    createdAt: toIso(row.created_at),
  })));
  return {
    ok: true,
    identity: await identityDocument(accountId),
    account: docsAccountDocument(accountResult.rows[0]),
    documents,
    pendingShares,
    counts: {
      all: documents.length,
      shared: documents.filter((doc) => !doc.owned || doc.collaboratorCount > 0).length,
      archived: documents.filter((doc) => doc.status === "archived").length,
      pending: pendingShares.length,
    },
  };
}

export async function requireDocumentAccess({ accountId = "", documentId = "", channelHash = "" } = {}) {
  ensureDatabase();
  const normalizedDocumentId = safeText(documentId, 80);
  const normalizedChannelHash = safeText(channelHash, 128);
  if (!/^[0-9a-f-]{36}$/i.test(normalizedDocumentId) || !/^[0-9a-f]{32}$/i.test(normalizedChannelHash)) {
    return { ok: false, status: 400, error: "docs_document_identity_invalid" };
  }
  const result = await query(
    `SELECT d.*,
            g.access_role,
            g.status AS grant_status,
            g.encrypted_capability_envelope,
            0::int AS collaborator_count,
            '[]'::jsonb AS task_ids
       FROM docs_documents d
       LEFT JOIN docs_access_grants g
         ON g.document_id = d.document_id
        AND g.recipient_account_id = $1
        AND g.status = 'accepted'
      WHERE d.document_id = $2
        AND d.pfdocs_channel_hash = $3
        AND d.status = 'active'
        AND (d.owner_account_id = $1 OR g.grant_id IS NOT NULL)
      LIMIT 1`,
    [accountId, normalizedDocumentId, normalizedChannelHash]
  );
  if (!result.rows.length) return { ok: false, status: 404, error: "docs_document_not_found" };
  return { ok: true, document: await documentRow(result.rows[0], accountId) };
}

export async function createDocument({
  accountId = "",
  documentId = "",
  channelHash = "",
  encryptedMetadata = {},
  proof = {},
} = {}) {
  ensureDatabase();
  const normalizedId = safeText(documentId, 80);
  const normalizedChannelHash = safeText(channelHash, 128);
  const metadata = safeObject(encryptedMetadata);
  if (!/^[0-9a-f-]{36}$/i.test(normalizedId) || !/^[0-9a-f]{32}$/i.test(normalizedChannelHash)) {
    return { ok: false, status: 400, error: "docs_document_identity_invalid" };
  }
  if (!metadata.ciphertext || !metadata.iv) {
    return { ok: false, status: 400, error: "docs_encrypted_metadata_invalid" };
  }
  const payload = { documentId: normalizedId, channelHash: normalizedChannelHash, encryptedMetadata: metadata };
  return transaction(async (client) => {
    await consumeCollaborationProof({
      client,
      accountId,
      action: "docs_create",
      resourceId: normalizedId,
      payload,
      proof,
    });
    const account = await client.query(`SELECT * FROM docs_accounts WHERE account_id = $1 FOR UPDATE`, [accountId]);
    if (!account.rows.length) return { ok: false, status: 409, error: "docs_setup_required" };
    const countResult = await client.query(
      `SELECT count(*)::int AS count FROM docs_documents
       WHERE owner_account_id = $1 AND status NOT IN ('deleted', 'deleting')`,
      [accountId]
    );
    if (Number(countResult.rows[0]?.count || 0) >= 100) {
      return { ok: false, status: 409, error: "docs_document_limit_reached" };
    }
    const inserted = await client.query(
      `INSERT INTO docs_documents (
         document_id, owner_account_id, pfdocs_channel_hash, encrypted_metadata
       ) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (document_id) DO UPDATE SET
         encrypted_metadata = EXCLUDED.encrypted_metadata,
         updated_at = now()
       WHERE docs_documents.owner_account_id = EXCLUDED.owner_account_id
         AND docs_documents.pfdocs_channel_hash = EXCLUDED.pfdocs_channel_hash
       RETURNING *`,
      [normalizedId, accountId, normalizedChannelHash, JSON.stringify(metadata)]
    );
    if (!inserted.rows.length) return { ok: false, status: 409, error: "docs_document_conflict" };
    await audit({
      accountId,
      eventType: "docs.document_created",
      resourceType: "document",
      resourceId: normalizedId,
      client,
    });
    return { ok: true, document: await documentRow(inserted.rows[0], accountId) };
  });
}

export async function updateDocument({ accountId = "", documentId = "", encryptedMetadata, status } = {}) {
  ensureDatabase();
  const patches = [];
  const values = [safeText(documentId, 80), accountId];
  if (encryptedMetadata) {
    values.push(JSON.stringify(safeObject(encryptedMetadata)));
    patches.push(`encrypted_metadata = $${values.length}::jsonb`);
  }
  if (status) {
    const normalizedStatus = safeText(status, 40);
    if (!["active", "archived"].includes(normalizedStatus)) {
      return { ok: false, status: 400, error: "docs_status_invalid" };
    }
    values.push(normalizedStatus);
    patches.push(`status = $${values.length}`);
    patches.push(normalizedStatus === "archived" ? "archived_at = now()" : "archived_at = NULL");
    patches.push(normalizedStatus === "archived" ? "delete_after = now() + interval '30 days'" : "delete_after = NULL");
  }
  if (!patches.length) return { ok: false, status: 400, error: "docs_update_required" };
  const result = await query(
    `UPDATE docs_documents SET ${patches.join(", ")}, updated_at = now()
     WHERE document_id = $1 AND owner_account_id = $2 AND status <> 'deleted'
     RETURNING *`,
    values
  );
  if (!result.rows.length) return { ok: false, status: 404, error: "docs_document_not_found" };
  return { ok: true, document: await documentRow(result.rows[0], accountId) };
}

export async function updateDocumentTaskLink({ accountId = "", documentId = "", taskId = "", action = "link" } = {}) {
  ensureDatabase();
  const normalizedDocumentId = safeText(documentId, 80);
  const normalizedTaskId = safeText(taskId, 180);
  if (!normalizedTaskId) return { ok: false, status: 400, error: "docs_task_id_required" };
  const document = await query(
    `SELECT document_id FROM docs_documents
     WHERE document_id = $1 AND owner_account_id = $2 AND status <> 'deleted'`,
    [normalizedDocumentId, accountId]
  );
  if (!document.rows.length) return { ok: false, status: 404, error: "docs_document_not_found" };
  if (action === "unlink") {
    await query(
      `DELETE FROM docs_task_links WHERE document_id = $1 AND task_id = $2 AND linked_by_account_id = $3`,
      [normalizedDocumentId, normalizedTaskId, accountId]
    );
    return { ok: true, documentId: normalizedDocumentId, taskId: normalizedTaskId, status: "unlinked" };
  }
  const task = await query(
    `SELECT task_id FROM task_projections
     WHERE task_id = $1 AND account_id = $2
       AND status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted')
       AND ${nonFixtureTaskProjectionSql("task_projections")}
     LIMIT 1`,
    [normalizedTaskId, accountId]
  );
  if (!task.rows.length) return { ok: false, status: 404, error: "docs_task_not_found" };
  await query(
    `INSERT INTO docs_task_links (document_id, task_id, linked_by_account_id)
     VALUES ($1, $2, $3) ON CONFLICT (document_id, task_id) DO NOTHING`,
    [normalizedDocumentId, normalizedTaskId, accountId]
  );
  return { ok: true, documentId: normalizedDocumentId, taskId: normalizedTaskId, status: "linked" };
}

export async function shareDocument({
  accountId = "",
  documentId = "",
  recipientAccountId = "",
  recipientWalletAddress = "",
  accessRole = "viewer",
  encryptedCapabilityEnvelope = {},
  proof = {},
} = {}) {
  ensureDatabase();
  const role = safeText(accessRole, 20).toLowerCase();
  if (!["viewer", "editor"].includes(role)) return { ok: false, status: 400, error: "docs_share_role_invalid" };
  const envelope = safeObject(encryptedCapabilityEnvelope);
  if (!envelope.ciphertext || !safeArray(envelope.recipients).length) {
    return { ok: false, status: 400, error: "docs_share_envelope_invalid" };
  }
  const payload = {
    documentId,
    recipientAccountId,
    recipientWalletAddress,
    accessRole: role,
    encryptedCapabilityEnvelope: envelope,
  };
  return transaction(async (client) => {
    const verified = await consumeCollaborationProof({
      client,
      accountId,
      action: "docs_share",
      resourceId: documentId,
      payload,
      proof,
    });
    const document = await client.query(
      `SELECT * FROM docs_documents WHERE document_id = $1 AND owner_account_id = $2 AND status = 'active' FOR UPDATE`,
      [documentId, accountId]
    );
    if (!document.rows.length) return { ok: false, status: 404, error: "docs_document_not_found" };
    const recipient = await getDurableLinkedWallet({ accountId: recipientAccountId });
    if (!recipient?.address || recipient.address !== recipientWalletAddress || recipientAccountId === accountId) {
      return { ok: false, status: 409, error: "docs_share_recipient_changed" };
    }
    const grantId = randomUUID();
    const inserted = await client.query(
      `INSERT INTO docs_access_grants (
         grant_id, document_id, owner_account_id, recipient_account_id,
         recipient_wallet_address, access_role, encrypted_capability_envelope,
         signature_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (document_id, recipient_account_id)
         WHERE status IN ('pending', 'accepted')
       DO UPDATE SET
         access_role = EXCLUDED.access_role,
         encrypted_capability_envelope = EXCLUDED.encrypted_capability_envelope,
         recipient_wallet_address = EXCLUDED.recipient_wallet_address,
         status = 'pending', accepted_at = NULL, revoked_at = NULL,
         signature_hash = EXCLUDED.signature_hash, updated_at = now()
       RETURNING *`,
      [grantId, documentId, accountId, recipientAccountId, recipientWalletAddress, role, JSON.stringify(envelope), verified.signatureHash]
    );
    await client.query(`UPDATE docs_documents SET updated_at = now() WHERE document_id = $1`, [documentId]);
    await audit({
      accountId,
      eventType: "docs.share_sent",
      subjectAccountId: recipientAccountId,
      resourceType: "docs_grant",
      resourceId: inserted.rows[0].grant_id,
      metadata: { accessRole: role, transport: "tasknode_mailbox" },
      client,
    });
    return { ok: true, grantId: inserted.rows[0].grant_id, status: "pending" };
  });
}

export async function actOnDocumentGrant({ accountId = "", grantId = "", action = "" } = {}) {
  ensureDatabase();
  const normalizedAction = safeText(action, 20);
  const targetStatus = { accept: "accepted", decline: "declined", leave: "left", revoke: "revoked" }[normalizedAction];
  if (!targetStatus) return { ok: false, status: 400, error: "docs_grant_action_invalid" };
  return transaction(async (client) => {
    const selected = await client.query(
      `SELECT * FROM docs_access_grants WHERE grant_id = $1 FOR UPDATE`,
      [grantId]
    );
    const grant = selected.rows[0];
    if (!grant) return { ok: false, status: 404, error: "docs_grant_not_found" };
    const recipientAction = ["accept", "decline", "leave"].includes(normalizedAction);
    if ((recipientAction && grant.recipient_account_id !== accountId) ||
        (normalizedAction === "revoke" && grant.owner_account_id !== accountId)) {
      return { ok: false, status: 403, error: "docs_grant_forbidden" };
    }
    if (normalizedAction === "accept" && grant.status !== "pending") {
      return { ok: false, status: 409, error: "docs_grant_not_pending" };
    }
    await client.query(
      `UPDATE docs_access_grants SET status = $2,
         accepted_at = CASE WHEN $2 = 'accepted' THEN now() ELSE accepted_at END,
         revoked_at = CASE WHEN $2 IN ('revoked', 'left') THEN now() ELSE revoked_at END,
         updated_at = now()
       WHERE grant_id = $1`,
      [grantId, targetStatus]
    );
    await audit({
      accountId,
      eventType: `docs.share_${targetStatus}`,
      subjectAccountId: recipientAction ? grant.owner_account_id : grant.recipient_account_id,
      resourceType: "docs_grant",
      resourceId: grantId,
      client,
    });
    return { ok: true, grantId, status: targetStatus };
  });
}

export function requestedGrantDirections(relationship, inviterAccountId, inviteeAccountId) {
  if (relationship === "collaborator") return [
    { subjectAccountId: inviterAccountId, viewerAccountId: inviteeAccountId },
    { subjectAccountId: inviteeAccountId, viewerAccountId: inviterAccountId },
  ];
  if (relationship === "manager") return [
    { subjectAccountId: inviterAccountId, viewerAccountId: inviteeAccountId },
  ];
  if (relationship === "direct_report") return [
    { subjectAccountId: inviteeAccountId, viewerAccountId: inviterAccountId },
  ];
  return [];
}

export function teamRelationshipFromDirections({ outgoing = false, incoming = false } = {}) {
  if (outgoing && incoming) return "collaborator";
  if (outgoing) return "manager";
  if (incoming) return "direct_report";
  return "none";
}

export async function createTeamInvite({
  accountId = "",
  inviteId = "",
  inviteeAccountId = "",
  relationship = "collaborator",
  proof = {},
} = {}) {
  ensureDatabase();
  const normalizedRelationship = safeText(relationship, 40).toLowerCase().replace(/\s+/g, "_");
  if (!["collaborator", "manager", "direct_report"].includes(normalizedRelationship)) {
    return { ok: false, status: 400, error: "team_relationship_invalid" };
  }
  if (!inviteeAccountId || inviteeAccountId === accountId) {
    return { ok: false, status: 400, error: "team_invitee_invalid" };
  }
  const normalizedInviteId = safeText(inviteId, 80);
  if (!/^[0-9a-f-]{36}$/i.test(normalizedInviteId)) {
    return { ok: false, status: 400, error: "team_invite_id_invalid" };
  }
  const grants = requestedGrantDirections(normalizedRelationship, accountId, inviteeAccountId);
  const payload = {
    inviteId: normalizedInviteId,
    inviterAccountId: accountId,
    inviteeAccountId,
    relationship: normalizedRelationship,
    requestedGrants: grants,
  };
  return transaction(async (client) => {
    await client.query(
      `UPDATE team_relationship_invites
       SET status = 'expired', terminal_at = now(), updated_at = now()
       WHERE status = 'pending' AND expires_at <= now()
         AND (inviter_account_id = $1 OR invitee_account_id = $1 OR inviter_account_id = $2 OR invitee_account_id = $2)`,
      [accountId, inviteeAccountId]
    );
    const verified = await consumeCollaborationProof({
      client,
      accountId,
      action: "team_invite",
      resourceId: normalizedInviteId,
      payload,
      proof,
    });
    const expiresAt = new Date(Date.now() + inviteTtlMs);
    try {
      await client.query(
        `INSERT INTO team_relationship_invites (
           invite_id, inviter_account_id, invitee_account_id,
           requested_relationship, requested_grants_json, canonical_payload,
           wallet_signature, signer_public_key, signer_wallet_address,
           expires_at, signature_hash
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)`,
        [normalizedInviteId, accountId, inviteeAccountId, normalizedRelationship, JSON.stringify(grants), JSON.stringify(payload), verified.signature, verified.publicKey, verified.walletAddress, expiresAt, verified.signatureHash]
      );
    } catch (error) {
      if (error?.code === "23505") return { ok: false, status: 409, error: "team_invite_already_pending" };
      throw error;
    }
    await audit({
      accountId,
      eventType: "team.invite_sent",
      subjectAccountId: inviteeAccountId,
      resourceType: "team_invite",
      resourceId: normalizedInviteId,
      metadata: { relationship: normalizedRelationship },
      client,
    });
    return { ok: true, inviteId: normalizedInviteId, status: "pending", expiresAt: expiresAt.toISOString() };
  });
}

async function insertTaskHistoryGrant(client, {
  subjectAccountId,
  viewerAccountId,
  sourceInviteId,
  signature,
  publicKey,
  walletAddress,
  canonicalPayload,
} = {}) {
  await client.query(
    `UPDATE task_history_grants SET status = 'revoked', revoked_at = now()
     WHERE subject_account_id = $1 AND viewer_account_id = $2
       AND scope = 'task_history_v1' AND status = 'active'`,
    [subjectAccountId, viewerAccountId]
  );
  const grantId = randomUUID();
  await client.query(
    `INSERT INTO task_history_grants (
       grant_id, subject_account_id, viewer_account_id,
       subject_wallet_address, canonical_payload, wallet_signature,
       signer_public_key, signature_hash, source_invite_id
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
    [grantId, subjectAccountId, viewerAccountId, walletAddress, JSON.stringify(canonicalPayload), signature, publicKey, sha256(signature), sourceInviteId]
  );
  return grantId;
}

export async function actOnTeamInvite({ accountId = "", inviteId = "", action = "", proof = {} } = {}) {
  ensureDatabase();
  const normalizedAction = safeText(action, 20);
  if (!["accept", "decline", "cancel"].includes(normalizedAction)) {
    return { ok: false, status: 400, error: "team_invite_action_invalid" };
  }
  return transaction(async (client) => {
    const selected = await client.query(
      `SELECT * FROM team_relationship_invites WHERE invite_id = $1 FOR UPDATE`,
      [inviteId]
    );
    const invite = selected.rows[0];
    if (!invite) return { ok: false, status: 404, error: "team_invite_not_found" };
    if (invite.status !== "pending" || Date.parse(invite.expires_at) <= Date.now()) {
      return { ok: false, status: 409, error: "team_invite_not_pending" };
    }
    if (normalizedAction === "cancel") {
      if (invite.inviter_account_id !== accountId) return { ok: false, status: 403, error: "team_invite_forbidden" };
      await client.query(
        `UPDATE team_relationship_invites SET status = 'cancelled', terminal_at = now(),
           terminal_actor_account_id = $2, updated_at = now() WHERE invite_id = $1`,
        [inviteId, accountId]
      );
      return { ok: true, inviteId, status: "cancelled" };
    }
    if (invite.invitee_account_id !== accountId) return { ok: false, status: 403, error: "team_invite_forbidden" };
    if (normalizedAction === "decline") {
      await client.query(
        `UPDATE team_relationship_invites SET status = 'declined', terminal_at = now(),
           terminal_actor_account_id = $2, updated_at = now() WHERE invite_id = $1`,
        [inviteId, accountId]
      );
      return { ok: true, inviteId, status: "declined" };
    }
    const directions = safeArray(invite.requested_grants_json);
    const payload = {
      inviteId,
      relationship: invite.requested_relationship,
      requestedGrants: directions,
      acceptingAccountId: accountId,
    };
    const verified = await consumeCollaborationProof({
      client,
      accountId,
      action: "team_invite_accept",
      resourceId: inviteId,
      payload,
      proof,
    });
    const grantIds = [];
    for (const direction of directions) {
      const subjectAccountId = safeText(direction.subjectAccountId, 180);
      const viewerAccountId = safeText(direction.viewerAccountId, 180);
      const subjectIsInviter = subjectAccountId === invite.inviter_account_id;
      const source = subjectIsInviter
        ? {
          signature: invite.wallet_signature,
          publicKey: invite.signer_public_key,
          walletAddress: invite.signer_wallet_address,
          canonicalPayload: invite.canonical_payload,
        }
        : {
          signature: verified.signature,
          publicKey: verified.publicKey,
          walletAddress: verified.walletAddress,
          canonicalPayload: payload,
        };
      grantIds.push(await insertTaskHistoryGrant(client, {
        subjectAccountId,
        viewerAccountId,
        sourceInviteId: inviteId,
        ...source,
      }));
    }
    await client.query(
      `UPDATE team_relationship_invites SET status = 'accepted', terminal_at = now(),
         terminal_actor_account_id = $2, updated_at = now() WHERE invite_id = $1`,
      [inviteId, accountId]
    );
    await audit({
      accountId,
      eventType: "team.invite_accepted",
      subjectAccountId: invite.inviter_account_id,
      resourceType: "team_invite",
      resourceId: inviteId,
      metadata: { relationship: invite.requested_relationship, grantCount: grantIds.length },
      client,
    });
    return { ok: true, inviteId, status: "accepted", grantIds };
  });
}

export async function revokeTaskHistoryGrant({ accountId = "", grantId = "", proof = {} } = {}) {
  ensureDatabase();
  const payload = { grantId };
  return transaction(async (client) => {
    const verified = await consumeCollaborationProof({
      client,
      accountId,
      action: "team_grant_revoke",
      resourceId: grantId,
      payload,
      proof,
    });
    const result = await client.query(
      `UPDATE task_history_grants SET status = 'revoked', revoked_at = now()
       WHERE grant_id = $1 AND subject_account_id = $2 AND status = 'active'
       RETURNING viewer_account_id`,
      [grantId, accountId]
    );
    if (!result.rows.length) return { ok: false, status: 404, error: "team_grant_not_found" };
    await audit({
      accountId,
      eventType: "team.grant_revoked",
      subjectAccountId: result.rows[0].viewer_account_id,
      resourceType: "task_history_grant",
      resourceId: grantId,
      metadata: { signatureHash: verified.signatureHash },
      client,
    });
    return { ok: true, grantId, status: "revoked" };
  });
}

export async function requireTaskHistoryGrant({ subjectAccountId = "", viewerAccountId = "" } = {}) {
  ensureDatabase();
  if (subjectAccountId === viewerAccountId) return { ok: true, self: true };
  const result = await query(
    `SELECT grant_id FROM task_history_grants
     WHERE subject_account_id = $1 AND viewer_account_id = $2
       AND scope = 'task_history_v1' AND status = 'active'
     LIMIT 1`,
    [subjectAccountId, viewerAccountId]
  );
  return result.rows.length
    ? { ok: true, grantId: result.rows[0].grant_id }
    : { ok: false, status: 403, error: "team_task_history_forbidden" };
}

async function teammateTaskSummary(accountId = "") {
  const result = await query(
    `SELECT count(*)::int AS task_count,
            COALESCE(sum(CASE WHEN reward_actual_pft > 0 THEN reward_actual_pft ELSE 0 END), 0)::numeric AS reward_pft,
            max(updated_at) AS last_task_at
     FROM task_projections
     WHERE account_id = $1 AND ${nonFixtureTaskProjectionSql("task_projections")}`,
    [accountId]
  );
  const current = await query(
    `SELECT task_id, title, status, updated_at
     FROM task_projections
     WHERE account_id = $1
       AND ${nonFixtureTaskProjectionSql("task_projections")}
       AND status IN ('proposed', 'accepted', 'submitted', 'verification_requested', 'verification_response_submitted')
     ORDER BY updated_at DESC, task_id DESC LIMIT 1`,
    [accountId]
  );
  return {
    taskCount: Number(result.rows[0]?.task_count || 0),
    rewardPft: Number(result.rows[0]?.reward_pft || 0),
    lastTaskAt: toIso(result.rows[0]?.last_task_at),
    currentTask: current.rows[0]
      ? {
        taskId: current.rows[0].task_id,
        title: current.rows[0].title,
        status: current.rows[0].status,
        updatedAt: toIso(current.rows[0].updated_at),
      }
      : null,
  };
}

export async function listTeam({ accountId = "" } = {}) {
  ensureDatabase();
  const [grantsResult, invitesResult] = await Promise.all([
    query(
      `SELECT * FROM task_history_grants
       WHERE (subject_account_id = $1 OR viewer_account_id = $1)
         AND scope = 'task_history_v1' AND status = 'active'
       ORDER BY activated_at DESC`,
      [accountId]
    ),
    query(
      `SELECT * FROM team_relationship_invites
       WHERE (inviter_account_id = $1 OR invitee_account_id = $1)
         AND status = 'pending' AND expires_at > now()
       ORDER BY created_at DESC`,
      [accountId]
    ),
  ]);
  const byAccount = new Map();
  for (const grant of grantsResult.rows) {
    const other = grant.subject_account_id === accountId ? grant.viewer_account_id : grant.subject_account_id;
    const item = byAccount.get(other) || { otherAccountId: other, outgoingGrant: null, incomingGrant: null };
    if (grant.subject_account_id === accountId) item.outgoingGrant = grant;
    else item.incomingGrant = grant;
    byAccount.set(other, item);
  }
  const members = [];
  for (const item of byAccount.values()) {
    const seesTheirs = Boolean(item.incomingGrant);
    members.push({
      accountId: item.otherAccountId,
      identity: await identityDocument(item.otherAccountId),
      relationship: teamRelationshipFromDirections({
        outgoing: Boolean(item.outgoingGrant),
        incoming: Boolean(item.incomingGrant),
      }),
      seesTheirs,
      theySeeYours: Boolean(item.outgoingGrant),
      outgoingGrantId: item.outgoingGrant?.grant_id || null,
      incomingGrantId: item.incomingGrant?.grant_id || null,
      summary: seesTheirs ? await teammateTaskSummary(item.otherAccountId) : null,
    });
  }
  const invites = await Promise.all(invitesResult.rows.map(async (row) => {
    const incoming = row.invitee_account_id === accountId;
    const otherAccountId = incoming ? row.inviter_account_id : row.invitee_account_id;
    return {
      inviteId: row.invite_id,
      direction: incoming ? "incoming" : "sent",
      relationship: row.requested_relationship,
      otherAccountId,
      identity: await identityDocument(otherAccountId),
      expiresAt: toIso(row.expires_at),
      createdAt: toIso(row.created_at),
    };
  }));
  return {
    ok: true,
    members: members.sort((a, b) => a.relationship.localeCompare(b.relationship) || a.identity.displayName.localeCompare(b.identity.displayName)),
    invites,
    counts: {
      collaborators: members.filter((member) => member.relationship === "collaborator").length,
      managers: members.filter((member) => member.relationship === "manager").length,
      directReports: members.filter((member) => member.relationship === "direct_report").length,
      incomingInvites: invites.filter((invite) => invite.direction === "incoming").length,
    },
  };
}

export async function teammateWalletAddress(accountId = "") {
  ensureDatabase();
  const result = await query(
    `SELECT wallet_address FROM account_linked_wallets
     WHERE account_id = $1 AND status = 'linked' LIMIT 1`,
    [accountId]
  );
  return safeText(result.rows[0]?.wallet_address, 120) || (await getDurableLinkedWallet({ accountId }))?.address || "";
}
