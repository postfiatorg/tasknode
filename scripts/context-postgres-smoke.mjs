import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import {
  getContextDocument,
  getContextHistory,
  saveContextDocument,
  saveContextHistoryProjection,
} from "../server/repositories/context.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for context Postgres smoke.");
}
if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

await migrateDatabase();

const suffix = randomUUID().slice(0, 8);
const accountId = `acct_context_pg_smoke_${suffix}`;
const walletAddress = `rContextSmoke${suffix}`;
const privatePayload = "PRIVATE EVIDENCE TEXT MUST NOT BE STORED";

const initial = await getContextDocument({ accountId });
assert.equal(initial.revision, 0);
assert.equal(initial.canEdit, true);

const firstSave = await saveContextDocument({
  accountId,
  title: "Context smoke",
  body: "This account-scoped context works without a wallet.",
});
assert.equal(firstSave.ok, true);
assert.equal(firstSave.document.revision, 1);

const secondSave = await saveContextDocument({
  accountId,
  title: "Context smoke updated",
  body: "This revised context should survive server restarts via Postgres.",
});
assert.equal(secondSave.ok, true);
assert.equal(secondSave.document.revision, 2);

const duplicateSave = await saveContextDocument({
  accountId,
  title: "Context smoke updated",
  body: "This revised context should survive server restarts via Postgres.",
});
assert.equal(duplicateSave.ok, true);
assert.equal(duplicateSave.document.revision, 2);

const loaded = await getContextDocument({ accountId });
assert.equal(loaded.title, "Context smoke updated");
assert.equal(loaded.revision, 2);
assert.match(loaded.body, /survive server restarts/);

const unlinkedHistory = await getContextHistory({ accountId });
assert.equal(unlinkedHistory.pointerCount, 0);
assert.equal(unlinkedHistory.canHydrate, false);

const projected = await saveContextHistoryProjection({
  accountId,
  projection: {
    walletAddress,
    contextRevisions: [
      {
        id: "ctx-history-1",
        cid: "ipfs://bafyContextPostgresSmoke",
        tx_hash: "CTX_PG_SMOKE_TX",
        created_at: "2026-05-16T00:00:00.000Z",
        word_count: 42,
      },
    ],
    tasks: [
      {
        id: "task-history-1",
        title: "Task title metadata",
        status: "rewarded",
        verification_type: "text",
      },
    ],
    taskEvents: [
      {
        id: "task-event-1",
        task_id: "task-history-1",
        event_type: "submission_recorded",
        event_payload: JSON.stringify({
          artifact_cid: "ipfs://bafyEvidencePostgresSmoke",
          response_text: privatePayload,
        }),
        created_at: "2026-05-16T00:01:00.000Z",
      },
    ],
  },
});
assert.equal(projected.ok, true);
assert.equal(projected.history.contextUpdateCount, 1);
assert.equal(projected.history.taskEventCount, 1);

const replay = await saveContextHistoryProjection({
  accountId,
  projection: {
    walletAddress,
    contextRevisions: [
      {
        id: "ctx-history-1",
        cid: "ipfs://bafyContextPostgresSmoke",
        tx_hash: "CTX_PG_SMOKE_TX",
        created_at: "2026-05-16T00:00:00.000Z",
        word_count: 42,
      },
    ],
    taskEvents: [
      {
        id: "task-event-1",
        task_id: "task-history-1",
        event_type: "submission_recorded",
        event_payload: JSON.stringify({
          artifact_cid: "ipfs://bafyEvidencePostgresSmoke",
          response_text: privatePayload,
        }),
        created_at: "2026-05-16T00:01:00.000Z",
      },
    ],
  },
});
assert.equal(replay.history.pointerCount, 2);

const linkedHistory = await getContextHistory({ accountId, walletAddress });
assert.equal(linkedHistory.pointerCount, 2);
assert.equal(linkedHistory.contextUpdateCount, 1);
assert.equal(linkedHistory.taskEventCount, 1);
assert.equal(linkedHistory.latestContextPointer.cid, "bafyContextPostgresSmoke");
assert.equal(JSON.stringify(linkedHistory).includes(privatePayload), false);

const delinkedBoundaryHistory = await getContextHistory({ accountId });
const delinkedBoundaryDocument = await getContextDocument({ accountId });
assert.equal(delinkedBoundaryHistory.pointerCount, 0);
assert.equal(delinkedBoundaryHistory.canHydrate, false);
assert.equal(delinkedBoundaryDocument.revision, 2);
assert.match(delinkedBoundaryDocument.body, /survive server restarts/);

const otherWalletHistory = await getContextHistory({ accountId, walletAddress: `${walletAddress}Other` });
assert.equal(otherWalletHistory.pointerCount, 0);
assert.equal(otherWalletHistory.canHydrate, true);

const revisionCount = await query(
  "SELECT count(*)::integer AS count FROM context_revisions WHERE account_id = $1",
  [accountId]
);
const pointerCount = await query(
  "SELECT count(*)::integer AS count FROM context_history_pointers WHERE account_id = $1 AND wallet_address = $2",
  [accountId, walletAddress]
);
assert.equal(revisionCount.rows[0].count, 1);
assert.equal(pointerCount.rows[0].count, 2);

const publishReducerTx = `CTX_PUBLISH_REDUCER_${suffix}`;
const publishReducerCid = `bafyContextPublishReducer${suffix}`;
const publishTimestamp = "2026-05-16T12:00:00.000Z";
const ledgerTimestamp = "2026-05-16T12:05:00.000Z";

await saveContextHistoryProjection({
  accountId,
  projection: {
    source: "tasknodeofficial_context_publish",
    walletAddress,
    contextRevisions: [
      {
        id: `pftl:${publishReducerTx}:0`,
        cid: publishReducerCid,
        tx_hash: publishReducerTx,
        tx_timestamp: publishTimestamp,
        memo_index: 0,
        context_version: "draft-revision-99",
        source: "pftl_cache.context_publish",
        word_count: 11,
      },
    ],
  },
});

await saveContextHistoryProjection({
  accountId,
  projection: {
    source: "pftl_cache.context_pointer",
    walletAddress,
    contextRevisions: [
      {
        id: `pftl:${publishReducerTx}:0`,
        cid: publishReducerCid,
        tx_hash: publishReducerTx,
        tx_timestamp: ledgerTimestamp,
        ledger_index: 424242,
        memo_index: 0,
        context_version: "pf.context.v1",
        source: "pftl_cache.context_pointer",
        word_count: 24,
      },
    ],
  },
});

const publishReducerRow = await query(
  `
    SELECT pointer_created_at, version, word_count, source, ledger_index
    FROM context_history_pointers
    WHERE account_id = $1
      AND wallet_address = $2
      AND tx_hash = $3
  `,
  [accountId, walletAddress, publishReducerTx]
);
assert.equal(publishReducerRow.rows.length, 1);
assert.equal(publishReducerRow.rows[0].source, "pftl_cache.context_pointer");
assert.equal(publishReducerRow.rows[0].version, "pf.context.v1");
assert.equal(Number(publishReducerRow.rows[0].word_count), 24);
assert.equal(String(publishReducerRow.rows[0].ledger_index), "424242");
assert.equal(new Date(publishReducerRow.rows[0].pointer_created_at).toISOString(), ledgerTimestamp);

console.log(`context postgres smoke ok: ${accountId}`);
await closePool();
