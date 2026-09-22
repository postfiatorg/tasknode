import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const TRACKER_MODEL = "zai/glm-5.3-flash";
export const TRACKER_CAPABILITIES = ["summary", "prompt", "replay", "review", "export"];
export const TRACKER_QUOTA_BYTES = 1024 * 1024 * 1024;
export const TRACKER_EVENT_BYTES = 1024 * 1024;
export const TRACKER_OUTPUT_BYTES = 32 * 1024;
export function trackerError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
export function object(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw trackerError("tracker_object_required");
  if (allowed && Object.keys(value).some(key => !allowed.includes(key))) throw trackerError("tracker_unknown_field");
  return value;
}
const TRACKER_TEXT_FIELDS = Object.freeze({
  text: "Text", apiKey: "Corbanu API credential", workspaceId: "Workspace ID", accountId: "Account ID",
  id: "Record ID", grantId: "Grant ID", title: "Campaign name", objective: "Campaign objective",
  note: "Rationale", handle: "Collaborator handle", memberHandles: "Campaign members", taskIds: "Task IDs",
  workspaceIds: "Workspace IDs", capabilities: "Sharing permissions", search: "Activity search",
  historyFrom: "History start", historyTo: "History end", expiresAt: "Expiry",
  "event.id": "Event ID", "event.instanceId": "Instance ID", "event.sessionId": "Session ID",
  "event.turnId": "Turn ID", "event.workspaceId": "Workspace ID", "event.occurredAt": "Event timestamp",
  "event.content": "Event content", "event.sourceDigest": "Source digest", "event.taskIds": "Event task IDs",
  "event.coverage": "Event coverage", "event.model": "Event model",
  "repository.id": "Repository ID", "repository.label": "Repository label", "repository.branch": "Repository branch",
  "repository.commit": "Repository commit", "goal.id": "Goal ID", "goal.status": "Goal status",
  "facts.action": "Action", "facts.status": "Action status", "facts.parentAgentId": "Parent agent ID",
  "facts.nativeTurnId": "Native turn ID", "facts.artifact": "Artifact",
  "summary.title": "Summary title", "summary.summary": "Summary", "summary.rationale": "Summary rationale",
});
export function trackerErrorResponse(error) {
  const code = typeof error.code === "string" && error.code.startsWith("tracker_") ? error.code : "tracker_request_failed";
  let message = code.split("_").join(" ");
  const candidate = error.validation;
  let validation;
  if (code === "tracker_text_invalid" && candidate && Object.hasOwn(TRACKER_TEXT_FIELDS, candidate.field)
      && ["type", "required", "max_bytes"].includes(candidate.reason) && Number.isSafeInteger(candidate.maxBytes) && candidate.maxBytes > 0) {
    validation = { field: candidate.field, reason: candidate.reason, maxBytes: candidate.maxBytes };
    const label = TRACKER_TEXT_FIELDS[validation.field];
    message = validation.reason === "required" ? `${label} is required. Enter a value and submit again.`
      : validation.reason === "max_bytes" ? `${label} exceeds ${validation.maxBytes} UTF-8 bytes. Shorten it and submit again.`
        : `${label} must be text. Correct this field and submit again.`;
  }
  if (code === "tracker_credential_required") message = "A Corbanu API credential is required to enable or sync recording. Link Corbanu API in Providers, then retry. Existing local activity is retained.";
  if (code === "tracker_subscription_required") message = "Campaign Tracker requires a funded Corbanu API account or an active legacy subscription. Check Corbanu API, then retry.";
  return { ok: false, error: code, message, ...(validation ? { validation } : {}) };
}
export function text(value, max, required = false, field = "text") {
  const reason = typeof value !== "string" ? "type" : required && !value.length ? "required" : Buffer.byteLength(value) > max ? "max_bytes" : null;
  if (reason) throw Object.assign(trackerError("tracker_text_invalid"), {
    validation: { field: Object.hasOwn(TRACKER_TEXT_FIELDS, field) ? field : "text", reason, maxBytes: max },
  });
  return value;
}
export function identifier(value, field = "id") {
  text(value, 200, true, field);
  if (![...value].every(c => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-".includes(c))) throw trackerError("tracker_identifier_invalid");
  return value;
}
export function timestamp(value, field = "text") {
  text(value, 40, true, field);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !value.endsWith("Z")) throw trackerError("tracker_timestamp_invalid");
  return date.toISOString();
}
export function stringList(value, max = 32, field = "id") {
  if (!Array.isArray(value) || value.length > max) throw trackerError("tracker_list_invalid");
  return [...new Set(value.map(item => identifier(item, field)))];
}
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash("sha256").update(stableJson(value)).digest("hex");

export function validateEvent(input) {
  object(input, ["id", "instanceId", "sessionId", "turnId", "sequence", "workspaceId", "kind", "occurredAt", "content", "repository", "goal", "facts", "taskIds", "coverage", "model", "sourceDigest"]);
  if (Buffer.byteLength(JSON.stringify(input)) > TRACKER_EVENT_BYTES + 16 * 1024) throw trackerError("tracker_event_too_large", 413);
  for (const key of ["id", "instanceId", "sessionId", "turnId", "workspaceId"]) identifier(input[key], `event.${key}`);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw trackerError("tracker_sequence_invalid");
  if (!["human_prompt", "automated_prompt", "agent_output", "tool", "goal", "turn_end", "gap"].includes(input.kind)) throw trackerError("tracker_kind_invalid");
  const occurredAt = timestamp(input.occurredAt, "event.occurredAt");
  if (Date.parse(occurredAt) > Date.now() + 5 * 60_000) throw trackerError("tracker_clock_ahead");
  const content = text(input.content || "", input.kind === "agent_output" ? TRACKER_OUTPUT_BYTES : ["human_prompt","automated_prompt"].includes(input.kind) ? TRACKER_EVENT_BYTES : 2048, false, "event.content");
  const contentHash=createHash("sha256").update(content).digest("hex");
  const sourceDigest=input.sourceDigest || contentHash;
  text(sourceDigest,64,true,"event.sourceDigest");
  if(sourceDigest.length!==64 || (sourceDigest!==contentHash && !(input.kind==="agent_output" && content==="" && Date.parse(occurredAt)<Date.now()-72*60*60_000))) throw trackerError("tracker_source_digest_invalid");
  const repository = object(input.repository || {}, ["id", "label", "remote", "branch", "commit", "dirty"]);
  for (const key of ["id", "label", "branch", "commit"]) if (repository[key] != null) text(repository[key], 500, false, `repository.${key}`);
  if (repository.dirty != null && typeof repository.dirty !== "boolean") throw trackerError("tracker_repository_invalid");
  if (repository.remote) {
    const url = new URL(repository.remote);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw trackerError("tracker_remote_invalid");
  }
  const goal = object(input.goal || {}, ["id", "active", "status"]);
  if (goal.id != null) text(goal.id, 200, false, "goal.id");
  if (goal.status != null) text(goal.status, 60, false, "goal.status");
  if (goal.active != null && typeof goal.active !== "boolean") throw trackerError("tracker_goal_invalid");
  const facts = object(input.facts || {}, ["action", "status", "exitCode", "durationMs", "parentAgentId", "nativeTurnId", "artifact", "attachmentCount"]);
  for (const key of ["action", "status", "parentAgentId", "nativeTurnId", "artifact"]) if (facts[key] != null) text(facts[key], 1000, false, `facts.${key}`);
  for (const key of ["exitCode", "durationMs", "attachmentCount"]) if (facts[key] != null && !Number.isSafeInteger(facts[key])) throw trackerError("tracker_fact_invalid");
  return { ...input, sourceDigest, occurredAt, content, repository, goal, facts, taskIds: stringList(input.taskIds || [], 32, "event.taskIds"), coverage: text(input.coverage || "observed_tui", 120, false, "event.coverage"), model: text(input.model || "", 200, false, "event.model") };
}

function key(env) {
  const raw = env.CAMPAIGN_TRACKER_ENCRYPTION_KEY || "";
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== raw) throw trackerError("tracker_encryption_not_configured", 503);
  return decoded;
}
export function seal(value, binding, env = process.env) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(env), nonce);
  cipher.setAAD(Buffer.from(binding));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { version: 1, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}
export function unseal(envelope, binding, env = process.env) {
  if (envelope.version !== 1) throw trackerError("tracker_encryption_version_invalid", 503);
  const decipher = createDecipheriv("aes-256-gcm", key(env), Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(Buffer.from(binding));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8"));
}

export function parseSummary(raw, taskIds) {
  const value = object(JSON.parse(raw), ["title", "summary", "outcome", "taskIds", "rationale"]);
  text(value.title, 300, true, "summary.title"); text(value.summary, 7000, true, "summary.summary"); text(value.rationale, 700, false, "summary.rationale");
  if (!["attempted", "failed", "partial", "reported_complete", "unknown"].includes(value.outcome)) throw trackerError("tracker_summary_outcome_invalid");
  value.taskIds = stringList(value.taskIds);
  if (value.taskIds.some(id => !taskIds.includes(id))) throw trackerError("tracker_summary_task_invalid");
  // Completion is always an unverified model claim; only task lifecycle supplies verified completion.
  return { ...value, mappingStatus: value.taskIds.length ? "suggested" : "unmapped", model: TRACKER_MODEL, schema: 1 };
}
