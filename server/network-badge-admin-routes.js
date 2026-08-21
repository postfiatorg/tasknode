import { timingSafeEqual } from "node:crypto";

import {
  approveNetworkBadge,
  expireNetworkBadge,
  getIdentityApprovalState,
  manualBadgeApprovalRecords,
  revokeNetworkBadge,
  setDefaultNetworkBadge,
} from "./repositories/identity-approvals.js";
import {
  approveNetworkBadgeFromVerifierJob,
  enqueueNetworkBadgeVerifierJob,
  listNetworkBadgeVerifierJobs,
  networkBadgeVerifierJobRecord,
  runNetworkBadgeVerifierJob,
} from "./repositories/network-badge-verifier-jobs.js";
import {
  resolveGithubCollaboratorPermission,
  resolveXUserMetrics,
} from "./repositories/identity-provider-resolvers.js";
import {
  disableProjectBadgeRequirement,
  listProjectBadgeRequirements,
  projectBadgeRequirementRecord,
  upsertProjectBadgeRequirement,
} from "./repositories/network-badges.js";

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

function badgeAdminAuthorized(req) {
  const expected = process.env.TASKNODE_NETWORK_BADGE_ADMIN_TOKEN || "";
  if (!expected) {
    return {
      ok: false,
      status: 409,
      body: {
        ok: false,
        error: "network_badge_admin_not_configured",
        message: "Network badge admin requires TASKNODE_NETWORK_BADGE_ADMIN_TOKEN.",
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
        error: "network_badge_admin_unauthorized",
        message: "Network badge admin writes require an authorized operator bearer token.",
      },
    };
  }
  return { ok: true };
}

function badgeAdminPayload(payload = {}) {
  const input = safeObject(payload);
  return {
    action: safeText(input.action || "list", 80).toLowerCase(),
    submit: input.submit === true,
    accountId: safeText(input.accountId || input.account_id, 180),
    badgeId: safeText(input.badgeId || input.badge_id, 80),
    jobId: safeText(input.jobId || input.job_id, 180),
    requirementId: safeText(input.requirementId || input.requirement_id || input.id, 180),
    projectId: safeText(input.projectId || input.project_id, 180),
    workType: safeText(input.workType || input.work_type || input.taskWorkType || input.task_work_type, 120),
    provider: safeText(input.provider, 80),
    verifierType: safeText(input.verifierType || input.verifier_type || input.type, 120),
    capabilityType: safeText(input.capabilityType || input.capability_type, 120),
    scopeLabel: safeText(input.scopeLabel || input.scope_label, 180),
    scopeDigest: safeText(input.scopeDigest || input.scope_digest, 80),
    maxPayoutOverridePft: Number(input.maxPayoutOverridePft || input.max_payout_override_pft || 0),
    publicHandle: safeText(input.publicHandle || input.public_handle || input.handle, 180),
    profileUrl: safeText(input.profileUrl || input.profile_url, 500),
    username: safeText(input.username || input.handle || input.publicHandle || input.public_handle, 180),
    userId: safeText(input.userId || input.user_id, 180),
    owner: safeText(input.owner || input.githubOwner || input.github_owner, 180),
    repo: safeText(input.repo || input.repository || input.githubRepo || input.github_repo, 180),
    requiredOwner: safeText(input.requiredOwner || input.required_owner || "postfiatorg", 180),
    providerToken: safeText(input.providerToken || input.provider_token || input.token, 4000),
    approvalLevel: safeText(input.approvalLevel || input.approval_level, 80),
    approvedByAccountId: safeText(input.approvedByAccountId || input.approved_by_account_id, 180),
    operator: safeText(input.operator || input.verifiedBy || input.verified_by || input.actor, 180),
    approvalScope: safeText(input.approvalScope || input.approval_scope, 240),
    reason: safeText(input.reason || input.notes, 700),
    status: safeText(input.status, 80),
    maxAttempts: Number(input.maxAttempts || input.max_attempts || 3),
    runAfter: safeText(input.runAfter || input.run_after, 80),
    selectedDefault: input.selectedDefault === true || input.selected_default === true || input.default === true,
    evidence: safeObject(input.evidence),
    metrics: safeObject(input.metrics),
  };
}

function requirementInput(input = {}) {
  return {
    id: input.requirementId,
    projectId: input.projectId,
    workType: input.workType,
    requiredBadgeId: input.badgeId,
    capabilityType: input.capabilityType,
    scopeLabel: input.scopeLabel,
    scopeDigest: input.scopeDigest,
    maxPayoutOverridePft: input.maxPayoutOverridePft,
    createdByAccountId: input.approvedByAccountId || input.operator,
  };
}

function dryRunApproval(input = {}) {
  return {
    ok: true,
    dryRun: true,
    action: "approve",
    plannedRecords: input.accountId && input.badgeId
      ? manualBadgeApprovalRecords({
          accountId: input.accountId,
          badgeId: input.badgeId,
          provider: input.provider,
          publicHandle: input.publicHandle,
          profileUrl: input.profileUrl,
          approvalLevel: input.approvalLevel,
          approvalScope: input.approvalScope,
          approvedByAccountId: input.approvedByAccountId,
          approvedByOperator: input.operator || "network_badge_admin_http",
          evidence: {
            source: "network_badge_admin_http",
            reason: input.reason,
            ...input.evidence,
          },
          metrics: input.metrics,
          selectedDefault: input.selectedDefault,
        })
      : null,
    message: input.accountId && input.badgeId
      ? "Dry run only. Resend with submit=true to approve."
      : "Dry run only. Submit with accountId+badgeId to preview records.",
  };
}

function verifierInput(input = {}) {
  return {
    username: input.username,
    userId: input.userId,
    owner: input.owner,
    repo: input.repo,
    requiredOwner: input.requiredOwner,
  };
}

function verifierJobInput(input = {}) {
  return {
    accountId: input.accountId,
    badgeId: input.badgeId,
    provider: input.provider,
    verifierType: input.verifierType,
    input: verifierInput(input),
    requestedByAccountId: input.approvedByAccountId,
    requestedByOperator: input.operator || "network_badge_admin_http",
    maxAttempts: input.maxAttempts,
    runAfter: input.runAfter,
  };
}

export async function handleNetworkBadgeAdminRoute({ json, readJson, req, res, url, fetchImpl = fetch }) {
  if (url.pathname !== "/api/profile/network-badges/admin") return false;
  if (req.method !== "POST") {
    json(res, 405, {
      ok: false,
      error: "network_badge_admin_method_not_allowed",
      message: "Network badge admin supports POST.",
    }, { allow: "POST" });
    return true;
  }

  const authorization = badgeAdminAuthorized(req);
  if (!authorization.ok) {
    json(res, authorization.status, authorization.body);
    return true;
  }

  const input = badgeAdminPayload(await readJson(req, 65536));
  if (input.action === "list") {
    json(res, 200, {
      ok: true,
      action: "list",
      state: await getIdentityApprovalState({ accountId: input.accountId }),
    });
    return true;
  }

  if (input.action === "list_project_requirements") {
    json(res, 200, {
      ok: true,
      action: "list_project_requirements",
      requirements: await listProjectBadgeRequirements({
        projectId: input.projectId,
        workType: input.workType,
        includeInactive: true,
      }),
    });
    return true;
  }

  if (input.action === "list_verifier_jobs") {
    json(res, 200, {
      ok: true,
      action: "list_verifier_jobs",
      jobs: await listNetworkBadgeVerifierJobs({
        accountId: input.accountId,
        badgeId: input.badgeId,
        status: input.status,
      }),
    });
    return true;
  }

  if (input.action === "enqueue_verifier_job") {
    const plan = networkBadgeVerifierJobRecord(verifierJobInput(input));
    const result = input.submit
      ? await enqueueNetworkBadgeVerifierJob(verifierJobInput(input))
      : {
          ok: true,
          dryRun: true,
          action: "enqueue_verifier_job",
          plannedJob: plan,
          message: "Dry run only. Resend with submit=true to write network_badge_verifier_jobs.",
        };
    json(res, result.ok ? 200 : result.status || 400, { action: "enqueue_verifier_job", ...result });
    return true;
  }

  if (input.action === "run_verifier_job") {
    if (!input.submit) {
      json(res, 200, {
        ok: true,
        dryRun: true,
        action: "run_verifier_job",
        jobId: input.jobId,
        message: "Dry run only. Resend with submit=true to mark and run the queued verifier job.",
      });
      return true;
    }
    const result = await runNetworkBadgeVerifierJob({
      jobId: input.jobId,
      fetchImpl,
      approvedByAccountId: input.approvedByAccountId,
      approvedByOperator: input.operator || "network_badge_admin_http",
    });
    json(res, result.ok ? 200 : result.status || 400, { action: "run_verifier_job", ...result });
    return true;
  }

  if (input.action === "approve_from_verifier_job") {
    if (!input.submit) {
      json(res, 200, {
        ok: true,
        dryRun: true,
        action: "approve_from_verifier_job",
        jobId: input.jobId,
        selectedDefault: input.selectedDefault,
        message: "Dry run only. Resend with submit=true to approve the badge from a succeeded, recommended verifier job.",
      });
      return true;
    }
    const result = await approveNetworkBadgeFromVerifierJob({
      jobId: input.jobId,
      approvedByAccountId: input.approvedByAccountId,
      approvedByOperator: input.operator || "network_badge_admin_http",
      selectedDefault: input.selectedDefault,
    });
    json(res, result.ok ? 200 : result.status || 400, { action: "approve_from_verifier_job", ...result });
    return true;
  }

  if (input.action === "resolve_x" || input.action === "resolve-x") {
    const result = await resolveXUserMetrics({
      username: input.username,
      userId: input.userId,
      bearerToken: input.providerToken,
      fetchImpl,
    });
    json(res, 200, {
      ok: true,
      action: "resolve_x",
      result,
      routingImpact: "read_only_evidence_packet_no_badge_write",
    });
    return true;
  }

  if (input.action === "resolve_github_collab" || input.action === "resolve-github-collab") {
    const result = await resolveGithubCollaboratorPermission({
      owner: input.owner || "postfiatorg",
      repo: input.repo,
      username: input.username,
      token: input.providerToken,
      fetchImpl,
    });
    json(res, 200, {
      ok: true,
      action: "resolve_github_collab",
      result,
      routingImpact: "read_only_evidence_packet_no_badge_write",
    });
    return true;
  }

  if (input.action === "set_project_requirement") {
    const plan = projectBadgeRequirementRecord(requirementInput(input));
    const result = input.submit
      ? await upsertProjectBadgeRequirement(requirementInput(input))
      : {
          ok: true,
          dryRun: true,
          action: "set_project_requirement",
          plannedRequirement: plan,
          message: "Dry run only. Resend with submit=true to write network_project_badge_requirements.",
        };
    json(res, result.ok ? 200 : result.status || 400, { action: "set_project_requirement", ...result });
    return true;
  }

  if (input.action === "disable_project_requirement") {
    const result = input.submit
      ? await disableProjectBadgeRequirement(requirementInput(input))
      : {
          ok: true,
          dryRun: true,
          action: "disable_project_requirement",
          requirementId: input.requirementId || projectBadgeRequirementRecord(requirementInput(input)).id,
          message: "Dry run only. Resend with submit=true to disable the requirement row.",
        };
    json(res, result.ok ? 200 : result.status || 400, { action: "disable_project_requirement", ...result });
    return true;
  }

  if (input.action === "approve") {
    const result = input.submit
      ? await approveNetworkBadge({
          accountId: input.accountId,
          badgeId: input.badgeId,
          provider: input.provider,
          publicHandle: input.publicHandle,
          profileUrl: input.profileUrl,
          approvalLevel: input.approvalLevel,
          approvalScope: input.approvalScope,
          approvedByAccountId: input.approvedByAccountId,
          approvedByOperator: input.operator || "network_badge_admin_http",
          evidence: {
            source: "network_badge_admin_http",
            reason: input.reason,
            ...input.evidence,
          },
          metrics: input.metrics,
          selectedDefault: input.selectedDefault,
        })
      : dryRunApproval(input);
    json(res, result.ok ? 200 : result.status || 400, { action: "approve", ...result });
    return true;
  }

  if (input.action === "revoke") {
    const result = input.submit
      ? await revokeNetworkBadge({
          accountId: input.accountId,
          badgeId: input.badgeId,
          reason: input.reason,
          revokedByOperator: input.operator || "network_badge_admin_http",
        })
      : {
          ok: true,
          dryRun: true,
          action: "revoke",
          accountId: input.accountId,
          badgeId: input.badgeId,
          reason: input.reason || "operator_revoked",
        };
    json(res, result.ok ? 200 : result.status || 400, { action: "revoke", ...result });
    return true;
  }

  if (input.action === "expire") {
    const result = input.submit
      ? await expireNetworkBadge({
          accountId: input.accountId,
          badgeId: input.badgeId,
          reason: input.reason,
          expiredByOperator: input.operator || "network_badge_admin_http",
        })
      : {
          ok: true,
          dryRun: true,
          action: "expire",
          accountId: input.accountId,
          badgeId: input.badgeId,
          reason: input.reason || "operator_expired",
        };
    json(res, result.ok ? 200 : result.status || 400, { action: "expire", ...result });
    return true;
  }

  if (input.action === "default") {
    const result = input.submit
      ? await setDefaultNetworkBadge({
          accountId: input.accountId,
          badgeId: input.badgeId,
        })
      : {
          ok: true,
          dryRun: true,
          action: "default",
          accountId: input.accountId,
          badgeId: input.badgeId,
        };
    json(res, result.ok ? 200 : result.status || 400, { action: "default", ...result });
    return true;
  }

  json(res, 400, {
    ok: false,
    error: "network_badge_admin_unknown_action",
    message: "Use action list, approve, approve_from_verifier_job, revoke, expire, default, list_project_requirements, set_project_requirement, disable_project_requirement, list_verifier_jobs, enqueue_verifier_job, run_verifier_job, resolve_x, or resolve_github_collab.",
  });
  return true;
}
