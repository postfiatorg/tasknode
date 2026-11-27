import { reconcileResearchJobs } from "./research-gateway.js";
import { runValidatorRewards } from "./validator-rewards.js";
import { runDailyTop30SnapshotJob } from "./finance-hub-top30.js";

let started = false;
export function startValidatorResearchWorker() {
  if (started) return;
  started = true;
  let busy = false;
  let rewardedMonth = "";
  let lastTop30SnapshotDate = "";
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (process.env.GA_RESEARCH_URL && process.env.GA_RESEARCH_HMAC_SECRET) await reconcileResearchJobs();
      const now = new Date();
      const month = now.toISOString().slice(0, 7);
      const utcDay = now.toISOString().slice(0, 10);
      if (process.env.TASKNODE_FINANCE_HUB_TOP30_ENABLED !== "false" && lastTop30SnapshotDate !== utcDay) {
        const snapshotResult = await runDailyTop30SnapshotJob({ now });
        console.log("finance_hub_top30_snapshot", JSON.stringify({
          ok: snapshotResult.ok,
          retainedFallback: snapshotResult.retainedFallback,
          snapshotId: snapshotResult.snapshot?.snapshot_id || null,
          summary: snapshotResult.snapshot?.summary || null,
        }));
        if (snapshotResult.ok) lastTop30SnapshotDate = utcDay;
      }
      if (process.env.TASKNODE_VALIDATOR_REWARDS_ENABLED === "true" && now.getUTCDate() === 1 && rewardedMonth !== month) {
        const result = await runValidatorRewards({ month, dryRun: false });
        console.log("validator_rewards", JSON.stringify(result));
        if (!result.report.some((row) => row.error)) rewardedMonth = month;
      }
    } catch (error) { console.error("validator_research_worker_failed", error.status ? error.message : "database_or_provider_unavailable"); }
    finally { busy = false; }
  };
  void tick();
  setInterval(() => void tick(), 30000).unref();
}
