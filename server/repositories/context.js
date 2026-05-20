import { createHash, randomUUID } from "node:crypto";
import { normalizeContextHistoryProjection } from "../context-history.js";
import { databaseEnabled, databaseStatus, query, transaction } from "../db/pool.js";
import {
  getContextDocument as getRuntimeContextDocument,
  getContextHistory as getRuntimeContextHistory,
  saveContextDocument as saveRuntimeContextDocument,
  saveContextHistoryProjection as saveRuntimeContextHistoryProjection,
} from "../runtime-store.js";
import { normalizeContextBodyForStorage } from "../../shared/context-html.js";

const maxContextBodyLength = 50_000;
const maxContextTitleLength = 120;
const maxContextUpdates = 250;
const maxTaskEvents = 500;
const contextProjectionSource = "pftl_cache_context_projection";

function useDatabase() {
  return databaseEnabled();
}

export function contextRepositoryStatus() {
  return databaseStatus();
}

function safeAccountId(accountId = "") {
  return String(accountId || "").trim().slice(0, 160);
}

function safeKey(value = "", fallback = "item") {
  const normalized = String(value || "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (normalized || fallback).slice(0, 100);
}

function cleanTitle(title = "") {
  return String(title || "Task Node Context")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxContextTitleLength) || "Task Node Context";
}

function cleanBody(body = "") {
  return normalizeContextBodyForStorage(String(body || "").slice(0, maxContextBodyLength));
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function stablePointerId({ accountId, walletAddress, pointerType, pointer }) {
  const key = [
    accountId,
    walletAddress,
    pointerType,
    pointer?.txHash || "",
    pointer?.memoIndex ?? "",
    pointer?.cid || "",
    pointer?.taskId || "",
    pointer?.eventType || "",
  ].join(":");
  return `ctxptr_${sha256(key).slice(0, 32)}`;
}

function wordCount(body = "") {
  const words = String(body || "").trim().match(/\S+/g);
  return words ? words.length : 0;
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function dateOrNull(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function intOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function defaultContextBody() {
  return [
    "# Task Node Context",
    "",
    "## Current Focus",
    "",
    "## Preferences",
    "",
    "## Active Projects",
    "",
    "## Notes",
  ].join("\n");
}

function defaultContextDocument({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const canEdit = Boolean(normalizedAccountId);
  const key = canEdit ? safeKey(normalizedAccountId, "account") : "signed_out";
  const now = new Date().toISOString();
  return {
    id: `ctx_${key}`,
    accountId: canEdit ? normalizedAccountId : null,
    title: "Task Node Context",
    body: defaultContextBody(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
    canEdit,
    savePath: "/api/context/edit/save",
  };
}

function publicContextDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id || null,
    title: row.title || "Task Node Context",
    body: row.body || "",
    revision: Number(row.revision || 0),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    canEdit: Boolean(row.account_id),
    savePath: "/api/context/edit/save",
  };
}

function historySnapshotKey({ accountId = "", walletAddress = "" } = {}) {
  return `${safeKey(accountId, "account")}:${safeKey(walletAddress, "wallet")}`;
}

function defaultHydration() {
  return {
    plaintextHydrated: false,
    requiresWalletUnlock: true,
    ipfsFetchReady: true,
    fetchPath: "/api/context/history/ipfs/:cid",
    note:
      "The cache stores PFTL pointer metadata only. Encrypted CID plaintext is fetched by CID and decrypted after local wallet unlock.",
  };
}

function emptyContextHistory({
  accountId = "",
  walletAddress = "",
  canHydrate = false,
  sync = null,
} = {}) {
  const normalizedAccountId = accountId ? safeAccountId(accountId) : null;
  const normalizedWalletAddress = walletAddress ? String(walletAddress).trim() : null;
  return {
    id: `ctx_history_${
      normalizedAccountId && normalizedWalletAddress
        ? historySnapshotKey({ accountId: normalizedAccountId, walletAddress: normalizedWalletAddress })
        : normalizedAccountId || "signed_out"
    }`,
    accountId: normalizedAccountId,
    source: contextProjectionSource,
    revision: 0,
    projectedAt: null,
    walletAddress: normalizedWalletAddress,
    pointerCount: 0,
    contextUpdateCount: 0,
    taskEventCount: 0,
    latestContextPointer: null,
    contextUpdates: [],
    taskEvents: [],
    hydration: {
      ...defaultHydration(),
      note:
        "No cached PFTL context pointers are available for this wallet yet. Background sync projects context pointers from cached wallet transactions.",
    },
    sync: sync || publicContextHistorySyncState(null, 0),
    canHydrate: Boolean(canHydrate && normalizedWalletAddress),
  };
}

function publicContextHistorySyncState(row, pointerCount = 0) {
  const archiveMarker = jsonObject(row?.archive_marker);
  const lastHotSyncAt = toIso(row?.last_hot_sync_at);
  const lastArchiveSyncAt = toIso(row?.last_archive_sync_at);
  const lastError = row?.last_error || null;
  let status = "syncing";
  if (lastError) status = "error";
  else if (archiveMarker.complete === true || lastHotSyncAt || lastArchiveSyncAt || Number(pointerCount || 0) > 0) {
    status = "ready";
  }
  return {
    source: "pftl_cache",
    status,
    archiveComplete: archiveMarker.complete === true,
    lastHotSyncAt,
    lastArchiveSyncAt,
    lastError,
  };
}

async function selectContextHistorySync({ walletAddress = "" } = {}) {
  const wallet = String(walletAddress || "").trim();
  if (!wallet) return null;
  const result = await query(
    `
      SELECT archive_marker, last_hot_sync_at, last_archive_sync_at, last_error
      FROM pftl_sync_wallets
      WHERE wallet_address = $1
      LIMIT 1
    `,
    [wallet]
  );
  return result.rows[0] || null;
}

function pointerType(pointer) {
  return Number(pointer?.kind || 0) === 5 || pointer?.kindLabel === "CONTEXT" ? "context" : "task_event";
}

function publicPointer(row) {
  const base = {
    cid: row.cid,
    kind: row.kind ?? null,
    kindLabel: row.kind_label || null,
    schema: row.schema || null,
    flags: Number(row.flags || 0),
    taskId: row.task_id || null,
    threadId: row.thread_id || null,
    contextId: row.context_id || null,
    txHash: row.tx_hash || null,
    ledgerIndex: row.ledger_index === null || row.ledger_index === undefined ? null : Number(row.ledger_index),
    memoIndex: row.memo_index === null || row.memo_index === undefined ? null : Number(row.memo_index),
    createdAt: toIso(row.pointer_created_at),
    account: row.account_address || null,
    destination: row.destination_address || null,
    direction: row.direction || null,
    source: row.source || "",
    version: row.version || null,
    wordCount: row.word_count === null || row.word_count === undefined ? null : Number(row.word_count),
  };

  if (row.pointer_type === "context") return base;

  return {
    ...base,
    eventId: row.event_id || null,
    eventType: row.event_type || null,
    title: row.title || "",
    status: row.status || "",
    artifactType: row.artifact_type || "",
    artifactCount:
      row.artifact_count === null || row.artifact_count === undefined ? undefined : Number(row.artifact_count),
  };
}

function runtimeHasSavedContext(document) {
  return Boolean(document?.accountId && Number(document?.revision || 0) > 0);
}

async function selectContextDocument(accountId) {
  const result = await query(
    `
      SELECT
        d.id,
        d.account_id,
        d.title,
        d.revision,
        d.created_at,
        d.updated_at,
        COALESCE(r.body, '') AS body
      FROM context_documents d
      LEFT JOIN context_revisions r
        ON r.id = d.current_revision_id
      WHERE d.account_id = $1
        AND d.deleted_at IS NULL
      LIMIT 1
    `,
    [accountId]
  );
  return result.rows[0] || null;
}

export async function getContextDocument({ accountId = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) {
    return defaultContextDocument({ accountId: "" });
  }
  if (!useDatabase()) {
    const document = getRuntimeContextDocument({ accountId: normalizedAccountId });
    return {
      ...document,
      body: normalizeContextBodyForStorage(document.body || ""),
    };
  }

  const row = await selectContextDocument(normalizedAccountId);
  if (row) return publicContextDocument(row);

  const runtimeDocument = getRuntimeContextDocument({ accountId: normalizedAccountId });
  if (runtimeHasSavedContext(runtimeDocument)) {
    return {
      ...runtimeDocument,
      body: normalizeContextBodyForStorage(runtimeDocument.body || ""),
    };
  }

  return defaultContextDocument({ accountId: normalizedAccountId });
}

export async function saveContextDocument({
  accountId = "",
  title = "",
  body = "",
  source = "native_editor",
  provenance = {},
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) {
    return { ok: false, status: 401, error: "context_login_required" };
  }
  if (!useDatabase()) {
    return saveRuntimeContextDocument({
      accountId: normalizedAccountId,
      title,
      body: cleanBody(body),
    });
  }

  const normalizedTitle = cleanTitle(title);
  const normalizedBody = cleanBody(body);

  const document = await transaction(async (client) => {
    const existing = await client.query(
      `
        SELECT *
        FROM context_documents
        WHERE account_id = $1
          AND deleted_at IS NULL
        LIMIT 1
        FOR UPDATE
      `,
      [normalizedAccountId]
    );

    const runtimeDocument = getRuntimeContextDocument({ accountId: normalizedAccountId });
    const current = existing.rows[0] || null;
    const now = new Date();
    const documentId = current?.id || runtimeDocument?.id || `ctx_${safeKey(normalizedAccountId, "account")}`;
    const currentRevision = Number(current?.revision || (runtimeHasSavedContext(runtimeDocument) ? runtimeDocument.revision : 0) || 0);
    let currentRevisionRow = null;
    if (current?.current_revision_id) {
      const currentRevisionResult = await client.query(
        `
          SELECT *
          FROM context_revisions
          WHERE id = $1
          FOR UPDATE
        `,
        [current.current_revision_id]
      );
      currentRevisionRow = currentRevisionResult.rows[0] || null;
    }

    const nextBodySha256 = sha256(normalizedBody);
    if (
      current &&
      currentRevisionRow &&
      current.title === normalizedTitle &&
      currentRevisionRow.body_sha256 === nextBodySha256
    ) {
      return {
        ...current,
        body: currentRevisionRow.body,
      };
    }

    const nextRevision = currentRevision + 1;
    const revisionId = currentRevisionRow?.id || `ctxrev_${randomUUID()}`;

    await client.query(
      `
        INSERT INTO context_documents (
          id,
          account_id,
          title,
          revision,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 0, $4, $4)
        ON CONFLICT (id) DO NOTHING
      `,
      [
        documentId,
        normalizedAccountId,
        runtimeHasSavedContext(runtimeDocument) ? runtimeDocument.title : normalizedTitle,
        dateOrNull(runtimeDocument?.createdAt) || now,
      ]
    );

    const savedRevision = currentRevisionRow
      ? await client.query(
        `
          UPDATE context_revisions
          SET
            revision = $2,
            title = $3,
            body = $4,
            body_sha256 = $5,
            word_count = $6,
            source = $7,
            provenance_json = $8,
            created_at = $9
          WHERE id = $1
          RETURNING *
        `,
        [
          revisionId,
          nextRevision,
          normalizedTitle,
          normalizedBody,
          nextBodySha256,
          wordCount(normalizedBody),
          String(source || "native_editor").slice(0, 80),
          jsonObject(provenance),
          now,
        ]
      )
      : await client.query(
        `
          INSERT INTO context_revisions (
            id,
            context_document_id,
            account_id,
            revision,
            title,
            body,
            body_sha256,
            word_count,
            source,
            provenance_json,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          RETURNING *
        `,
        [
          revisionId,
          documentId,
          normalizedAccountId,
          nextRevision,
          normalizedTitle,
          normalizedBody,
          nextBodySha256,
          wordCount(normalizedBody),
          String(source || "native_editor").slice(0, 80),
          jsonObject(provenance),
          now,
        ]
      );

    const updated = await client.query(
      `
        UPDATE context_documents
        SET
          title = $2,
          current_revision_id = $3,
          revision = $4,
          updated_at = $5
        WHERE id = $1
        RETURNING *
      `,
      [documentId, normalizedTitle, savedRevision.rows[0].id, nextRevision, now]
    );

    return {
      ...updated.rows[0],
      body: savedRevision.rows[0].body,
    };
  });

  return {
    ok: true,
    document: publicContextDocument(document),
  };
}

export async function getContextHistory({ accountId = "", walletAddress = "" } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedWalletAddress = String(walletAddress || "").trim();
  if (!useDatabase()) {
    return getRuntimeContextHistory({ accountId: normalizedAccountId, walletAddress: normalizedWalletAddress });
  }
  if (!normalizedAccountId || !normalizedWalletAddress) {
    const syncRow = normalizedWalletAddress
      ? await selectContextHistorySync({ walletAddress: normalizedWalletAddress })
      : null;
    return emptyContextHistory({
      accountId: normalizedAccountId,
      walletAddress: normalizedWalletAddress,
      canHydrate: Boolean(normalizedAccountId && normalizedWalletAddress),
      sync: publicContextHistorySyncState(syncRow, 0),
    });
  }

  const syncRow = await selectContextHistorySync({ walletAddress: normalizedWalletAddress });

  const imports = await query(
    `
      SELECT *
      FROM context_history_imports
      WHERE account_id = $1
        AND wallet_address = $2
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [normalizedAccountId, normalizedWalletAddress]
  );

  const counts = await query(
    `
      SELECT pointer_type, count(*)::integer AS count
      FROM context_history_pointers
      WHERE account_id = $1
        AND wallet_address = $2
      GROUP BY pointer_type
    `,
    [normalizedAccountId, normalizedWalletAddress]
  );
  const pointerCounts = counts.rows.reduce((acc, row) => {
    acc[row.pointer_type || "task_event"] = Number(row.count || 0);
    return acc;
  }, {});
  const totalContextUpdates = Number(pointerCounts.context || 0);
  const totalTaskEvents = Object.entries(pointerCounts)
    .filter(([type]) => type !== "context")
    .reduce((sum, [, count]) => sum + Number(count || 0), 0);
  const totalPointers = totalContextUpdates + totalTaskEvents;

  const contextPointerRows = await query(
    `
      SELECT *
      FROM context_history_pointers
      WHERE account_id = $1
        AND wallet_address = $2
        AND pointer_type = 'context'
      ORDER BY
        pointer_created_at DESC NULLS LAST,
        ledger_index DESC NULLS LAST,
        created_at DESC,
        id DESC
      LIMIT $3
    `,
    [normalizedAccountId, normalizedWalletAddress, maxContextUpdates]
  );

  const taskPointerRows = await query(
    `
      SELECT *
      FROM context_history_pointers
      WHERE account_id = $1
        AND wallet_address = $2
        AND pointer_type <> 'context'
      ORDER BY
        pointer_created_at DESC NULLS LAST,
        ledger_index DESC NULLS LAST,
        created_at DESC,
        id DESC
      LIMIT $3
    `,
    [normalizedAccountId, normalizedWalletAddress, maxTaskEvents]
  );

  if (totalPointers === 0) {
    return emptyContextHistory({
      accountId: normalizedAccountId,
      walletAddress: normalizedWalletAddress,
      canHydrate: true,
      sync: publicContextHistorySyncState(syncRow, 0),
    });
  }

  const contextUpdates = [];
  const taskEvents = [];
  for (const row of contextPointerRows.rows) {
    contextUpdates.push(publicPointer(row));
  }
  for (const row of taskPointerRows.rows) {
    taskEvents.push(publicPointer(row));
  }

  const latestImport = imports.rows[0] || null;
  const metadata = jsonObject(latestImport?.metadata_json);

  return {
    id: `ctx_history_${historySnapshotKey({
      accountId: normalizedAccountId,
      walletAddress: normalizedWalletAddress,
    })}`,
    accountId: normalizedAccountId,
    source: latestImport?.source || contextProjectionSource,
    revision: Number(metadata.projectionCount || 0) || Number(imports.rowCount || 0) || 1,
    projectedAt: toIso(latestImport?.created_at),
    normalizedAt: metadata.normalizedAt || metadata.projectedAt || null,
    walletAddress: normalizedWalletAddress,
    pointerCount: totalPointers,
    contextUpdateCount: totalContextUpdates,
    taskEventCount: totalTaskEvents,
    latestContextPointer: contextUpdates[0] || null,
    contextUpdates,
    taskEvents,
    hydration: jsonObject(metadata.hydration).fetchPath ? metadata.hydration : defaultHydration(),
    sync: publicContextHistorySyncState(syncRow, totalPointers),
    canHydrate: true,
  };
}

async function insertPointer({
  client,
  importId,
  accountId,
  walletAddress,
  pointer,
  pointerType: explicitPointerType,
}) {
  const type = explicitPointerType || pointerType(pointer);
  const id = stablePointerId({ accountId, walletAddress, pointerType: type, pointer });
  const inserted = await client.query(
    `
      INSERT INTO context_history_pointers (
        id,
        import_id,
        account_id,
        wallet_address,
        cid,
        pointer_type,
        kind,
        kind_label,
        schema,
        flags,
        task_id,
        thread_id,
        context_id,
        tx_hash,
        ledger_index,
        memo_index,
        pointer_created_at,
        account_address,
        destination_address,
        direction,
        source,
        version,
        word_count,
        event_id,
        event_type,
        title,
        status,
        artifact_type,
        artifact_count,
        metadata_json
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24, $25, $26, $27, $28,
        $29, $30
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [
      id,
      importId,
      accountId,
      walletAddress,
      String(pointer.cid || "").trim(),
      type,
      intOrNull(pointer.kind),
      pointer.kindLabel || null,
      pointer.schema || null,
      intOrNull(pointer.flags) || 0,
      pointer.taskId || null,
      pointer.threadId || null,
      pointer.contextId || null,
      pointer.txHash || null,
      intOrNull(pointer.ledgerIndex),
      intOrNull(pointer.memoIndex),
      dateOrNull(pointer.createdAt),
      pointer.account || null,
      pointer.destination || null,
      pointer.direction || null,
      pointer.source || "",
      pointer.version || null,
      intOrNull(pointer.wordCount),
      pointer.eventId || null,
      pointer.eventType || null,
      pointer.title || "",
      pointer.status || "",
      pointer.artifactType || "",
      intOrNull(pointer.artifactCount),
      {},
    ]
  );
  return Boolean(inserted.rows[0]);
}

export async function saveContextHistoryProjection({ accountId = "", projection = {}, snapshot = {} } = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) {
    return { ok: false, status: 401, error: "context_login_required" };
  }
  if (!useDatabase()) {
    return saveRuntimeContextHistoryProjection({
      accountId: normalizedAccountId,
      projection: Object.keys(jsonObject(projection)).length ? projection : snapshot,
    });
  }

  const normalized = normalizeContextHistoryProjection(
    Object.keys(jsonObject(projection)).length ? projection : snapshot
  );
  const normalizedWalletAddress = normalized.walletAddress ? String(normalized.walletAddress).trim() : "";
  if (!normalizedWalletAddress) {
    return {
      ok: false,
      status: 409,
      error: "context_history_wallet_required",
    };
  }

  await transaction(async (client) => {
    const projectionId = `ctxproj_${randomUUID()}`;
    const existingProjections = await client.query(
      `
        SELECT count(*)::integer AS count
        FROM context_history_imports
        WHERE account_id = $1
          AND wallet_address = $2
      `,
      [normalizedAccountId, normalizedWalletAddress]
    );
    const projectionCount = Number(existingProjections.rows[0]?.count || 0) + 1;

    await client.query(
      `
        INSERT INTO context_history_imports (
          id,
          account_id,
          wallet_address,
          source,
          status,
          pointer_count,
          context_update_count,
          task_event_count,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $8)
      `,
      [
        projectionId,
        normalizedAccountId,
        normalizedWalletAddress,
        normalized.source || contextProjectionSource,
        normalized.pointerCount,
        normalized.contextUpdateCount,
        normalized.taskEventCount,
        {
          normalizedAt: normalized.normalizedAt,
          projectionCount,
          hydration: normalized.hydration,
        },
      ]
    );

    for (const pointer of normalized.contextUpdates) {
      await insertPointer({
        client,
        importId: projectionId,
        accountId: normalizedAccountId,
        walletAddress: normalizedWalletAddress,
        pointer,
        pointerType: "context",
      });
    }

    for (const pointer of normalized.taskEvents) {
      if (!pointer?.cid) continue;
      await insertPointer({
        client,
        importId: projectionId,
        accountId: normalizedAccountId,
        walletAddress: normalizedWalletAddress,
        pointer,
        pointerType: "task_event",
      });
    }
  });

  return {
    ok: true,
    history: await getContextHistory({
      accountId: normalizedAccountId,
      walletAddress: normalizedWalletAddress,
    }),
  };
}
