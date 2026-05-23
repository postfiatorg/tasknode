import { statusFromRewardAmount } from "../shared/task-lifecycle.js";

function cleanText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function eventSchema(event = {}) {
  const payload = objectValue(event.payload);
  return cleanText(event.schema || payload.schema, 140);
}

function rewardFromHydratedEvents(events = []) {
  const ordered = Array.isArray(events) ? [...events].reverse() : [];
  for (const event of ordered) {
    const payload = objectValue(event.payload);
    const schema = eventSchema(event);
    if (schema === "pf.reward.v1") {
      return cleanText(payload.reward_pft || payload.reward_actual_pft || "0", 80);
    }
    if (schema === "pf.task.reward_decision.v1") {
      return cleanText(payload.score?.reward_pft || payload.reward_pft || payload.reward_actual_pft || "0", 80);
    }
  }
  return "";
}

export function canonicalReceiptProjection({ projection = {}, hydratedEvents = [] } = {}) {
  const projectedEvents = Array.isArray(projection.events) ? projection.events : [];
  const schemas = new Set([
    ...projectedEvents.map(eventSchema),
    ...hydratedEvents.map(eventSchema),
  ].filter(Boolean));
  const hasRewardPayment = schemas.has("pf.reward.v1");
  const hasRewardDecision = schemas.has("pf.task.reward_decision.v1");
  const rewardActualPft = cleanText(projection.reward_actual_pft, 80) ||
    rewardFromHydratedEvents(hydratedEvents) ||
    "";
  let status = cleanText(projection.status || "unknown", 80);
  if (hasRewardPayment) {
    status = "rewarded";
  } else if (hasRewardDecision) {
    status = statusFromRewardAmount(rewardActualPft);
  }
  return {
    status,
    rewardActualPft: rewardActualPft || (status === "rewarded" ? "0" : ""),
  };
}
