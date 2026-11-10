import { recoverDailyAirdropDebt } from "../server/profile-daily-airdrop-recovery.js";
import { closePool } from "../server/db/pool.js";
const arg = name => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
try {
  const result = await recoverDailyAirdropDebt({ runId: arg("run-id"),
    execute: process.argv.includes("--execute"), expectedDigest: arg("expected-digest") });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.code || "daily_airdrop_recovery_failed" }));
  process.exitCode = 1;
} finally { await closePool(); }
