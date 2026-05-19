const terminalRewardSchemas = new Set(["pf.task.reward_decision.v1", "pf.reward.v1"]);

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
  const hasTerminalRewardDecision = [...schemas].some((schema) => terminalRewardSchemas.has(schema));
  const status = hasTerminalRewardDecision
    ? "rewarded"
    : cleanText(projection.status || "unknown", 80);
  const rewardActualPft = cleanText(projection.reward_actual_pft, 80) ||
    rewardFromHydratedEvents(hydratedEvents) ||
    (status === "rewarded" ? "0" : "");
  return {
    status,
    rewardActualPft,
  };
}
