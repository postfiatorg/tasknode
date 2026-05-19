import { closePool } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  defaultJobsCorpusUrl,
  ingestJobsCorpus,
  loadJobsCorpusSource,
} from "../server/jobs-corpus.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

function hasArg(name) {
  return process.argv.includes(name);
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Jobs corpus ingestion.");
}
if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const filePath = argValue("--file") || process.env.TASKNODE_JOBS_CORPUS_FILE || "";
const sourceUrl = argValue("--url") || process.env.TASKNODE_JOBS_CORPUS_URL || defaultJobsCorpusUrl;
const provider = hasArg("--deterministic")
  ? "deterministic"
  : argValue("--provider") || process.env.TASKNODE_JOBS_EMBEDDING_PROVIDER || "openai";
const force = hasArg("--force");

try {
  await migrateDatabase();
  const source = await loadJobsCorpusSource({ filePath, sourceUrl });
  const result = await ingestJobsCorpus({
    raw: source.raw,
    sourceUrl: source.sourceUrl,
    fetchedAt: source.fetchedAt,
    provider,
    force,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closePool();
}
