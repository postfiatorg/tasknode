#!/usr/bin/env node

import assert from "node:assert/strict";

import { TEAM_CONTEXT_PROMPT_VERSION } from "../server/team-context-contract.js";
import { composeTeamContextDisplayState } from "../server/repositories/team-context.js";
import {
  generateTeamContextReport,
  parseTeamContextResponse,
} from "../server/team-context-worker.js";
import { teamContextStatusLabel } from "../src/features/team/team-context-refresh.js";

const generatedAt = "2026-08-31T22:15:00.000Z";
const source = {
  sourceFingerprint: "fingerprint-current",
  members: [
    {
      accountId: "account_existing",
      displayName: "@existing",
      hiveHandle: "existing",
      taskHistoryVisible: true,
      tasksPastDay: 2,
      tasksPastWeek: 5,
      recentRewardedTasks: [{ title: "Restore the contributor workflow" }],
    },
    {
      accountId: "account_new",
      displayName: "@new",
      hiveHandle: "new",
      taskHistoryVisible: true,
      tasksPastDay: 1,
      tasksPastWeek: 1,
      recentRewardedTasks: [{ title: "Verify the new contributor workflow" }],
    },
  ],
};
function detailedResponse(memberKey, label) {
  return {
    member_key: memberKey,
    focus: `${label} member worked on the contributor workflow that controls how rewarded-task evidence becomes visible to teammates. The goal was to preserve useful context while keeping access changes enforceable throughout report generation and display.`,
    completed_changes: [
      `${label} member restored the contributor workflow and verified the server-issued member binding, so generated summaries remain attached to the correct account even when model output arrives in a different order.`,
      `${label} member tested refresh behavior with an existing report, ensuring the page continues showing the last authorized summary and completion time instead of replacing all useful text with a loading message.`,
    ],
    operational_effect: "Teammates can now read concrete recent-work context during regeneration, while revoked access and newly added members remain safely isolated from stale report content.",
  };
}
const keyedReport = parseTeamContextResponse(JSON.stringify({
  overview: "The team completed useful work.",
  members: [
    detailedResponse("member_2", "Second"),
    detailedResponse("member_1", "First"),
  ],
}), source);
assert.deepEqual(
  keyedReport.members.map((member) => member.account_id),
  ["account_existing", "account_new"],
  "server-issued keys must restore account IDs deterministically even when model output order changes"
);
assert.equal(keyedReport.members[0].recent_work.includes("First member restored the contributor workflow"), true);

const mixedSource = {
  ...source,
  members: [
    source.members[0],
    {
      accountId: "account_without_rewards",
      displayName: "@without-rewards",
      hiveHandle: "without-rewards",
      taskHistoryVisible: true,
      tasksPastDay: 0,
      tasksPastWeek: 0,
      recentRewardedTasks: [],
    },
    source.members[1],
  ],
};
const mixedReport = parseTeamContextResponse(JSON.stringify({
  overview: "The rewarded contributors completed useful work.",
  members: [
    detailedResponse("member_3", "Third"),
    detailedResponse("member_1", "First"),
  ],
}), mixedSource);
assert.deepEqual(
  mixedReport.members.map((member) => member.account_id),
  ["account_existing", "account_without_rewards", "account_new"],
  "the server must restore model summaries around a no-work member without asking the model to emit that member"
);
assert.equal(
  mixedReport.members[1].recent_work,
  "No rewarded work is available yet for this member.",
  "the server must synthesize the no-work sentence deterministically"
);

const capturedMemberPackets = [];
const generatedMixedReport = await generateTeamContextReport(mixedSource, {
  env: { VERCEL_AI_GATEWAY_API_KEY: "vercel-smoke-key" },
  fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    const packet = JSON.parse(body.messages[1].content);
    capturedMemberPackets.push(packet);
    const displayName = packet.team_members[0].display_name;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: {
          content: JSON.stringify({
            overview: `${displayName} concrete contributor workflow`,
            members: [detailedResponse("member_1", displayName)],
          }),
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  },
});
assert.equal(capturedMemberPackets.length, 2, "each rewarded contributor must receive an isolated model call");
assert.equal(
  capturedMemberPackets.every((packet) =>
    packet.team_members.length === 1
    && packet.team_members[0].member_key === "member_1"
    && packet.team_members[0].display_name !== "@without-rewards"
  ),
  true,
  "model calls must contain exactly one rewarded contributor and exclude no-work members"
);
assert.equal(generatedMixedReport.report.members.length, 3);
assert.equal(
  generatedMixedReport.report.members[1].recent_work,
  "No rewarded work is available yet for this member."
);
assert.equal(generatedMixedReport.usage.totalTokens, 600);

assert.throws(
  () => parseTeamContextResponse(JSON.stringify({
    overview: "",
    members: [
      detailedResponse("member_1", "First"),
      detailedResponse("member_55555", "Mutated"),
    ],
  }), source),
  /team_context_response_member_set_mismatch/,
  "mutated model keys must fail closed without assigning text to the wrong account"
);

const staleReport = {
  source_fingerprint: "fingerprint-previous",
  prompt_version: TEAM_CONTEXT_PROMPT_VERSION,
  generated_at: generatedAt,
  provider: "vercel",
  model: "zai/glm-5.3-flash",
  report_json: {
    overview: "Existing and revoked members shipped useful work.",
    members: [
      {
        account_id: "account_existing",
        recent_work: "Shipped the latest completed contributor workflow.",
      },
      {
        account_id: "account_revoked",
        recent_work: "This revoked member must never remain visible.",
      },
    ],
  },
};

const refreshing = composeTeamContextDisplayState({
  source,
  report: staleReport,
  job: { status: "processing", last_error: "" },
});
assert.equal(refreshing.status, "processing");
assert.equal(refreshing.showingPreviousReport, true);
assert.equal(refreshing.reportIsCurrent, false);
assert.equal(refreshing.generatedAt, generatedAt);
assert.equal(
  refreshing.members[0].recentWork,
  "Shipped the latest completed contributor workflow.",
  "refreshing must preserve the last completed summary for an authorized member"
);
assert.match(refreshing.members[1].recentWork, /No completed summary is available/);
assert.equal(refreshing.overview, "", "an overview mentioning a revoked member must be hidden");
assert.equal(
  refreshing.members.some((member) => member.recentWork.includes("updating this member")),
  false,
  "refreshing must not replace all output with a blocking loading sentence"
);
assert.equal(
  teamContextStatusLabel(refreshing),
  "Updating — showing last completed report"
);

const authorizedStaleReport = {
  ...staleReport,
  report_json: {
    overview: "The current authorized team shipped useful work.",
    members: staleReport.report_json.members.slice(0, 1),
  },
};
const safeRefreshing = composeTeamContextDisplayState({
  source,
  report: authorizedStaleReport,
  job: { status: "pending", last_error: "" },
});
assert.equal(safeRefreshing.overview, "The current authorized team shipped useful work.");

const failedRefresh = composeTeamContextDisplayState({
  source,
  report: authorizedStaleReport,
  job: { status: "failed", last_error: "provider_timeout" },
});
assert.equal(failedRefresh.status, "failed");
assert.equal(failedRefresh.members[0].recentWork, "Shipped the latest completed contributor workflow.");
assert.equal(failedRefresh.lastError, "provider_timeout");
assert.equal(
  teamContextStatusLabel(failedRefresh),
  "Latest update failed — showing last completed report"
);

const current = composeTeamContextDisplayState({
  source,
  report: {
    ...authorizedStaleReport,
    source_fingerprint: source.sourceFingerprint,
    prompt_version: TEAM_CONTEXT_PROMPT_VERSION,
  },
  job: { status: "completed", last_error: "" },
});
assert.equal(current.status, "current");
assert.equal(current.showingPreviousReport, false);
assert.equal(current.reportIsCurrent, true);
assert.equal(teamContextStatusLabel(current), "Current");

const firstReport = composeTeamContextDisplayState({
  source,
  report: null,
  job: { status: "pending", last_error: "" },
});
assert.equal(firstReport.showingPreviousReport, false);
assert.equal(teamContextStatusLabel(firstReport), "Generating first report");

console.log("team context state smoke ok");
