// The server signs a SHA-256 of this canonical form into every collaboration
// challenge, and the browser recomputes it before signing, so both sides must
// build it with these exact functions.

const ACTION_MAX_LENGTH = 80;
const RESOURCE_ID_MAX_LENGTH = 240;

function safeText(value = "", max = 4000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((output, key) => {
    if (value[key] !== undefined) output[key] = stableValue(value[key]);
    return output;
  }, {});
}

export function stableCollaborationJson(value) {
  return JSON.stringify(stableValue(value));
}

export function collaborationChallengePayload({
  action = "",
  resourceId = "",
  payload = {},
} = {}) {
  return {
    action: safeText(action, ACTION_MAX_LENGTH),
    resourceId: safeText(resourceId, RESOURCE_ID_MAX_LENGTH),
    payload: stableValue(safeObject(payload)),
  };
}
