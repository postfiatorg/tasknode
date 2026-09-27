// Value accountability and account blacklist (2026-09-26).
//
// Accounts paid for work the network task content policy now bans must justify
// it through one mandatory accountability task: concrete, verifiable evidence
// that the work accreted Post Fiat market cap, plus a Discord sign-off from a
// different member. The board manager (Kimi) judges strictly. Rejection,
// refusal or a missed deadline blacklists the account. Blacklisted accounts get
// no new network tasks and no reward payments. The operator can lift an entry.

import crypto from "node:crypto";
import { query } from "./db/pool.js";
import {
  NETWORK_TASK_CONTENT_POLICY_VERSION,
  networkTaskContentViolation,
} from "./network-task-content-policy.js";

export const VALUE_ACCOUNTABILITY_BOARD_ID = "board_value_accountability";
export const VALUE_ACCOUNTABILITY_COHORT_POLICY = NETWORK_TASK_CONTENT_POLICY_VERSION;
export const VALUE_ACCOUNTABILITY_OPERATOR_HANDLE = "goodalexander";
export const VALUE_ACCOUNTABILITY_DEFAULT_DEADLINE_HOURS = 168;

function safeText(value = "", max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function id(prefix, seed) {
  return `${prefix}_${crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 24)}`;
}

function normalizeWallet(value = "") {
  return safeText(value, 120);
}

// ---------------------------------------------------------------- blacklist

export async function activeBlacklistEntry({ accountId = "", walletAddress = "" } = {}) {
  const account = safeText(accountId, 180);
  const wallet = normalizeWallet(walletAddress);
  if (!account && !wallet) return null;
  const result = await query(
    `SELECT id, account_id, public_handle, reason_code, reason, created_at
       FROM account_blacklist
      WHERE status = 'active'
        AND (($1 <> '' AND account_id = $1) OR ($2 <> '' AND $2 = ANY(wallet_addresses)))
      LIMIT 1`,
    [account, wallet]
  );
  return result.rows[0] || null;
}

export async function assertNotBlacklisted({ accountId = "", walletAddress = "", action = "" } = {}) {
  const entry = await activeBlacklistEntry({ accountId, walletAddress });
  if (!entry) return;
  throw Object.assign(
    new Error(`account_blacklisted${action ? `:${action}` : ""}: ${entry.reason_code}`),
    { status: 403, code: "account_blacklisted", blacklistId: entry.id }
  );
}

async function accountIdentity(accountId) {
  const account = await query(
    "SELECT hive_handle FROM app_accounts WHERE account_id = $1 LIMIT 1",
    [accountId]
  );
  const wallets = await query(
    `SELECT DISTINCT wallet FROM (
       SELECT subject_wallet AS wallet FROM task_projections WHERE account_id = $1 AND subject_wallet IS NOT NULL
     ) w WHERE wallet <> ''`,
    [accountId]
  );
  let linked = "";
  try {
    const { getLinkedWallet } = await import("./repositories/account-wallets.js");
    const found = await getLinkedWallet({ accountId });
    linked = found?.status === "linked" ? found.address || "" : "";
  } catch {
    linked = "";
  }
  const walletSet = new Set(wallets.rows.map((row) => row.wallet).filter(Boolean));
  if (linked) walletSet.add(linked);
  return { handle: safeText(account.rows[0]?.hive_handle, 120), wallets: [...walletSet] };
}

export async function blacklistAccount({
  accountId,
  reasonCode,
  reason = "",
  evidence = {},
  source = "operator",
  caseId = "",
  createdBy = "",
} = {}) {
  const account = safeText(accountId, 180);
  if (!account || !safeText(reasonCode, 120)) throw new Error("blacklistAccount requires accountId and reasonCode");
  const existing = await activeBlacklistEntry({ accountId: account });
  if (existing) return { created: false, entry: existing };
  const identity = await accountIdentity(account);
  const entryId = id("blk", `${account}:${Date.now()}`);
  const result = await query(
    `INSERT INTO account_blacklist
       (id, account_id, wallet_addresses, public_handle, reason_code, reason, evidence_json, source, case_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
     ON CONFLICT (account_id) WHERE status = 'active' DO NOTHING
     RETURNING id, account_id, public_handle, reason_code, reason, created_at`,
    [
      entryId,
      account,
      identity.wallets,
      identity.handle,
      safeText(reasonCode, 120),
      safeText(reason, 2000),
      JSON.stringify(evidence || {}),
      safeText(source, 60),
      safeText(caseId, 120),
      safeText(createdBy, 180),
    ]
  );
  return { created: Boolean(result.rows[0]), entry: result.rows[0] || (await activeBlacklistEntry({ accountId: account })) };
}

export async function liftBlacklist({ accountId, reason, liftedBy = "" } = {}) {
  if (!safeText(reason)) throw new Error("liftBlacklist requires a reason");
  const result = await query(
    `UPDATE account_blacklist
        SET status = 'lifted', lifted_at = now(), lifted_by = $2, lift_reason = $3
      WHERE account_id = $1 AND status = 'active'
      RETURNING id`,
    [safeText(accountId, 180), safeText(liftedBy, 180), safeText(reason, 2000)]
  );
  return { lifted: result.rowCount > 0 };
}

export async function listPublicBlacklist({ limit = 500 } = {}) {
  const result = await query(
    `SELECT b.public_handle, b.reason_code, b.reason, b.source, b.created_at,
            c.flagged_task_count, c.flagged_pft
       FROM account_blacklist b
       LEFT JOIN value_accountability_cases c ON c.id = b.case_id
      WHERE b.status = 'active'
      ORDER BY b.created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || 500, 2000))]
  );
  return result.rows.map((row) => ({
    handle: row.public_handle || "(no public handle)",
    reason_code: row.reason_code,
    reason: row.reason,
    source: row.source,
    blacklisted_at: row.created_at,
    flagged_task_count: Number(row.flagged_task_count || 0),
    flagged_pft: Number(row.flagged_pft || 0),
  }));
}

// ---------------------------------------------------------------- cohort

export async function computeValueAccountabilityCohort() {
  const operator = await query(
    "SELECT account_id FROM app_accounts WHERE lower(hive_handle) = lower($1)",
    [VALUE_ACCOUNTABILITY_OPERATOR_HANDLE]
  );
  const operatorIds = new Set(operator.rows.map((row) => row.account_id));
  const tasks = await query(
    `SELECT task_id, account_id, subject_wallet, title, description, reward_actual_pft::float AS pft
       FROM task_projections
      WHERE task_kind = 'network' AND status = 'rewarded' AND coalesce(reward_actual_pft, 0) > 0
        AND account_id IS NOT NULL`
  );
  const byAccount = new Map();
  for (const task of tasks.rows) {
    if (operatorIds.has(task.account_id)) continue;
    if (!networkTaskContentViolation(task.title, task.description)) continue;
    const entry = byAccount.get(task.account_id) || { accountId: task.account_id, wallet: task.subject_wallet || "", taskIds: [], titles: [], pft: 0 };
    entry.taskIds.push(task.task_id);
    entry.titles.push(safeText(task.title, 160));
    entry.pft += Number(task.pft || 0);
    byAccount.set(task.account_id, entry);
  }
  return [...byAccount.values()].sort((a, b) => b.pft - a.pft);
}

// ---------------------------------------------------------------- cases

export async function upsertCase({ accountId, wallet, handle, taskIds, pft }) {
  const caseId = id("vac", `${accountId}:${VALUE_ACCOUNTABILITY_COHORT_POLICY}`);
  const result = await query(
    `INSERT INTO value_accountability_cases
       (id, account_id, wallet_address, public_handle, cohort_policy, flagged_task_ids, flagged_task_count, flagged_pft)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id, cohort_policy) DO UPDATE
       SET wallet_address = EXCLUDED.wallet_address,
           public_handle = EXCLUDED.public_handle,
           flagged_task_ids = EXCLUDED.flagged_task_ids,
           flagged_task_count = EXCLUDED.flagged_task_count,
           flagged_pft = EXCLUDED.flagged_pft,
           updated_at = now()
     RETURNING *`,
    [caseId, accountId, wallet || "", handle || "", VALUE_ACCOUNTABILITY_COHORT_POLICY, taskIds, taskIds.length, pft]
  );
  return result.rows[0];
}

export async function markCaseIssued({ caseId, runId, deadlineAt }) {
  await query(
    `UPDATE value_accountability_cases
        SET status = 'issued', board_manager_run_id = $2, deadline_at = $3, updated_at = now()
      WHERE id = $1 AND status = 'pending_issue'`,
    [caseId, safeText(runId, 180), deadlineAt]
  );
}

// Link issued cases to the task the generation worker produced for their run.
export async function linkIssuedCaseTasks() {
  const result = await query(
    `UPDATE value_accountability_cases c
        SET accountability_task_id = j.task_id, updated_at = now()
       FROM network_task_generation_jobs j
      WHERE c.status = 'issued' AND c.accountability_task_id = ''
        AND j.board_manager_run_id = c.board_manager_run_id AND coalesce(j.task_id, '') <> ''
      RETURNING c.id`
  );
  return result.rowCount;
}

export async function caseForAccountabilityTask(taskId) {
  const result = await query(
    "SELECT * FROM value_accountability_cases WHERE accountability_task_id = $1 LIMIT 1",
    [safeText(taskId, 180)]
  );
  return result.rows[0] || null;
}

async function decideCase(caseRow, { status, verdict }) {
  await query(
    `UPDATE value_accountability_cases
        SET status = $2, verdict_json = $3::jsonb, decided_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'issued'`,
    [caseRow.id, status, JSON.stringify(verdict || {})]
  );
}

// Called when the board manager reviews an accountability task.
export async function recordAccountabilityVerdict({ taskId, decision, reason = "", decidedBy = "board_manager" }) {
  const caseRow = await caseForAccountabilityTask(taskId);
  if (!caseRow || caseRow.status !== "issued") return { handled: false };
  const verdict = { task_id: taskId, decision, reason: safeText(reason, 2000), decided_by: decidedBy, decided_at: new Date().toISOString() };
  if (decision === "accept") {
    await decideCase(caseRow, { status: "cleared", verdict });
    return { handled: true, status: "cleared" };
  }
  await decideCase(caseRow, { status: "blacklisted", verdict });
  const blacklisted = await blacklistAccount({
    accountId: caseRow.account_id,
    reasonCode: "value_accountability_rejected",
    reason: safeText(reason, 2000) || "Value check submission showed no checkable contribution to Post Fiat.",
    evidence: { case_id: caseRow.id, accountability_task_id: taskId, flagged_task_ids: caseRow.flagged_task_ids },
    source: "value_accountability",
    caseId: caseRow.id,
    createdBy: decidedBy,
  });
  return { handled: true, status: "blacklisted", blacklist: blacklisted.entry };
}

// Blacklist issued cases whose task was refused, cancelled by the user, or
// never satisfied by the deadline.
export async function enforceExpiredCases({ execute = false, now = new Date() } = {}) {
  await linkIssuedCaseTasks();
  const cases = await query(
    `SELECT c.*, t.status AS task_status
       FROM value_accountability_cases c
       LEFT JOIN task_projections t ON t.task_id = c.accountability_task_id
      WHERE c.status = 'issued'`
  );
  const actions = [];
  for (const row of cases.rows) {
    const refused = ["refused", "expired", "abandoned"].includes(String(row.task_status || ""));
    const overdue = row.deadline_at && new Date(row.deadline_at) <= now && row.task_status !== "rewarded";
    if (row.task_status === "rewarded") {
      actions.push({ caseId: row.id, accountId: row.account_id, action: "clear", reason: "accountability task accepted" });
      if (execute) await decideCase(row, { status: "cleared", verdict: { task_status: row.task_status, via: "sweep" } });
      continue;
    }
    if (!refused && !overdue) continue;
    const reasonCode = refused ? "value_accountability_refused" : "value_accountability_deadline_missed";
    actions.push({ caseId: row.id, accountId: row.account_id, action: "blacklist", reasonCode, taskStatus: row.task_status || "" });
    if (!execute) continue;
    await decideCase(row, { status: "blacklisted", verdict: { reason_code: reasonCode, task_status: row.task_status || "", via: "sweep" } });
    await blacklistAccount({
      accountId: row.account_id,
      reasonCode,
      reason: refused
        ? "Refused the mandatory value accountability task."
        : "Did not respond to the value check (Discord handle plus proof of any contribution) by the deadline.",
      evidence: { case_id: row.id, accountability_task_id: row.accountability_task_id, flagged_task_ids: row.flagged_task_ids },
      source: "value_accountability",
      caseId: row.id,
      createdBy: "value_accountability_sweep",
    });
  }
  return actions;
}
