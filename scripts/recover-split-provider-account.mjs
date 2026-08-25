#!/usr/bin/env node
import { closePool } from "../server/db/pool.js";
import { recoverSplitProviderAccount } from "../server/repositories/accounts.js";

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected_argument: ${token}`);
    if (token === "--execute" || token === "--help") {
      flags.add(token);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`argument_value_required: ${token}`);
    values[token.slice(2)] = value;
    index += 1;
  }
  return { values, flags };
}

const usage = [
  "Usage:",
  "  node scripts/recover-split-provider-account.mjs",
  "    --source <duplicate-account-id>",
  "    --target <recovered-account-id>",
  "    --provider <provider>",
  "    --provider-user-id <provider-user-id>",
  "    --wallet <wallet-address>",
  "    --operator <operator-name>",
  "    --reason <audit-reason>",
  "    [--expected-target-task-count <count>]",
  "    [--expected-target-verified-badge-count <count>]",
  "    [--actor-account-id <account-id>]",
  "    [--execute]",
  "",
  "Without --execute, the command validates every guard and prints a dry-run preview.",
].join("\n");

let exitCode = 0;
try {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("--help")) {
    console.log(usage);
  } else {
    const result = await recoverSplitProviderAccount({
      sourceAccountId: values.source,
      targetAccountId: values.target,
      provider: values.provider,
      providerUserId: values["provider-user-id"],
      expectedWalletAddress: values.wallet,
      actorAccountId: values["actor-account-id"] || "",
      actorOperator: values.operator,
      reason: values.reason,
      dryRun: !flags.has("--execute"),
      expectedTargetTaskCount: values["expected-target-task-count"] === undefined
        ? null
        : Number(values["expected-target-task-count"]),
      expectedTargetVerifiedBadgeCount: values["expected-target-verified-badge-count"] === undefined
        ? null
        : Number(values["expected-target-verified-badge-count"]),
    });
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  exitCode = 1;
  console.error(JSON.stringify({
    ok: false,
    error: error?.code || "account_recovery_failed",
    message: error?.message || "Account recovery failed.",
  }, null, 2));
} finally {
  await closePool();
}
process.exitCode = exitCode;
