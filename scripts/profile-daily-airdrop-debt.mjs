#!/usr/bin/env node
import { closePool, databaseEnabled } from "../server/db/pool.js";
import { listDailyAirdropDebt } from "../server/profile-daily-airdrop-issuance.js";

if (process.env.DATABASE_URL && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length).trim();
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

try {
  if (!databaseEnabled()) throw new Error("database_not_configured");
  const debt = await listDailyAirdropDebt({
    sinceDate: argValue("--since-date", ""),
    limit: Number(argValue("--limit", "200")),
  });
  if (hasFlag("--json")) {
    console.log(JSON.stringify({ ok: true, count: debt.length, debt }, null, 2));
  } else if (!debt.length) {
    console.log("daily_airdrop_debt_count=0");
  } else {
    console.log(`daily_airdrop_debt_count=${debt.length}`);
    for (const item of debt) {
      console.log([
        `kind=${item.kind}`,
        `account=${item.publicHandle || item.accountId}`,
        `runDate=${item.runDate}`,
        `runId=${item.runId}`,
        item.issuanceId ? `issuanceId=${item.issuanceId}` : "",
        `amountPft=${item.amountPft}`,
        `status=${item.status}`,
        `nextAction=${item.nextAction}`,
        item.lastErrorCode ? `lastErrorCode=${item.lastErrorCode}` : "",
      ].filter(Boolean).join(" "));
    }
  }
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  await closePool().catch(() => null);
  process.exit(1);
}

await closePool().catch(() => null);
