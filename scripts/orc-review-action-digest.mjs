#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const INPUT_LEDGER_SCHEMA = "pf.orc.submitted_work_review_ledger.v1";
const OUTPUT_SCHEMA = "pf.orc.review_action_digest.v1";

function usage() {
  return `Usage:
  node scripts/orc-review-action-digest.mjs batch --ledger <file> --out <dir> [--generated-by <handle>]
  node scripts/orc-review-action-digest.mjs generate --ledger <file> [--generated-by <handle>]

Commands:
  batch     Write digest.json, discord_briefing.md, and routing_packets/<owner>.json files.
  generate  Print the action digest bundle to stdout without writing files.

The ledger must contain records[] compatible with ${INPUT_LEDGER_SCHEMA}.`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { command: "help", options: {} };
  }
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    index += 1;
    if (options[key] === undefined) options[key] = next;
    else if (Array.isArray(options[key])) options[key].push(next);
    else options[key] = [options[key], next];
  }
  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function safeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeKey(value, fallback = "uncategorized") {
  const normalized = safeText(value)
    .toLowerCase()
    .replace(/^@/, "")
    .replaceAll(/[^a-z0-9_ -]/g, "")
    .replaceAll(/[ -]+/g, "_");
  return normalized || fallback;
}

function normalizeHandle(value, fallback = "grashnuk") {
  return safeText(value, fallback).replace(/^@/, "") || fallback;
}

function readNested(record, paths) {
  for (const pathSpec of paths) {
    const parts = pathSpec.split(".");
    let current = record;
    for (const part of parts) {
      if (!current || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return "";
}

function findCategory(record) {
  return normalizeKey(
    readNested(record, [
      "category",
      "reviewCategory",
      "routing.category",
      "parserOutput.category",
      "parserOutput.reviewCategory",
    ])
  );
}

function findOwner(record) {
  return normalizeKey(
    readNested(record, [
      "actionOwner",
      "owner",
      "routing.owner",
      "routing.actionOwner",
      "parserOutput.actionOwner",
      "parserOutput.owner",
      "recommendedOwner",
    ]),
    "unassigned_owner"
  );
}

function findDisposition(record) {
  return normalizeKey(
    readNested(record, [
      "disposition",
      "reviewDisposition",
      "routing.disposition",
      "parserOutput.disposition",
      "parserOutput.reviewDisposition",
    ]) || record.reviewStatus || record.archiveAction,
    "reviewed_unclear"
  );
}

function findRecommendedAction(record) {
  const value = readNested(record, [
    "recommendedAction",
    "nextAction",
    "routing.recommendedAction",
    "parserOutput.recommendedAction",
    "parserOutput.nextAction",
    "parserOutput.rewardRecommendation",
    "parserOutput.reviewerNotes",
  ]);
  if (safeText(value)) return safeText(value);
  const archiveAction = normalizeKey(record.archiveAction, "");
  if (archiveAction === "needs_followup") return "Route for follow-up before the work is closed.";
  if (archiveAction === "hold") return "Hold for owner review before operationalizing.";
  if (archiveAction === "reject") return "Do not count further until replacement evidence is supplied.";
  return "No owner action specified.";
}

function findIntegritySignals(record) {
  return [
    ...asArray(record.integritySignals),
    ...asArray(record.integritySignal),
    ...asArray(record.reviewFlags),
    ...asArray(record.parserOutput?.integritySignals),
    ...asArray(record.parserOutput?.flagIndicators),
  ]
    .map((signal) => normalizeKey(signal, ""))
    .filter(Boolean)
    .filter((signal, index, signals) => signals.indexOf(signal) === index);
}

function findPriority(record) {
  const explicit = Number(
    readNested(record, ["priority", "priorityScore", "routing.priority", "parserOutput.priority"])
  );
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, Number(explicit.toFixed(2))));
  const disposition = findDisposition(record);
  const signals = findIntegritySignals(record);
  if (signals.length > 0 || disposition.includes("integrity")) return 90;
  if (disposition.includes("follow_up")) return 70;
  if (String(record.archiveAction || "").toLowerCase() === "needs_followup") return 65;
  if (String(record.reviewStatus || "").toLowerCase() !== "verified") return 55;
  return 25;
}

function isActionRequired(record) {
  if (record.actionRequired === true || record.requiresAction === true) return true;
  if (record.actionRequired === false || record.requiresAction === false) return false;
  const owner = findOwner(record);
  const disposition = findDisposition(record);
  const archiveAction = normalizeKey(record.archiveAction, "");
  if (owner && owner !== "unassigned_owner" && owner !== "none") return true;
  if (disposition.includes("follow_up") || disposition.includes("integrity")) return true;
  return ["needs_followup", "hold", "reject"].includes(archiveAction);
}

function countBy(records, finder) {
  const counts = {};
  for (const record of records) {
    const key = finder(record);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function countSignals(records) {
  const counts = {};
  for (const record of records) {
    for (const signal of findIntegritySignals(record)) {
      counts[signal] = (counts[signal] || 0) + 1;
    }
  }
  return counts;
}

function findContributor(record) {
  const handle = readNested(record, [
    "recipientHandle",
    "assigneeHandle",
    "contributor.handle",
    "recipient.handle",
    "submitterHandle",
  ]);
  const accountId = readNested(record, [
    "recipientAccountId",
    "assigneeAccountId",
    "contributor.accountId",
    "recipient.accountId",
    "accountId",
  ]);
  const wallet = readNested(record, [
    "walletAddress",
    "assigneeWallet",
    "contributor.walletAddress",
    "recipient.walletAddress",
  ]);
  return {
    handle: safeText(handle),
    accountId: safeText(accountId),
    walletAddress: safeText(wallet),
  };
}

function buildTaskItem(record) {
  return {
    reviewId: safeText(record.id),
    taskId: safeText(record.taskId),
    contributor: findContributor(record),
    reviewStatus: normalizeKey(record.reviewStatus, "unknown"),
    disposition: findDisposition(record),
    category: findCategory(record),
    priority: findPriority(record),
    integritySignals: findIntegritySignals(record),
    recommendedAction: findRecommendedAction(record),
    source: {
      cid: safeText(record.source?.cid || record.sourceCid),
      txHash: safeText(record.source?.txHash || record.sourceTxHash),
    },
    feedbackCompatiblePayload: {
      recipientAccountId: safeText(
        readNested(record, ["recipientAccountId", "assigneeAccountId", "recipient.accountId"])
      ),
      messageBody: [
        `Follow-up on reviewed task ${safeText(record.taskId, "unknown task")}.`,
        `Disposition: ${findDisposition(record)}.`,
        `Recommended action: ${findRecommendedAction(record)}`,
      ].join("\n"),
      metadata: {
        schema: OUTPUT_SCHEMA,
        sourceReviewId: safeText(record.id),
        sourceTaskId: safeText(record.taskId),
        actionOwner: findOwner(record),
        category: findCategory(record),
        integritySignals: findIntegritySignals(record),
      },
    },
  };
}

function sortActionItems(items) {
  return [...items].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    return String(left.taskId).localeCompare(String(right.taskId));
  });
}

function buildRoutingPackets(actionRecords, generatedBy, generatedAt, sourceLedgerSchema) {
  const owners = {};
  for (const record of actionRecords) {
    const owner = findOwner(record);
    if (!owners[owner]) owners[owner] = [];
    owners[owner].push(buildTaskItem(record));
  }
  return Object.entries(owners)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([owner, items]) => {
      const sortedItems = sortActionItems(items);
      return {
        schema: OUTPUT_SCHEMA,
        packetType: "owner_action_routing_packet",
        generatedAt,
        generatedBy,
        sourceLedgerSchema,
        actionOwner: owner,
        summary: {
          totalItems: sortedItems.length,
          byCategory: countBy(sortedItems, (item) => item.category),
          byDisposition: countBy(sortedItems, (item) => item.disposition),
          integritySignalFrequencies: countSignals(sortedItems),
          highestPriority: sortedItems[0]?.priority ?? 0,
        },
        tasks: sortedItems,
      };
    });
}

function buildDigest(ledger, records, actionRecords, packets, generatedBy, generatedAt) {
  const sortedActionItems = sortActionItems(actionRecords.map(buildTaskItem));
  return {
    schema: OUTPUT_SCHEMA,
    packetType: "consolidated_review_action_digest",
    generatedAt,
    generatedBy,
    sourceLedgerSchema: safeText(ledger.schema, INPUT_LEDGER_SCHEMA),
    counts: {
      totalReviewRecords: records.length,
      actionRequiredRecords: actionRecords.length,
      noActionRecords: records.length - actionRecords.length,
      actionOwners: packets.length,
    },
    byReviewStatus: countBy(records, (record) => normalizeKey(record.reviewStatus, "unknown")),
    byDisposition: countBy(records, findDisposition),
    byActionOwner: countBy(actionRecords, findOwner),
    byCategory: countBy(actionRecords, findCategory),
    integritySignalFrequencies: countSignals(actionRecords),
    highestPriorityItems: sortedActionItems.slice(0, 5).map((item) => ({
      taskId: item.taskId,
      actionOwner: item.feedbackCompatiblePayload.metadata.actionOwner,
      category: item.category,
      priority: item.priority,
      disposition: item.disposition,
      integritySignals: item.integritySignals,
      recommendedAction: item.recommendedAction,
    })),
    routingPacketFiles: packets.map((packet) => `routing_packets/${packet.actionOwner}.json`),
  };
}

function buildDiscordBriefing(digest, packets) {
  const lines = [
    "@goodalexander Orc review action digest is ready.",
    "",
    `Records reviewed: ${digest.counts.totalReviewRecords}`,
    `Action-required records: ${digest.counts.actionRequiredRecords}`,
    `Action owners: ${digest.counts.actionOwners}`,
    "",
    "Highest-priority items:",
  ];
  for (const item of digest.highestPriorityItems) {
    const signals = item.integritySignals.length ? item.integritySignals.join(", ") : "none";
    lines.push(
      `- ${item.taskId} -> ${item.actionOwner} / ${item.category} / p${item.priority}: ${item.recommendedAction} (signals: ${signals})`
    );
  }
  lines.push("", "Owner packet summary:");
  for (const packet of packets) {
    lines.push(
      `- ${packet.actionOwner}: ${packet.summary.totalItems} item(s), top priority ${packet.summary.highestPriority}`
    );
  }
  lines.push(
    "",
    "Generated artifacts:",
    "- digest.json",
    "- discord_briefing.md",
    "- routing_packets/<owner>.json"
  );
  return `${lines.join("\n")}\n`;
}

async function readLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) throw new Error(`Ledger not found: ${ledgerPath}`);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.records)) {
    throw new Error("Ledger must be a JSON object with records[]");
  }
  return ledger;
}

function buildBundle(ledger, options) {
  const generatedBy = normalizeHandle(options["generated-by"], "grashnuk");
  const generatedAt = new Date().toISOString();
  const records = ledger.records;
  const actionRecords = records.filter(isActionRequired);
  const sourceLedgerSchema = safeText(ledger.schema, INPUT_LEDGER_SCHEMA);
  const routingPackets = buildRoutingPackets(actionRecords, generatedBy, generatedAt, sourceLedgerSchema);
  const digest = buildDigest(ledger, records, actionRecords, routingPackets, generatedBy, generatedAt);
  return {
    ok: true,
    schema: OUTPUT_SCHEMA,
    generatedAt,
    generatedBy,
    digest,
    routingPackets,
    discordBriefing: buildDiscordBriefing(digest, routingPackets),
  };
}

async function writeBatch(bundle, outDir) {
  await mkdir(path.join(outDir, "routing_packets"), { recursive: true });
  await writeFile(path.join(outDir, "digest.json"), `${JSON.stringify(bundle.digest, null, 2)}\n`);
  await writeFile(path.join(outDir, "discord_briefing.md"), bundle.discordBriefing);
  for (const packet of bundle.routingPackets) {
    await writeFile(
      path.join(outDir, "routing_packets", `${packet.actionOwner}.json`),
      `${JSON.stringify(packet, null, 2)}\n`
    );
  }
  return {
    ok: true,
    schema: OUTPUT_SCHEMA,
    outDir,
    files: [
      "digest.json",
      "discord_briefing.md",
      ...bundle.routingPackets.map((packet) => `routing_packets/${packet.actionOwner}.json`),
    ],
    counts: bundle.digest.counts,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help || options.h) {
    console.log(usage());
    return;
  }
  if (!["batch", "generate"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const ledger = await readLedger(requireOption(options, "ledger"));
  const bundle = buildBundle(ledger, options);
  if (command === "generate") {
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }
  const outDir = requireOption(options, "out");
  const result = await writeBatch(bundle, outDir);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
