import { createHash } from "node:crypto";

import { databaseEnabled, query, transaction } from "../db/pool.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function digestText(value = "") {
  const normalized = safeText(value, 1000).toLowerCase();
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex");
}

export function normalizeCapabilityType(value = "") {
  return safeText(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "unspecified_capability";
}

export function capabilityScopeDigest(value = "") {
  const normalized = safeText(value, 500).toLowerCase();
  if (!normalized) return "";
  return `scope:${digestText(normalized).slice(0, 24)}`;
}

function normalizeCapabilityStatus(value = "") {
  const normalized = safeText(value, 80).toLowerCase();
  if (["declared", "verifying", "verified", "expired", "revoked"].includes(normalized)) return normalized;
  return "declared";
}

function machineOperatorKind(profile = {}) {
  const capabilityType = normalizeCapabilityType(profile.capability_type || profile.capabilityType);
  const metadata = safeObject(profile.metadata_json || profile.metadata);
  const metadataKind = normalizeCapabilityType(metadata.operator_kind || metadata.operatorKind || metadata.machine_operator_kind || metadata.machineOperatorKind);
  if (metadata.machine_operator === true || metadata.machineOperator === true || metadata.is_machine_operator === true || metadata.isMachineOperator === true) {
    return metadataKind || capabilityType || "machine_operator";
  }
  if ([
    "machine_operator",
    "orc_operator",
    "tasknode_agent",
    "tasknode_agent_client",
    "evidence_evaluation_orc",
  ].includes(capabilityType)) {
    return capabilityType;
  }
  return "";
}

function capabilityProfileId({ accountId = "", projectId = "", capabilityType = "", scopeDigest = "" } = {}) {
  return `cap_${digestText([accountId, projectId, capabilityType, scopeDigest].join("|")).slice(0, 32)}`;
}

function isExpired(row = {}) {
  const expiresAt = row.expires_at || row.expiresAt;
  if (!expiresAt) return false;
  const time = Date.parse(expiresAt);
  return Number.isFinite(time) && time <= Date.now();
}

export function normalizeCapabilityProfileRow(row = {}) {
  const status = normalizeCapabilityStatus(row.status);
  const expired = status === "verified" && isExpired(row);
  const effectiveStatus = expired ? "expired" : status;
  return {
    id: safeText(row.id, 180),
    account_id: safeText(row.account_id || row.accountId, 180),
    project_id: safeText(row.project_id || row.projectId, 180),
    capability_type: normalizeCapabilityType(row.capability_type || row.capabilityType),
    scope_label: safeText(row.scope_label || row.scopeLabel, 180),
    scope_digest: safeText(row.scope_digest || row.scopeDigest, 80),
    status,
    effective_status: effectiveStatus,
    verified: effectiveStatus === "verified",
    evidence_task_id: safeText(row.evidence_task_id || row.evidenceTaskId, 180),
    evidence_url_or_ref: safeText(row.evidence_url_or_ref || row.evidenceUrlOrRef, 500),
    verified_by: safeText(row.verified_by || row.verifiedBy, 180),
    verified_at: toIso(row.verified_at || row.verifiedAt),
    expires_at: toIso(row.expires_at || row.expiresAt),
    revoked_at: toIso(row.revoked_at || row.revokedAt),
    notes: safeText(row.notes, 700),
    metadata: safeObject(row.metadata_json || row.metadata),
    created_at: toIso(row.created_at || row.createdAt),
    updated_at: toIso(row.updated_at || row.updatedAt),
  };
}

export function publicMachineOperatorDisclosureFromProfiles(profiles = []) {
  const verifiedProfiles = safeArray(profiles)
    .map(normalizeCapabilityProfileRow)
    .filter((profile) => profile.verified && machineOperatorKind(profile));
  if (!verifiedProfiles.length) return null;
  const primary = verifiedProfiles[0];
  const metadata = safeObject(primary.metadata);
  return {
    isMachineOperator: true,
    label: safeText(metadata.public_label || metadata.publicLabel, 80) || "Orc operator",
    kind: machineOperatorKind(primary),
    mandateUrl: safeText(metadata.mandate_url || metadata.mandateUrl, 500),
    capabilities: verifiedProfiles.slice(0, 6).map((profile) => ({
      id: profile.id,
      capabilityType: profile.capability_type,
      scopeLabel: profile.scope_label,
      status: profile.effective_status,
      evidenceTaskId: profile.evidence_task_id,
      evidenceRef: profile.evidence_url_or_ref,
      verifiedAt: profile.verified_at,
      expiresAt: profile.expires_at,
    })),
    safety: "No seed, session token, private payload plaintext, or runtime secret is exposed.",
  };
}

export async function listMachineOperatorDisclosures({
  accountIds = [],
  queryImpl = query,
  databaseReady = databaseEnabled(),
} = {}) {
  if (!databaseReady && queryImpl === query) return {};
  if (queryImpl === query && !(await capabilityTableExists())) return {};
  const normalizedAccountIds = [...new Set(safeArray(accountIds).map((item) => safeText(item, 180)).filter(Boolean))];
  if (!normalizedAccountIds.length) return {};
  const result = await queryImpl(
    `
      SELECT *
      FROM board_manager_capability_profiles
      WHERE account_id = ANY($1::text[])
        AND status = 'verified'
        AND revoked_at IS NULL
        AND (
          expires_at IS NULL
          OR expires_at > now()
        )
      ORDER BY verified_at DESC NULLS LAST, updated_at DESC, id ASC
    `,
    [normalizedAccountIds]
  );
  const grouped = new Map();
  for (const row of result.rows) {
    const profile = normalizeCapabilityProfileRow(row);
    if (!machineOperatorKind(profile)) continue;
    const list = grouped.get(profile.account_id) || [];
    list.push(profile);
    grouped.set(profile.account_id, list);
  }
  return Object.fromEntries(
    [...grouped.entries()].map(([accountId, profiles]) => [accountId, publicMachineOperatorDisclosureFromProfiles(profiles)])
  );
}

export function normalizeCapabilityProfileInput({
  accountId = "",
  projectId = "",
  capabilityType = "",
  scope = "",
  scopeLabel = "",
  evidenceTaskId = "",
  evidenceUrlOrRef = "",
  verifiedBy = "",
  expiresAt = null,
  notes = "",
  metadata = {},
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedProjectId = safeText(projectId, 180);
  const normalizedCapabilityType = normalizeCapabilityType(capabilityType);
  const normalizedScopeLabel = safeText(scopeLabel || normalizedCapabilityType, 180);
  const normalizedScopeDigest = capabilityScopeDigest(scope || normalizedScopeLabel || normalizedCapabilityType);
  return {
    id: capabilityProfileId({
      accountId: normalizedAccountId,
      projectId: normalizedProjectId,
      capabilityType: normalizedCapabilityType,
      scopeDigest: normalizedScopeDigest,
    }),
    accountId: normalizedAccountId,
    projectId: normalizedProjectId,
    capabilityType: normalizedCapabilityType,
    scopeLabel: normalizedScopeLabel,
    scopeDigest: normalizedScopeDigest,
    evidenceTaskId: safeText(evidenceTaskId, 180),
    evidenceUrlOrRef: safeText(evidenceUrlOrRef, 500),
    verifiedBy: safeText(verifiedBy, 180) || "operator",
    expiresAt: expiresAt ? toIso(expiresAt) : null,
    notes: safeText(notes, 700),
    metadata: safeObject(metadata),
  };
}

async function capabilityTableExists(client = null) {
  if (!databaseEnabled()) return false;
  const executor = client || { query };
  const result = await executor.query("SELECT to_regclass('public.board_manager_capability_profiles') AS name");
  return Boolean(result.rows[0]?.name);
}

export async function listCapabilityProfilesForBoardManager({
  accountIds = [],
  projectIds = [],
  limit = 200,
} = {}) {
  if (!databaseEnabled()) return [];
  if (!(await capabilityTableExists())) return [];
  const normalizedAccountIds = [...new Set(safeArray(accountIds).map((item) => safeText(item, 180)).filter(Boolean))];
  const normalizedProjectIds = [...new Set(safeArray(projectIds).map((item) => safeText(item, 180)).filter(Boolean))];
  const result = await query(
    `
      SELECT *
      FROM board_manager_capability_profiles
      WHERE (
          cardinality($1::text[]) = 0
          OR account_id = ANY($1::text[])
        )
        AND (
          cardinality($2::text[]) = 0
          OR project_id = ''
          OR project_id = ANY($2::text[])
        )
      ORDER BY
        CASE status WHEN 'verified' THEN 0 WHEN 'verifying' THEN 1 WHEN 'declared' THEN 2 ELSE 3 END,
        verified_at DESC NULLS LAST,
        updated_at DESC,
        id ASC
      LIMIT $3
    `,
    [
      normalizedAccountIds,
      normalizedProjectIds,
      Math.min(Math.max(Number(limit) || 200, 1), 500),
    ]
  );
  return result.rows.map(normalizeCapabilityProfileRow);
}

export async function verifyCapabilityProfile(input = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const profile = normalizeCapabilityProfileInput(input);
  if (!profile.accountId) {
    return { ok: false, status: 400, error: "capability_account_required" };
  }
  if (!profile.capabilityType || profile.capabilityType === "unspecified_capability") {
    return { ok: false, status: 400, error: "capability_type_required" };
  }
  return transaction(async (client) => {
    if (!(await capabilityTableExists(client))) {
      return { ok: false, status: 409, error: "capability_profiles_not_migrated" };
    }
    const result = await client.query(
      `
        INSERT INTO board_manager_capability_profiles (
          id,
          account_id,
          project_id,
          capability_type,
          scope_label,
          scope_digest,
          status,
          evidence_task_id,
          evidence_url_or_ref,
          verified_by,
          verified_at,
          expires_at,
          notes,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'verified', $7, $8, $9, now(), $10::timestamptz, $11, $12::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          account_id = EXCLUDED.account_id,
          project_id = EXCLUDED.project_id,
          capability_type = EXCLUDED.capability_type,
          scope_label = EXCLUDED.scope_label,
          scope_digest = EXCLUDED.scope_digest,
          status = 'verified',
          evidence_task_id = EXCLUDED.evidence_task_id,
          evidence_url_or_ref = EXCLUDED.evidence_url_or_ref,
          verified_by = EXCLUDED.verified_by,
          verified_at = EXCLUDED.verified_at,
          expires_at = EXCLUDED.expires_at,
          revoked_at = NULL,
          notes = EXCLUDED.notes,
          metadata_json = board_manager_capability_profiles.metadata_json || EXCLUDED.metadata_json,
          updated_at = now()
        RETURNING *
      `,
      [
        profile.id,
        profile.accountId,
        profile.projectId,
        profile.capabilityType,
        profile.scopeLabel,
        profile.scopeDigest,
        profile.evidenceTaskId,
        profile.evidenceUrlOrRef,
        profile.verifiedBy,
        profile.expiresAt,
        profile.notes,
        jsonValue({
          ...profile.metadata,
          raw_scope_redacted: true,
        }),
      ]
    );
    return { ok: true, profile: normalizeCapabilityProfileRow(result.rows[0]) };
  });
}

export async function revokeCapabilityProfile({
  accountId = "",
  projectId = "",
  capabilityType = "",
  scope = "",
  scopeLabel = "",
  revokedBy = "",
  notes = "",
  metadata = {},
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured" };
  const profile = normalizeCapabilityProfileInput({
    accountId,
    projectId,
    capabilityType,
    scope,
    scopeLabel,
    verifiedBy: revokedBy,
    notes,
    metadata,
  });
  if (!profile.accountId) {
    return { ok: false, status: 400, error: "capability_account_required" };
  }
  return transaction(async (client) => {
    if (!(await capabilityTableExists(client))) {
      return { ok: false, status: 409, error: "capability_profiles_not_migrated" };
    }
    const result = await client.query(
      `
        UPDATE board_manager_capability_profiles
        SET status = 'revoked',
            revoked_at = now(),
            notes = $2,
            metadata_json = metadata_json || $3::jsonb,
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [
        profile.id,
        profile.notes,
        jsonValue({
          ...profile.metadata,
          revoked_by: safeText(revokedBy, 180) || "operator",
          raw_scope_redacted: true,
        }),
      ]
    );
    if (!result.rows[0]) {
      return { ok: false, status: 404, error: "capability_profile_not_found" };
    }
    return { ok: true, profile: normalizeCapabilityProfileRow(result.rows[0]) };
  });
}
