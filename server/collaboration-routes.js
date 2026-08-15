import {
  actOnDocumentGrant,
  actOnTeamInvite,
  createCollaborationChallenge,
  createDocument,
  docsIdentityForAccount,
  createTeamInvite,
  listDocs,
  listTeam,
  recipientEncryptionIdentity,
  requireTaskHistoryGrant,
  resolveCollaborationIdentity,
  revokeTaskHistoryGrant,
  setupDocsAccount,
  shareDocument,
  suggestCollaborationIdentities,
  teammateWalletAddress,
  updateDocument,
  updateDocumentTaskLink,
} from "./repositories/collaboration.js";
import {
  bindNostrIdentity,
  getNostrIdentity,
  getNostrMessagingBootstrap,
  getNostrWellKnownDirectory,
  resolveNostrMessagingIdentity,
  revokeNostrIdentity,
} from "./repositories/nostr-messages.js";
import { generateDocsAssistantResponse, generateDocsOdvResponse } from "./docs-odv.js";
import { getTaskDetail, listTaskState } from "./repositories/tasks.js";

function methodError(name) {
  return { ok: false, status: 405, error: `${name}_method_not_allowed` };
}

function featureEnabled(name) {
  if (process.env[name] === "true") return true;
  if (process.env[name] === "false") return false;
  return (process.env.TASKNODE_ENV || process.env.NODE_ENV || "development") !== "production";
}

function featureError(name) {
  return { ok: false, status: 503, error: `${name}_disabled` };
}

function routeResult(json, res, result) {
  json(res, result?.ok === false ? Number(result.status || 400) : 200, result);
}

function routeFailure(json, res, error) {
  const status = Number(error?.status || 500);
  const candidate = String(error?.code || error?.message || "");
  const safeError = /^(collaboration|docs|team|nostr|messages)_[a-z0-9_]+$/.test(candidate)
    ? candidate
    : "collaboration_request_failed";
  json(res, status, {
    ok: false,
    error: safeError,
  });
}

async function run(json, res, operation) {
  try {
    routeResult(json, res, await operation());
  } catch (error) {
    routeFailure(json, res, error);
  }
}

function accountIdFor(session) {
  return String(session?.accountId || "").trim();
}

export async function handleCollaborationRoute({ json, readJson, req, res, session, url }) {
  const accountId = accountIdFor(session);
  const pathname = url.pathname;
  const collaborationPath = pathname.startsWith("/api/collaboration/") ||
    pathname.startsWith("/api/docs") ||
    pathname.startsWith("/api/team") ||
    pathname.startsWith("/api/messages");

  if (pathname === "/.well-known/nostr.json") {
    if (req.method !== "GET") return routeResult(json, res, methodError("nostr_well_known")), true;
    if (!featureEnabled("TASKNODE_MESSAGES_ENABLED")) return routeResult(json, res, featureError("messages")), true;
    try {
      json(res, 200, await getNostrWellKnownDirectory({ name: url.searchParams.get("name") || "" }), {
        "access-control-allow-origin": "*",
      });
    } catch (error) {
      routeFailure(json, res, error);
    }
    return true;
  }

  if (collaborationPath && !accountId) {
    json(res, 401, {
      ok: false,
      error: "collaboration_login_required",
      message: "Sign in before using Docs or Team collaboration.",
    });
    return true;
  }

  if (pathname === "/api/collaboration/challenge") {
    if (req.method !== "POST") return routeResult(json, res, methodError("collaboration_challenge")), true;
    const payload = await readJson(req, 512_000);
    await run(json, res, () => createCollaborationChallenge({
      accountId,
      action: payload.action,
      resourceId: payload.resourceId,
      payload: payload.payload,
    }));
    return true;
  }

  if (pathname === "/api/collaboration/resolve") {
    if (req.method !== "GET") return routeResult(json, res, methodError("collaboration_resolve")), true;
    await run(json, res, () => resolveCollaborationIdentity({
      viewerAccountId: accountId,
      input: url.searchParams.get("q") || "",
    }));
    return true;
  }

  if (pathname === "/api/collaboration/encryption-identity") {
    if (req.method !== "GET") return routeResult(json, res, methodError("collaboration_encryption_identity")), true;
    await run(json, res, async () => {
      const target = await resolveCollaborationIdentity({
        viewerAccountId: accountId,
        input: url.searchParams.get("q") || "",
      });
      if (!target.ok) return target;
      return recipientEncryptionIdentity({ accountId: target.identity.accountId });
    });
    return true;
  }

  if (pathname === "/api/collaboration/suggestions") {
    if (req.method !== "GET") return routeResult(json, res, methodError("collaboration_suggestions")), true;
    await run(json, res, () => suggestCollaborationIdentities({
      viewerAccountId: accountId,
      input: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit") || 8,
    }));
    return true;
  }

  if (pathname.startsWith("/api/messages")) {
    if (!featureEnabled("TASKNODE_MESSAGES_ENABLED")) {
      routeResult(json, res, featureError("messages"));
      return true;
    }
    if (pathname === "/api/messages/bootstrap") {
      if (req.method !== "GET") return routeResult(json, res, methodError("messages_bootstrap")), true;
      await run(json, res, () => getNostrMessagingBootstrap({ accountId }));
      return true;
    }
    if (pathname === "/api/messages/identity") {
      if (req.method === "POST") {
        const payload = await readJson(req, 128_000);
        await run(json, res, () => bindNostrIdentity({ accountId, ...payload }));
        return true;
      }
      if (req.method === "DELETE") {
        const payload = await readJson(req, 128_000);
        await run(json, res, () => revokeNostrIdentity({ accountId, proof: payload.proof }));
        return true;
      }
      return routeResult(json, res, methodError("messages_identity")), true;
    }
    if (pathname === "/api/messages/resolve") {
      if (req.method !== "GET") return routeResult(json, res, methodError("messages_resolve")), true;
      await run(json, res, () => resolveNostrMessagingIdentity({
        viewerAccountId: accountId,
        input: url.searchParams.get("q") || "",
      }));
      return true;
    }
  }

  if (pathname.startsWith("/api/docs")) {
    if (!featureEnabled("TASKNODE_DOCS_ENABLED")) {
      routeResult(json, res, featureError("docs"));
      return true;
    }
    if (pathname === "/api/docs") {
      if (req.method !== "GET") return routeResult(json, res, methodError("docs")), true;
      await run(json, res, () => listDocs({ accountId }));
      return true;
    }
    if (pathname === "/api/docs/setup") {
      if (req.method !== "POST") return routeResult(json, res, methodError("docs_setup")), true;
      const payload = await readJson(req, 512_000);
      await run(json, res, () => setupDocsAccount({ accountId, ...payload }));
      return true;
    }
    if (pathname === "/api/docs/documents") {
      if (req.method !== "POST") return routeResult(json, res, methodError("docs_documents")), true;
      const payload = await readJson(req, 512_000);
      await run(json, res, () => createDocument({ accountId, ...payload }));
      return true;
    }
    const documentMatch = pathname.match(/^\/api\/docs\/documents\/([0-9a-f-]{36})$/i);
    if (documentMatch) {
      if (req.method !== "PATCH") return routeResult(json, res, methodError("docs_document")), true;
      const payload = await readJson(req, 512_000);
      await run(json, res, () => updateDocument({ accountId, documentId: documentMatch[1], ...payload }));
      return true;
    }
    const odvMatch = pathname.match(/^\/api\/docs\/documents\/([0-9a-f-]{36})\/odv$/i);
    if (odvMatch) {
      if (!featureEnabled("TASKNODE_DOCS_ODV_ENABLED")) return routeResult(json, res, featureError("docs_odv")), true;
      if (req.method !== "POST") return routeResult(json, res, methodError("docs_odv")), true;
      const payload = await readJson(req, 128_000);
      await run(json, res, () => generateDocsOdvResponse({
        accountId,
        documentId: odvMatch[1],
        channelHash: payload.channelHash,
        prompt: payload.prompt,
        documentTitle: payload.documentTitle,
        documentContent: payload.documentContent,
        recentMessages: payload.recentMessages,
        identity: docsIdentityForAccount(accountId),
      }));
      return true;
    }
    const assistantMatch = pathname.match(/^\/api\/docs\/documents\/([0-9a-f-]{36})\/assistant$/i);
    if (assistantMatch) {
      if (!featureEnabled("TASKNODE_DOCS_ODV_ENABLED")) return routeResult(json, res, featureError("docs_assistant")), true;
      if (req.method !== "POST") return routeResult(json, res, methodError("docs_assistant")), true;
      const payload = await readJson(req, 128_000);
      await run(json, res, () => generateDocsAssistantResponse({
        accountId,
        documentId: assistantMatch[1],
        channelHash: payload.channelHash,
        persona: payload.persona,
        includeFullContext: payload.includeFullContext === true,
        prompt: payload.prompt,
        documentTitle: payload.documentTitle,
        documentContent: payload.documentContent,
        recentMessages: payload.recentMessages,
        identity: docsIdentityForAccount(accountId),
      }));
      return true;
    }
    const shareMatch = pathname.match(/^\/api\/docs\/documents\/([0-9a-f-]{36})\/share$/i);
    if (shareMatch) {
      if (req.method !== "POST") return routeResult(json, res, methodError("docs_share")), true;
      const payload = await readJson(req, 512_000);
      await run(json, res, () => shareDocument({ accountId, documentId: shareMatch[1], ...payload }));
      return true;
    }
    const taskLinkMatch = pathname.match(/^\/api\/docs\/documents\/([0-9a-f-]{36})\/tasks$/i);
    if (taskLinkMatch) {
      if (!["POST", "DELETE"].includes(req.method)) return routeResult(json, res, methodError("docs_task_link")), true;
      const payload = await readJson(req, 16_384);
      await run(json, res, () => updateDocumentTaskLink({
        accountId,
        documentId: taskLinkMatch[1],
        taskId: payload.taskId,
        action: req.method === "DELETE" ? "unlink" : "link",
      }));
      return true;
    }
    const grantMatch = pathname.match(/^\/api\/docs\/shares\/([0-9a-f-]{36})\/action$/i);
    if (grantMatch) {
      if (req.method !== "POST") return routeResult(json, res, methodError("docs_share_action")), true;
      const payload = await readJson(req, 16_384);
      await run(json, res, () => actOnDocumentGrant({ accountId, grantId: grantMatch[1], action: payload.action }));
      return true;
    }
  }

  if (pathname.startsWith("/api/team")) {
    if (!featureEnabled("TASKNODE_TEAM_ENABLED")) {
      routeResult(json, res, featureError("team"));
      return true;
    }
    if (pathname === "/api/team") {
      if (req.method !== "GET") return routeResult(json, res, methodError("team")), true;
      await run(json, res, () => listTeam({ accountId }));
      return true;
    }
    if (pathname === "/api/team/invites") {
      if (req.method !== "POST") return routeResult(json, res, methodError("team_invites")), true;
      const payload = await readJson(req, 128_000);
      await run(json, res, () => createTeamInvite({ accountId, ...payload }));
      return true;
    }
    const inviteMatch = pathname.match(/^\/api\/team\/invites\/([0-9a-f-]{36})\/action$/i);
    if (inviteMatch) {
      if (req.method !== "POST") return routeResult(json, res, methodError("team_invite_action")), true;
      const payload = await readJson(req, 128_000);
      await run(json, res, () => actOnTeamInvite({ accountId, inviteId: inviteMatch[1], ...payload }));
      return true;
    }
    const revokeMatch = pathname.match(/^\/api\/team\/grants\/([0-9a-f-]{36})\/revoke$/i);
    if (revokeMatch) {
      if (req.method !== "POST") return routeResult(json, res, methodError("team_grant_revoke")), true;
      const payload = await readJson(req, 128_000);
      await run(json, res, () => revokeTaskHistoryGrant({ accountId, grantId: revokeMatch[1], proof: payload.proof }));
      return true;
    }
    if (pathname === "/api/team/nostr") {
      if (req.method === "GET") {
        await run(json, res, async () => ({ ok: true, identity: await getNostrIdentity({ accountId, viewerAccountId: accountId }) }));
        return true;
      }
      if (req.method === "POST") {
        const payload = await readJson(req, 128_000);
        await run(json, res, () => bindNostrIdentity({ accountId, ...payload }));
        return true;
      }
      if (req.method === "DELETE") {
        const payload = await readJson(req, 128_000);
        await run(json, res, () => revokeNostrIdentity({ accountId, proof: payload.proof }));
        return true;
      }
      return routeResult(json, res, methodError("team_nostr")), true;
    }
    const teammateNostrMatch = pathname.match(/^\/api\/team\/([^/]+)\/nostr$/);
    if (teammateNostrMatch) {
      if (req.method !== "GET") return routeResult(json, res, methodError("team_member_nostr")), true;
      await run(json, res, async () => ({
        ok: true,
        identity: await getNostrIdentity({
          accountId: decodeURIComponent(teammateNostrMatch[1]),
          viewerAccountId: accountId,
        }),
      }));
      return true;
    }
    const taskListMatch = pathname.match(/^\/api\/team\/([^/]+)\/tasks$/);
    if (taskListMatch) {
      if (req.method !== "GET") return routeResult(json, res, methodError("team_member_tasks")), true;
      const subjectAccountId = decodeURIComponent(taskListMatch[1]);
      await run(json, res, async () => {
        const grant = await requireTaskHistoryGrant({ subjectAccountId, viewerAccountId: accountId });
        if (!grant.ok) return grant;
        const walletAddress = await teammateWalletAddress(subjectAccountId);
        if (!walletAddress) return { ok: false, status: 404, error: "team_member_wallet_not_found" };
        const state = await listTaskState({ accountId: subjectAccountId, walletAddress });
        return {
          ok: true,
          subjectAccountId,
          tasks: {
            outstanding: state.outstanding || [],
            verification: state.verification || [],
            refused: state.refused || [],
            rewarded: state.rewarded || [],
            sync: state.sync || {},
          },
        };
      });
      return true;
    }
    const taskDetailMatch = pathname.match(/^\/api\/team\/([^/]+)\/tasks\/([^/]+)$/);
    if (taskDetailMatch) {
      if (req.method !== "GET") return routeResult(json, res, methodError("team_member_task")), true;
      const subjectAccountId = decodeURIComponent(taskDetailMatch[1]);
      const taskId = decodeURIComponent(taskDetailMatch[2]);
      await run(json, res, async () => {
        const grant = await requireTaskHistoryGrant({ subjectAccountId, viewerAccountId: accountId });
        if (!grant.ok) return grant;
        const walletAddress = await teammateWalletAddress(subjectAccountId);
        const detail = await getTaskDetail({ accountId: subjectAccountId, walletAddress, taskId });
        return detail || { ok: false, status: 404, error: "team_task_not_found" };
      });
      return true;
    }
  }

  return false;
}
