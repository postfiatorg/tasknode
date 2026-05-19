import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { migrateDatabase } from "../server/db/migrate.js";
import { closePool, query } from "../server/db/pool.js";
import {
  buildJobsRetrievalQuery,
  formatJobsRetrieval,
  ingestJobsCorpus,
  jobsRetrievalForChat,
  searchJobsCorpus,
} from "../server/jobs-corpus.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Jobs corpus pgvector smoke.");
}
if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}
process.env.TASKNODE_JOBS_EMBEDDING_PROVIDER = "deterministic";

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

const raw = [
  "# Focus",
  "Great product work is not saying yes to every idea. Focus means cutting the merely good so the essential product can become obvious.",
  "",
  "# Craft",
  "The back of the fence matters. The invisible implementation should be clean because sloppy internals eventually become visible user pain.",
  "",
  "# Launch",
  "A usable product loop matters more than a sprawling roadmap. Ship the smallest complete loop, learn from real users, and then refine.",
  "",
  "# Taste",
  "Taste is the act of refusing clutter. A product should make the important thing feel inevitable.",
].join("\n");
const rawSha256 = sha256(raw);

try {
  await migrateDatabase();
  await query("DELETE FROM jobs_corpus_sources WHERE raw_sha256 = $1", [rawSha256]);

  const ingested = await ingestJobsCorpus({
    raw,
    sourceUrl: "smoke://jobs-corpus-pgvector",
    sourceLabel: "Jobs corpus smoke",
    provider: "deterministic",
    force: true,
  });
  assert.equal(ingested.ok, true);
  assert.ok(ingested.chunkCount >= 3);

  const replay = await ingestJobsCorpus({
    raw,
    sourceUrl: "smoke://jobs-corpus-pgvector",
    sourceLabel: "Jobs corpus smoke",
    provider: "deterministic",
  });
  assert.equal(replay.skipped, true);
  assert.equal(replay.reason, "already_ingested");

  const results = await searchJobsCorpus({
    queryText: "I have too many product ideas and need to cut down to one focused product loop.",
    provider: "deterministic",
    limit: 3,
  });
  assert.equal(results.ok, true);
  assert.equal(results.chunks.length, 3);
  assert.ok(results.chunks.some((chunk) => /focus|product loop|roadmap/i.test(chunk.content)));

  const rendered = formatJobsRetrieval(results.chunks);
  assert.ok(rendered.includes("<jobs_retrieval_context count=\"3\">"));
  assert.ok(rendered.includes("<![CDATA["));

  const retrievalQuery = buildJobsRetrievalQuery({
    message: "Help me cut this product down to one real loop.",
    contextDocument: { body: "The product needs one working loop before breadth." },
    memoryContext: { memories: [{ memoryText: "The user values focus over broad unfinished surfaces." }] },
    taskContext: { outstanding: [{ title: "Finish the task loop", status: "Accepted" }] },
  });
  assert.ok(retrievalQuery.includes("one real loop"));
  assert.ok(retrievalQuery.includes("Finish the task loop"));

  const runtime = await jobsRetrievalForChat({
    message: "Help me cut this product down to one real loop.",
    contextDocument: { body: "The product needs one working loop before breadth." },
    memoryContext: { memories: [{ memoryText: "The user values focus over broad unfinished surfaces." }] },
    taskContext: { outstanding: [{ title: "Finish the task loop", status: "Accepted" }] },
  });
  assert.equal(runtime.ok, true);
  assert.equal(runtime.chunks.length, 3);
  assert.ok(runtime.text.includes("<jobs_retrieval_context count=\"3\">"));

  await query("DELETE FROM jobs_corpus_sources WHERE raw_sha256 = $1", [rawSha256]);
  console.log("jobs corpus pgvector smoke ok");
} finally {
  await closePool();
}
