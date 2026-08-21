import { query } from "../db/pool.js";

const safeAccountId = (accountId = "") => String(accountId || "").trim().slice(0, 160);

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function publicContextEditProposal(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id || "",
    conversationId: row.conversation_id || "",
    assistantMessageId: row.assistant_message_id || "",
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
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    appliedAt: toIso(row.applied_at),
    rejectedAt: toIso(row.rejected_at),
  };
}

function mergeContextEditProposalMetadata(metadata = {}, proposal = null) {
  if (!proposal) return metadata;
  const contextEdit = metadata.contextEdit && typeof metadata.contextEdit === "object" ? metadata.contextEdit : {};
  const existingProposal = contextEdit.proposal && typeof contextEdit.proposal === "object" ? contextEdit.proposal : {};
  return {
    ...metadata,
    contextEdit: {
      ...contextEdit,
      state: proposal.state === "pending" ? contextEdit.state || "proposal" : proposal.state,
      proposal: {
        ...existingProposal,
        ...proposal,
      },
    },
  };
}

export async function hydrateContextEditProposalMetadata(rows = [], accountId = "") {
  const assistantIds = rows
    .filter((row) => row.role === "assistant")
    .map((row) => row.id)
    .filter(Boolean);
  if (assistantIds.length === 0) return rows;

  let proposalRows;
  try {
    proposalRows = await query(
      `
        SELECT *
        FROM context_edit_proposals
        WHERE account_id = $2
          AND assistant_message_id = ANY($1::text[])
      `,
      [assistantIds, safeAccountId(accountId)]
    );
  } catch (error) {
    if (error?.code === "42P01") return rows;
    throw error;
  }

  if (proposalRows.rows.length === 0) return rows;
  const proposalsByAssistantId = new Map(
    proposalRows.rows.map((row) => [row.assistant_message_id, publicContextEditProposal(row)])
  );

  return rows.map((row) => {
    const proposal = proposalsByAssistantId.get(row.id);
    if (!proposal) return row;
    const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
    return {
      ...row,
      metadata_json: mergeContextEditProposalMetadata(metadata, proposal),
    };
  });
}
