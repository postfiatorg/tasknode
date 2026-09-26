// Value accountability operator CLI.
//
//   node scripts/value-accountability.mjs cohort [--json]
//   node scripts/value-accountability.mjs issue [--deadline-hours 168] [--limit N] [--execute]
//   node scripts/value-accountability.mjs enforce [--execute]
//   node scripts/value-accountability.mjs status [--json]
//   node scripts/value-accountability.mjs blacklist <accountId> --reason "..." [--execute]
//   node scripts/value-accountability.mjs lift <accountId> --reason "..." [--execute]
//
// Writes are dry runs unless --execute is passed.

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}
if (!process.env.DATABASE_STATEMENT_TIMEOUT_MS) process.env.DATABASE_STATEMENT_TIMEOUT_MS = "30000";

import { closePool, query } from "../server/db/pool.js";
import {
  VALUE_ACCOUNTABILITY_BOARD_ID,
  VALUE_ACCOUNTABILITY_DEFAULT_DEADLINE_HOURS,
  activeBlacklistEntry,
  blacklistAccount,
  computeValueAccountabilityCohort,
  enforceExpiredCases,
  liftBlacklist,
  linkIssuedCaseTasks,
  markCaseIssued,
  upsertCase,
} from "../server/value-accountability.js";

const [, , command = "", ...rest] = process.argv;
const positional = rest.filter((arg, index) => !arg.startsWith("--") && !rest[index - 1]?.startsWith("--"));
const execute = rest.includes("--execute");
const asJson = rest.includes("--json");
function flag(name, fallback = "") {
  const index = rest.indexOf(name);
  return index >= 0 && rest[index + 1] ? rest[index + 1] : fallback;
}

async function handleFor(accountId) {
  const row = (await query("SELECT hive_handle FROM app_accounts WHERE account_id = $1", [accountId])).rows[0];
  return row?.hive_handle || "";
}

async function linkedWallet(accountId, fallback) {
  const { getLinkedWallet } = await import("../server/repositories/account-wallets.js");
  const linked = await getLinkedWallet({ accountId });
  return linked?.status === "linked" && linked.address ? linked.address : fallback;
}

function needText({ handle, entry, deadlineAt }) {
  const titles = entry.titles.slice(0, 12).map((title, i) => `  - ${entry.taskIds[i]}: ${title}`).join("\n");
  const more = entry.titles.length > 12 ? `\n  - …and ${entry.titles.length - 12} more` : "";
  return [
    `MANDATORY VALUE ACCOUNTABILITY for ${handle ? `@${handle}` : "this account"}.`,
    `Task Node paid this account ${Math.round(entry.pft).toLocaleString("en-US")} PFT for ${entry.taskIds.length} network tasks whose work type is now banned as network work (commentary on published writing, or audit/review write-ups):`,
    titles + more,
    `To keep earning on Task Node, show that this paid work increased Post Fiat market cap. Submit before ${deadlineAt.toISOString()}:`,
    "1. Economic outcomes: specific, verifiable outcomes your paid work caused, such as new paying users, liquidity or trading volume, exchange listings, integrations, revenue or partnerships, each with a link a reviewer can open (on-chain transaction, exchange or DEX data, public metric, or a signed statement from the counterparty).",
    "2. Causation: for each outcome, the chain from your specific paid tasks to that outcome. Effort, word counts, views and likes do not count.",
    "3. Member sign-off: a link to a public message in the Post Fiat Discord from a different member (not you and not an account you control) naming the outcome they confirm and stating that it added market cap.",
    "Refusing this task, missing the deadline, or failing to demonstrate market-cap accretion blacklists this account: no further network tasks and no reward payments. The board manager judges strictly.",
  ].join("\n");
}

async function cohort() {
  const rows = await computeValueAccountabilityCohort();
  if (asJson) return console.log(JSON.stringify(rows, null, 2));
  let total = 0;
  for (const row of rows) {
    total += row.pft;
    const handle = await handleFor(row.accountId);
    const blacklisted = await activeBlacklistEntry({ accountId: row.accountId });
    console.log(`${row.accountId.padEnd(38)} ${(handle || "-").padEnd(22)} tasks=${String(row.taskIds.length).padStart(3)} pft=${String(Math.round(row.pft)).padStart(8)}${blacklisted ? " BLACKLISTED" : ""}`);
  }
  console.log(`accounts=${rows.length} flagged_pft=${Math.round(total)}`);
}

async function issue() {
  const deadlineHours = Math.max(24, Number(flag("--deadline-hours", VALUE_ACCOUNTABILITY_DEFAULT_DEADLINE_HOURS)) || VALUE_ACCOUNTABILITY_DEFAULT_DEADLINE_HOURS);
  const limit = Number(flag("--limit", "0")) || Infinity;
  const { taskCreate } = await import("./bm/writes.mjs");
  const rows = await computeValueAccountabilityCohort();
  let issued = 0;
  for (const entry of rows) {
    if (issued >= limit) break;
    if (await activeBlacklistEntry({ accountId: entry.accountId })) continue;
    const handle = await handleFor(entry.accountId);
    const wallet = await linkedWallet(entry.accountId, entry.wallet);
    if (!wallet) {
      console.log(`skip ${entry.accountId}: no wallet`);
      continue;
    }
    const caseRow = await upsertCase({ accountId: entry.accountId, wallet, handle, taskIds: entry.taskIds, pft: entry.pft });
    if (caseRow.status !== "pending_issue") {
      console.log(`skip ${entry.accountId}: case ${caseRow.status}`);
      continue;
    }
    const deadlineAt = new Date(Date.now() + deadlineHours * 3600 * 1000);
    const result = await taskCreate({
      boardId: VALUE_ACCOUNTABILITY_BOARD_ID,
      accountId: entry.accountId,
      wallet,
      need: needText({ handle, entry, deadlineAt }),
      reason: "Operator mandate 2026-09-26: value accountability for PFT paid on banned task shapes.",
      workType: "value_accountability",
      rewardMin: 0,
      rewardMax: 1,
      acceptWindowHours: deadlineHours,
      operatorDuty: true,
      execute,
    });
    const outcome = result.actionResult?.result || {};
    console.log(`${execute ? "ISSUED" : "DRY"} ${entry.accountId} @${handle || "-"} run=${result.runId} executed=${outcome.executed ?? false}${outcome.reason ? ` reason=${outcome.reason}` : ""}`);
    if (execute && outcome.executed !== false) {
      await markCaseIssued({ caseId: caseRow.id, runId: result.runId, deadlineAt });
      issued += 1;
    }
  }
  console.log(`${execute ? "issued" : "would issue"}=${execute ? issued : Math.min(rows.length, limit)} deadline_hours=${deadlineHours}`);
}

async function enforce() {
  const actions = await enforceExpiredCases({ execute });
  for (const action of actions) console.log(`${execute ? "APPLIED" : "DRY"} ${action.action} ${action.accountId} ${action.reasonCode || action.reason || ""} ${action.taskStatus || ""}`);
  console.log(`${execute ? "applied" : "would apply"}=${actions.length}`);
}

async function status() {
  await linkIssuedCaseTasks();
  const rows = (await query(
    `SELECT c.account_id, c.public_handle, c.status, c.flagged_task_count, c.flagged_pft::float AS pft,
            c.accountability_task_id, c.deadline_at, t.status AS task_status
       FROM value_accountability_cases c
       LEFT JOIN task_projections t ON t.task_id = c.accountability_task_id
      ORDER BY c.flagged_pft DESC`
  )).rows;
  if (asJson) return console.log(JSON.stringify(rows, null, 2));
  for (const row of rows) {
    console.log(`${row.status.padEnd(13)} ${(row.public_handle || "-").padEnd(22)} pft=${String(Math.round(row.pft)).padStart(8)} task=${row.accountability_task_id || "(generating)"} task_status=${row.task_status || "-"} deadline=${row.deadline_at ? new Date(row.deadline_at).toISOString() : "-"}`);
  }
  const counts = rows.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] || 0) + 1 }), {});
  console.log(JSON.stringify(counts));
}

async function manual(kind) {
  const accountId = positional[0];
  const reason = flag("--reason");
  if (!accountId || !reason) throw new Error(`Usage: ${kind} <accountId> --reason "..." [--execute]`);
  if (!execute) return console.log(`DRY ${kind} ${accountId}: ${reason}`);
  const result = kind === "lift"
    ? await liftBlacklist({ accountId, reason, liftedBy: "operator_cli" })
    : await blacklistAccount({ accountId, reasonCode: "operator_blacklist", reason, source: "operator", createdBy: "operator_cli" });
  console.log(JSON.stringify(result));
}

try {
  if (command === "cohort") await cohort();
  else if (command === "issue") await issue();
  else if (command === "enforce") await enforce();
  else if (command === "status") await status();
  else if (command === "blacklist") await manual("blacklist");
  else if (command === "lift") await manual("lift");
  else {
    console.error("Usage: value-accountability.mjs cohort|issue|enforce|status|blacklist|lift (see file header)");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
