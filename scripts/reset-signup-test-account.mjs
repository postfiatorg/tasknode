#!/usr/bin/env node
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closePool, databaseEnabled, query, transaction } from "../server/db/pool.js";

const defaultStorePath = process.env.TASKNODE_STORE_PATH || "/tmp/tasknodeofficial-runtime-store.json";
const blockingGrantStatuses = ["processing", "completed", "unknown"];
const creditKinds = new Set(["account_credit", "top_up_credit", "reward_credit", "refund_credit"]);
const accountDataExclusions = ["billing_accounts", "billing_ledger_entries"];

function usage() {
  return [
    "Reset an email signup test account and detach prior funding state by default.",
    "",
    "Usage:",
    "  npm run signup-reset -- --email run1066@protonmail.com",
    "  npm run signup-reset -- --email run1066@protonmail.com --execute --grant-mode reset",
    "",
    "Options:",
    "  --email <address>          Email account to reset. Required.",
    "  --store <path>             Runtime store JSON path. Defaults to TASKNODE_STORE_PATH or /tmp/tasknodeofficial-runtime-store.json.",
    "  --execute                  Mutate the store. Without this, the command is a dry run.",
    "  --deposit-mode <mode>      keep or retire. Default: retire.",
    "  --grant-mode <mode>        preserve or reset. Default: reset.",
    "  --billing-mode <mode>      archive, preserve, or delete. Default: archive.",
    "  --data-mode <mode>         archive or preserve non-billing Postgres account rows. Default: archive.",
    "  --actor <name>             Operator name for the audit event.",
    "  --reason <text>            Audit reason. Default: signup_reset_qa.",
    "  --no-backup                Do not write a .bak copy before mutation.",
    "  --help                     Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    actor: process.env.USER || "operator",
    backup: true,
    billingMode: "archive",
    dataMode: "archive",
    depositMode: "retire",
    execute: false,
    grantMode: "reset",
    reason: "signup_reset_qa",
    storePath: defaultStorePath,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--execute") options.execute = true;
    else if (arg === "--no-backup") options.backup = false;
    else if (arg === "--email") {
      options.email = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--store") {
      options.storePath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--deposit-mode") {
      options.depositMode = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--grant-mode") {
      options.grantMode = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--billing-mode") {
      options.billingMode = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--data-mode") {
      options.dataMode = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--actor") {
      options.actor = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--reason") {
      options.reason = argv[index + 1] || "";
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.email = String(options.email || "").trim();
  options.canonicalEmail = options.email.toLowerCase();
  options.storePath = path.resolve(String(options.storePath || "").trim());
  options.actor = String(options.actor || "operator").slice(0, 120);
  options.reason = String(options.reason || "signup_reset_qa").slice(0, 240);

  if (!options.help && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(options.canonicalEmail)) {
    throw new Error("--email must be a valid email address.");
  }
  if (!["keep", "retire"].includes(options.depositMode)) {
    throw new Error("--deposit-mode must be keep or retire.");
  }
  if (!["preserve", "reset"].includes(options.grantMode)) {
    throw new Error("--grant-mode must be preserve or reset.");
  }
  if (!["archive", "preserve", "delete"].includes(options.billingMode)) {
    throw new Error("--billing-mode must be archive, preserve, or delete.");
  }
  if (!["archive", "preserve"].includes(options.dataMode)) {
    throw new Error("--data-mode must be archive or preserve.");
  }
  return options;
}

function stableId(value, prefix) {
  const digest = createHash("sha256").update(String(value || "")).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function readStore(storePath) {
  if (!existsSync(storePath)) return {};
  return JSON.parse(readFileSync(storePath, "utf8"));
}

function objectMap(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function quoteIdentifier(value) {
  return `"${String(value || "").replaceAll("\"", "\"\"")}"`;
}

function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 1)}***@${domain}`;
}

function balanceSummary(deposit) {
  if (!deposit) return null;
  return {
    address: deposit.address || "",
    status: deposit.status || "",
    observedBalances: deposit.observedBalances || {},
    pendingBalances: deposit.pendingBalances || {},
    creditedBalances: deposit.creditedBalances || {},
    lastSyncAt: deposit.lastSyncAt || null,
  };
}

function runtimeLedgerSummary(entries) {
  return entries.reduce(
    (summary, entry) => {
      const amount = Number(entry?.amountUsd || entry?.amount_usd || 0);
      const kind = String(entry?.kind || "");
      summary.entryCount += 1;
      if (creditKinds.has(kind)) summary.creditUsd += amount;
      if (kind === "chat_debit") summary.debitUsd += amount;
      if (entry?.source === "ethereum_deposit" && creditKinds.has(kind)) {
        summary.ethereumDepositCreditUsd += amount;
      }
      return summary;
    },
    { entryCount: 0, creditUsd: 0, debitUsd: 0, ethereumDepositCreditUsd: 0 }
  );
}

async function databaseAccountRowSummary(accountId) {
  const tables = await query(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'account_id'
        AND table_name <> ALL($1::text[])
      ORDER BY table_name`,
    [accountDataExclusions]
  );
  const rows = [];
  for (const table of tables.rows) {
    const result = await query(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.table_name)} WHERE account_id = $1`, [accountId]);
    const count = Number(result.rows[0]?.count || 0);
    if (count > 0) rows.push({ table: table.table_name, count });
  }
  return rows;
}

function buildPlan(state, options) {
  const accountEmails = objectMap(state.accountEmails);
  const expectedEmailAccountId = stableId(options.canonicalEmail, "acct_email");
  const mappedAccountId = String(accountEmails[options.canonicalEmail] || "");
  const accountId = mappedAccountId || expectedEmailAccountId;
  const wallet = objectMap(state.accountWallets)[accountId] || null;
  const walletAddress = String(wallet?.address || "").trim();
  const grantMatches = list(state.walletInitiationGrants).filter((grant) => (
    grant?.accountId === accountId || (walletAddress && grant?.walletAddress === walletAddress)
  ));
  const runtimeLedgerEntries = list(state.ledgerEntries).filter((entry) => entry?.accountId === accountId);

  return {
    accountId,
    expectedEmailAccountId,
    mappedAccountId,
    account: objectMap(state.accounts)[accountId] || null,
    wallet,
    walletAddress,
    activeDeposit: objectMap(state.ethereumDepositAccounts)[accountId] || null,
    retiredDeposits: list(state.ethereumDepositRetiredAccounts).filter((deposit) => deposit?.accountId === accountId),
    sessionIds: Object.entries(objectMap(state.sessions))
      .filter(([, session]) => session?.accountId === accountId)
      .map(([id]) => id),
    emailChallengeIds: Object.entries(objectMap(state.emailChallenges))
      .filter(([, challenge]) => challenge?.canonicalEmail === options.canonicalEmail)
      .map(([id]) => id),
    oauthStateIds: Object.entries(objectMap(state.oauthStates))
      .filter(([, row]) => row?.linkAccountId === accountId)
      .map(([id]) => id),
    identityKeys: Object.entries(objectMap(state.accountIdentities))
      .filter(([, id]) => id === accountId)
      .map(([key]) => key),
    grantIds: grantMatches.map((grant) => grant?.id).filter(Boolean),
    runtimeLedgerEntryIds: runtimeLedgerEntries.map((entry) => entry?.id).filter(Boolean),
    runtimeLedgerSummary: runtimeLedgerSummary(runtimeLedgerEntries),
  };
}

function ensureStateBuckets(state) {
  state.accounts = objectMap(state.accounts);
  state.accountEmails = objectMap(state.accountEmails);
  state.accountIdentities = objectMap(state.accountIdentities);
  state.accountWallets = objectMap(state.accountWallets);
  state.sessions = objectMap(state.sessions);
  state.emailChallenges = objectMap(state.emailChallenges);
  state.oauthStates = objectMap(state.oauthStates);
  state.ledgerEntries = list(state.ledgerEntries);
  state.walletInitiationGrants = list(state.walletInitiationGrants);
  state.ethereumDepositAccounts = objectMap(state.ethereumDepositAccounts);
  state.ethereumDepositRetiredAccounts = list(state.ethereumDepositRetiredAccounts);
  state.ethereumDepositAddressIndex = objectMap(state.ethereumDepositAddressIndex);
  state.authEvents = list(state.authEvents);
}

function applyRuntimeReset(state, plan, options) {
  ensureStateBuckets(state);
  const now = new Date().toISOString();
  const archivedAccountId = options.dataMode === "archive" ? options.dataArchiveId : plan.accountId;
  const removed = {
    account: Boolean(state.accounts[plan.accountId]),
    accountEmail: state.accountEmails[options.canonicalEmail] === plan.accountId,
    walletLink: Boolean(state.accountWallets[plan.accountId]),
    sessions: plan.sessionIds.length,
    emailChallenges: plan.emailChallengeIds.length,
    oauthStates: plan.oauthStateIds.length,
    identities: plan.identityKeys.length,
    runtimeGrants: 0,
    runtimeLedgerEntries: 0,
    retiredDepositsArchived: 0,
  };

  if (options.depositMode === "retire" && state.ethereumDepositAccounts[plan.accountId]?.address) {
    const active = state.ethereumDepositAccounts[plan.accountId];
    state.ethereumDepositRetiredAccounts.push({
      ...active,
      accountId: archivedAccountId,
      status: "retired_signup_test_reset",
      retiredAt: now,
      retireReason: `signup_test_reset:${options.reason}`,
      archivedFromAccountId: plan.accountId,
      archivedAt: now,
    });
    delete state.ethereumDepositAddressIndex[String(active.address || "").toLowerCase()];
    delete state.ethereumDepositAccounts[plan.accountId];
  }
  if (options.dataMode === "archive") {
    for (const deposit of state.ethereumDepositRetiredAccounts) {
      if (deposit?.accountId !== plan.accountId) continue;
      deposit.accountId = archivedAccountId;
      deposit.archivedFromAccountId = plan.accountId;
      deposit.archivedAt = deposit.archivedAt || now;
      removed.retiredDepositsArchived += 1;
    }
  }

  delete state.accounts[plan.accountId];
  if (state.accountEmails[options.canonicalEmail] === plan.accountId) delete state.accountEmails[options.canonicalEmail];
  delete state.accountWallets[plan.accountId];
  for (const id of plan.sessionIds) delete state.sessions[id];
  for (const id of plan.emailChallengeIds) delete state.emailChallenges[id];
  for (const id of plan.oauthStateIds) delete state.oauthStates[id];
  for (const key of plan.identityKeys) delete state.accountIdentities[key];

  if (options.grantMode === "reset") {
    const grantIds = new Set(plan.grantIds);
    const before = state.walletInitiationGrants.length;
    state.walletInitiationGrants = state.walletInitiationGrants.filter((grant) => !grantIds.has(grant?.id));
    removed.runtimeGrants = before - state.walletInitiationGrants.length;
  }
  if (options.billingMode === "delete") {
    const entryIds = new Set(plan.runtimeLedgerEntryIds);
    const before = state.ledgerEntries.length;
    state.ledgerEntries = state.ledgerEntries.filter((entry) => !entryIds.has(entry?.id));
    removed.runtimeLedgerEntries = before - state.ledgerEntries.length;
  } else if (options.billingMode === "archive") {
    for (const entry of state.ledgerEntries) {
      if (entry?.accountId !== plan.accountId) continue;
      entry.accountId = options.billingArchiveId;
      entry.archivedFromAccountId = plan.accountId;
      entry.archivedAt = now;
      removed.runtimeLedgerEntries += 1;
    }
  }

  state.authEvents.push({
    id: randomUUID(),
    accountId: plan.accountId,
    eventType: "signup_test_account_purged",
    provider: "email",
    email: maskEmail(options.canonicalEmail),
    decision: "accepted",
    metadata: {
      actor: options.actor,
      canonicalEmail: options.canonicalEmail,
      depositMode: options.depositMode,
      grantMode: options.grantMode,
      billingMode: options.billingMode,
      billingArchiveId: options.billingArchiveId || null,
      reason: options.reason,
      walletAddress: plan.walletAddress || null,
      activeDeposit: balanceSummary(plan.activeDeposit),
      removed,
    },
    createdAt: now,
  });
  state.authEvents = state.authEvents.slice(-1000);
  return removed;
}

async function databaseSummary(plan) {
  if (!databaseEnabled()) return { enabled: false };
  try {
    const grants = await query(
      `SELECT id, status, account_id, wallet_address, amount_pft, tx_hash, updated_at
         FROM wallet_initiation_grants
        WHERE account_id = $1 OR wallet_address = $2
        ORDER BY updated_at DESC
        LIMIT 20`,
      [plan.accountId, plan.walletAddress || ""]
    );
    const billing = await query(
      `SELECT COUNT(*) AS entry_count,
              COALESCE(SUM(CASE WHEN kind = ANY($2::text[]) THEN amount_usd ELSE 0 END), 0) AS credit_usd,
              COALESCE(SUM(CASE WHEN kind = 'chat_debit' THEN amount_usd ELSE 0 END), 0) AS debit_usd,
              COALESCE(SUM(CASE WHEN source = 'ethereum_deposit' AND kind = ANY($2::text[]) THEN amount_usd ELSE 0 END), 0) AS ethereum_deposit_credit_usd,
              EXISTS(SELECT 1 FROM billing_accounts WHERE account_id = $1) AS account_exists
         FROM billing_ledger_entries
        WHERE account_id = $1`,
      [plan.accountId, Array.from(creditKinds)]
    );
    const accountRows = await databaseAccountRowSummary(plan.accountId);
    return {
      enabled: true,
      grants: grants.rows.map((row) => ({
        id: row.id,
        status: row.status,
        accountId: row.account_id,
        walletAddress: row.wallet_address,
        amountPft: Number(row.amount_pft || 0),
        txHash: row.tx_hash || "",
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      })),
      billing: {
        entryCount: Number(billing.rows[0]?.entry_count || 0),
        creditUsd: Number(billing.rows[0]?.credit_usd || 0),
        debitUsd: Number(billing.rows[0]?.debit_usd || 0),
        ethereumDepositCreditUsd: Number(billing.rows[0]?.ethereum_deposit_credit_usd || 0),
        accountExists: billing.rows[0]?.account_exists === true,
      },
      accountRows,
    };
  } catch (error) {
    return { enabled: true, error: error?.message || "database_summary_failed" };
  }
}

async function resetDatabaseAccountRows(plan, options) {
  if (!databaseEnabled() || options.dataMode === "preserve") return { changed: 0, skipped: !databaseEnabled() };
  return transaction(async (client) => {
    const tables = await client.query(
      `SELECT table_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'account_id'
          AND table_name <> ALL($1::text[])
        ORDER BY table_name`,
      [accountDataExclusions]
    );
    const changed = {};
    let totalRows = 0;
    for (const table of tables.rows) {
      const result = await client.query(
        `UPDATE ${quoteIdentifier(table.table_name)} SET account_id = $2 WHERE account_id = $1`,
        [plan.accountId, options.dataArchiveId]
      );
      if (result.rowCount > 0) {
        changed[table.table_name] = result.rowCount;
        totalRows += result.rowCount;
      }
    }
    return { mode: "archive", archiveId: options.dataArchiveId, totalRows, tables: changed };
  });
}

async function resetDatabaseBilling(plan, options) {
  if (!databaseEnabled() || options.billingMode === "preserve") return { changed: 0, skipped: !databaseEnabled() };
  return transaction(async (client) => {
    if (options.billingMode === "delete") {
      const ledger = await client.query("DELETE FROM billing_ledger_entries WHERE account_id = $1", [plan.accountId]);
      const account = await client.query("DELETE FROM billing_accounts WHERE account_id = $1", [plan.accountId]);
      return { mode: "delete", ledgerRows: ledger.rowCount, billingAccounts: account.rowCount };
    }
    const ledger = await client.query(
      "UPDATE billing_ledger_entries SET account_id = $2 WHERE account_id = $1",
      [plan.accountId, options.billingArchiveId]
    );
    const account = await client.query(
      "UPDATE billing_accounts SET account_id = $2, status = 'archived', updated_at = now() WHERE account_id = $1",
      [plan.accountId, options.billingArchiveId]
    );
    return { mode: "archive", archiveId: options.billingArchiveId, ledgerRows: ledger.rowCount, billingAccounts: account.rowCount };
  });
}

async function resetDatabaseGrants(plan, options) {
  if (!databaseEnabled() || options.grantMode !== "reset") return { changed: 0, skipped: !databaseEnabled() };
  const result = await query(
    `UPDATE wallet_initiation_grants
        SET status = 'failed',
            error_message = $4,
            updated_at = now()
      WHERE status = ANY($1::text[])
        AND (account_id = $2 OR wallet_address = $3)
      RETURNING id`,
    [
      blockingGrantStatuses,
      plan.accountId,
      plan.walletAddress || "",
      `reset by signup QA purge: ${options.reason}`,
    ]
  );
  return { changed: result.rowCount, grantIds: result.rows.map((row) => row.id) };
}

function hasAnyResetTarget(plan, dbBefore = {}) {
  return Boolean(
    plan.account ||
    plan.mappedAccountId ||
    plan.wallet ||
    plan.activeDeposit ||
    plan.retiredDeposits.length ||
    plan.sessionIds.length ||
    plan.emailChallengeIds.length ||
    plan.oauthStateIds.length ||
    plan.identityKeys.length ||
    plan.grantIds.length ||
    list(dbBefore.grants).length ||
    Number(dbBefore.billing?.entryCount || 0) > 0 ||
    dbBefore.billing?.accountExists === true ||
    list(dbBefore.accountRows).length > 0
  );
}

function warningsFor(plan, options, dbBefore) {
  const warnings = [];
  warnings.push("Stop or restart the API around --execute so in-memory runtime-store state cannot overwrite the JSON reset.");
  if (options.grantMode === "reset") {
    warnings.push("grant-mode reset can make a test account eligible for another faucet grant; use only for QA accounts.");
  }
  if (options.depositMode === "retire") {
    warnings.push("deposit-mode retire preserves the old deposit record in retired deposits but allocates a new top-up address after signup.");
  }
  if (options.billingMode === "archive") {
    warnings.push("billing-mode archive detaches prior credit/debit rows from the reusable email account so the next signup starts at $0.");
  }
  if (options.dataMode === "archive") {
    warnings.push("data-mode archive detaches chat/task/context/cache rows from the reusable email account.");
  }
  if (dbBefore?.error) warnings.push(`Postgres summary failed: ${dbBefore.error}`);
  return warnings;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const state = readStore(options.storePath);
  ensureStateBuckets(state);
  const plan = buildPlan(state, options);
  const dbBefore = await databaseSummary(plan);
  let runtimeRemoved = null;
  let databaseGrantReset = null;
  let databaseBillingReset = null;
  let databaseDataReset = null;
  let backupPath = null;
  options.billingArchiveId = `archived_signup_reset_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}_${plan.accountId}`.slice(0, 240);
  options.dataArchiveId = `archived_account_purge_${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}_${plan.accountId}`.slice(0, 240);

  const foundTarget = hasAnyResetTarget(plan, dbBefore);

  if (options.execute && foundTarget) {
    if (options.grantMode === "reset") databaseGrantReset = await resetDatabaseGrants(plan, options);
    databaseBillingReset = await resetDatabaseBilling(plan, options);
    databaseDataReset = await resetDatabaseAccountRows(plan, options);
    if (options.backup && existsSync(options.storePath)) {
      backupPath = `${options.storePath}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
      copyFileSync(options.storePath, backupPath);
    }
    runtimeRemoved = applyRuntimeReset(state, plan, options);
    mkdirSync(path.dirname(options.storePath), { recursive: true });
    writeFileSync(options.storePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  const summary = {
    dryRun: !options.execute,
    changed: Boolean(options.execute && foundTarget),
    email: options.canonicalEmail,
    accountId: plan.accountId,
    storePath: options.storePath,
    backupPath,
    depositMode: options.depositMode,
    grantMode: options.grantMode,
    billingMode: options.billingMode,
    billingArchiveId: options.billingMode === "archive" ? options.billingArchiveId : null,
    dataMode: options.dataMode,
    dataArchiveId: options.dataMode === "archive" ? options.dataArchiveId : null,
    found: foundTarget,
    preserved: {
      activeDeposit: options.depositMode === "keep" ? balanceSummary(plan.activeDeposit) : null,
      retiredDepositCount: plan.retiredDeposits.length,
      runtimeLedger: plan.runtimeLedgerSummary,
      database: dbBefore,
    },
    removed: runtimeRemoved || {
      account: Boolean(plan.account),
      walletLink: Boolean(plan.wallet),
      sessions: plan.sessionIds.length,
      emailChallenges: plan.emailChallengeIds.length,
      oauthStates: plan.oauthStateIds.length,
      identities: plan.identityKeys.length,
      runtimeGrants: options.grantMode === "reset" ? plan.grantIds.length : 0,
      runtimeLedgerEntries: options.billingMode === "preserve" ? 0 : plan.runtimeLedgerEntryIds.length,
    },
    databaseGrantReset,
    databaseBillingReset,
    databaseDataReset,
    warnings: warningsFor(plan, options, dbBefore),
    nextSteps: options.execute
      ? ["Restart the API process.", "Sign up with the same email and verify wallet/top-up state."]
      : ["Re-run with --execute after stopping the API process if the dry-run plan is correct."],
  };

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error?.message || "signup reset failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
