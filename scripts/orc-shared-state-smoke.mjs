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
assert.ok(
  migrateJs.indexOf("062_orc_agents_and_activity.sql") < migrateJs.indexOf("063_orc_task_reviews.sql"),
  "orc task review history migration must run after the shared state base migration"
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

assert.match(reviewStatePy, /CREATE TABLE IF NOT EXISTS orc_task_reviews/);
assert.match(reviewStatePy, /INSERT INTO orc_task_reviews/);
assert.match(reviewStatePy, /historyTable.*orc_task_reviews/s);

console.log("orc-shared-state-smoke ok");
