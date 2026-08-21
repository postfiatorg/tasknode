import { migrateDatabase } from "../server/db/migrate.js";
import { closePool } from "../server/db/pool.js";
import { verifyCidOnCleanGateway } from "../server/ipfs-replication-worker.js";
import { ipfsReplicationFreshWriteSummary } from "../server/repositories/ipfs-replication-jobs.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    "Fresh IPFS CID replication check",
    "",
    "Usage:",
    "  npm run ipfs-new-write-replication-check -- --lookback-hours 24 --require-clean-gateway",
    "",
    "Options:",
    "  --lookback-hours <n>       Window to inspect. Default: 24",
    "  --stale-seconds <n>        Age before an unverified CID is stale. Default: 60",
    "  --limit <n>                Unverified samples to include. Default: 100",
    "  --require-clean-gateway    Actively check unverified sample CIDs against the clean gateway",
    "  --fail-on-unverified       Exit nonzero if fresh CIDs remain unverified",
    "  --pretty                   Pretty-print JSON",
  ].join("\n");
}

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(usage());
  process.exit(0);
}

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

await migrateDatabase();

const summary = await ipfsReplicationFreshWriteSummary({
  lookbackHours: argValue("--lookback-hours", "24"),
  staleSeconds: argValue("--stale-seconds", "60"),
  limit: argValue("--limit", "100"),
});

let cleanGatewaySamples = [];
if (summary.ok && hasFlag("--require-clean-gateway")) {
  cleanGatewaySamples = await Promise.all(
    summary.unverifiedSamples.map(async (job) => {
      const cleanGateway = await verifyCidOnCleanGateway({
        cid: job.cid,
        payloadClass: job.payloadClass,
      });
      return {
        jobId: job.id,
        cid: job.cid,
        payloadClass: job.payloadClass,
        status: job.status,
        cleanGateway,
      };
    })
  );
}

const result = {
  ...summary,
  requireCleanGateway: hasFlag("--require-clean-gateway"),
  cleanGatewaySamples,
};

console.log(JSON.stringify(result, null, hasFlag("--pretty") ? 2 : 0));
await closePool();

if (hasFlag("--fail-on-unverified") && summary.ok && (
  summary.pending > 0 ||
  summary.failed > 0 ||
  summary.stale > 0 ||
  cleanGatewaySamples.some((sample) => sample.cleanGateway?.ok === false)
)) {
  process.exit(1);
}
