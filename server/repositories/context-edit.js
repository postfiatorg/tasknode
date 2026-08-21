import { randomUUID } from "node:crypto";
import { databaseEnabled, databaseStatus, query } from "../db/pool.js";

const runtimeProposals = new Map();

function useDatabase() {
  return databaseEnabled();
}

export function contextEditStatus() {
  return databaseStatus();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeAccountId(accountId = "") {
  return safeText(accountId, 160);
}

function safeConversationId(conversationId = "") {
  return safeText(conversationId || "dev", 180) || "dev";
}

function intOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function publicProposal(row) {
  if (!row) return null;
  const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  return {
    id: row.id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    assistantMessageId: row.assistant_message_id,
    baseContextRevision: Number(row.base_context_revision || 0),
    baseBodySha256: row.base_body_sha256 || "",
    operation: row.operation || "",
    anchorType: row.anchor_type || "",
    lineStart: row.line_start === null || row.line_start === undefined ? null : Number(row.line_start),
    lineEnd: row.line_end === null || row.line_end === undefined ? null : Number(row.line_end),
    targetHeading: row.target_heading || "",
    targetBefore: row.target_before || "",
    targetAfter: row.target_after || "",
    rationale: row.rationale || "",
    risk: row.risk || "low",
    state: row.state || "pending",
    savedContextRevision: row.saved_context_revision === null || row.saved_context_revision === undefined
      ? null
      : Number(row.saved_context_revision),
    savedContextDocumentId: row.saved_context_document_id || "",
    savedContextHash: row.saved_context_hash || "",
    metadata,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    appliedAt: toIso(row.applied_at),
    rejectedAt: toIso(row.rejected_at),
  };
}

function runtimeRow(input) {
  const now = new Date().toISOString();
  return {
    id: input.id,
    account_id: input.accountId,
    conversation_id: input.conversationId,
    assistant_message_id: input.assistantMessageId,
    base_context_revision: input.baseContextRevision,
    base_body_sha256: input.baseBodySha256,
    operation: input.operation,
    anchor_type: input.anchorType,
    line_start: input.lineStart,
    line_end: input.lineEnd,
    target_heading: input.targetHeading,
    target_before: input.targetBefore,
    target_after: input.targetAfter,
    rationale: input.rationale,
    risk: input.risk,
    state: "pending",
    metadata_json: input.metadata || {},
    created_at: now,
    updated_at: now,
  };
}

export async function createContextEditProposal(input = {}) {
  const row = runtimeRow({
    id: safeText(input.id || `ctxedit_${randomUUID()}`, 180),
    accountId: safeAccountId(input.accountId),
    conversationId: safeConversationId(input.conversationId),
    assistantMessageId: safeText(input.assistantMessageId, 180),
    baseContextRevision: Number(input.baseContextRevision || 0),
    baseBodySha256: safeText(input.baseBodySha256, 100),
    operation: safeText(input.operation, 80),
    anchorType: safeText(input.anchorType, 80),
    lineStart: intOrNull(input.lineStart),
    lineEnd: intOrNull(input.lineEnd),
    targetHeading: safeText(input.targetHeading, 1000),
    targetBefore: safeText(input.targetBefore, 12000),
    targetAfter: safeText(input.targetAfter, 24000),
    rationale: safeText(input.rationale, 2000),
    risk: safeText(input.risk || "low", 40),
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  });

  if (!useDatabase()) {
    runtimeProposals.set(row.id, row);
    return publicProposal(row);
  }

  const inserted = await query(
    `
      INSERT INTO context_edit_proposals (
        id,
        account_id,
        conversation_id,
        assistant_message_id,
        base_context_revision,
        base_body_sha256,
        operation,
        anchor_type,
        line_start,
        line_end,
        target_heading,
        target_before,
        target_after,
        rationale,
        risk,
        state,
        metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, 'pending', $16
      )
      RETURNING *
    `,
    [
      row.id,
      row.account_id,
      row.conversation_id,
      row.assistant_message_id,
      row.base_context_revision,
      row.base_body_sha256,
      row.operation,
      row.anchor_type,
      row.line_start,
      row.line_end,
      row.target_heading,
      row.target_before,
      row.target_after,
      row.rationale,
      row.risk,
      row.metadata_json,
    ]
  );
  return publicProposal(inserted.rows[0]);
}

export async function getContextEditProposal({ accountId = "", proposalId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedProposalId = safeText(proposalId, 180);
  if (!normalizedAccountId || !normalizedProposalId) return null;

  if (!useDatabase()) {
    const row = runtimeProposals.get(normalizedProposalId);
    return row?.account_id === normalizedAccountId ? publicProposal(row) : null;
  }

  const result = await query(
    `
      SELECT *
      FROM context_edit_proposals
      WHERE id = $1
        AND account_id = $2
      LIMIT 1
    `,
    [normalizedProposalId, normalizedAccountId]
  );
  return publicProposal(result.rows[0]);
}

export async function getActiveContextEditProposal({ accountId = "", conversationId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedConversationId = safeConversationId(conversationId);
  if (!normalizedAccountId) return null;

  if (!useDatabase()) {
    const rows = Array.from(runtimeProposals.values())
      .filter((row) =>
        row.account_id === normalizedAccountId &&
        row.conversation_id === normalizedConversationId &&
        row.state === "pending"
      )
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
    return publicProposal(rows[0]);
  }

  const result = await query(
    `
      SELECT *
      FROM context_edit_proposals
      WHERE account_id = $1
        AND conversation_id = $2
        AND state = 'pending'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId, normalizedConversationId]
  );
  return publicProposal(result.rows[0]);
}

export async function markContextEditProposalApplied({
  accountId = "",
  proposalId = "",
  savedContextRevision = null,
  savedContextDocumentId = "",
  savedContextHash = "",
} = {}) {
  const proposal = await getContextEditProposal({ accountId, proposalId });
  if (!proposal) return null;
  if (!useDatabase()) {
    const row = runtimeProposals.get(proposal.id);
    Object.assign(row, {
      state: "applied",
      saved_context_revision: intOrNull(savedContextRevision),
      saved_context_document_id: safeText(savedContextDocumentId, 180),
      saved_context_hash: safeText(savedContextHash, 100),
      updated_at: new Date().toISOString(),
      applied_at: new Date().toISOString(),
    });
    return publicProposal(row);
  }

  const result = await query(
    `
      UPDATE context_edit_proposals
      SET
        state = 'applied',
        saved_context_revision = $3,
        saved_context_document_id = $4,
        saved_context_hash = $5,
        updated_at = now(),
        applied_at = now()
      WHERE id = $1
        AND account_id = $2
      RETURNING *
    `,
    [
      safeText(proposalId, 180),
      safeAccountId(accountId),
      intOrNull(savedContextRevision),
      safeText(savedContextDocumentId, 180),
      safeText(savedContextHash, 100),
    ]
  );
  return publicProposal(result.rows[0]);
}

export async function markContextEditProposalRejected({ accountId = "", proposalId = "" } = {}) {
  const proposal = await getContextEditProposal({ accountId, proposalId });
  if (!proposal) return null;
  if (!useDatabase()) {
    const row = runtimeProposals.get(proposal.id);
    Object.assign(row, {
      state: "rejected",
      updated_at: new Date().toISOString(),
      rejected_at: new Date().toISOString(),
    });
    return publicProposal(row);
  }

  const result = await query(
    `
      UPDATE context_edit_proposals
      SET state = 'rejected', updated_at = now(), rejected_at = now()
      WHERE id = $1
        AND account_id = $2
      RETURNING *
    `,
    [safeText(proposalId, 180), safeAccountId(accountId)]
  );
  return publicProposal(result.rows[0]);
}
