import { randomUUID } from "node:crypto";
import { databaseEnabled, query as defaultQuery, transaction as defaultTransaction } from "../db/pool.js";

function safeText(value = "", max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function clampMs(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

function rowToPoolObject(row) {
  if (!row) return null;
  return {
    objectId: row.object_id,
    valueAtoms: BigInt(row.value_atoms),
    version: Number(row.version),
    nonce: Number(row.nonce),
    leasedBy: row.leased_by_payout_id || null,
    leaseToken: row.lease_token || "",
  };
}

function rowToPayout(row) {
  if (!row) return null;
  const record = row.record_json && typeof row.record_json === "object" ? row.record_json : {};
  return {
    ...record,
    payoutId: row.payout_id,
    taskId: row.task_id || record.taskId || "",
    lane: row.lane || record.lane || "fastpay",
    status: row.status,
    objectId: row.object_id,
    objectVersion: Number(row.object_version),
    orderHash: row.order_hash,
    lockId: row.lock_id || record.lockId || "",
    fallbackAttemptId: row.fallback_attempt_id || record.fallbackAttemptId || null,
    fallbackTxHash: row.fallback_tx_hash || record.fallbackTxHash || null,
    cid: row.cid || record.cid || "",
    rawEnvelopeHex: row.raw_envelope_hex || record.rawEnvelopeHex || "",
    lastError: row.last_error || record.lastError || "",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ""),
  };
}

function rowToPinJob(row) {
  if (!row) return null;
  return {
    payoutId: row.payout_id,
    cid: row.cid,
    rawEnvelopeHex: row.raw_envelope_hex,
    taskId: row.task_id || "",
    schema: row.schema_name || "pf.reward.v1",
    status: row.status,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || "",
    nextAttemptAt: row.next_attempt_at,
    claimedBy: row.claimed_by || "",
    claimedAt: row.claimed_at,
    pinnedAt: row.pinned_at,
  };
}

function makePoolAdapter(pool) {
  if (!pool) {
    return {
      query: defaultQuery,
      transaction: defaultTransaction,
      isEnabled: databaseEnabled,
    };
  }
  return {
    query: (text, params = []) => pool.query(text, params),
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve original error.
        }
        throw error;
      } finally {
        client.release();
      }
    },
    isEnabled: () => true,
  };
}

export class PostgresFastPayPayoutStore {
  constructor({
    pool = null,
    leaseTtlMs = 60_000,
    staleSubmitMs = 30_000,
  } = {}) {
    this.durable = true;
    this.db = makePoolAdapter(pool);
    this.leaseTtlMs = clampMs(leaseTtlMs, 60_000, 100, 3_600_000);
    this.staleSubmitMs = clampMs(staleSubmitMs, 30_000, 0, 3_600_000);
  }

  assertDatabaseReady() {
    if (!this.db.isEnabled()) {
      throw new Error("fastpay_postgres_store_database_disabled");
    }
  }

  async seedObjects(objects = []) {
    this.assertDatabaseReady();
    if (!Array.isArray(objects) || objects.length === 0) return { inserted: 0 };
    return this.db.transaction(async (client) => {
      let inserted = 0;
      for (const obj of objects) {
        const objectId = safeText(obj?.objectId, 200);
        const valueAtoms = BigInt(obj?.valueAtoms ?? 0n);
        const version = Number(obj?.version ?? 0);
        const nonce = Number(obj?.nonce ?? 0);
        if (!objectId || valueAtoms <= 0n || !Number.isSafeInteger(version) || version < 0) {
          throw new Error("fastpay_invalid_pool_object");
        }
        const res = await client.query(
          `
            INSERT INTO l1_fastpay_payout_objects (
              object_id, version, value_atoms, nonce, status
            )
            VALUES ($1, $2, $3, $4, 'available')
            ON CONFLICT (object_id, version) DO NOTHING
          `,
          [objectId, version, valueAtoms.toString(), nonce]
        );
        inserted += res.rowCount || 0;
      }
      return { inserted };
    });
  }

  async listPoolObjects() {
    this.assertDatabaseReady();
    const res = await this.db.query(
      `
        SELECT *
        FROM l1_fastpay_payout_objects
        ORDER BY object_id ASC, version ASC
      `
    );
    return res.rows.map((row) => ({
      ...rowToPoolObject(row),
      status: row.status,
      spentBy: row.spent_by_payout_id || null,
    }));
  }

  async getPayout(payoutId) {
    this.assertDatabaseReady();
    const id = safeText(payoutId, 180);
    if (!id) return null;
    const res = await this.db.query(
      "SELECT * FROM l1_fastpay_payouts WHERE payout_id = $1",
      [id]
    );
    return rowToPayout(res.rows[0]);
  }

  async leaseObject({ payoutId, minAtoms, ownerToken = "" } = {}) {
    this.assertDatabaseReady();
    const id = safeText(payoutId, 180);
    const needed = BigInt(minAtoms ?? 0n);
    const token = safeText(ownerToken, 120) || `lease_${randomUUID()}`;
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('tasknode:fastpay:payout'), hashtext($1))",
        [id]
      );

      const persisted = await client.query(
        "SELECT * FROM l1_fastpay_payouts WHERE payout_id = $1",
        [id]
      );
      if (persisted.rows[0]) {
        return { alreadyPersisted: true, existingPayout: rowToPayout(persisted.rows[0]) };
      }

      const held = await client.query(
        `
          SELECT *,
            (leased_at IS NOT NULL AND leased_at > now() - ($2::text || ' milliseconds')::interval) AS lease_fresh
          FROM l1_fastpay_payout_objects
          WHERE status = 'leased' AND leased_by_payout_id = $1
          FOR UPDATE
        `,
        [id, String(this.leaseTtlMs)]
      );
      if (held.rows[0]) {
        const row = held.rows[0];
        if (row.lease_fresh && row.lease_token && row.lease_token !== token) {
          const error = new Error("fastpay_payout_in_progress");
          error.submissionAttempted = false;
          error.retryable = true;
          throw error;
        }
        const reclaimed = await client.query(
          `
            UPDATE l1_fastpay_payout_objects
            SET lease_token = $3, leased_at = now(), updated_at = now()
            WHERE object_id = $1 AND version = $2
            RETURNING *
          `,
          [row.object_id, row.version, token]
        );
        return rowToPoolObject(reclaimed.rows[0]);
      }

      const candidate = await client.query(
        `
          SELECT object_id, version
          FROM l1_fastpay_payout_objects
          WHERE status = 'available' AND value_atoms >= $1
          ORDER BY value_atoms ASC, object_id ASC, version ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
        [needed.toString()]
      );
      if (!candidate.rows[0]) return null;

      const updated = await client.query(
        `
          UPDATE l1_fastpay_payout_objects
          SET
            status = 'leased',
            leased_by_payout_id = $3,
            lease_token = $4,
            leased_at = now(),
            updated_at = now()
          WHERE object_id = $1 AND version = $2 AND status = 'available'
          RETURNING *
        `,
        [candidate.rows[0].object_id, candidate.rows[0].version, id, token]
      );
      return rowToPoolObject(updated.rows[0]);
    });
  }

  async commitPreparedPayout(payoutId, record, { pinOutbox = null } = {}) {
    this.assertDatabaseReady();
    const id = safeText(payoutId, 180);
    return this.db.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('tasknode:fastpay:payout'), hashtext($1))",
        [id]
      );

      const existing = await client.query(
        "SELECT * FROM l1_fastpay_payouts WHERE payout_id = $1 FOR UPDATE",
        [id]
      );
      if (existing.rows[0]) {
        return { created: false, payout: rowToPayout(existing.rows[0]) };
      }

      const leased = await client.query(
        `
          SELECT *
          FROM l1_fastpay_payout_objects
          WHERE object_id = $1 AND version = $2 AND status = 'leased' AND leased_by_payout_id = $3
          FOR UPDATE
        `,
        [record.objectId, Number(record.objectVersion || 0), id]
      );
      if (!leased.rows[0]) {
        const error = new Error("fastpay_object_lease_lost");
        error.submissionAttempted = false;
        throw error;
      }

      const inserted = await client.query(
        `
          INSERT INTO l1_fastpay_payouts (
            payout_id, task_id, lane, status, object_id, object_version,
            order_hash, lock_id, cid, raw_envelope_hex, record_json
          )
          VALUES ($1, $2, $3, 'order_persisted', $4, $5, $6, $7, $8, $9, $10::jsonb)
          RETURNING *
        `,
        [
          id,
          safeText(record.taskId, 180),
          safeText(record.lane || "fastpay", 40),
          record.objectId,
          Number(record.objectVersion || 0),
          safeText(record.orderHash, 128).toLowerCase(),
          safeText(record.lockId, 128).toLowerCase(),
          safeText(record.cid, 240),
          safeText(record.rawEnvelopeHex, 2_200_000),
          JSON.stringify(record),
        ]
      );

      if (pinOutbox?.cid && pinOutbox?.rawEnvelopeHex) {
        await client.query(
          `
            INSERT INTO l1_fastpay_pin_outbox (
              payout_id, cid, raw_envelope_hex, task_id, schema_name, status
            )
            VALUES ($1, $2, $3, $4, $5, 'queued')
            ON CONFLICT (payout_id) DO NOTHING
          `,
          [
            id,
            safeText(pinOutbox.cid, 240),
            safeText(pinOutbox.rawEnvelopeHex, 2_200_000),
            safeText(pinOutbox.taskId || record.taskId, 180),
            safeText(pinOutbox.schema || "pf.reward.v1", 120),
          ]
        );
      }

      return { created: true, payout: rowToPayout(inserted.rows[0]) };
    });
  }

  async claimSubmission(payoutId, workerToken = "") {
    this.assertDatabaseReady();
    const id = safeText(payoutId, 180);
    const token = safeText(workerToken, 120) || `sub_${randomUUID()}`;
    return this.db.transaction(async (client) => {
      const current = await client.query(
        `
          SELECT *,
            (
              active_worker_claimed_at IS NOT NULL
              AND active_worker_claimed_at > now() - ($2::text || ' milliseconds')::interval
            ) AS claim_fresh
          FROM l1_fastpay_payouts
          WHERE payout_id = $1
          FOR UPDATE
        `,
        [id, String(this.staleSubmitMs)]
      );
      const row = current.rows[0];
      if (!row) return { claimed: false, reason: "missing", payout: null };
      if (row.status === "confirmed" || row.status === "fallback_unknown") {
        return { claimed: false, reason: row.status, payout: rowToPayout(row) };
      }
      if (row.status === "submitting" && row.claim_fresh && row.active_worker_token && row.active_worker_token !== token) {
        return { claimed: false, reason: "in_progress", payout: rowToPayout(row) };
      }
      const updated = await client.query(
        `
          UPDATE l1_fastpay_payouts
          SET
            status = 'submitting',
            active_worker_token = $2,
            active_worker_claimed_at = now(),
            record_json = record_json || jsonb_build_object('status', 'submitting'),
            updated_at = now()
          WHERE payout_id = $1
          RETURNING *
        `,
        [id, token]
      );
      return { claimed: true, workerToken: token, payout: rowToPayout(updated.rows[0]) };
    });
  }

  async savePayout(payoutId, record) {
    this.assertDatabaseReady();
    const id = safeText(payoutId, 180);
    const clearClaim = ["confirmed", "submit_unknown", "fallback_unknown"].includes(record.status);
    const res = await this.db.query(
      `
        UPDATE l1_fastpay_payouts
        SET
          lane = $2,
          status = $3,
          fallback_attempt_id = COALESCE($4, fallback_attempt_id),
          fallback_tx_hash = COALESCE($5, fallback_tx_hash),
          last_error = $6,
          active_worker_token = CASE WHEN $7::boolean THEN '' ELSE active_worker_token END,
          active_worker_claimed_at = CASE WHEN $7::boolean THEN NULL ELSE active_worker_claimed_at END,
          record_json = $8::jsonb,
          updated_at = now()
        WHERE payout_id = $1
        RETURNING *
      `,
      [
        id,
        safeText(record.lane || "fastpay", 40),
        safeText(record.status, 40),
        record.fallbackAttemptId ? safeText(record.fallbackAttemptId, 180) : null,
        record.fallbackTxHash ? safeText(record.fallbackTxHash, 128).toLowerCase() : null,
        safeText(record.lastError, 1000),
        clearClaim,
        JSON.stringify(record),
      ]
    );
    return rowToPayout(res.rows[0]);
  }

  async confirmPayout({ payoutId, record, objectId, objectVersion, changeObject = null } = {}) {
    this.assertDatabaseReady();
    const id = safeText(payoutId, 180);
    return this.db.transaction(async (client) => {
      await client.query(
        `
          UPDATE l1_fastpay_payout_objects
          SET
            status = 'spent',
            leased_by_payout_id = NULL,
            lease_token = '',
            leased_at = NULL,
            spent_by_payout_id = $3,
            updated_at = now()
          WHERE object_id = $1 AND version = $2 AND leased_by_payout_id = $3
        `,
        [objectId, Number(objectVersion || 0), id]
      );
      if (changeObject && BigInt(changeObject.valueAtoms || 0n) > 0n) {
        await client.query(
          `
            INSERT INTO l1_fastpay_payout_objects (
              object_id, version, value_atoms, nonce, status
            )
            VALUES ($1, $2, $3, $4, 'available')
            ON CONFLICT (object_id, version) DO NOTHING
          `,
          [
            safeText(changeObject.objectId, 200),
            Number(changeObject.version || 0),
            BigInt(changeObject.valueAtoms).toString(),
            Number(changeObject.nonce || 0),
          ]
        );
      }
      const updated = await client.query(
        `
          UPDATE l1_fastpay_payouts
          SET
            lane = $2,
            status = 'confirmed',
            fallback_tx_hash = COALESCE($3, fallback_tx_hash),
            active_worker_token = '',
            active_worker_claimed_at = NULL,
            last_error = '',
            record_json = $4::jsonb,
            updated_at = now()
          WHERE payout_id = $1
          RETURNING *
        `,
        [
          id,
          safeText(record.lane || "fastpay", 40),
          record.receipt?.lane === "consensus_pft" ? safeText(record.receipt.txHash, 128).toLowerCase() : null,
          JSON.stringify({ ...record, status: "confirmed" }),
        ]
      );
      return rowToPayout(updated.rows[0]);
    });
  }

  async beginConsensusFallback({
    payoutId,
    record,
    objectId,
    objectVersion,
    recoveredObject,
    cancellationKind,
    fallbackAttemptId,
  } = {}) {
    this.assertDatabaseReady();
    const id = safeText(payoutId, 180);
    const attemptId = safeText(fallbackAttemptId, 180) || `fp_fb_${randomUUID()}`;
    return this.db.transaction(async (client) => {
      await client.query(
        `
          UPDATE l1_fastpay_payout_objects
          SET
            status = 'retired',
            leased_by_payout_id = NULL,
            lease_token = '',
            leased_at = NULL,
            updated_at = now()
          WHERE object_id = $1 AND version = $2 AND leased_by_payout_id = $3
        `,
        [objectId, Number(objectVersion || 0), id]
      );
      if (recoveredObject && BigInt(recoveredObject.valueAtoms || 0n) > 0n) {
        await client.query(
          `
            INSERT INTO l1_fastpay_payout_objects (
              object_id, version, value_atoms, nonce, status
            )
            VALUES ($1, $2, $3, $4, 'available')
            ON CONFLICT (object_id, version) DO NOTHING
          `,
          [
            safeText(recoveredObject.objectId, 200),
            Number(recoveredObject.version || 0),
            BigInt(recoveredObject.valueAtoms).toString(),
            Number(recoveredObject.nonce || 0),
          ]
        );
      }
      const nextRecord = {
        ...record,
        lane: "consensus_pft",
        status: "fallback_unknown",
        cancellation: cancellationKind,
        fallbackAttemptId: attemptId,
      };
      const updated = await client.query(
        `
          UPDATE l1_fastpay_payouts
          SET
            lane = 'consensus_pft',
            status = 'fallback_unknown',
            fallback_attempt_id = COALESCE(fallback_attempt_id, $2),
            active_worker_token = '',
            active_worker_claimed_at = NULL,
            record_json = $3::jsonb,
            updated_at = now()
          WHERE payout_id = $1
          RETURNING *
        `,
        [id, attemptId, JSON.stringify(nextRecord)]
      );
      return rowToPayout(updated.rows[0]);
    });
  }

  async completeObjectLease({ objectId, objectVersion = null, payoutId, changeObject = null } = {}) {
    this.assertDatabaseReady();
    return this.db.transaction(async (client) => {
      if (objectVersion !== null && objectVersion !== undefined) {
        await client.query(
          `
            UPDATE l1_fastpay_payout_objects
            SET status = 'spent', leased_by_payout_id = NULL, lease_token = '', leased_at = NULL,
                spent_by_payout_id = $3, updated_at = now()
            WHERE object_id = $1 AND version = $2 AND leased_by_payout_id = $3
          `,
          [objectId, Number(objectVersion), payoutId]
        );
      } else {
        await client.query(
          `
            UPDATE l1_fastpay_payout_objects
            SET status = 'spent', leased_by_payout_id = NULL, lease_token = '', leased_at = NULL,
                spent_by_payout_id = $2, updated_at = now()
            WHERE object_id = $1 AND status = 'leased' AND leased_by_payout_id = $2
          `,
          [objectId, payoutId]
        );
      }
      if (changeObject && BigInt(changeObject.valueAtoms || 0n) > 0n) {
        await client.query(
          `
            INSERT INTO l1_fastpay_payout_objects (
              object_id, version, value_atoms, nonce, status
            )
            VALUES ($1, $2, $3, $4, 'available')
            ON CONFLICT (object_id, version) DO NOTHING
          `,
          [
            safeText(changeObject.objectId, 200),
            Number(changeObject.version || 0),
            BigInt(changeObject.valueAtoms).toString(),
            Number(changeObject.nonce || 0),
          ]
        );
      }
    });
  }

  async releaseObjectLease({ objectId, objectVersion = null, payoutId, replaceObject = null } = {}) {
    this.assertDatabaseReady();
    return this.db.transaction(async (client) => {
      const targetFilter = objectVersion !== null && objectVersion !== undefined
        ? { sql: "object_id = $1 AND version = $2 AND leased_by_payout_id = $3", params: [objectId, Number(objectVersion), payoutId] }
        : { sql: "object_id = $1 AND status = 'leased' AND leased_by_payout_id = $2", params: [objectId, payoutId] };
      if (replaceObject) {
        await client.query(
          `
            UPDATE l1_fastpay_payout_objects
            SET status = 'retired', leased_by_payout_id = NULL, lease_token = '', leased_at = NULL, updated_at = now()
            WHERE ${targetFilter.sql}
          `,
          targetFilter.params
        );
        await client.query(
          `
            INSERT INTO l1_fastpay_payout_objects (
              object_id, version, value_atoms, nonce, status
            )
            VALUES ($1, $2, $3, $4, 'available')
            ON CONFLICT (object_id, version) DO NOTHING
          `,
          [
            safeText(replaceObject.objectId, 200),
            Number(replaceObject.version || 0),
            BigInt(replaceObject.valueAtoms).toString(),
            Number(replaceObject.nonce || 0),
          ]
        );
      } else {
        await client.query(
          `
            UPDATE l1_fastpay_payout_objects
            SET status = 'available', leased_by_payout_id = NULL, lease_token = '', leased_at = NULL, updated_at = now()
            WHERE ${targetFilter.sql}
          `,
          targetFilter.params
        );
      }
    });
  }

  async getPinOutboxJob(payoutId) {
    this.assertDatabaseReady();
    const res = await this.db.query(
      "SELECT * FROM l1_fastpay_pin_outbox WHERE payout_id = $1",
      [safeText(payoutId, 180)]
    );
    return rowToPinJob(res.rows[0]);
  }

  async markPinOutboxPinned({ payoutId } = {}) {
    this.assertDatabaseReady();
    const res = await this.db.query(
      `
        UPDATE l1_fastpay_pin_outbox
        SET
          status = 'pinned',
          attempts = GREATEST(attempts, 1),
          last_error = '',
          claimed_by = '',
          claimed_at = NULL,
          pinned_at = now(),
          updated_at = now()
        WHERE payout_id = $1
        RETURNING *
      `,
      [safeText(payoutId, 180)]
    );
    return rowToPinJob(res.rows[0]);
  }

  async markPinOutboxFailed({ payoutId, error = "pin_failed", retryDelayMs = 5_000, maxAttempts = 20 } = {}) {
    this.assertDatabaseReady();
    const delayMs = clampMs(retryDelayMs, 5_000, 0, 3_600_000);
    const max = Math.max(1, Number(maxAttempts) || 20);
    const res = await this.db.query(
      `
        UPDATE l1_fastpay_pin_outbox
        SET
          attempts = CASE WHEN claimed_at IS NULL THEN attempts + 1 ELSE attempts END,
          status = CASE WHEN (CASE WHEN claimed_at IS NULL THEN attempts + 1 ELSE attempts END) >= $3::integer THEN 'failed' ELSE 'retry_wait' END,
          last_error = $2,
          next_attempt_at = now() + ($4::text || ' milliseconds')::interval,
          claimed_by = '',
          claimed_at = NULL,
          updated_at = now()
        WHERE payout_id = $1 AND status <> 'pinned'
        RETURNING *
      `,
      [safeText(payoutId, 180), safeText(error, 1000), max, String(delayMs)]
    );
    return rowToPinJob(res.rows[0]);
  }

  async claimDuePinOutboxJobs({ workerId = `fastpay_pin_${process.pid}`, limit = 10, staleClaimMs = 60_000 } = {}) {
    this.assertDatabaseReady();
    const bounded = Math.min(100, Math.max(1, Number(limit) || 10));
    const staleMs = clampMs(staleClaimMs, 60_000, 0, 3_600_000);
    const res = await this.db.query(
      `
        UPDATE l1_fastpay_pin_outbox
        SET
          status = 'pinning',
          claimed_by = $1,
          claimed_at = now(),
          attempts = attempts + 1,
          updated_at = now()
        WHERE payout_id IN (
          SELECT payout_id
          FROM l1_fastpay_pin_outbox
          WHERE
            (status IN ('queued', 'retry_wait') AND next_attempt_at <= now())
            OR (status = 'pinning' AND claimed_at < now() - ($2::text || ' milliseconds')::interval)
          ORDER BY created_at ASC, payout_id ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `,
      [safeText(workerId, 160), String(staleMs), bounded]
    );
    return res.rows.map(rowToPinJob);
  }
}

export async function drainFastPayPinOutbox({
  store,
  pinEnvelope,
  workerId = `fastpay_pin_${process.pid}`,
  limit = 10,
  staleClaimMs = 60_000,
  retryDelayMs = 5_000,
} = {}) {
  if (!store || typeof store.claimDuePinOutboxJobs !== "function") {
    throw new Error("fastpay_pin_outbox_store_required");
  }
  if (typeof pinEnvelope !== "function") {
    throw new Error("fastpay_pin_envelope_fn_required");
  }
  const jobs = await store.claimDuePinOutboxJobs({ workerId, limit, staleClaimMs });
  const results = [];
  for (const job of jobs) {
    try {
      const res = await pinEnvelope({
        rawEnvelopeBytes: Buffer.from(job.rawEnvelopeHex, "hex"),
        cid: job.cid,
        taskId: job.taskId,
        payoutId: job.payoutId,
        schema: job.schema,
      });
      if (res && res.ok === false) {
        throw new Error(safeText(res.error || "pin_returned_not_ok", 500));
      }
      const updated = await store.markPinOutboxPinned({ payoutId: job.payoutId });
      results.push({ ok: true, payoutId: job.payoutId, cid: job.cid, job: updated });
    } catch (error) {
      const updated = await store.markPinOutboxFailed({
        payoutId: job.payoutId,
        error: error?.message || "pin_failed",
        retryDelayMs,
      });
      results.push({ ok: false, payoutId: job.payoutId, cid: job.cid, error: error?.message || "pin_failed", job: updated });
    }
  }
  return { claimed: jobs.length, pinned: results.filter((r) => r.ok).length, results };
}
