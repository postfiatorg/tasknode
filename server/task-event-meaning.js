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
  if (normalized === "pf.reward.v1") {
    const rewardPft = numberValue(
      payload?.reward_pft ||
        payload?.reward_actual_pft ||
        payload?.economic_reward_pft ||
        payload?.reward_score?.reward_pft
    );
    if (rewardPft <= 0) {
      return "The reward wallet recorded a zero-PFT review outcome with a one-drop carrier transaction.";
    }
    return "The reward wallet recorded the review outcome and paid the user.";
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

export function taskEventExpectation({ status = "", timeline = [] } = {}) {
  const events = Array.isArray(timeline) ? timeline : [];
  const schemas = new Set(events.map(eventSchema).filter(Boolean));
  const last = events[events.length - 1] || {};
  const lastSchema = eventSchema(last);

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
        "Initial evidence is indexed. The task authority has not published a verification request or terminal reward outcome yet. The next canonical step is usually pf.task.update.v1 with transition verification_requested, or pf.reward.v1 after review.",
      missingSchemas: ["pf.task.update.v1", "pf.reward.v1"],
    };
  }

  if (
    cleanText(status, 120) === "verification_response_submitted" &&
    lastSchema === "pf.task.verification_response.v1" &&
    !schemas.has("pf.reward.v1")
  ) {
    return {
      severity: "warning",
      label: "Awaiting Task Node review",
      body:
        "The user verification response is indexed. No terminal authority review has been indexed yet. The next canonical event should be one pf.reward.v1 outcome transaction.",
      missingSchemas: ["pf.reward.v1"],
    };
  }

  return null;
}
