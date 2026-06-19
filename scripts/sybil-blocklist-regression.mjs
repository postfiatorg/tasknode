#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const XRPL_WALLET_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

const LINEAGE = [
  {
    taskId: "task_2ec03c162f35f5060453d1f5476fadf2",
    description: "XRPL Sybil Fund Flow Graph Script",
    rewardCid: "QmefkU6HW2okwUeuVVNuuDkwcNzGqfu7dyX3358RCX7QRr",
  },
  {
    taskId: "task_cc79625ec50467785ae070b1e4336fff",
    description: "Automated Sybil Blocklist Patch Generator",
    rewardCid: "QmbzyjFcUu4EHbW95GqBVKAeVJ3kUa8yGKY4nBmJxiRzUJ",
  },
  {
    taskId: "task_07f8a1bcb02702eadbbf797b29b70406",
    description: "Blocklist Propagation Verification Script",
  },
];

function usage() {
  return `Usage:
  node scripts/sybil-blocklist-regression.mjs \\
    --graph <historical-flow-graph.json> \\
    --blocklist <latest-blocklist-or-patch.json> \\
    [--base <base-blocklist.json>] \\
    [--report <report.json>] \\
    [--summary <summary.md>] \\
    [--count-review-entries-as-blocked] \\
    [--allow-gaps]

The command exits nonzero when historical flagged wallets are missing from the
deployable blocked set, unless --allow-gaps is supplied. Review-only candidates
are reported separately and do not count as blocked by default.`;
}

function parseArgs(argv) {
  const args = {
    base: null,
    blocklist: null,
    graph: null,
    report: null,
    summary: null,
    allowGaps: false,
    countReviewEntriesAsBlocked: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--allow-gaps") {
      args.allowGaps = true;
      continue;
    }
    if (arg === "--count-review-entries-as-blocked") {
      args.countReviewEntriesAsBlocked = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === "--base") {
      args.base = next;
    } else if (arg === "--blocklist") {
      args.blocklist = next;
    } else if (arg === "--graph") {
      args.graph = next;
    } else if (arg === "--report") {
      args.report = next;
    } else if (arg === "--summary") {
      args.summary = next;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  if (!args.graph || !args.blocklist) {
    throw new Error("--graph and --blocklist are required");
  }

  return args;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read JSON from ${filePath}: ${error.message}`);
  }
}

function isWallet(value) {
  return typeof value === "string" && XRPL_WALLET_RE.test(value);
}

function addWallet(set, value) {
  if (isWallet(value)) {
    set.add(value);
  }
}

function collectWalletsRecursively(value, set = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWalletsRecursively(item, set);
    }
    return set;
  }
  if (!value || typeof value !== "object") {
    addWallet(set, value);
    return set;
  }
  for (const item of Object.values(value)) {
    collectWalletsRecursively(item, set);
  }
  return set;
}

function collectWalletsFromEntries(entries, set) {
  if (!Array.isArray(entries)) {
    return;
  }
  for (const entry of entries) {
    if (typeof entry === "string") {
      addWallet(set, entry);
      continue;
    }
    if (!entry || typeof entry !== "object") {
      continue;
    }
    addWallet(set, entry.wallet);
    addWallet(set, entry.address);
    addWallet(set, entry.account);
    addWallet(set, entry.account_address);
    if (entry.entry && typeof entry.entry === "object") {
      addWallet(set, entry.entry.wallet);
      addWallet(set, entry.entry.address);
      addWallet(set, entry.entry.account);
    }
  }
}

function collectHistoricalFlaggedWallets(graph) {
  const wallets = new Set();
  collectWalletsFromEntries(graph.flagged_wallets, wallets);

  for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
    if (node?.flagged === true || node?.isFlagged === true || node?.risk === "flagged") {
      addWallet(wallets, node.wallet);
      addWallet(wallets, node.address);
      addWallet(wallets, node.id);
    }
  }

  for (const funder of Array.isArray(graph.shared_funders) ? graph.shared_funders : []) {
    collectWalletsFromEntries(funder?.flagged_targets, wallets);
  }

  for (const sink of Array.isArray(graph.shared_sinks) ? graph.shared_sinks : []) {
    collectWalletsFromEntries(sink?.flagged_sources, wallets);
  }

  return wallets;
}

function collectConfigBlockedWallets(config) {
  const wallets = new Set();
  for (const key of [
    "banned_wallets_flat",
    "blocked_wallets_flat",
    "bannedWalletsFlat",
    "blockedWalletsFlat",
    "banned_wallets",
    "blocked_wallets",
    "bannedWallets",
    "blockedWallets",
    "wallets",
    "entries",
  ]) {
    collectWalletsFromEntries(config?.[key], wallets);
  }
  return wallets.size ? wallets : collectWalletsRecursively(config);
}

function collectPatchSurfaces(blocklist) {
  const patchOps = new Set();
  const addedEntries = new Set();
  const reviewEntries = new Set();
  const summaryDecisions = new Set();

  for (const op of Array.isArray(blocklist?.ops) ? blocklist.ops : []) {
    const opName = String(op?.op || op?.operation || "").toLowerCase();
    if (["add_ban", "add_block", "block_wallet", "ban_wallet", "add"].includes(opName)) {
      collectWalletsFromEntries([op?.entry ?? op], patchOps);
    }
  }

  collectWalletsFromEntries(blocklist?.added_entries, addedEntries);
  collectWalletsFromEntries(blocklist?.additions, addedEntries);
  collectWalletsFromEntries(blocklist?.review_entries, reviewEntries);
  collectWalletsFromEntries(blocklist?.manual_review, reviewEntries);
  collectWalletsFromEntries(blocklist?.summary?.decisions, summaryDecisions);

  return {
    patchOps,
    addedEntries,
    reviewEntries,
    summaryDecisions,
    allPatchReferences: collectWalletsRecursively(blocklist),
  };
}

function sorted(set) {
  return [...set].sort((a, b) => a.localeCompare(b));
}

function union(...sets) {
  const out = new Set();
  for (const set of sets) {
    for (const item of set) {
      out.add(item);
    }
  }
  return out;
}

function hasPatchShape(blocklist) {
  const schema = String(blocklist?.schema || blocklist?.target_schema || "").toLowerCase();
  return schema.includes("patch") || Array.isArray(blocklist?.ops) || Array.isArray(blocklist?.added_entries);
}

function buildReport({ args, baseConfig, blocklist, graph }) {
  const historicalWallets = collectHistoricalFlaggedWallets(graph);
  const baseBlocklist = baseConfig ? collectConfigBlockedWallets(baseConfig) : new Set();
  const patchLike = hasPatchShape(blocklist);
  const patchSurfaces = collectPatchSurfaces(blocklist);
  const blocklistConfig = patchLike ? new Set() : collectConfigBlockedWallets(blocklist);
  const blockedWallets = union(baseBlocklist, blocklistConfig, patchSurfaces.patchOps, patchSurfaces.addedEntries);

  if (args.countReviewEntriesAsBlocked) {
    for (const wallet of patchSurfaces.reviewEntries) {
      blockedWallets.add(wallet);
    }
  }

  const surfaceSets = {
    baseBlocklist,
    blocklistConfig,
    patchOps: patchSurfaces.patchOps,
    addedEntries: patchSurfaces.addedEntries,
    reviewEntries: patchSurfaces.reviewEntries,
    summaryDecisions: patchSurfaces.summaryDecisions,
    allPatchReferences: patchSurfaces.allPatchReferences,
  };

  const results = sorted(historicalWallets).map((wallet) => {
    const presentSurfaces = Object.entries(surfaceSets)
      .filter(([, set]) => set.has(wallet))
      .map(([name]) => name);
    const blocked = blockedWallets.has(wallet);
    return {
      wallet,
      status: blocked ? "pass" : "fail",
      expected: "blocked",
      observed: blocked ? "blocked" : "not_blocked",
      deployableBlocked: blocked,
      reviewOnly: !blocked && patchSurfaces.reviewEntries.has(wallet),
      presentSurfaces,
      gapReason: blocked
        ? null
        : patchSurfaces.reviewEntries.has(wallet)
          ? "Wallet is present only in review_entries, which is not a deployable block surface by default."
          : "Wallet is absent from deployable blocklist surfaces.",
    };
  });

  const failed = results.filter((result) => result.status === "fail");
  const passed = results.filter((result) => result.status === "pass");

  return {
    schema: "tasknode.sybil_blocklist_regression.v1",
    generatedAt: new Date().toISOString(),
    lineage: LINEAGE,
    inputs: {
      graph: path.resolve(args.graph),
      base: args.base ? path.resolve(args.base) : null,
      blocklist: path.resolve(args.blocklist),
    },
    policy: {
      historicalSource: "flagged_wallets plus explicitly flagged graph nodes/relationships",
      deployableSurfaces: [
        "base blocklist config wallet sets",
        "non-patch blocklist config wallet sets",
        "patch ops that add/ban/block wallets",
        "patch added_entries",
      ],
      reviewEntriesCountAsBlocked: args.countReviewEntriesAsBlocked,
    },
    surfaces: Object.fromEntries(
      Object.entries(surfaceSets).map(([name, set]) => [name, { count: set.size, wallets: sorted(set) }])
    ),
    results,
    summary: {
      totalHistoricalFlaggedWallets: historicalWallets.size,
      passed: passed.length,
      failed: failed.length,
      missingWallets: failed.map((result) => result.wallet),
      status: failed.length ? "fail" : "pass",
    },
  };
}

function buildSummary(report) {
  const lines = [];
  const { summary } = report;
  const status = summary.failed ? "FAIL" : "PASS";

  lines.push("# Blocklist Regression Summary");
  lines.push("");
  lines.push(`@goodalexander regression result: ${status}`);
  lines.push("");
  lines.push(`Historical flagged wallets tested: ${summary.totalHistoricalFlaggedWallets}`);
  lines.push(`Deployably blocked: ${summary.passed}`);
  lines.push(`Gaps: ${summary.failed}`);
  lines.push("");
  lines.push("## Tested Wallets");
  lines.push("");
  lines.push("| Wallet | Result | Evidence surfaces | Gap reason |");
  lines.push("| --- | --- | --- | --- |");
  for (const result of report.results) {
    lines.push(
      `| ${result.wallet} | ${result.status} | ${result.presentSurfaces.join(", ") || "none"} | ${
        result.gapReason || ""
      } |`
    );
  }
  lines.push("");
  lines.push("## Interpretation");
  lines.push("");
  if (summary.failed) {
    lines.push(
      "The regression test found historical Sybil-flow flagged wallets that are not present in deployable blocklist surfaces. Review-only entries are called out but do not satisfy the block requirement unless the command is run with --count-review-entries-as-blocked."
    );
    lines.push("");
    lines.push("Recommended action: update the automated blocklist generator or current blocklist config so every historical flagged wallet is either deployably blocked or explicitly documented with a reviewed exception.");
  } else {
    lines.push("Every historical Sybil-flow flagged wallet remained present in deployable blocklist surfaces.");
  }
  lines.push("");
  lines.push("## Command");
  lines.push("");
  lines.push("```bash");
  lines.push(
    `node scripts/sybil-blocklist-regression.mjs --graph ${report.inputs.graph} --blocklist ${report.inputs.blocklist}${
      report.inputs.base ? ` --base ${report.inputs.base}` : ""
    }`
  );
  lines.push("```");
  lines.push("");

  return `${lines.join("\n")}\n`;
}

async function writeOutput(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const graph = await readJson(args.graph);
  const blocklist = await readJson(args.blocklist);
  const baseConfig = args.base ? await readJson(args.base) : null;
  const report = buildReport({ args, baseConfig, blocklist, graph });
  const summary = buildSummary(report);

  if (args.report) {
    await writeOutput(args.report, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (args.summary) {
    await writeOutput(args.summary, summary);
  }

  console.log(
    JSON.stringify(
      {
        status: report.summary.status,
        totalHistoricalFlaggedWallets: report.summary.totalHistoricalFlaggedWallets,
        passed: report.summary.passed,
        failed: report.summary.failed,
        missingWallets: report.summary.missingWallets,
        report: args.report ? path.resolve(args.report) : null,
        summary: args.summary ? path.resolve(args.summary) : null,
      },
      null,
      2
    )
  );

  if (report.summary.failed && !args.allowGaps) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
});
