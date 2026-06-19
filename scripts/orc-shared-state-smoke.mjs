import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrateJs = await readFile(new URL("../server/db/migrate.js", import.meta.url), "utf8");
const migration062 = await readFile(
  new URL("../server/db/migrations/062_orc_agents_and_activity.sql", import.meta.url),
  "utf8"
);
const migration063 = await readFile(
  new URL("../server/db/migrations/063_orc_task_reviews.sql", import.meta.url),
  "utf8"
);
const migration064 = await readFile(
  new URL("../server/db/migrations/064_orc_review_queue_public_items.sql", import.meta.url),
  "utf8"
);
const migration065 = await readFile(
  new URL("../server/db/migrations/065_network_task_status_packets.sql", import.meta.url),
  "utf8"
);
const reviewStatePy = await readFile(
  new URL("../reference_clients/python/orc_tooling/review_state.py", import.meta.url),
  "utf8"
);
const nazgulPy = await readFile(
  new URL("../reference_clients/python/orc_tooling/nazgul.py", import.meta.url),
  "utf8"
);

assert.match(migrateJs, /062_orc_agents_and_activity\.sql/);
assert.match(migrateJs, /063_orc_task_reviews\.sql/);
assert.match(migrateJs, /064_orc_review_queue_public_items\.sql/);
assert.match(migrateJs, /065_network_task_status_packets\.sql/);
assert.ok(
  migrateJs.indexOf("062_orc_agents_and_activity.sql") < migrateJs.indexOf("063_orc_task_reviews.sql"),
  "orc task review history migration must run after the shared state base migration"
);
assert.ok(
  migrateJs.indexOf("063_orc_task_reviews.sql") < migrateJs.indexOf("064_orc_review_queue_public_items.sql"),
  "public review item ingestion must run after the review-state/history tables"
);
assert.ok(
  migrateJs.indexOf("064_orc_review_queue_public_items.sql") < migrateJs.indexOf("065_network_task_status_packets.sql"),
  "network task status packets must run after public review item ingestion"
);

for (const table of ["orc_run_journal", "orc_operator_interactions"]) {
  assert.match(migration062, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(migration062, new RegExp(`CREATE INDEX IF NOT EXISTS ${table}`));
  assert.match(nazgulPy, new RegExp(`"${table}"`));
}

assert.match(migration063, /CREATE TABLE IF NOT EXISTS orc_task_reviews/);
assert.match(migration063, /CREATE INDEX IF NOT EXISTS orc_task_reviews_task_idx/);
assert.match(migration063, /CREATE INDEX IF NOT EXISTS orc_task_reviews_reviewer_idx/);
assert.match(migration063, /INSERT INTO orc_task_reviews/);
assert.match(migration063, /FROM orc_task_review_states/);
assert.match(migration064, /CREATE TABLE IF NOT EXISTS orc_task_review_items/);
assert.match(migration064, /source_mode.*local_projection/s);
assert.match(migration064, /directory_public/);
assert.match(migration064, /FROM orc_task_review_items item/);
assert.match(migration064, /LEFT JOIN orc_task_review_states s/);
assert.match(migration065, /network_status_packet/);
assert.match(migration065, /pf\.task_node\.network_task_status_packet\.v1/);
assert.match(migration065, /status_packet_json/);
assert.match(migration065, /closed_zero/);
assert.match(migration065, /repairRequired/);

assert.match(reviewStatePy, /CREATE TABLE IF NOT EXISTS orc_task_reviews/);
assert.match(reviewStatePy, /CREATE TABLE IF NOT EXISTS orc_task_review_items/);
assert.match(reviewStatePy, /INSERT INTO orc_task_reviews/);
assert.match(reviewStatePy, /FROM orc_task_review_items item/);
assert.match(reviewStatePy, /network_status_packet/);
assert.match(reviewStatePy, /status_packet_json/);
assert.match(reviewStatePy, /closed_zero/);
assert.match(reviewStatePy, /historyTable.*orc_task_reviews/s);

console.log("orc-shared-state-smoke ok");
