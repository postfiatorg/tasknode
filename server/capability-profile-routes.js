import { timingSafeEqual } from "node:crypto";

import {
  revokeCapabilityProfile,
  verifyCapabilityProfile,
} from "./repositories/capability-profiles.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeEqualText(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(header = "") {
  const text = safeText(header, 2000);
  return text.toLowerCase().startsWith("bearer ") ? text.slice("bearer ".length).trim() : "";
}

function capabilityAdminAuthorized(req) {
  const expected = process.env.TASKNODE_CAPABILITY_PROFILE_ADMIN_TOKEN || "";
  if (!expected) {
    return {
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "capability_profile_admin_not_configured",
        message: "Capability profile verification requires TASKNODE_CAPABILITY_PROFILE_ADMIN_TOKEN.",
      },
    };
  }
  const actual = bearerToken(req.headers.authorization || "");
  if (!actual || !safeEqualText(actual, expected)) {
    return {
      ok: false,
      status: 401,
      body: {
        ok: false,
        error: "capability_profile_unauthorized",
        message: "Capability profile writes require an authorized operator bearer token.",
      },
    };
  }
  return { ok: true };
}

function capabilityPayload(payload = {}) {
  const input = safeObject(payload);
  return {
    accountId: safeText(input.accountId || input.account_id, 180),
    projectId: safeText(input.projectId || input.project_id, 180),
    capabilityType: safeText(input.capabilityType || input.capability_type, 120),
    scope: safeText(input.scope || input.scope_ref || input.scopeRef, 500),
    scopeLabel: safeText(input.scopeLabel || input.scope_label, 180),
    evidenceTaskId: safeText(input.evidenceTaskId || input.evidence_task_id || input.taskId || input.task_id, 180),
    evidenceUrlOrRef: safeText(input.evidenceUrlOrRef || input.evidence_url_or_ref || input.evidenceUrl || input.evidence_url, 500),
    verifiedBy: safeText(input.verifiedBy || input.verified_by || input.actor, 180),
    revokedBy: safeText(input.revokedBy || input.revoked_by || input.actor, 180),
    expiresAt: input.expiresAt || input.expires_at || null,
    notes: safeText(input.notes, 700),
    metadata: safeObject(input.metadata),
  };
}

export async function handleCapabilityProfileRoute({ json, readJson, req, res, url }) {
  if (url.pathname !== "/api/hive/capability-profile") return false;
  if (req.method !== "POST") {
    json(res, 405, {
      ok: false,
      error: "capability_profile_method_not_allowed",
      message: "Capability profile verification supports POST.",
    }, { allow: "POST" });
    return true;
  }

  const authorization = capabilityAdminAuthorized(req);
  if (!authorization.ok) {
    json(res, authorization.status, authorization.body);
    return true;
  }

  const body = await readJson(req, 32768);
  const action = safeText(body.action || "verify", 80).toLowerCase();
  const input = capabilityPayload(body);
  const result = action === "revoke"
    ? await revokeCapabilityProfile(input)
    : await verifyCapabilityProfile(input);
  json(res, result.ok ? 200 : result.status || 400, {
    ok: Boolean(result.ok),
    action: action === "revoke" ? "revoke" : "verify",
    ...result,
  });
  return true;
}
