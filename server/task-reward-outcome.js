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

function decisionRewardPft(payload = {}, score = {}) {
  return firstNumericValue(
    score.reward_pft,
    score.rewardPft,
    payload.reward_pft,
    payload.rewardPft,
    payload.reward_actual_pft,
    payload.rewardActualPft
  );
}

function paymentRewardPft(payload = {}) {
  return firstNumericValue(
    payload.reward_pft,
    payload.rewardPft,
    payload.amount_pft,
    payload.amountPft,
    payload.reward_actual_pft,
    payload.rewardActualPft
  );
}

function rewardTitle({ hasDecision, hasPayment, rewardPft }) {
  if (hasPayment) return "Reward paid";
  if (hasDecision && rewardPft <= 0) return "No PFT paid";
  if (hasDecision) return "Reward decision indexed";
  return "Reward status indexed";
}

function rewardStatus({ hasDecision, hasPayment, rewardPft }) {
  if (hasPayment) return "paid";
  if (hasDecision && rewardPft <= 0) return "zero_reward";
  if (hasDecision) return "decision_only";
  return "indexed";
}

function rewardSummary({ hasDecision, hasPayment, rewardPft }) {
  if (hasPayment) {
    return "A reward payment is indexed on-chain for this task.";
  }
  if (hasDecision && rewardPft <= 0) {
    return "The authority review closed this task with a zero-PFT decision. Because the decision amount is zero, no separate reward payment transaction is expected.";
  }
  if (hasDecision) {
    return "A positive reward decision is indexed, but the matching payment event has not been indexed yet.";
  }
  return "The task is marked rewarded, but no reward decision payload was found in the indexed task timeline.";
}

export function taskRewardOutcome({ offeredPft = null, task = {}, timeline = [] } = {}) {
  const events = Array.isArray(timeline) ? timeline : [];
  const decisionEvent = latestEventBySchema(events, "pf.task.reward_decision.v1");
  const paymentEvent = latestEventBySchema(events, "pf.reward.v1");
  if (!decisionEvent && !paymentEvent) return null;

  const decisionPayload = safeObject(decisionEvent?.rawPayload);
  const score = safeObject(decisionPayload.score);
  const paymentPayload = safeObject(paymentEvent?.rawPayload);
  const decisionAmount = decisionEvent ? decisionRewardPft(decisionPayload, score) : 0;
  const paymentAmount = paymentEvent ? paymentRewardPft(paymentPayload) : 0;
  const rewardPft = paymentEvent ? paymentAmount : decisionAmount;
  const hasDecision = Boolean(decisionEvent);
  const hasPayment = Boolean(paymentEvent);

  return {
    status: rewardStatus({ hasDecision, hasPayment, rewardPft }),
    title: rewardTitle({ hasDecision, hasPayment, rewardPft }),
    summary: rewardSummary({ hasDecision, hasPayment, rewardPft }),
    decision: safeText(score.decision || decisionPayload.decision, 80),
    reason: safeText(score.reason || decisionPayload.reason, 3000),
    userFeedback: safeText(score.user_feedback || score.userFeedback || decisionPayload.user_feedback, 3000),
    rewardPft,
    offeredPft: firstNumericValue(offeredPft, task.offeredPft, task.rewardOfferPft, task.pft),
    completion: score.completion ?? null,
    evidenceQuality: score.evidence_quality ?? score.evidenceQuality ?? null,
    decisionCid: safeText(decisionEvent?.cid, 200),
    decisionTxHash: safeText(decisionEvent?.txHash, 200),
    paymentCid: safeText(paymentEvent?.cid, 200),
    paymentTxHash: safeText(paymentEvent?.txHash, 200),
  };
}
