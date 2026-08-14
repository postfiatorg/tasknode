#!/usr/bin/env node
import { closePool } from "../server/db/pool.js";
import { runPublicProfileSnapshot } from "../server/profile-public-snapshot.js";

if (!process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const accountId = argValue("--account-id", process.env.TASKNODE_PUBLIC_PROFILE_ACCOUNT_ID || "");
const model = argValue("--model", process.env.TASKNODE_PUBLIC_PROFILE_MODEL || "z-ai/glm-5.2");
const json = hasFlag("--json");

if (!accountId) {
  console.error("Usage: node scripts/profile-public-snapshot.mjs --account-id <account_id> [--json]");
  process.exit(1);
}

try {
  const result = await runPublicProfileSnapshot({ accountId, model });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("public_profile_snapshot_complete");
    console.log(`snapshot_id=${result.snapshot.snapshotId}`);
    console.log(`account_id=${result.snapshot.accountId}`);
    console.log(`model=${result.model}`);
    console.log(`input_fingerprint=${result.inputFingerprint}`);
    console.log(`role_title=${result.output.role_title}`);
    console.log(`archetype=${result.output.archetype}`);
    console.log(`skills=${result.output.skills.join(", ")}`);
  }
} finally {
  await closePool().catch(() => null);
}
