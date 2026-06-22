#!/usr/bin/env node
import {
  approveNetworkBadge,
  expireNetworkBadge,
  getIdentityApprovalState,
  manualBadgeApprovalRecords,
  revokeNetworkBadge,
  setDefaultNetworkBadge,
} from "../server/repositories/identity-approvals.js";
import {
  approveNetworkBadgeFromVerifierJob,
  enqueueNetworkBadgeVerifierJob,
  listNetworkBadgeVerifierJobs,
  networkBadgeVerifierJobRecord,
  runNetworkBadgeVerifierJob,
} from "../server/repositories/network-badge-verifier-jobs.js";
import {
  resolveGithubCollaboratorPermission,
  resolveXUserMetrics,
} from "../server/repositories/identity-provider-resolvers.js";

function argMap(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function usage() {
  return `Network badge admin

Usage:
  node scripts/network-badge-admin.mjs list --account-id <account>
  node scripts/network-badge-admin.mjs approve --account-id <account> --badge-id <badge> --operator <name> [--public-handle <handle>] [--approval-scope badge:project_leader] [--submit]
  node scripts/network-badge-admin.mjs revoke --account-id <account> --badge-id <badge> --reason <reason> --operator <name> --submit
  node scripts/network-badge-admin.mjs expire --account-id <account> --badge-id <badge> --reason <reason> --operator <name> --submit
  node scripts/network-badge-admin.mjs default --account-id <account> --badge-id <badge> --submit
  node scripts/network-badge-admin.mjs resolve-x --username <handle>
  node scripts/network-badge-admin.mjs resolve-github-collab --owner postfiatorg --repo tasknodeofficial --username <handle>
  node scripts/network-badge-admin.mjs list-verifier-jobs [--account-id <account>] [--badge-id <badge>] [--status queued]
  node scripts/network-badge-admin.mjs enqueue-verifier-job --account-id <account> --verifier-type <type> [--badge-id <badge>] [--username <handle>] [--submit]
      verifier types: x_user_metrics, github_collaborator_permission, qa_worker_access, expert_access
  node scripts/network-badge-admin.mjs run-verifier-job --job-id <job> --submit
  node scripts/network-badge-admin.mjs approve-from-verifier-job --job-id <job> --operator <name> [--default] --submit

Rules:
  Mutating commands are dry-run by default. Add --submit to write to Postgres.
This tool never signs, routes, pays, bans, or moves PFT.`;
}

function text(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function json(value) {
  console.log(JSON.stringify(value, null, 2));
}

function verifierInput(args = {}) {
  return {
    username: args.username || args.handle,
    userId: args["user-id"] || args.userId,
    owner: args.owner,
    repo: args.repo,
    requiredOwner: args["required-owner"] || args.requiredOwner,
  };
}

function verifierJobInput(args = {}) {
  return {
    accountId: args["account-id"] || args.accountId,
    badgeId: args["badge-id"] || args.badgeId,
    provider: args.provider,
    verifierType: args["verifier-type"] || args.verifierType || args.type,
    input: verifierInput(args),
    requestedByAccountId: args["approved-by-account-id"] || args.approvedByAccountId,
    requestedByOperator: args.operator || "network_badge_admin",
    maxAttempts: args["max-attempts"] || args.maxAttempts,
    runAfter: args["run-after"] || args.runAfter,
  };
}

async function main() {
  const args = argMap();
  const command = args._[0] || "help";
  const submit = args.submit === true;
  if (command === "help" || args.help) {
    console.log(usage());
    return;
  }

  if (command === "list") {
    json(await getIdentityApprovalState({ accountId: args["account-id"] || args.accountId }));
    return;
  }

  if (command === "approve") {
    if (!submit) {
      json({
        ok: true,
        dryRun: true,
        action: "approve",
        plannedRecords: manualBadgeApprovalRecords({
          accountId: args["account-id"] || args.accountId,
          badgeId: args["badge-id"] || args.badgeId,
          provider: args.provider,
          publicHandle: args["public-handle"] || args.publicHandle,
          profileUrl: args["profile-url"] || args.profileUrl,
          approvalLevel: args["approval-level"] || args.approvalLevel,
          approvalScope: args["approval-scope"] || args.approvalScope,
          approvedByAccountId: args["approved-by-account-id"] || args.approvedByAccountId,
          approvedByOperator: args.operator || "network_badge_admin",
          evidence: {
            reason: args.reason || "",
            dryRun: true,
          },
          selectedDefault: args.default === true,
        }),
      });
      return;
    }
    json(await approveNetworkBadge({
      accountId: args["account-id"] || args.accountId,
      badgeId: args["badge-id"] || args.badgeId,
      provider: args.provider,
      publicHandle: args["public-handle"] || args.publicHandle,
      profileUrl: args["profile-url"] || args.profileUrl,
      approvalLevel: args["approval-level"] || args.approvalLevel,
      approvalScope: args["approval-scope"] || args.approvalScope,
      approvedByAccountId: args["approved-by-account-id"] || args.approvedByAccountId,
      approvedByOperator: args.operator || "network_badge_admin",
      evidence: {
        reason: args.reason || "",
        source: "network_badge_admin_cli",
      },
      selectedDefault: args.default === true,
    }));
    return;
  }

  if (command === "resolve-x") {
    json(await resolveXUserMetrics({
      username: args.username || args.handle,
      userId: args["user-id"] || args.userId,
      bearerToken: args.token || "",
    }));
    return;
  }

  if (command === "resolve-github-collab") {
    json(await resolveGithubCollaboratorPermission({
      owner: args.owner || "postfiatorg",
      repo: args.repo,
      username: args.username || args.handle,
      token: args.token || "",
    }));
    return;
  }

  if (command === "list-verifier-jobs") {
    json({
      ok: true,
      action: "list-verifier-jobs",
      jobs: await listNetworkBadgeVerifierJobs({
        accountId: args["account-id"] || args.accountId,
        badgeId: args["badge-id"] || args.badgeId,
        status: args.status,
        limit: args.limit,
      }),
    });
    return;
  }

  if (command === "enqueue-verifier-job") {
    if (!submit) {
      json({
        ok: true,
        dryRun: true,
        action: "enqueue-verifier-job",
        plannedJob: networkBadgeVerifierJobRecord(verifierJobInput(args)),
        message: "Dry run only. Add --submit to write network_badge_verifier_jobs.",
      });
      return;
    }
    json(await enqueueNetworkBadgeVerifierJob(verifierJobInput(args)));
    return;
  }

  if (command === "run-verifier-job") {
    if (!submit) {
      json({
        ok: true,
        dryRun: true,
        action: "run-verifier-job",
        jobId: text(args["job-id"] || args.jobId, 180),
        message: "Dry run only. Add --submit to mark and run the queued verifier job.",
      });
      return;
    }
    json(await runNetworkBadgeVerifierJob({
      jobId: args["job-id"] || args.jobId,
      approvedByAccountId: args["approved-by-account-id"] || args.approvedByAccountId,
      approvedByOperator: args.operator || "network_badge_admin",
    }));
    return;
  }

  if (command === "approve-from-verifier-job") {
    if (!submit) {
      json({
        ok: true,
        dryRun: true,
        action: "approve-from-verifier-job",
        jobId: text(args["job-id"] || args.jobId, 180),
        selectedDefault: args.default === true,
        message: "Dry run only. Add --submit to approve the badge from a succeeded, recommended verifier job.",
      });
      return;
    }
    json(await approveNetworkBadgeFromVerifierJob({
      jobId: args["job-id"] || args.jobId,
      approvedByAccountId: args["approved-by-account-id"] || args.approvedByAccountId,
      approvedByOperator: args.operator || "network_badge_admin",
      selectedDefault: args.default === true,
    }));
    return;
  }

  if (command === "revoke") {
    if (!submit) {
      json({
        ok: true,
        dryRun: true,
        action: "revoke",
        accountId: text(args["account-id"] || args.accountId, 180),
        badgeId: text(args["badge-id"] || args.badgeId, 80),
        reason: text(args.reason || "operator_revoked", 500),
      });
      return;
    }
    json(await revokeNetworkBadge({
      accountId: args["account-id"] || args.accountId,
      badgeId: args["badge-id"] || args.badgeId,
      reason: args.reason,
      revokedByOperator: args.operator || "network_badge_admin",
    }));
    return;
  }

  if (command === "expire") {
    if (!submit) {
      json({
        ok: true,
        dryRun: true,
        action: "expire",
        accountId: text(args["account-id"] || args.accountId, 180),
        badgeId: text(args["badge-id"] || args.badgeId, 80),
        reason: text(args.reason || "operator_expired", 500),
      });
      return;
    }
    json(await expireNetworkBadge({
      accountId: args["account-id"] || args.accountId,
      badgeId: args["badge-id"] || args.badgeId,
      reason: args.reason,
      expiredByOperator: args.operator || "network_badge_admin",
    }));
    return;
  }

  if (command === "default") {
    if (!submit) {
      json({
        ok: true,
        dryRun: true,
        action: "default",
        accountId: text(args["account-id"] || args.accountId, 180),
        badgeId: text(args["badge-id"] || args.badgeId, 80),
      });
      return;
    }
    json(await setDefaultNetworkBadge({
      accountId: args["account-id"] || args.accountId,
      badgeId: args["badge-id"] || args.badgeId,
    }));
    return;
  }

  console.error(`Unknown command: ${command}\n\n${usage()}`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
