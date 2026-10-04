import assert from "node:assert/strict";
import { claimPftlReducerEvents } from "../server/pftl-cache-reducer.js";

// Keyless smoke: drives claimPftlReducerEvents against an in-memory recording
// pg client (no Postgres, no env vars) and proves that a claim pass re-drives
// status='failed' reducer rows back to 'pending' on a bounded, renewable
// backoff. On the unmodified tree the claim only resets 'processing' rows, so
// no failed-row re-drive is issued and this smoke fails; on the fixed tree the
// re-drive UPDATE is present and it passes.

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

function recordingClient({ claimedRows = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const normalized = normalizeSql(sql);
      calls.push({ sql: normalized, raw: String(sql), params });
      // The claim step is the only statement that returns rows to the caller.
      if (normalized.includes("returning *")) {
        return { rows: claimedRows, rowCount: claimedRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function fakeTransaction(client) {
  return async (work) => work(client);
}

// 1) The disabled-database guard still short-circuits with no work.
{
  const client = recordingClient();
  const rows = await claimPftlReducerEvents({
    transactionImpl: fakeTransaction(client),
    databaseEnabledImpl: () => false,
  });
  assert.deepEqual(rows, [], "disabled database must claim nothing");
  assert.equal(client.calls.length, 0, "disabled database must issue no queries");
}

// 2) An enabled claim pass must re-drive failed rows and still return claims.
{
  const claimedRows = [{ id: 1, task_id: "task_retry", status: "processing", attempts: 1 }];
  const client = recordingClient({ claimedRows });
  const rows = await claimPftlReducerEvents({
    transactionImpl: fakeTransaction(client),
    databaseEnabledImpl: () => true,
  });
  assert.deepEqual(rows, claimedRows, "claim must return the claimed rows");

  const redrive = client.calls.find(
    (call) =>
      call.sql.includes("update pftl_cache_reducer_events") &&
      call.sql.includes("where status = 'failed'") &&
      call.sql.includes("set status = 'pending'")
  );
  assert.ok(
    redrive,
    "claim pass must re-drive status='failed' rows back to 'pending' (missing on the unmodified tree)"
  );

  // Bounded: the re-drive caps the number of attempts so a genuinely poison
  // row eventually stops instead of being retried forever.
  assert.match(
    redrive.sql,
    /attempts < \$\d/,
    "re-drive must cap attempts so a poison row is bounded"
  );

  // Renewable + no hot-loop: the eligibility window grows with attempts
  // (least/greatest over attempts) rather than re-driving immediately.
  assert.ok(
    redrive.sql.includes("least(") &&
      redrive.sql.includes("greatest(") &&
      redrive.sql.includes("attempts *"),
    "re-drive must gate on a backoff window that grows with attempts"
  );
  assert.ok(
    redrive.sql.includes("updated_at < now()"),
    "re-drive must only reconsider rows whose backoff window has elapsed"
  );

  // Params must express a finite cap and a min<=max backoff band.
  const [maxAttempts, maxBackoff, minBackoff] = redrive.params;
  assert.ok(
    Number.isFinite(maxAttempts) && maxAttempts > 0,
    "attempt cap must be a finite positive number"
  );
  assert.ok(
    Number.isFinite(minBackoff) &&
      Number.isFinite(maxBackoff) &&
      minBackoff > 0 &&
      minBackoff <= maxBackoff,
    "backoff band must be positive with min <= max"
  );

  // The failed re-drive must run in addition to the pre-existing
  // processing-timeout reset, never in place of it.
  const timeoutReset = client.calls.find(
    (call) =>
      call.sql.includes("where status = 'processing'") &&
      call.sql.includes("set status = 'pending'")
  );
  assert.ok(timeoutReset, "processing-timeout reset must still run");
}

console.log("pftl-cache-failed-retry-smoke: ok");
