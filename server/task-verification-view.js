function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

export function currentVerificationRequest(timeline = []) {
  const rows = Array.isArray(timeline) ? timeline : [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const event = rows[index];
    const payload = safeObject(event?.rawPayload);
    const transition = safeText(payload.transition || payload.status, 80);
    const isVerificationRequest =
      event?.schema === "pf.task.verification_request.v1" ||
      (event?.schema === "pf.task.update.v1" && transition === "verification_requested");
    if (!isVerificationRequest) continue;
    const request = safeObject(payload.verification_request);
    const ask = safeText(payload.verification_ask || request.verification_ask || request.ask, 4000);
    if (!ask) return null;
    return {
      ask,
      body: ask,
      type: safeText(payload.verification_type || request.verification_type, 120),
      assessment: safeText(request.assessment || payload.assessment, 120),
      reason: safeText(payload.reason || request.reason, 1000),
      eventId: safeText(payload.event_id, 180),
      createdAt: toIso(payload.created_at),
    };
  }
  return null;
}
