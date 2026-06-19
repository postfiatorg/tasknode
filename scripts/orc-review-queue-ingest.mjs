#!/usr/bin/env node
import { ingestDirectoryRewardedTasksIntoReviewQueue } from "../server/repositories/orc-review-queue-ingestion.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

const taskKind = argValue("--task-kind", "network");
const limit = Number(argValue("--limit", "500")) || 500;
const execute = process.argv.includes("--execute");

const result = await ingestDirectoryRewardedTasksIntoReviewQueue({
  taskKind,
  limit,
  execute,
});

console.log(JSON.stringify({
  ...result,
  mode: execute ? "execute" : "dry-run",
  hint: execute ? undefined : "Re-run with --execute to upsert orc_task_review_items.",
}, null, 2));

process.exit(result.ok ? 0 : 1);
