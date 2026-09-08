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
export function text(value, max, required = false) {
  if (typeof value !== "string" || Buffer.byteLength(value) > max || (required && !value.length)) throw trackerError("tracker_text_invalid");
  return value;
}
export function identifier(value) {
  text(value, 200, true);
  if (![...value].every(c => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-".includes(c))) throw trackerError("tracker_identifier_invalid");
  return value;
}
export function timestamp(value) {
  text(value, 40, true);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !value.endsWith("Z")) throw trackerError("tracker_timestamp_invalid");
  return date.toISOString();
}
export function stringList(value, max = 32) {
  if (!Array.isArray(value) || value.length > max) throw trackerError("tracker_list_invalid");
  return [...new Set(value.map(identifier))];
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
  for (const key of ["id", "instanceId", "sessionId", "turnId", "workspaceId"]) identifier(input[key]);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) throw trackerError("tracker_sequence_invalid");
  if (!["human_prompt", "automated_prompt", "agent_output", "tool", "goal", "turn_end", "gap"].includes(input.kind)) throw trackerError("tracker_kind_invalid");
  const occurredAt = timestamp(input.occurredAt);
  if (Date.parse(occurredAt) > Date.now() + 5 * 60_000) throw trackerError("tracker_clock_ahead");
  const content = text(input.content || "", input.kind === "agent_output" ? TRACKER_OUTPUT_BYTES : ["human_prompt","automated_prompt"].includes(input.kind) ? TRACKER_EVENT_BYTES : 2048);
  const contentHash=createHash("sha256").update(content).digest("hex");
  const sourceDigest=input.sourceDigest || contentHash;
  text(sourceDigest,64,true);
  if(sourceDigest.length!==64 || (sourceDigest!==contentHash && !(input.kind==="agent_output" && content==="" && Date.parse(occurredAt)<Date.now()-72*60*60_000))) throw trackerError("tracker_source_digest_invalid");
  const repository = object(input.repository || {}, ["id", "label", "remote", "branch", "commit", "dirty"]);
  for (const key of ["id", "label", "branch", "commit"]) if (repository[key] != null) text(repository[key], 500);
  if (repository.dirty != null && typeof repository.dirty !== "boolean") throw trackerError("tracker_repository_invalid");
  if (repository.remote) {
    const url = new URL(repository.remote);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw trackerError("tracker_remote_invalid");
  }
  const goal = object(input.goal || {}, ["id", "active", "status"]);
  if (goal.id != null) text(goal.id, 200);
  if (goal.status != null) text(goal.status, 60);
  if (goal.active != null && typeof goal.active !== "boolean") throw trackerError("tracker_goal_invalid");
  const facts = object(input.facts || {}, ["action", "status", "exitCode", "durationMs", "parentAgentId", "nativeTurnId", "artifact", "attachmentCount"]);
  for (const key of ["action", "status", "parentAgentId", "nativeTurnId", "artifact"]) if (facts[key] != null) text(facts[key], 1000);
  for (const key of ["exitCode", "durationMs", "attachmentCount"]) if (facts[key] != null && !Number.isSafeInteger(facts[key])) throw trackerError("tracker_fact_invalid");
  return { ...input, sourceDigest, occurredAt, content, repository, goal, facts, taskIds: stringList(input.taskIds || []), coverage: text(input.coverage || "observed_tui", 120), model: text(input.model || "", 200) };
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
  text(value.title, 300, true); text(value.summary, 7000, true); text(value.rationale, 700);
  if (!["attempted", "failed", "partial", "reported_complete", "unknown"].includes(value.outcome)) throw trackerError("tracker_summary_outcome_invalid");
  value.taskIds = stringList(value.taskIds);
  if (value.taskIds.some(id => !taskIds.includes(id))) throw trackerError("tracker_summary_task_invalid");
  // Completion is always an unverified model claim; only task lifecycle supplies verified completion.
  return { ...value, mappingStatus: value.taskIds.length ? "suggested" : "unmapped", model: TRACKER_MODEL, schema: 1 };
}
