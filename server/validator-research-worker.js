import { reconcileResearchJobs } from "./research-gateway.js";
import { runValidatorRewards } from "./validator-rewards.js";
import { l1UptimeFeedConfig, refreshL1ValidatorAccess } from "./l1-validator-access.js";

let started = false;
export function startValidatorResearchWorker() {
  if (started) return;
  // Enforcement switched on without a feed, or with a keyset that does not
  // parse, stops the start: it is never read as "enforcement off".
  l1UptimeFeedConfig();
  started = true;
  let busy = false;
  let rewardedMonth = "";
  let accessReadAt = 0;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (process.env.GA_RESEARCH_URL && process.env.GA_RESEARCH_HMAC_SECRET) await reconcileResearchJobs();
      const now = new Date();
      // The uptime feed is read every five minutes. A bad or missing feed is
      // logged and changes nothing.
      if (now.getTime() - accessReadAt >= 300000) {
        accessReadAt = now.getTime();
        const access = await refreshL1ValidatorAccess({ now });
        if (access.status !== "not_configured") console.log("l1_validator_access", JSON.stringify(access));
      }
      const month = now.toISOString().slice(0, 7);
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
