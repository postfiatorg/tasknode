function cleanText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function humanize(value = "") {
  const words = [];
  let current = "";
  for (const char of String(value || "")) {
    if (char === "_" || char === "-") {
      if (current) words.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words
    .map((word) => word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : "")
    .filter(Boolean)
    .join(" ");
}

export function taskEventMeaning(schema = "", payload = {}) {
  const normalized = cleanText(schema, 120);
  const transition = cleanText(payload?.transition || payload?.status_after || payload?.status, 120);
  if (normalized === "pf.task.request.v1") {
    return "The user requested a task and published the request bundle pointer.";
  }
  if (normalized === "pf.task.offer.v1") {
    return "The task authority offered this task to the user wallet.";
  }
  if (normalized === "pf.task.update.v1") {
    return {
      accepted: "The user accepted the task.",
      refused: "The user refused the task.",
      rejected: "The task was rejected.",
      expired: "The task expired before acceptance or completion.",
      cancelled: "The task was cancelled.",
      verification_requested: "The task authority requested follow-up verification evidence.",
    }[transition] || `The task state changed${transition ? ` to ${humanize(transition)}` : ""}.`;
  }
  if (normalized === "pf.task.submission.v1") {
    return "The user submitted initial task evidence.";
  }
  if (normalized === "pf.task.verification_response.v1") {
    return "The user responded to the verification request.";
  }
  if (normalized === "pf.task.reward_decision.v1") {
    return "The task authority scored the submitted evidence.";
  }
  if (normalized === "pf.reward.v1") {
    return "The reward wallet paid the user.";
  }
  return "";
}

function eventSchema(event = {}) {
  return cleanText(event?.schema || event?.rawPayload?.schema, 120);
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rewardDecisionAmount(event = {}) {
  const payload = event?.rawPayload || {};
  return numberValue(payload?.score?.reward_pft || payload?.reward_pft || payload?.reward_actual_pft);
}

export function taskEventExpectation({ status = "", timeline = [] } = {}) {
  const events = Array.isArray(timeline) ? timeline : [];
  const schemas = new Set(events.map(eventSchema).filter(Boolean));
  const last = events[events.length - 1] || {};
  const lastSchema = eventSchema(last);
  const rewardDecision = events.find((event) => eventSchema(event) === "pf.task.reward_decision.v1");

  if (
    cleanText(status, 120) === "submitted" &&
    lastSchema === "pf.task.submission.v1" &&
    !events.some((event) => {
      if (eventSchema(event) !== "pf.task.update.v1") return false;
      const transition = cleanText(
        event?.rawPayload?.transition || event?.rawPayload?.status_after || event?.rawPayload?.status,
        120
      );
      return transition === "verification_requested";
    })
  ) {
    return {
      severity: "warning",
      label: "Awaiting authority review",
      body:
        "Initial evidence is indexed. The task authority has not published a verification request or reward decision yet. The next canonical step is usually pf.task.update.v1 with transition verification_requested, or pf.task.reward_decision.v1 after review.",
      missingSchemas: ["pf.task.update.v1", "pf.task.reward_decision.v1"],
    };
  }

  if (
    cleanText(status, 120) === "verification_response_submitted" &&
    lastSchema === "pf.task.verification_response.v1" &&
    !schemas.has("pf.task.reward_decision.v1") &&
    !schemas.has("pf.reward.v1")
  ) {
    return {
      severity: "warning",
      label: "Awaiting Task Node review",
      body:
        "The user verification response is indexed. No authority review has been indexed yet. The next canonical event should be pf.task.reward_decision.v1; if the reward is greater than zero it should be followed by pf.reward.v1.",
      missingSchemas: ["pf.task.reward_decision.v1", "pf.reward.v1"],
    };
  }

  if (rewardDecision && !schemas.has("pf.reward.v1") && rewardDecisionAmount(rewardDecision) > 0) {
    return {
      severity: "warning",
      label: "Reward payment not indexed",
      body:
        "A positive reward decision is indexed, but the matching pf.reward.v1 payment pointer is not indexed yet.",
      missingSchemas: ["pf.reward.v1"],
    };
  }

  if (rewardDecision && !schemas.has("pf.reward.v1") && rewardDecisionAmount(rewardDecision) === 0) {
    return {
      severity: "neutral",
      label: "Closed with zero reward",
      body:
        "The authority review is indexed with a zero-PFT decision, so no separate payment pointer is expected.",
      missingSchemas: [],
    };
  }

  return null;
}
