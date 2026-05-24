import assert from "node:assert/strict";
import { formatDailyAirdropSummary } from "../server/profile-daily-airdrop-worker.js";
import { formatBoardManagerAgentRun } from "../server/repositories/board-manager-run-summary.js";

const summary = formatDailyAirdropSummary({
  totalPft: 12500,
  userCount: 2,
  scoredCount: 2,
  failedCount: 0,
});
assert.equal(summary, "Dispensed 12,500 PFT to 2 users as part of daily airdrop. Scored 2 eligible accounts.");

const feedEntry = formatBoardManagerAgentRun({
  id: "boardrun_daily_airdrop_smoke",
  status: "completed",
  dryRun: false,
  selectedAction: "daily_airdrop",
  decision: {
    action: "daily_airdrop",
    target_type: "daily_airdrop",
    target_id: "2026-05-24",
    reason: summary,
    confidence: 1,
  },
  actionPayload: {
    summary,
  },
  actionResults: [
    {
      id: "boardaction_daily_airdrop_smoke",
      action: "daily_airdrop",
      targetType: "daily_airdrop",
      targetId: "2026-05-24",
      result: {
        executed: true,
        totalPft: 12500,
        userCount: 2,
      },
      createdAt: "2026-05-24T00:00:00.000Z",
    },
  ],
});
assert.equal(feedEntry.label, "Daily airdrop");
assert.equal(feedEntry.state, "executed");
assert.equal(feedEntry.summary, summary);
assert.equal(feedEntry.actionResults[0].summary, "Dispensed 12,500 PFT to 2 users as part of daily airdrop.");

console.log("profile daily airdrop worker smoke ok");
