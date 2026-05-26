import { decodePftPointerMemo } from "../context-history-rpc.js";
import { databaseEnabled, query, transaction } from "../db/pool.js";

const RIPPLE_EPOCH_OFFSET = 946684800;
const POINTER_MEMO_TYPE = "pf.ptr";
const POINTER_MEMO_FORMAT = "v4";
const TASK_POINTER_KINDS = new Set(["TASK", "TASK_UPDATE", "TASK_SUBMISSION", "REWARD"]);

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function intOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function safeJson(value, fallback = {}) {
  return value && typeof value === "object" ? value : fallback;
}

function nativeDrops(value) {
  if (typeof value === "string" && /^-?\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return null;
}

function rippleTimeToIso(txDate) {
  if (typeof txDate !== "number") return null;
  const date = new Date((txDate + RIPPLE_EPOCH_OFFSET) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function decodeHexText(value) {
  const text = normalizeText(value);
  if (!text || text.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(text)) return text;
  try {
    return Buffer.from(text, "hex").toString("utf8");
  } catch {
    return text;
  }
}

export function normalizeAccountTxEntry(entry) {
  const candidate = entry?.tx_json || entry?.tx || entry?.transaction || entry;
  if (!candidate) return null;
  if (typeof candidate === "string") {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return typeof candidate === "object" ? candidate : null;
}

function normalizeMeta(entry) {
  const candidate = entry?.meta_json || entry?.meta || entry?.metaData || entry?.metadata || null;
  if (!candidate) return null;
  if (typeof candidate === "string") {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  return typeof candidate === "object" ? candidate : null;
}

function txHash(entry, tx) {
  return normalizeText(tx?.hash || tx?.Hash || entry?.hash || entry?.tx_hash || entry?.txHash) || null;
}

function ledgerIndex(entry, tx, meta) {
  return intOrNull(
    tx?.ledger_index ||
      tx?.ledgerIndex ||
      entry?.ledger_index ||
      entry?.ledgerIndex ||
      meta?.LedgerSequence ||
      meta?.ledger_index
  );
}

function transactionResult(meta) {
  return normalizeText(
    meta?.TransactionResult ||
      meta?.transaction_result ||
      meta?.engine_result ||
      meta?.result
  ) || null;
}

function closeTime(entry, tx) {
  return (
    rippleTimeToIso(typeof tx?.date === "number" ? tx.date : entry?.date) ||
    normalizeIso(entry?.close_time_iso || entry?.createdAt || entry?.created_at || tx?.close_time_iso)
  );
}

function directionForWallet(walletAddress, tx) {
  const account = normalizeText(tx?.Account || tx?.account);
  const destination = normalizeText(tx?.Destination || tx?.destination);
  const wallet = normalizeText(walletAddress);

  if (!wallet) return { direction: null, counterpartyWallet: null };
  if (account === wallet && destination === wallet) {
    return { direction: "self", counterpartyWallet: wallet };
  }
  if (account === wallet) {
    return { direction: "outbound", counterpartyWallet: destination || null };
  }
  if (destination === wallet) {
    return { direction: "inbound", counterpartyWallet: account || null };
  }
  if (account || destination) {
    return { direction: "affected", counterpartyWallet: account || destination || null };
  }
  return { direction: null, counterpartyWallet: null };
}

export function mapPftlTransaction(entry, walletAddress = "") {
  const tx = normalizeAccountTxEntry(entry);
  if (!tx) return null;
  const meta = normalizeMeta(entry);
  const hash = txHash(entry, tx);
  if (!hash) return null;
  const { direction, counterpartyWallet } = directionForWallet(walletAddress, tx);

  return {
    txHash: hash,
    ledgerIndex: ledgerIndex(entry, tx, meta),
    txType: normalizeText(tx.TransactionType || tx.transaction_type) || null,
    validated: entry?.validated ?? tx?.validated ?? null,
    account: normalizeText(tx.Account || tx.account) || null,
    destination: normalizeText(tx.Destination || tx.destination) || null,
    transactionResult: transactionResult(meta),
    closeTime: closeTime(entry, tx),
    txJson: tx,
    metaJson: meta,
    walletAddress: normalizeText(walletAddress),
    direction,
    counterpartyWallet,
    deliveredDrops: nativeDrops(meta?.delivered_amount || tx.DeliverMax || tx.deliverMax || tx.Amount),
    feeDrops: nativeDrops(tx.Fee || tx.fee),
  };
}

export function extractPointerMemosFromTransaction({ txHash: hash, tx, walletAddress = "" } = {}) {
  const memos = Array.isArray(tx?.Memos) ? tx.Memos : [];
  const rows = [];

  memos.forEach((wrapper, memoIndex) => {
    const memo = wrapper?.Memo || wrapper || {};
    const memoType = decodeHexText(memo.MemoType || memo.memo_type || "");
    const memoFormat = decodeHexText(memo.MemoFormat || memo.memo_format || "");
    const memoDataHex = normalizeText(memo.MemoData || memo.memo_data || "");
    if (!memoDataHex) return;

    let pointer = null;
    let decodeError = null;
    if (memoType === POINTER_MEMO_TYPE && memoFormat === POINTER_MEMO_FORMAT) {
      pointer = decodePftPointerMemo(memoDataHex);
      if (!pointer?.cid) decodeError = "pointer_decode_failed";
    }

    rows.push({
      txHash: hash,
      memoIndex,
      walletAddress: normalizeText(walletAddress) || null,
      memoType: memoType || null,
      memoFormat: memoFormat || null,
      pointerKind: pointer?.kindLabel || (pointer?.kind === undefined ? null : String(pointer.kind)),
      schemaVersion: pointer?.schema === undefined || pointer?.schema === null ? null : String(pointer.schema),
      cid: pointer?.cid || null,
      taskId: pointer?.taskId || null,
      requestId: pointer?.requestId || null,
      contextId: pointer?.contextId || null,
      threadId: pointer?.threadId || null,
      memoDataHex,
      decodedJson: pointer || {},
      decodeError,
    });
  });

  return rows;
}

async function runQuery(client, text, params) {
  return client ? client.query(text, params) : query(text, params);
}

export async function registerPftlSyncWallet({
  walletAddress = "",
  accountId = "",
  role = "user",
  ownerWalletAddress = "",
  priority = 100,
  status = "active",
  metadata = {},
} = {}) {
  const wallet = normalizeText(walletAddress);
  if (!wallet || !databaseEnabled()) return { ok: false, skipped: true };

  await query(
    `
      INSERT INTO pftl_sync_wallets (
        wallet_address,
        account_id,
        role,
        owner_wallet_address,
        priority,
        status,
        metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (wallet_address)
      DO UPDATE SET
        account_id = COALESCE(NULLIF(EXCLUDED.account_id, ''), pftl_sync_wallets.account_id),
        role = COALESCE(NULLIF(EXCLUDED.role, ''), pftl_sync_wallets.role),
        owner_wallet_address = COALESCE(NULLIF(EXCLUDED.owner_wallet_address, ''), pftl_sync_wallets.owner_wallet_address),
        priority = LEAST(pftl_sync_wallets.priority, EXCLUDED.priority),
        status = EXCLUDED.status,
        metadata_json = pftl_sync_wallets.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
    `,
    [
      wallet,
      normalizeText(accountId),
      normalizeText(role) || "user",
      normalizeText(ownerWalletAddress),
      intOrNull(priority) ?? 100,
      normalizeText(status) || "active",
      safeJson(metadata),
    ]
  );

  return { ok: true, walletAddress: wallet };
}

export async function markPftlSyncWalletInactive({ walletAddress = "", reason = "" } = {}) {
  const wallet = normalizeText(walletAddress);
  if (!wallet || !databaseEnabled()) return { ok: false, skipped: true };
  await query(
    `
      UPDATE pftl_sync_wallets
      SET status = 'inactive',
          metadata_json = metadata_json || $2::jsonb,
          updated_at = now()
      WHERE wallet_address = $1
    `,
    [wallet, { inactiveReason: normalizeText(reason) || "user_delinked" }]
  );
  return { ok: true, walletAddress: wallet };
}

export async function upsertPftlTransactionBatch({
  walletAddress = "",
  transactions = [],
  client = null,
} = {}) {
  const wallet = normalizeText(walletAddress);
  const entries = Array.isArray(transactions) ? transactions : [];
  let inserted = 0;
  let pointerCount = 0;
  let maxLedger = null;
  let newestHash = null;

  for (const entry of entries) {
    const mapped = mapPftlTransaction(entry, wallet);
    if (!mapped) continue;
    await runQuery(
      client,
      `
        INSERT INTO pftl_transactions (
          tx_hash,
          ledger_index,
          tx_type,
          validated,
          account,
          destination,
          transaction_result,
          close_time,
          tx_json,
          meta_json
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (tx_hash)
        DO UPDATE SET
          ledger_index = COALESCE(EXCLUDED.ledger_index, pftl_transactions.ledger_index),
          tx_type = COALESCE(EXCLUDED.tx_type, pftl_transactions.tx_type),
          validated = COALESCE(EXCLUDED.validated, pftl_transactions.validated),
          account = COALESCE(EXCLUDED.account, pftl_transactions.account),
          destination = COALESCE(EXCLUDED.destination, pftl_transactions.destination),
          transaction_result = COALESCE(EXCLUDED.transaction_result, pftl_transactions.transaction_result),
          close_time = COALESCE(EXCLUDED.close_time, pftl_transactions.close_time),
          tx_json = EXCLUDED.tx_json,
          meta_json = COALESCE(EXCLUDED.meta_json, pftl_transactions.meta_json),
          updated_at = now()
      `,
      [
        mapped.txHash,
        mapped.ledgerIndex,
        mapped.txType,
        mapped.validated,
        mapped.account,
        mapped.destination,
        mapped.transactionResult,
        mapped.closeTime,
        mapped.txJson,
        mapped.metaJson,
      ]
    );

    if (wallet) {
      await runQuery(
        client,
        `
          INSERT INTO pftl_wallet_transactions (
            wallet_address,
            tx_hash,
            direction,
            counterparty_wallet,
            delivered_drops,
            fee_drops,
            ledger_index,
            close_time
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (wallet_address, tx_hash)
          DO UPDATE SET
            direction = COALESCE(EXCLUDED.direction, pftl_wallet_transactions.direction),
            counterparty_wallet = COALESCE(EXCLUDED.counterparty_wallet, pftl_wallet_transactions.counterparty_wallet),
            delivered_drops = COALESCE(EXCLUDED.delivered_drops, pftl_wallet_transactions.delivered_drops),
            fee_drops = COALESCE(EXCLUDED.fee_drops, pftl_wallet_transactions.fee_drops),
            ledger_index = COALESCE(EXCLUDED.ledger_index, pftl_wallet_transactions.ledger_index),
            close_time = COALESCE(EXCLUDED.close_time, pftl_wallet_transactions.close_time)
        `,
        [
          wallet,
          mapped.txHash,
          mapped.direction,
          mapped.counterpartyWallet,
          mapped.deliveredDrops,
          mapped.feeDrops,
          mapped.ledgerIndex,
          mapped.closeTime,
        ]
      );
    }

    const pointerRows = extractPointerMemosFromTransaction({
      txHash: mapped.txHash,
      tx: mapped.txJson,
      walletAddress: wallet,
    });
    for (const pointer of pointerRows) {
      await runQuery(
        client,
        `
          INSERT INTO pftl_pointer_memos (
            tx_hash,
            memo_index,
            wallet_address,
            memo_type,
            memo_format,
            pointer_kind,
            schema_version,
            cid,
            task_id,
            request_id,
            context_id,
            thread_id,
            memo_data_hex,
            decoded_json,
            decode_error
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (tx_hash, memo_index)
          DO UPDATE SET
            wallet_address = COALESCE(EXCLUDED.wallet_address, pftl_pointer_memos.wallet_address),
            memo_type = COALESCE(EXCLUDED.memo_type, pftl_pointer_memos.memo_type),
            memo_format = COALESCE(EXCLUDED.memo_format, pftl_pointer_memos.memo_format),
            pointer_kind = COALESCE(EXCLUDED.pointer_kind, pftl_pointer_memos.pointer_kind),
            schema_version = COALESCE(EXCLUDED.schema_version, pftl_pointer_memos.schema_version),
            cid = COALESCE(EXCLUDED.cid, pftl_pointer_memos.cid),
            task_id = COALESCE(EXCLUDED.task_id, pftl_pointer_memos.task_id),
            request_id = COALESCE(EXCLUDED.request_id, pftl_pointer_memos.request_id),
            context_id = COALESCE(EXCLUDED.context_id, pftl_pointer_memos.context_id),
            thread_id = COALESCE(EXCLUDED.thread_id, pftl_pointer_memos.thread_id),
            memo_data_hex = EXCLUDED.memo_data_hex,
            decoded_json = CASE
              WHEN EXCLUDED.decoded_json = '{}'::jsonb THEN pftl_pointer_memos.decoded_json
              ELSE EXCLUDED.decoded_json
            END,
            decode_error = EXCLUDED.decode_error
        `,
        [
          pointer.txHash,
          pointer.memoIndex,
          pointer.walletAddress,
          pointer.memoType,
          pointer.memoFormat,
          pointer.pointerKind,
          pointer.schemaVersion,
          pointer.cid,
          pointer.taskId,
          pointer.requestId,
          pointer.contextId,
          pointer.threadId,
          pointer.memoDataHex,
          pointer.decodedJson,
          pointer.decodeError,
        ]
      );
      pointerCount += 1;
      if (wallet) {
        await runQuery(
          client,
          `
            INSERT INTO pftl_pointer_observations (
              wallet_address,
              tx_hash,
              memo_index,
              account_id,
              wallet_role,
              direction,
              pointer_kind,
              cid,
              task_id,
              request_id,
              context_id,
              thread_id,
              source
            )
            SELECT
              $1,
              $2,
              $3,
              COALESCE(sw.account_id, ''),
              COALESCE(sw.role, ''),
              wt.direction,
              $4,
              $5,
              $6,
              $7,
              $8,
              $9,
              'pftl_cache_ingest'
            FROM (SELECT 1) seed
            LEFT JOIN pftl_sync_wallets sw ON sw.wallet_address = $1
            LEFT JOIN pftl_wallet_transactions wt
              ON wt.wallet_address = $1
             AND wt.tx_hash = $2
            ON CONFLICT (wallet_address, tx_hash, memo_index)
            DO UPDATE SET
              account_id = COALESCE(NULLIF(EXCLUDED.account_id, ''), pftl_pointer_observations.account_id),
              wallet_role = COALESCE(NULLIF(EXCLUDED.wallet_role, ''), pftl_pointer_observations.wallet_role),
              direction = COALESCE(EXCLUDED.direction, pftl_pointer_observations.direction),
              pointer_kind = COALESCE(EXCLUDED.pointer_kind, pftl_pointer_observations.pointer_kind),
              cid = COALESCE(EXCLUDED.cid, pftl_pointer_observations.cid),
              task_id = COALESCE(EXCLUDED.task_id, pftl_pointer_observations.task_id),
              request_id = COALESCE(EXCLUDED.request_id, pftl_pointer_observations.request_id),
              context_id = COALESCE(EXCLUDED.context_id, pftl_pointer_observations.context_id),
              thread_id = COALESCE(EXCLUDED.thread_id, pftl_pointer_observations.thread_id),
              source = EXCLUDED.source,
              updated_at = now()
          `,
          [
            wallet,
            pointer.txHash,
            pointer.memoIndex,
            pointer.pointerKind,
            pointer.cid,
            pointer.taskId,
            pointer.requestId,
            pointer.contextId,
            pointer.threadId,
          ]
        );
      }
    }

    inserted += 1;
    if (mapped.ledgerIndex !== null && (maxLedger === null || mapped.ledgerIndex > maxLedger)) {
      maxLedger = mapped.ledgerIndex;
      newestHash = mapped.txHash;
    }
  }

  return { inserted, pointerCount, maxLedger, newestHash };
}

export async function storePftlAccountTransactions({
  walletAddress = "",
  transactions = [],
  syncKind = "hot",
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  const wallet = normalizeText(walletAddress);
  return transaction(async (client) => {
    const result = await upsertPftlTransactionBatch({ walletAddress: wallet, transactions, client });
    const timestampColumn = syncKind === "archive" ? "last_archive_sync_at" : "last_hot_sync_at";
    await client.query(
      `
        UPDATE pftl_sync_wallets
        SET ${timestampColumn} = now(),
            last_seen_tx_hash = CASE
              WHEN $4 = 'archive' THEN COALESCE(last_seen_tx_hash, $2)
              ELSE COALESCE($2, last_seen_tx_hash)
            END,
            last_seen_ledger = CASE
              WHEN $4 = 'archive' THEN GREATEST(COALESCE(last_seen_ledger, $3), COALESCE($3, last_seen_ledger))
              ELSE COALESCE($3, last_seen_ledger)
            END,
            last_error = NULL,
            updated_at = now()
        WHERE wallet_address = $1
      `,
      [wallet, result.newestHash, result.maxLedger, normalizeText(syncKind)]
    );
    return { ok: true, ...result };
  });
}

export async function listCachedAccountTx({ walletAddress = "", limit = 100 } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, transactions: [] };
  const wallet = normalizeText(walletAddress);
  if (!wallet) return { ok: false, transactions: [] };
  const cappedLimit = Math.min(Math.max(Number(limit) || 100, 1), 400);
  const result = await query(
    `
      SELECT
        wt.wallet_address,
        wt.direction,
        wt.counterparty_wallet,
        t.tx_hash,
        t.ledger_index,
        t.tx_type,
        t.validated,
        t.close_time,
        t.tx_json,
        t.meta_json
      FROM pftl_wallet_transactions wt
      JOIN pftl_transactions t ON t.tx_hash = wt.tx_hash
      WHERE wt.wallet_address = $1
      ORDER BY wt.ledger_index DESC NULLS LAST, wt.close_time DESC NULLS LAST, wt.tx_hash DESC
      LIMIT $2
    `,
    [wallet, cappedLimit]
  );
  return {
    ok: true,
    walletAddress: wallet,
    transactions: result.rows.map((row) => ({
      tx: row.tx_json,
      tx_json: row.tx_json,
      meta: row.meta_json,
      meta_json: row.meta_json,
      hash: row.tx_hash,
      tx_hash: row.tx_hash,
      ledger_index: row.ledger_index,
      validated: row.validated,
      direction: row.direction,
      counterparty: row.counterparty_wallet,
      close_time_iso: normalizeIso(row.close_time),
    })),
  };
}

export async function getPftlSyncWallet({ walletAddress = "" } = {}) {
  if (!databaseEnabled()) return null;
  const wallet = normalizeText(walletAddress);
  if (!wallet) return null;
  const result = await query(
    `
      SELECT *
      FROM pftl_sync_wallets
      WHERE wallet_address = $1
      LIMIT 1
    `,
    [wallet]
  );
  return result.rows[0] || null;
}

export async function recordPftlSyncError({ walletAddress = "", error } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  const wallet = normalizeText(walletAddress);
  if (!wallet) return { ok: false };
  await query(
    `
      UPDATE pftl_sync_wallets
      SET last_error = $2,
          updated_at = now()
      WHERE wallet_address = $1
    `,
    [wallet, String(error?.message || error || "pftl_sync_failed").slice(0, 1000)]
  );
  return { ok: true };
}

export async function markPftlSyncWalletChecked({ walletAddress = "", previousTxnId = "" } = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  const wallet = normalizeText(walletAddress);
  const previous = normalizeText(previousTxnId);
  if (!wallet) return { ok: false };
  await query(
    `
      UPDATE pftl_sync_wallets
      SET last_checked_at = now(),
          last_hot_sync_at = now(),
          last_seen_tx_hash = COALESCE(NULLIF($2, ''), last_seen_tx_hash),
          last_error = NULL,
          metadata_json = metadata_json || $3::jsonb,
          updated_at = now()
      WHERE wallet_address = $1
    `,
    [wallet, previous, { previousTxnId: previous }]
  );
  return { ok: true };
}

export async function listPftlWalletsDueForHotSync({ limit = 5, staleMs = 60000 } = {}) {
  if (!databaseEnabled()) return [];
  const cappedLimit = Math.min(Math.max(Number(limit) || 5, 1), 50);
  const cappedStaleMs = Math.min(Math.max(Number(staleMs) || 60000, 1000), 86_400_000);
  const result = await query(
    `
      SELECT wallet_address, account_id, role, priority, last_seen_tx_hash, last_hot_sync_at
      FROM pftl_sync_wallets
      WHERE status = 'active'
        AND (
          last_hot_sync_at IS NULL
          OR last_hot_sync_at < now() - ($2 * INTERVAL '1 millisecond')
        )
      ORDER BY priority ASC, COALESCE(last_hot_sync_at, 'epoch'::timestamptz) ASC, updated_at DESC
      LIMIT $1
    `,
    [cappedLimit, cappedStaleMs]
  );
  return result.rows;
}

export async function listPftlWalletsDueForArchiveSync({ limit = 1, staleMs = 3_600_000 } = {}) {
  if (!databaseEnabled()) return [];
  const cappedLimit = clampInteger(limit, 1, 1, 20);
  const cappedStaleMs = clampInteger(staleMs, 3_600_000, 60_000, 7 * 86_400_000);
  const result = await query(
    `
      SELECT
        wallet_address,
        account_id,
        role,
        priority,
        archive_marker,
        last_archive_ledger,
        last_archive_sync_at
      FROM pftl_sync_wallets
      WHERE status = 'active'
        AND COALESCE(archive_marker @> '{"complete": true}'::jsonb, false) = false
        AND (
          last_archive_sync_at IS NULL
          OR last_archive_sync_at < now() - ($2 * INTERVAL '1 millisecond')
        )
      ORDER BY priority ASC, COALESCE(last_archive_sync_at, 'epoch'::timestamptz) ASC, updated_at DESC
      LIMIT $1
    `,
    [cappedLimit, cappedStaleMs]
  );
  return result.rows;
}

export async function recordPftlArchiveCheckpoint({
  walletAddress = "",
  marker = null,
  complete = false,
  lastArchiveLedger = null,
  scannedTransactions = 0,
  pages = 0,
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  const wallet = normalizeText(walletAddress);
  if (!wallet) return { ok: false };
  const checkpoint = {
    complete: Boolean(complete),
    marker: complete ? null : marker || null,
    scannedTransactions: intOrNull(scannedTransactions) ?? 0,
    pages: intOrNull(pages) ?? 0,
    updatedAt: new Date().toISOString(),
  };
  await query(
    `
      UPDATE pftl_sync_wallets
      SET archive_marker = $2,
          last_archive_sync_at = now(),
          last_archive_ledger = COALESCE($3, last_archive_ledger),
          last_error = NULL,
          updated_at = now()
      WHERE wallet_address = $1
    `,
    [wallet, checkpoint, intOrNull(lastArchiveLedger)]
  );
  return { ok: true, walletAddress: wallet, checkpoint };
}

export async function listActivePftlSyncWallets({ limit = 1000 } = {}) {
  if (!databaseEnabled()) return [];
  const cappedLimit = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
  const result = await query(
    `
      SELECT wallet_address, account_id, role, priority, last_seen_ledger, last_hot_sync_at
      FROM pftl_sync_wallets
      WHERE status = 'active'
      ORDER BY priority ASC, updated_at DESC, wallet_address ASC
      LIMIT $1
    `,
    [cappedLimit]
  );
  return result.rows;
}

function reducerKindForPointer(pointer = {}) {
  const kind = normalizeText(pointer?.pointer_kind || pointer).toUpperCase();
  if (kind === "CONTEXT") return "context_pointer_hydrate";
  if (TASK_POINTER_KINDS.has(kind) && !normalizeText(pointer?.task_id)) return "";
  if (TASK_POINTER_KINDS.has(kind)) return "task_projection_replay";
  return "";
}

function reducerDedupeKey({ walletAddress = "", txHash = "", reducerKind = "", memoIndex = null, cid = "" } = {}) {
  return [
    normalizeText(walletAddress),
    normalizeText(txHash),
    normalizeText(reducerKind),
    memoIndex === null || memoIndex === undefined ? -1 : intOrNull(memoIndex),
    normalizeText(cid),
  ].join("|");
}

export async function enqueuePftlReducerEventsForTransaction({
  walletAddress = "",
  accountId = "",
  txHash = "",
  ledgerIndex = null,
  transactionResult = "",
  source = "pftl_cache_watcher",
  payload = {},
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, inserted: 0 };
  const wallet = normalizeText(walletAddress);
  const hash = normalizeText(txHash);
  if (!wallet || !hash) return { ok: false, inserted: 0 };

  let inserted = 0;
  const balanceResult = await query(
    `
      INSERT INTO pftl_cache_reducer_events (
        dedupe_key,
        wallet_address,
        account_id,
        tx_hash,
        ledger_index,
        reducer_kind,
        source,
        payload_json
      )
      VALUES ($1,$2,$3,$4,$5,'wallet_balance_refresh',$6,$7)
      ON CONFLICT (dedupe_key)
      DO NOTHING
    `,
    [
      reducerDedupeKey({
        walletAddress: wallet,
        txHash: hash,
        reducerKind: "wallet_balance_refresh",
      }),
      wallet,
      normalizeText(accountId),
      hash,
      intOrNull(ledgerIndex),
      normalizeText(source) || "pftl_cache_watcher",
      safeJson(payload),
    ]
  );
  inserted += balanceResult.rowCount || 0;

  if (normalizeText(transactionResult) && normalizeText(transactionResult) !== "tesSUCCESS") {
    return { ok: true, inserted };
  }

  const pointerRows = await query(
    `
      SELECT
        memo_index,
        pointer_kind,
        cid,
        task_id,
        context_id,
        decoded_json
      FROM pftl_pointer_memos
      WHERE tx_hash = $1
        AND cid IS NOT NULL
        AND decode_error IS NULL
    `,
    [hash]
  );

  for (const pointer of pointerRows.rows) {
    const reducerKind = reducerKindForPointer(pointer);
    if (!reducerKind) continue;
    const pointerResult = await query(
      `
        INSERT INTO pftl_cache_reducer_events (
          dedupe_key,
          wallet_address,
          account_id,
          tx_hash,
          ledger_index,
          reducer_kind,
          pointer_kind,
          cid,
          task_id,
          context_id,
          memo_index,
          source,
          payload_json
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (dedupe_key)
        DO NOTHING
      `,
      [
        reducerDedupeKey({
          walletAddress: wallet,
          txHash: hash,
          reducerKind,
          memoIndex: pointer.memo_index,
          cid: pointer.cid,
        }),
        wallet,
        normalizeText(accountId),
        hash,
        intOrNull(ledgerIndex),
        reducerKind,
        pointer.pointer_kind || null,
        pointer.cid || null,
        pointer.task_id || null,
        pointer.context_id || null,
        intOrNull(pointer.memo_index),
        normalizeText(source) || "pftl_cache_watcher",
        {
          ...safeJson(payload),
          pointer: safeJson(pointer.decoded_json),
        },
      ]
    );
    inserted += pointerResult.rowCount || 0;
  }

  return { ok: true, inserted };
}

export async function recordPftlCacheWatcherState({
  id = "default",
  endpointUrl = "",
  status = "idle",
  subscribedWalletCount = 0,
  lastLedgerIndex = null,
  lastEventTxHash = "",
  lastError = "",
  metadata = {},
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true };
  await query(
    `
      INSERT INTO pftl_cache_watcher_state (
        id,
        endpoint_url,
        status,
        subscribed_wallet_count,
        last_ledger_index,
        last_event_tx_hash,
        last_event_at,
        last_error,
        metadata_json
      )
      VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6 = '' THEN NULL ELSE now() END,$7,$8)
      ON CONFLICT (id)
      DO UPDATE SET
        endpoint_url = EXCLUDED.endpoint_url,
        status = EXCLUDED.status,
        subscribed_wallet_count = EXCLUDED.subscribed_wallet_count,
        last_ledger_index = COALESCE(EXCLUDED.last_ledger_index, pftl_cache_watcher_state.last_ledger_index),
        last_event_tx_hash = COALESCE(NULLIF(EXCLUDED.last_event_tx_hash, ''), pftl_cache_watcher_state.last_event_tx_hash),
        last_event_at = COALESCE(EXCLUDED.last_event_at, pftl_cache_watcher_state.last_event_at),
        last_error = EXCLUDED.last_error,
        metadata_json = pftl_cache_watcher_state.metadata_json || EXCLUDED.metadata_json,
        updated_at = now()
    `,
    [
      normalizeText(id) || "default",
      normalizeText(endpointUrl),
      normalizeText(status) || "idle",
      intOrNull(subscribedWalletCount) ?? 0,
      intOrNull(lastLedgerIndex),
      normalizeText(lastEventTxHash),
      normalizeText(lastError),
      safeJson(metadata),
    ]
  );
  return { ok: true };
}
