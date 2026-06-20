#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const INPUT_SCHEMA = "pf.orc.sybil_detection_input.v1";
const REPORT_SCHEMA = "pf.orc.sybil_detection_report.v1";
const MODE = "recommend_only_no_enforcement";
const DETECTOR_VERSION = "sybil_review_detector_v1";

function usage() {
  return `Usage:
  node scripts/sybil-review-detector.mjs generate --input <fixture.json> [--out <report.json>] [options]
  node scripts/sybil-review-detector.mjs batch --input <fixture.json> --out <dir> [options]
  node scripts/sybil-review-detector.mjs db-scan [--out <report.json>] [--persist] [options]

Options:
  --generated-by <handle>                 Default: grashnuk
  --generated-at <iso timestamp>          Default: current time
  --burst-task-threshold <n>              Default: 3. More than this many Network tasks in the burst window flags.
  --burst-window-hours <n>                Default: 3
  --partial-reward-threshold <n>          Default: 2
  --duplicate-text-threshold <n>          Default: 2
  --rapid-submit-threshold <n>            Default: 2
  --rapid-submit-minutes <n>              Default: 10
  --minimum-risk-score <n>                Default: 25. Persist/report flags at or above this score.
  --since <iso|Nd>                        Optional DB scan lower bound on task updated_at.
  --limit <n>                             DB task row limit. Default: 2000

The detector writes review flags only. It never bans accounts, mutates routing,
moves PFT, signs enforcement payloads, clawbacks rewards, or deploys.`;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { command: "help", options: {} };
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

function safeText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function asArray(value) {
  if (value === undefined || value === null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueTexts(values) {
  return [...new Set(asArray(values).map((value) => safeText(value)).filter(Boolean))].sort();
}

function normalizeHandle(value) {
  return safeText(value).replace(/^@+/, "");
}

function normalizeKey(value, fallback = "unknown") {
  const normalized = safeText(value)
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^@+/, "")
    .replaceAll(/[^a-z0-9_ -]/g, "")
    .replaceAll(/[ -]+/g, "_");
  return normalized || fallback;
}

function numberOption(options, key, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const raw = options[key] === undefined ? fallback : options[key];
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${key} must be a number from ${min} to ${max}`);
  }
  return value;
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function ensureIsoTimestamp(value, label) {
  const timestamp = safeText(value);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function generatedAt(options) {
  return options["generated-at"]
    ? ensureIsoTimestamp(options["generated-at"], "--generated-at")
    : new Date().toISOString();
}

function generatedBy(options) {
  return normalizeHandle(options["generated-by"] || "grashnuk") || "grashnuk";
}

function parseSince(value) {
  const text = safeText(value);
  if (!text) return "";
  const relative = text.match(/^(\d+)d$/i);
  if (relative) {
    return new Date(Date.now() - Number(relative[1]) * 24 * 60 * 60 * 1000).toISOString();
  }
  return ensureIsoTimestamp(text, "--since");
}

function buildCriteria(options) {
  return {
    burstTaskThreshold: numberOption(options, "burst-task-threshold", 3, { min: 1 }),
    burstWindowHours: numberOption(options, "burst-window-hours", 3, { min: 0.1 }),
    partialRewardThreshold: numberOption(options, "partial-reward-threshold", 2, { min: 1 }),
    duplicateTextThreshold: numberOption(options, "duplicate-text-threshold", 2, { min: 2 }),
    rapidSubmitThreshold: numberOption(options, "rapid-submit-threshold", 2, { min: 1 }),
    rapidSubmitMinutes: numberOption(options, "rapid-submit-minutes", 10, { min: 1 }),
    minimumRiskScore: numberOption(options, "minimum-risk-score", 25, { min: 0 }),
  };
}

async function readJson(filePath, label = "JSON") {
  if (!existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

async function writeJson(filePath, payload) {
  await writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function hashText(value, length = 16) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function toIso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function objectValuesDeep(value, depth = 0) {
  if (depth > 6 || value === undefined || value === null || value === false) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => objectValuesDeep(item, depth + 1));
  if (typeof value === "object") return Object.values(value).flatMap((item) => objectValuesDeep(item, depth + 1));
  return [];
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

function submissionText(submission) {
  const explicit = [
    readNested(submission, ["text", "body", "notes", "summary", "description", "submissionText"]),
    readNested(submission, ["payload.text", "payload.body", "payload.notes", "payload.summary", "payload.description", "payload.submission_text"]),
    readNested(submission, ["payload.evidence.text", "payload.evidence.summary", "payload.response.text"]),
  ].map((value) => safeText(value)).filter(Boolean);
  if (explicit.length) return explicit.join("\n\n").slice(0, 20000);
  return objectValuesDeep(submission)
    .filter((value) => value.length > 20)
    .join("\n")
    .slice(0, 20000);
}

function hasArtifactArray(submission) {
  const paths = [
    "files",
    "attachments",
    "artifacts",
    "artifactRefs",
    "changedFiles",
    "commits",
    "pullRequests",
    "urls",
    "links",
    "payload.files",
    "payload.attachments",
    "payload.artifacts",
    "payload.artifactRefs",
    "payload.changedFiles",
    "payload.commits",
    "payload.pullRequests",
    "payload.urls",
    "payload.links",
    "payload.evidence.files",
    "payload.evidence.artifacts",
  ];
  return paths.some((pathSpec) => asArray(readNested(submission, [pathSpec])).filter(Boolean).length > 0);
}

function concreteEvidenceSignals(text, submission) {
  const haystack = `${text}\n${objectValuesDeep(submission).join("\n")}`;
  const signals = [];
  if (/```/.test(haystack)) signals.push("code_fence");
  if (/https?:\/\/|github\.com|gitlab\.com|linear\.app|ipfs:\/\//i.test(haystack)) signals.push("external_url");
  if (/\bQm[1-9A-HJ-NP-Za-km-z]{44}\b|\bbafy[a-z0-9]{20,}\b/i.test(haystack)) signals.push("cid");
  if (/\b[0-9A-F]{48,64}\b/i.test(haystack)) signals.push("tx_or_commit_hash");
  if (/\b(npm|pnpm|yarn|uv|pytest|python|node|go test|cargo test|git diff|git show|git commit|gh pr)\b/i.test(haystack)) signals.push("command_or_test");
  if (/\b[\w./-]+\.(js|jsx|ts|tsx|py|mjs|sql|md|json|css|html|yml|yaml|toml)\b/i.test(haystack)) signals.push("file_path");
  if (/\b(PR|pull request|commit|branch|diff|patch|test result|commands run|changed files)\b/i.test(haystack)) signals.push("engineering_proof_words");
  if (hasArtifactArray(submission)) signals.push("structured_artifact_array");
  return uniqueTexts(signals);
}

function normalizedSubmissionHash(text) {
  const normalized = safeText(text)
    .toLowerCase()
    .replaceAll(/https?:\/\/\S+/g, " ")
    .replaceAll(/\btask_[a-f0-9]+\b/g, " task_id ")
    .replaceAll(/\bqmf?[1-9a-hj-np-za-km-z]{20,}\b/gi, " cid ")
    .replaceAll(/[^a-z0-9]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return normalized ? hashText(normalized, 24) : "";
}

function classifySubmission(submission) {
  const text = submissionText(submission);
  const signals = concreteEvidenceSignals(text, submission);
  const textOnlyNoWork = Boolean(text) && signals.length === 0;
  return {
    text,
    textLength: text.length,
    textHash: normalizedSubmissionHash(text),
    concreteEvidenceSignals: signals,
    textOnlyNoWork,
    likelyAiTextOnly: textOnlyNoWork,
  };
}

function normalizeProvider(provider) {
  const key = normalizeKey(provider, "");
  if (["x", "twitter"].includes(key)) return "x";
  if (["github", "git_hub"].includes(key)) return "github";
  if (["email", "mail", "password"].includes(key)) return "email";
  return key;
}

function providerRisk(providers) {
  const normalized = uniqueTexts(asArray(providers).map((provider) => normalizeProvider(provider)).filter(Boolean));
  if (normalized.includes("github") || normalized.includes("x")) {
    return { label: "lower_identity_risk", score: 0, providers: normalized };
  }
  if (normalized.includes("email")) {
    return { label: "email_only_or_email_primary", score: 10, providers: normalized };
  }
  if (normalized.length === 0) return { label: "unknown_provider", score: 6, providers: normalized };
  return { label: "non_social_provider", score: 4, providers: normalized };
}

function taskTimestamp(task) {
  return toIso(task.rewardedAt || task.submittedAt || task.updatedAt || task.lastEventAt || task.createdAt);
}

function acceptedTimestamp(task) {
  return toIso(task.acceptedAt || task.createdAt);
}

function submittedTimestamp(task) {
  return toIso(task.submittedAt || task.lastSubmissionAt || task.updatedAt || task.lastEventAt);
}

function rewardIsPartial(task) {
  const actual = numberValue(task.rewardActualPft ?? task.reward_actual_pft);
  const offer = numberValue(task.rewardOfferPft ?? task.reward_offer_pft);
  return actual > 0 && offer > 0 && actual < offer;
}

function normalizedTitle(title) {
  const stopWords = new Set(["phase", "part", "task", "build", "create", "prepare", "review"]);
  return normalizeKey(title, "")
    .split("_")
    .filter((token) => token && !stopWords.has(token) && !/^v\d+$/i.test(token))
    .join("_");
}

function groupContributors(input) {
  const byKey = new Map();
  const sourceContributors = asArray(input.contributors);
  for (const contributor of sourceContributors) {
    const accountId = safeText(contributor.accountId);
    const walletAddress = safeText(contributor.walletAddress || contributor.wallet);
    const handle = normalizeHandle(contributor.handle);
    const subjectKey = safeText(contributor.contributorKey || accountId || walletAddress || handle || "unknown_contributor");
    const existing = byKey.get(subjectKey) || {
      subjectKey,
      accountId,
      walletAddresses: [],
      handles: [],
      providers: [],
      tasks: [],
    };
    existing.accountId ||= accountId;
    existing.walletAddresses = uniqueTexts([...existing.walletAddresses, walletAddress, ...asArray(contributor.walletAddresses)]);
    existing.handles = uniqueTexts([...existing.handles, handle, ...asArray(contributor.handles).map(normalizeHandle)]);
    existing.providers = uniqueTexts([...existing.providers, ...asArray(contributor.providers).map(normalizeProvider)]);
    existing.tasks.push(...asArray(contributor.tasks));
    byKey.set(subjectKey, existing);
  }
  return [...byKey.values()];
}

function rollingBurst(tasks, criteria) {
  const timed = tasks
    .map((task) => ({ task, timestamp: taskTimestamp(task), time: Date.parse(taskTimestamp(task)) }))
    .filter((item) => Number.isFinite(item.time))
    .sort((left, right) => left.time - right.time);
  const windowMs = criteria.burstWindowHours * 60 * 60 * 1000;
  let best = [];
  for (let start = 0; start < timed.length; start += 1) {
    const current = [];
    for (let end = start; end < timed.length; end += 1) {
      if (timed[end].time - timed[start].time <= windowMs) current.push(timed[end]);
    }
    if (current.length > best.length) best = current;
  }
  return best;
}

function evaluateContributor(contributor, criteria) {
  const networkTasks = asArray(contributor.tasks).filter((task) => normalizeKey(task.taskKind || task.task_kind, "") === "network");
  const submissions = networkTasks.map((task) => ({
    task,
    classification: classifySubmission(task.submission || task.submissionPayload || task.latestSubmission || {}),
  })).filter((item) => item.classification.text || Object.keys(taskLikeSubmission(item.task)).length);
  const flags = [];
  const evidence = {};
  const addFlag = (rule, score, details = {}) => {
    flags.push({ rule, score, details });
  };

  const burst = rollingBurst(networkTasks, criteria);
  if (burst.length > criteria.burstTaskThreshold) {
    addFlag("network_task_burst_gt_3_in_3h", 35, {
      observed: burst.length,
      threshold: criteria.burstTaskThreshold,
      windowHours: criteria.burstWindowHours,
      taskIds: burst.map((item) => safeText(item.task.taskId || item.task.task_id)).filter(Boolean),
      startedAt: burst[0]?.timestamp || "",
      endedAt: burst.at(-1)?.timestamp || "",
    });
  }

  const partialRewards = networkTasks.filter(rewardIsPartial);
  if (partialRewards.length >= criteria.partialRewardThreshold) {
    addFlag("partial_network_rewards_2plus", 30, {
      observed: partialRewards.length,
      threshold: criteria.partialRewardThreshold,
      taskIds: partialRewards.map((task) => safeText(task.taskId || task.task_id)).filter(Boolean),
      rewards: partialRewards.map((task) => ({
        taskId: safeText(task.taskId || task.task_id),
        rewardOfferPft: numberValue(task.rewardOfferPft ?? task.reward_offer_pft),
        rewardActualPft: numberValue(task.rewardActualPft ?? task.reward_actual_pft),
      })),
    });
  }

  const textOnlyTasks = submissions.filter((item) => item.classification.textOnlyNoWork);
  if (textOnlyTasks.length > 0) {
    addFlag("text_only_no_work_submission", 30, {
      observed: textOnlyTasks.length,
      taskIds: textOnlyTasks.map((item) => safeText(item.task.taskId || item.task.task_id)).filter(Boolean),
      criterion: "submission has text but no code, artifacts, commands, tests, links, CIDs, tx hashes, commits, PRs, changed files, or structured artifact refs",
    });
  }

  if (submissions.length > 0 && submissions.every((item) => item.classification.likelyAiTextOnly)) {
    addFlag("all_ai_like_text_only_submissions", 45, {
      observed: submissions.length,
      taskIds: submissions.map((item) => safeText(item.task.taskId || item.task.task_id)).filter(Boolean),
      criterion: "all available submissions are text-only with no concrete work proof",
    });
  }

  const duplicateTextBuckets = new Map();
  for (const item of submissions) {
    const hash = item.classification.textHash;
    if (!hash) continue;
    const bucket = duplicateTextBuckets.get(hash) || [];
    bucket.push(item);
    duplicateTextBuckets.set(hash, bucket);
  }
  const duplicateText = [...duplicateTextBuckets.values()].filter((bucket) => bucket.length >= criteria.duplicateTextThreshold);
  if (duplicateText.length > 0) {
    addFlag("duplicate_submission_text", 20, {
      duplicateGroups: duplicateText.map((bucket) => ({
        count: bucket.length,
        taskIds: bucket.map((item) => safeText(item.task.taskId || item.task.task_id)).filter(Boolean),
      })),
    });
  }

  const titleBuckets = new Map();
  for (const task of networkTasks) {
    const key = normalizedTitle(task.title);
    if (!key) continue;
    const bucket = titleBuckets.get(key) || [];
    bucket.push(task);
    titleBuckets.set(key, bucket);
  }
  const repeatedTitles = [...titleBuckets.values()].filter((bucket) => bucket.length >= 3);
  if (repeatedTitles.length > 0) {
    addFlag("repeated_title_family", 15, {
      repeatedGroups: repeatedTitles.map((bucket) => ({
        count: bucket.length,
        titles: uniqueTexts(bucket.map((task) => task.title)).slice(0, 8),
        taskIds: bucket.map((task) => safeText(task.taskId || task.task_id)).filter(Boolean),
      })),
    });
  }

  const rapidSubmits = networkTasks.filter((task) => {
    const accepted = Date.parse(acceptedTimestamp(task));
    const submitted = Date.parse(submittedTimestamp(task));
    if (!Number.isFinite(accepted) || !Number.isFinite(submitted)) return false;
    const deltaMinutes = (submitted - accepted) / 60000;
    return deltaMinutes >= 0 && deltaMinutes <= criteria.rapidSubmitMinutes;
  });
  if (rapidSubmits.length >= criteria.rapidSubmitThreshold) {
    addFlag("rapid_accept_to_submit_loop", 15, {
      observed: rapidSubmits.length,
      threshold: criteria.rapidSubmitThreshold,
      maxMinutes: criteria.rapidSubmitMinutes,
      taskIds: rapidSubmits.map((task) => safeText(task.taskId || task.task_id)).filter(Boolean),
    });
  }

  const provider = providerRisk(contributor.providers);
  if (provider.score > 0 && flags.length > 0) {
    addFlag(`provider_risk_${provider.label}`, provider.score, {
      providers: provider.providers,
      note: "Provider risk modifies an existing task-quality or velocity signal; it is not a standalone Sybil finding.",
    });
  }

  evidence.networkTaskCount = networkTasks.length;
  evidence.submissionCount = submissions.length;
  evidence.textOnlyNoWorkCount = textOnlyTasks.length;
  evidence.partialRewardCount = partialRewards.length;
  evidence.providers = provider.providers;
  evidence.providerRisk = provider.label;
  evidence.flags = flags;

  const riskScore = Math.min(100, flags.reduce((sum, flag) => sum + flag.score, 0));
  const riskBand = riskScore >= 75 ? "high_review_priority" : riskScore >= 45 ? "review_required" : "watch";
  const flagRules = uniqueTexts(flags.map((flag) => flag.rule));
  return {
    subjectKey: contributor.subjectKey,
    accountId: contributor.accountId || "",
    walletAddresses: uniqueTexts(contributor.walletAddresses),
    handles: uniqueTexts(contributor.handles),
    providerRisk: provider.label,
    riskScore,
    riskBand,
    flagRules,
    evidence,
    recommendedAction: flagRules.length
      ? "Human review required before any routing suppression, ban, or money action. Inspect raw submissions, task packets, and identity context."
      : "No Sybil review flag from current criteria.",
  };
}

function taskLikeSubmission(task) {
  return task.submission || task.submissionPayload || task.latestSubmission || {};
}

function buildReport(input, options = {}) {
  if (!input || typeof input !== "object") throw new Error("Input must be a JSON object");
  if (input.schema && input.schema !== INPUT_SCHEMA) {
    throw new Error(`Input schema must be ${INPUT_SCHEMA}; got ${safeText(input.schema)}`);
  }
  const criteria = buildCriteria(options);
  const at = generatedAt(options);
  const by = generatedBy(options);
  const contributors = groupContributors(input);
  const evaluated = contributors.map((contributor) => evaluateContributor(contributor, criteria));
  const flags = evaluated
    .filter((item) => item.flagRules.length > 0 && item.riskScore >= criteria.minimumRiskScore)
    .sort((left, right) => right.riskScore - left.riskScore || String(left.subjectKey).localeCompare(String(right.subjectKey)));
  const summary = {
    contributorsEvaluated: contributors.length,
    contributorsFlagged: flags.length,
    flagCounts: countRuleOccurrences(flags),
    riskBandCounts: countBy(flags, (flag) => flag.riskBand),
    providerRiskCounts: countBy(flags, (flag) => flag.providerRisk),
  };
  const runId = `sybrun_${hashText(`${at}:${by}:${JSON.stringify(summary)}:${JSON.stringify(criteria)}`, 24)}`;
  return {
    ok: true,
    schema: REPORT_SCHEMA,
    detectorVersion: DETECTOR_VERSION,
    mode: MODE,
    runId,
    generatedAt: at,
    generatedBy: by,
    criteria,
    summary,
    enforcementBoundary: {
      recommendOnly: true,
      wouldMutateLiveRouting: false,
      wouldMoveFunds: false,
      wouldBanAccounts: false,
      wouldClawBackRewards: false,
      wouldDeploy: false,
      requiresHumanApprovalForAnyOperationalUse: true,
    },
    flags: flags.map((flag) => ({
      id: flagId(runId, flag),
      ...flag,
      status: "sybil_review_flagged",
      operationalUseAllowed: false,
      requiresHumanApproval: true,
    })),
  };
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function countRuleOccurrences(flags) {
  const counts = {};
  for (const flag of flags) {
    for (const rule of flag.flagRules) counts[rule] = (counts[rule] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function flagId(runId, flag) {
  return `sybflag_${hashText(`${runId}:${flag.subjectKey}:${flag.flagRules.join(",")}`, 24)}`;
}

function dbUrlFromEnv() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  if (process.env.TASKNODE_DATABASE_URL) return process.env.TASKNODE_DATABASE_URL;
  return "";
}

async function dbQuery() {
  if (!process.env.DATABASE_URL && process.env.TASKNODE_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TASKNODE_DATABASE_URL;
  }
  if (!process.env.TASKNODE_DATABASE_ENABLED) process.env.TASKNODE_DATABASE_ENABLED = "true";
  if (!dbUrlFromEnv()) throw new Error("DATABASE_URL or TASKNODE_DATABASE_URL is required for db-scan");
  return import("../server/db/pool.js");
}

async function loadDbInput(options) {
  const { query, closePool } = await dbQuery();
  try {
    const sinceIso = parseSince(options.since || "");
    const limit = Math.min(Math.max(Number(options.limit || 2000), 1), 10000);
    const taskResult = await query(
      `
        SELECT task_id, account_id, subject_wallet, status, title, task_kind,
               reward_offer_pft::text AS reward_offer_pft,
               reward_actual_pft::text AS reward_actual_pft,
               created_at, updated_at, last_event_at
        FROM task_projections
        WHERE task_kind = 'network'
          AND ($1::timestamptz IS NULL OR updated_at >= $1::timestamptz)
        ORDER BY updated_at DESC, task_id DESC
        LIMIT $2
      `,
      [sinceIso || null, limit]
    );
    const taskIds = taskResult.rows.map((row) => row.task_id);
    const accountIds = uniqueTexts(taskResult.rows.map((row) => row.account_id));
    const eventResult = taskIds.length
      ? await query(
          `
            SELECT task_id, account_id, wallet_address, event_type, payload_json, occurred_at, source_cid, source_tx_hash
            FROM task_events
            WHERE task_id = ANY($1::text[])
              AND (
                event_type = 'pf.task.submission.v1'
                OR payload_json->>'schema' = 'pf.task.submission.v1'
              )
            ORDER BY occurred_at ASC, id ASC
          `,
          [taskIds]
        )
      : { rows: [] };
    const providersResult = accountIds.length
      ? await query(
          `
            SELECT account_id, provider
            FROM user_observability_events
            WHERE account_id = ANY($1::text[])
              AND provider <> ''
            GROUP BY account_id, provider
          `,
          [accountIds]
        )
      : { rows: [] };
    const handlesResult = accountIds.length
      ? await query(
          `
            SELECT account_id, hive_handle, display_name
            FROM recommended_connection_profiles
            WHERE account_id = ANY($1::text[])
          `,
          [accountIds]
        )
      : { rows: [] };
    const eventsByTask = new Map();
    for (const event of eventResult.rows) {
      const rows = eventsByTask.get(event.task_id) || [];
      rows.push(event);
      eventsByTask.set(event.task_id, rows);
    }
    const providersByAccount = new Map();
    for (const row of providersResult.rows) {
      const rows = providersByAccount.get(row.account_id) || [];
      rows.push(row.provider);
      providersByAccount.set(row.account_id, rows);
    }
    const handlesByAccount = new Map();
    for (const row of handlesResult.rows) {
      handlesByAccount.set(row.account_id, {
        handle: normalizeHandle(row.hive_handle),
        displayName: safeText(row.display_name),
      });
    }
    const contributorMap = new Map();
    for (const row of taskResult.rows) {
      const subjectKey = row.account_id || row.subject_wallet || "unknown_contributor";
      const contributor = contributorMap.get(subjectKey) || {
        contributorKey: subjectKey,
        accountId: row.account_id,
        walletAddress: row.subject_wallet,
        walletAddresses: [],
        handles: [],
        providers: providersByAccount.get(row.account_id) || [],
        tasks: [],
      };
      const handle = handlesByAccount.get(row.account_id)?.handle || "";
      contributor.handles = uniqueTexts([...contributor.handles, handle]);
      contributor.walletAddresses = uniqueTexts([...contributor.walletAddresses, row.subject_wallet]);
      const submissionEvent = eventsByTask.get(row.task_id)?.at(-1);
      contributor.tasks.push({
        taskId: row.task_id,
        accountId: row.account_id,
        walletAddress: row.subject_wallet,
        title: row.title,
        status: row.status,
        taskKind: row.task_kind,
        rewardOfferPft: row.reward_offer_pft,
        rewardActualPft: row.reward_actual_pft,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastEventAt: row.last_event_at,
        submittedAt: submissionEvent?.occurred_at || "",
        submission: submissionEvent
          ? {
              payload: submissionEvent.payload_json,
              sourceCid: submissionEvent.source_cid,
              sourceTxHash: submissionEvent.source_tx_hash,
            }
          : {},
      });
      contributorMap.set(subjectKey, contributor);
    }
    return {
      schema: INPUT_SCHEMA,
      source: {
        kind: "tasknode_postgres",
        since: sinceIso,
        taskRows: taskResult.rows.length,
        submissionRows: eventResult.rows.length,
      },
      contributors: [...contributorMap.values()],
    };
  } finally {
    await closePool();
  }
}

async function persistReport(report) {
  const { query, closePool } = await dbQuery();
  try {
    await query(
      `
        INSERT INTO sybil_review_runs (
          id, schema, detector_version, generated_by, mode,
          criteria_json, summary_json, source_json, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          summary_json = EXCLUDED.summary_json,
          source_json = EXCLUDED.source_json
      `,
      [
        report.runId,
        report.schema,
        report.detectorVersion,
        report.generatedBy,
        report.mode,
        JSON.stringify(report.criteria),
        JSON.stringify(report.summary),
        JSON.stringify({ enforcementBoundary: report.enforcementBoundary }),
        report.generatedAt,
      ]
    );
    for (const flag of report.flags) {
      await query(
        `
          INSERT INTO sybil_review_flags (
            id, run_id, subject_key, account_id, wallet_addresses, handles,
            provider_risk, risk_score, risk_band, status, flag_rules,
            evidence_json, recommended_action, operational_use_allowed,
            requires_human_approval, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5::text[], $6::text[],
            $7, $8, $9, $10, $11::text[],
            $12::jsonb, $13, false, true, $14::timestamptz, now()
          )
          ON CONFLICT (id) DO UPDATE SET
            provider_risk = EXCLUDED.provider_risk,
            risk_score = EXCLUDED.risk_score,
            risk_band = EXCLUDED.risk_band,
            status = EXCLUDED.status,
            flag_rules = EXCLUDED.flag_rules,
            evidence_json = EXCLUDED.evidence_json,
            recommended_action = EXCLUDED.recommended_action,
            operational_use_allowed = false,
            requires_human_approval = true,
            updated_at = now()
        `,
        [
          flag.id,
          report.runId,
          flag.subjectKey,
          flag.accountId,
          flag.walletAddresses,
          flag.handles,
          flag.providerRisk,
          flag.riskScore,
          flag.riskBand,
          flag.status,
          flag.flagRules,
          JSON.stringify(flag.evidence),
          flag.recommendedAction,
          report.generatedAt,
        ]
      );
    }
    return { persisted: true, runId: report.runId, flagCount: report.flags.length };
  } finally {
    await closePool();
  }
}

async function run() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help") {
    console.log(usage());
    return;
  }
  let input;
  if (command === "generate" || command === "batch") {
    input = await readJson(requireOption(options, "input"), "Input");
  } else if (command === "db-scan") {
    input = await loadDbInput(options);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  const report = buildReport(input, options);
  if (options.persist) {
    report.persistence = await persistReport(report);
  }
  if (command === "batch") {
    const outDir = requireOption(options, "out");
    await mkdir(outDir, { recursive: true });
    const reportPath = path.join(outDir, "sybil_detection_report.json");
    const summaryPath = path.join(outDir, "sybil_detection_summary.md");
    await writeJson(reportPath, report);
    await writeText(summaryPath, renderSummary(report));
    console.log(JSON.stringify({ ok: true, schema: report.schema, runId: report.runId, summary: report.summary, outputs: { report: reportPath, summary: summaryPath } }, null, 2));
    return;
  }
  if (options.out && options.out !== true) {
    await writeJson(String(options.out), report);
    console.log(JSON.stringify({ ok: true, schema: report.schema, runId: report.runId, summary: report.summary, output: String(options.out), persistence: report.persistence || null }, null, 2));
    return;
  }
  console.log(JSON.stringify(report, null, 2));
}

function renderSummary(report) {
  const lines = [
    "# Sybil Detection Review Summary",
    "",
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `Contributors evaluated: ${report.summary.contributorsEvaluated}`,
    `Contributors flagged: ${report.summary.contributorsFlagged}`,
    "",
    "This is recommend-only. It does not ban accounts, mutate routing, move funds, claw back rewards, or deploy.",
    "",
    "| Subject | Score | Band | Rules |",
    "| --- | ---: | --- | --- |",
  ];
  for (const flag of report.flags) {
    lines.push(`| ${flag.subjectKey} | ${flag.riskScore} | ${flag.riskBand} | ${flag.flagRules.join(", ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

run().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
