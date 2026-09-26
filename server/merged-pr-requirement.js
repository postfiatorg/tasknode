// Merged-PR payment requirement for network tasks (operator policy, 2026-09-26).
//
// A network task is paid only for a GitHub pull request that is MERGED into the
// repository's default branch. An open, closed or draft PR is not evidence.
// All Post Fiat repositories are public, so the check reads the public GitHub
// API. To stop farming, the PR must be authored by the GitHub account linked to
// the contributor's Task Node account, merged after the task was created, and
// never already used to pay another task.
//
// Exempt: the Value Accountability board (its 1 PFT task is a verdict, not
// work) and operator duty referrals routed to the operator account.

import { query } from "./db/pool.js";

export const MERGED_PR_POLICY_VERSION = "network_task_merged_pr_v1";
export const MERGED_PR_EXEMPT_BOARDS = new Set(["board_value_accountability"]);
export const MERGED_PR_OPERATOR_HANDLE = "goodalexander";
export const MERGED_PR_REQUIREMENT_TEXT =
  "Payment requirement: this task pays only for a GitHub pull request authored by the GitHub account linked to your Task Node account and MERGED into the repository's default branch (main) after this task was created. Submit the PR URL. An open, unmerged, closed or draft PR is not evidence and will not be paid; neither is a PR that already paid another task.";

const PR_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

export function extractPullRequestRefs(...payloads) {
  const text = payloads.map((value) => (typeof value === "string" ? value : JSON.stringify(value ?? ""))).join("\n");
  const seen = new Map();
  for (const match of text.matchAll(PR_URL)) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/, "");
    const number = Number(match[3]);
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
    if (!seen.has(key)) seen.set(key, { owner, repo, number, key, url: `https://github.com/${owner}/${repo}/pull/${number}` });
  }
  return [...seen.values()];
}

async function githubJson(path, fetchImpl = fetch) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "tasknode-merged-pr-check" };
  const token = process.env.GITHUB_TOKEN || process.env.TASKNODE_GITHUB_TOKEN || "";
  if (token) headers.Authorization = `Bearer ${token}`;
  const base = process.env.GITHUB_API_BASE_URL || "https://api.github.com";
  const response = await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw Object.assign(new Error(`github_api_unavailable:${response.status}`), { status: 503, retryable: true });
  }
  return response.json();
}

export async function linkedGithubLogins(accountId) {
  const result = await query(
    "SELECT identity_json FROM account_provider_identities WHERE account_id = $1 AND provider = 'github'",
    [safeText(accountId, 180)]
  );
  return result.rows
    .map((row) => safeText(row.identity_json?.username || row.identity_json?.login, 120).toLowerCase())
    .filter(Boolean);
}

async function prAlreadyPaid(prKey, taskId) {
  const result = await query(
    `SELECT task_id FROM task_projections
      WHERE task_id <> $2 AND metadata_json->'merged_pr_evidence'->>'key' = $1
        AND status = 'rewarded'
      LIMIT 1`,
    [prKey, taskId]
  );
  return result.rows[0]?.task_id || "";
}

// Returns { ok: true, evidence } or { ok: false, reason, detail }.
export async function verifyMergedPullRequest({ taskId, accountId, taskCreatedAt, evidencePayloads = [], fetchImpl = fetch } = {}) {
  const refs = extractPullRequestRefs(...evidencePayloads);
  if (!refs.length) return { ok: false, reason: "no_pull_request_url", detail: "No GitHub pull request URL was submitted." };
  const logins = await linkedGithubLogins(accountId);
  if (!logins.length) {
    return { ok: false, reason: "github_not_linked", detail: "Link your GitHub account in Task Node; payment requires a PR you authored." };
  }
  const failures = [];
  for (const ref of refs) {
    const pr = await githubJson(`/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, fetchImpl);
    if (!pr) { failures.push(`${ref.url}: not found`); continue; }
    const defaultBranch = pr.base?.repo?.default_branch || "";
    const author = safeText(pr.user?.login, 120).toLowerCase();
    if (!pr.merged || !pr.merged_at) { failures.push(`${ref.url}: not merged`); continue; }
    if (!defaultBranch || pr.base?.ref !== defaultBranch) { failures.push(`${ref.url}: merged into ${pr.base?.ref || "?"}, not ${defaultBranch || "the default branch"}`); continue; }
    if (!logins.includes(author)) { failures.push(`${ref.url}: authored by ${author || "?"}, not your linked GitHub (${logins.join(", ")})`); continue; }
    if (taskCreatedAt && new Date(pr.merged_at) < new Date(taskCreatedAt)) { failures.push(`${ref.url}: merged before this task existed`); continue; }
    const paidTask = await prAlreadyPaid(ref.key, taskId);
    if (paidTask) { failures.push(`${ref.url}: already paid task ${paidTask}`); continue; }
    return {
      ok: true,
      evidence: {
        policy: MERGED_PR_POLICY_VERSION,
        key: ref.key,
        url: ref.url,
        author,
        base_ref: pr.base.ref,
        merged_at: pr.merged_at,
        merge_commit_sha: pr.merge_commit_sha || "",
        verified_at: new Date().toISOString(),
      },
    };
  }
  return { ok: false, reason: "no_qualifying_merged_pull_request", detail: failures.join("; ") };
}

// Decide whether a task is subject to the requirement.
export async function mergedPrRequiredForTask(taskId) {
  const result = await query(
    `SELECT t.task_kind, t.account_id, t.created_at, a.project_id, lower(coalesce(acc.hive_handle, '')) AS handle
       FROM task_projections t
       LEFT JOIN LATERAL (
         SELECT project_id FROM network_task_allocations WHERE generated_task_id = t.task_id ORDER BY updated_at DESC LIMIT 1
       ) a ON true
       LEFT JOIN app_accounts acc ON acc.account_id = t.account_id
      WHERE t.task_id = $1`,
    [safeText(taskId, 180)]
  );
  const row = result.rows[0];
  if (!row) return { required: false, row: null };
  const isNetwork = row.task_kind === "network" || Boolean(row.project_id);
  const exempt = MERGED_PR_EXEMPT_BOARDS.has(row.project_id || "") || row.handle === MERGED_PR_OPERATOR_HANDLE;
  return { required: isNetwork && !exempt, row };
}

async function evidencePayloadsForTask(taskId, accountId) {
  const result = await query(
    `SELECT payload_json FROM task_events
      WHERE task_id = $1 AND account_id = $2
        AND event_type = ANY($3::text[])`,
    [taskId, accountId, ["pf.task.submission.v1", "pf.task.verification_response.v1"]]
  );
  return result.rows.map((row) => row.payload_json);
}

// Verify, record on the task, and throw if the task may not be paid.
export async function assertMergedPrForPayment({ taskId, fetchImpl = fetch } = {}) {
  const { required, row } = await mergedPrRequiredForTask(taskId);
  if (!required) return { required: false };
  const cached = await query(
    "SELECT metadata_json->'merged_pr_evidence' AS evidence FROM task_projections WHERE task_id = $1",
    [taskId]
  );
  const existing = cached.rows[0]?.evidence;
  if (existing?.policy === MERGED_PR_POLICY_VERSION && existing?.key) return { required: true, evidence: existing };
  const result = await verifyMergedPullRequest({
    taskId,
    accountId: row.account_id,
    taskCreatedAt: row.created_at,
    evidencePayloads: await evidencePayloadsForTask(taskId, row.account_id),
    fetchImpl,
  });
  if (!result.ok) {
    throw Object.assign(new Error(`merged_pr_required:${result.reason}: ${result.detail}`), {
      status: 422,
      code: "merged_pr_required",
      reason: result.reason,
    });
  }
  await query(
    `UPDATE task_projections
        SET metadata_json = jsonb_set(coalesce(metadata_json, '{}'::jsonb), '{merged_pr_evidence}', $2::jsonb, true),
            updated_at = now()
      WHERE task_id = $1`,
    [taskId, JSON.stringify(result.evidence)]
  );
  return { required: true, evidence: result.evidence };
}
