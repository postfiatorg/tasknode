import { hiveGovernanceFounderAccess } from "./hive-operator-access.js";
import { createGovernanceSessionEngine } from "./hive-governance-engine.js";
import { getDefaultGovernanceStore } from "./repositories/hive-governance.js";

function sessionPathParts(pathname = "") {
  const prefix = "/api/hive/governance/sessions";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).replace(/^\/+|\/+$/g, "");
  if (!rest) return { sessionId: "", action: "" };
  const [sessionId = "", action = "", extra = ""] = rest.split("/");
  if (extra) return null;
  return { sessionId: decodeURIComponent(sessionId), action };
}

export async function handleHiveGovernanceRoute({
  req,
  res,
  url,
  session,
  json,
  readJson,
  engine = null,
  store = null,
  checkFounderAccess = hiveGovernanceFounderAccess,
  env = process.env,
}) {
  const parts = sessionPathParts(url.pathname);
  if (!parts) return false;

  const repo = store || getDefaultGovernanceStore();
  const gov = engine || createGovernanceSessionEngine({ store: repo });

  try {
    // Public read endpoints (no login required, per Pillar 1 public archive spec).
    if (!parts.sessionId && req.method === "GET") {
      const state = url.searchParams.get("state") || "";
      const limit = Number(url.searchParams.get("limit") || 50);
      const sessions = await repo.listSessions({ limit, state });
      json(res, 200, { ok: true, sessions });
      return true;
    }

    if (parts.sessionId && !parts.action && req.method === "GET") {
      if (url.searchParams.get("format") === "bundle") {
        const bundle = await gov.exportVerificationBundle(parts.sessionId);
        json(res, 200, { ok: true, bundle });
        return true;
      }
      const record = await repo.getSession(parts.sessionId);
      if (!record) {
        json(res, 404, { ok: false, error: "governance_session_not_found" });
        return true;
      }
      const anchors = await repo.listAnchors(parts.sessionId);
      json(res, 200, { ok: true, session: record, anchors });
      return true;
    }

    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method_not_allowed" });
      return true;
    }

    // Off unless enabled: the engine does not yet pin artifacts or confirm anchors
    // on chain, so a changed session would publish records nobody can verify.
    if (env.TASKNODE_HIVE_GOVERNANCE_MUTATIONS_ENABLED !== "true") {
      json(res, 503, {
        ok: false,
        error: "hive_governance_mutations_not_enabled",
        message: "Governance session changes are not enabled on this server.",
      });
      return true;
    }

    // All mutations are strictly founder-only (1-of-1 at launch).
    const access = await checkFounderAccess(session, { env });
    if (!access.ok) {
      json(res, access.status || 403, { ok: false, error: access.error, message: access.message });
      return true;
    }

    const body = await readJson(req, 512 * 1024);

    if (!parts.sessionId) {
      const result = await gov.scheduleSession({
        ...body,
        founderAccountId: session.accountId,
      });
      json(res, 201, { ok: true, ...result });
      return true;
    }

    if (parts.action === "open") {
      const result = await gov.openSession(parts.sessionId, body);
      json(res, 200, { ok: true, ...result });
      return true;
    }

    if (parts.action === "close") {
      const result = await gov.closeSession(parts.sessionId, body);
      json(res, 200, { ok: true, ...result });
      return true;
    }

    if (parts.action === "minutes") {
      const result = await gov.reviseMinutes(parts.sessionId, body);
      json(res, 200, { ok: true, ...result });
      return true;
    }

    if (parts.action === "anchor") {
      const result = await gov.anchorSession(parts.sessionId, body);
      json(res, 200, { ok: true, ...result });
      return true;
    }

    if (parts.action === "archive") {
      const result = await gov.archiveSession(parts.sessionId);
      json(res, 200, { ok: true, ...result });
      return true;
    }

    json(res, 404, { ok: false, error: "governance_action_not_found" });
    return true;
  } catch (error) {
    json(res, Number(error?.status) || 500, {
      ok: false,
      error: error?.code || error?.message || "hive_governance_error",
      message: error?.message || "Governance session request failed.",
    });
    return true;
  }
}
