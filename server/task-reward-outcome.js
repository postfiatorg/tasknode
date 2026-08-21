function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function eventSchema(event = {}) {
  return safeText(event.schema || safeObject(event.rawPayload).schema, 120);
}

function latestEventBySchema(timeline = [], schema) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (eventSchema(timeline[index]) === schema) return timeline[index];
  }
  return null;
}

function firstNumericValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null || String(value).trim() === "") continue;
    return numeric(value);
  }
  return 0;
}

function paymentRewardPft(payload = {}) {
  return firstNumericValue(
    payload.reward_pft,
    payload.economic_reward_pft,
    payload.rewardPft,
    payload.amount_pft,
    payload.amountPft,
    payload.reward_actual_pft,
    payload.rewardActualPft
  );
}

function rewardTitle({ rewardPft }) {
  if (rewardPft <= 0) return "No PFT paid";
  return "Reward paid";
}

function rewardStatus({ rewardPft }) {
  if (rewardPft <= 0) return "zero_reward";
  return "paid";
}

function rewardSummary({ rewardPft }) {
  if (rewardPft <= 0) {
    return "The authority review closed this task with a zero-PFT outcome. The indexed reward transaction is a one-drop carrier for the terminal reward payload, not an economic reward.";
  }
  return "A terminal reward outcome is indexed on-chain for this task.";
}

export function taskRewardOutcome({ offeredPft = null, task = {}, timeline = [] } = {}) {
  const events = Array.isArray(timeline) ? timeline : [];
  const paymentEvent = latestEventBySchema(events, "pf.reward.v1");
  if (!paymentEvent) return null;

  const paymentPayload = safeObject(paymentEvent?.rawPayload);
  const score = safeObject(paymentPayload.reward_score || paymentPayload.score);
  const rewardPft = paymentRewardPft(paymentPayload);

  return {
    status: rewardStatus({ rewardPft }),
    title: rewardTitle({ rewardPft }),
    summary: rewardSummary({ rewardPft }),
    decision: safeText(score.decision || paymentPayload.reward_decision, 80),
    reason: safeText(score.reason || paymentPayload.reward_summary, 3000),
    userFeedback: safeText(score.user_feedback || score.userFeedback || paymentPayload.user_feedback, 3000),
    rewardPft,
    offeredPft: firstNumericValue(offeredPft, task.offeredPft, task.rewardOfferPft, task.pft),
    completion: score.completion ?? null,
    evidenceQuality: score.evidence_quality ?? score.evidenceQuality ?? null,
    paymentCid: safeText(paymentEvent?.cid, 200),
    paymentTxHash: safeText(paymentEvent?.txHash, 200),
    paymentObservedAt: safeText(paymentEvent?.observedAt || paymentEvent?.occurredAt || paymentEvent?.createdAt, 80),
  };
}
