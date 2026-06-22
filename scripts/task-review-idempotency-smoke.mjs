import assert from "node:assert/strict";

import { taskReviewWorkerInternalsForTests } from "../server/task-review-worker.js";

const {
  buildRewardOutcomePayload,
  discordAnnouncementEvidenceStatus,
  parseDiscordMessageLink,
  resolveDiscordAnnouncementEvidenceStatus,
  evidencePayloadHasScreenshot,
  existingRewardReviewEvent,
  existingVerificationRequestEvent,
  isRewardReviewPayload,
  isVerificationRequestPayload,
  normalizeRewardScore,
  taskReviewPublisherPermission,
  timelineEventPublishedRef,
  workerClaimStaleSeconds,
} = taskReviewWorkerInternalsForTests;

const originalStale = process.env.TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS;
delete process.env.TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS;
assert.equal(workerClaimStaleSeconds(), 900);
process.env.TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS = "60";
assert.equal(workerClaimStaleSeconds(), 300);
process.env.TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS = "1200";
assert.equal(workerClaimStaleSeconds(), 1200);
if (originalStale === undefined) delete process.env.TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS;
else process.env.TASKNODE_TASK_WORKER_CLAIM_STALE_SECONDS = originalStale;

assert.deepEqual(
  taskReviewPublisherPermission({
    enabled: true,
    env: { TASKNODE_ENV: "development", TASKNODE_TASK_REVIEW_WORKER_ENABLED: "true" },
  }),
  { enabled: false, reason: "non_production_publisher_blocked" }
);
assert.deepEqual(
  taskReviewPublisherPermission({
    enabled: true,
    env: { TASKNODE_ENV: "production", TASKNODE_TASK_REVIEW_WORKER_ENABLED: "true" },
  }),
  { enabled: true, reason: "production" }
);
assert.deepEqual(
  taskReviewPublisherPermission({
    enabled: true,
    env: {
      TASKNODE_ENV: "development",
      TASKNODE_TASK_REVIEW_WORKER_ENABLED: "true",
      TASKNODE_TASK_REVIEW_ALLOW_NON_PRODUCTION: "true",
    },
  }),
  { enabled: true, reason: "non_production_override" }
);

assert.equal(isVerificationRequestPayload({
  schema: "pf.task.update.v1",
  transition: "verification_requested",
}), true);
assert.equal(isVerificationRequestPayload({ schema: "pf.task.reward_decision.v1" }), false);
assert.equal(isRewardReviewPayload({ schema: "pf.task.reward_decision.v1" }), false);
assert.equal(isRewardReviewPayload({ schema: "pf.reward.v1" }), true);
assert.equal(isRewardReviewPayload({ schema: "pf.task.update.v1" }), false);

const badgeCappedScore = normalizeRewardScore(
  {
    decision: "reward",
    reward_pft: "50000",
    completion: 100,
    evidence_quality: 100,
    reason: "Strong evidence.",
    user_feedback: "Strong evidence.",
  },
  50000,
  { badgeRewardCapPft: 5000 }
);
assert.equal(badgeCappedScore.reward_pft, "5000.00");
assert.equal(badgeCappedScore.badge_reward_cap_pft, "5000.00");
assert.equal(badgeCappedScore.badge_cap_applied, true);

assert.equal(
  discordAnnouncementEvidenceStatus({
    verificationResponse: {
      response: {
        text: "Announced in Discord: https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
      },
    },
  }).evidence_type,
  "discord_message_link"
);
assert.deepEqual(
  parseDiscordMessageLink("https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678"),
  {
    guildId: "123456789012345678",
    channelId: "223456789012345678",
    messageId: "323456789012345678",
    url: "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
  }
);
assert.equal(
  (await resolveDiscordAnnouncementEvidenceStatus({
    verificationResponse: {
      response_text: "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
    },
  }, {
    env: {
      TASKNODE_DISCORD_ALLOWED_CHANNEL_IDS: "223456789012345678",
      TASKNODE_DISCORD_ALLOWED_GUILD_IDS: "123456789012345678",
    },
  })).discord_validation.status,
  "syntactic"
);
assert.equal(
  (await resolveDiscordAnnouncementEvidenceStatus({
    verificationResponse: {
      response_text: "https://discord.com/channels/123456789012345678/999999999999999999/323456789012345678",
    },
  }, {
    env: {
      TASKNODE_DISCORD_ALLOWED_CHANNEL_IDS: "223456789012345678",
    },
  })).ok,
  false
);
assert.equal(
  (await resolveDiscordAnnouncementEvidenceStatus({
    verificationResponse: {
      response_text: "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
    },
  }, {
    env: {
      TASKNODE_DISCORD_BOT_TOKEN: "bot-token",
      TASKNODE_DISCORD_ALLOWED_CHANNEL_IDS: "223456789012345678",
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://discord.com/api/v10/channels/223456789012345678/messages/323456789012345678");
      assert.equal(options.headers.authorization, "Bot bot-token");
      return { ok: true, status: 200 };
    },
  })).discord_validation.status,
  "verified"
);
assert.equal(
  (await resolveDiscordAnnouncementEvidenceStatus({
    verificationResponse: {
      response_text: "https://discord.com/channels/123456789012345678/223456789012345678/323456789012345678",
    },
  }, {
    env: {
      TASKNODE_DISCORD_BOT_TOKEN: "bot-token",
    },
    fetchImpl: async () => ({ ok: false, status: 404 }),
  })).ok,
  false
);
assert.equal(
  discordAnnouncementEvidenceStatus({
    verificationResponse: {
      response_text: "Discord message id: 323456789012345678",
    },
  }).evidence_type,
  "discord_message_id"
);
assert.equal(
  discordAnnouncementEvidenceStatus({
    verificationResponse: {
      evidence_items: [
        {
          artifact_type: "screenshot",
          file: { name: "discord-announcement.png", mime_type: "image/png" },
          notes: "Screenshot from Discord announcement channel.",
        },
      ],
    },
  }).evidence_type,
  "discord_announcement_screenshot"
);
assert.equal(
  discordAnnouncementEvidenceStatus({
    verificationResponse: {
      evidence_items: [
        {
          artifact_type: "screenshot",
          file: { name: "proof.png", mime_type: "image/png" },
          notes: "Screenshot of the output.",
        },
      ],
    },
  }).ok,
  false
);
assert.equal(
  discordAnnouncementEvidenceStatus({
    verificationResponse: { response_text: "Completed the work, see notes." },
  }).ok,
  false
);
assert.equal(evidencePayloadHasScreenshot({ file: { name: "proof.webp", mime_type: "image/webp" } }), true);

const detail = {
  forensics: {
    timeline: [
      {
        rawPayload: { schema: "pf.task.offer.v1" },
        txHash: "OFFER_TX",
        cid: "OFFER_CID",
      },
      {
        rawPayload: {
          schema: "pf.task.update.v1",
          transition: "verification_requested",
        },
        txHash: "VERIFY_TX",
        cid: "VERIFY_CID",
      },
      {
        rawPayload: { schema: "pf.reward.v1" },
        txHash: "REWARD_TX",
        cid: "REWARD_CID",
      },
    ],
  },
};

assert.equal(timelineEventPublishedRef(existingVerificationRequestEvent(detail)).txHash, "VERIFY_TX");
assert.equal(timelineEventPublishedRef(existingRewardReviewEvent(detail)).txHash, "REWARD_TX");

const positiveOutcome = buildRewardOutcomePayload({
  row: { task_id: "task_positive_reward", subject_wallet: "rUser" },
  score: {
    decision: "reward",
    reward_pft: "18.00",
    completion: 100,
    evidence_quality: 94,
    reason: "Evidence met requirements.",
    user_feedback: "Good work.",
  },
  authorityWalletAddress: "rAuthority",
  rewardWalletAddress: "rReward",
  createdAt: "2026-06-02T00:00:00.000Z",
});
assert.equal(positiveOutcome.payload.schema, "pf.reward.v1");
assert.equal(positiveOutcome.payload.reward_history_schema, 2);
assert.equal(positiveOutcome.payload.reward_pft, "18.00");
assert.equal(positiveOutcome.payload.economic_reward_pft, "18.00");
assert.equal(positiveOutcome.rewardAmountDrops, "18000000");
assert.equal(positiveOutcome.payload.transaction_amount_drops, "18000000");
assert.equal(positiveOutcome.payload.carrier_amount_drops, "0");
assert.equal(positiveOutcome.payload.task_history.reward_decision, undefined);
assert.equal(positiveOutcome.payload.reward_score.evidence_quality, 94);

const zeroOutcome = buildRewardOutcomePayload({
  row: { task_id: "task_zero_reward", subject_wallet: "rUser" },
  score: {
    decision: "reject",
    reward_pft: "0.00",
    completion: 10,
    evidence_quality: 15,
    reason: "Evidence did not meet requirements.",
    user_feedback: "Submit clearer evidence.",
  },
  authorityWalletAddress: "rAuthority",
  rewardWalletAddress: "rReward",
  createdAt: "2026-06-02T00:00:00.000Z",
});
assert.equal(zeroOutcome.payload.schema, "pf.reward.v1");
assert.equal(zeroOutcome.payload.reward_pft, "0.00");
assert.equal(zeroOutcome.payload.economic_reward_pft, "0.00");
assert.equal(zeroOutcome.rewardAmountDrops, "1");
assert.equal(zeroOutcome.payload.transaction_amount_drops, "1");
assert.equal(zeroOutcome.payload.carrier_amount_drops, "1");

console.log("task-review-idempotency-smoke ok");
