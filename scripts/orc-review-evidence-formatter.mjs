#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ORC_REVIEW_FORMATTER_PROMPT_VERSION = "orc_review_formatter_v1";

function safeText(value = "", max = 4000) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function numeric(value = 0) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function uniqueStrings(values = [], max = 20) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = safeText(value, 240);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

function firstText(...values) {
  for (const value of values) {
    const text = safeText(value, 4000);
    if (text) return text;
  }
  return "";
}

function collectFromObject(value, keys = []) {
  const object = safeObject(value);
  return keys.map((key) => object[key]).filter(Boolean);
}

function normalizeArtifact(artifact = {}, index = 1) {
  const source = safeObject(artifact);
  const file = safeObject(source.file);
  return {
    index: Number(source.index || index),
    artifactType: firstText(source.artifactType, source.artifact_type, source.type, source.evidenceType),
    value: firstText(source.value, source.text, source.content, file.text),
    url: firstText(source.url, safeObject(source.source).url),
    notes: firstText(source.notes, source.summary),
    file: file.name || file.size || file.text
      ? {
        name: safeText(file.name, 240),
        size: Number(file.size || 0) || null,
        text: safeText(file.text, 1800),
      }
      : {},
  };
}

function normalizeSubmission(submission = {}, index = 1) {
  const source = safeObject(submission);
  const artifacts = safeArray(source.artifacts?.length ? source.artifacts : source.evidenceItems || source.evidence_items)
    .map((artifact, artifactIndex) => normalizeArtifact(artifact, artifactIndex + 1));
  const fallbackArtifact = normalizeArtifact(source, 1);
  return {
    index: Number(source.index || index),
    eventType: firstText(source.eventType, source.event_type, "pf.task.submission.v1"),
    sourceCid: firstText(source.sourceCid, source.source_cid, source.cid),
    sourceTxHash: firstText(source.sourceTxHash, source.source_tx_hash, source.txHash),
    occurredAt: firstText(source.occurredAt, source.occurred_at, source.time),
    summary: firstText(source.summary, source.notes),
    artifacts: artifacts.length ? artifacts : (fallbackArtifact.value || fallbackArtifact.url || fallbackArtifact.notes ? [fallbackArtifact] : []),
  };
}

function normalizeTimelineEvent(event = {}) {
  const source = safeObject(event);
  return {
    action: firstText(source.action, source.eventType, source.event_type),
    label: safeText(source.label, 200),
    time: firstText(source.time, source.occurredAt, source.occurred_at),
    txHash: firstText(source.txHash, source.sourceTxHash, source.source_tx_hash),
    cid: firstText(source.cid, source.sourceCid, source.source_cid),
  };
}

function normalizeEvaluationPacket(packet = {}) {
  const source = safeObject(packet);
  return {
    id: safeText(source.id, 180),
    packetStatus: firstText(source.packetStatus, source.packet_status, source.status),
    evaluatorId: firstText(source.evaluatorId, source.evaluator_id),
    summary: safeText(source.summary, 1200),
    recommendation: firstText(source.recommendation, source.recommendedAction, source.recommended_action),
    sourceDigest: firstText(source.sourceDigest, source.source_digest),
    updatedAt: firstText(source.updatedAt, source.updated_at),
  };
}

export function normalizeEvidencePacket(packet = {}) {
  const source = safeObject(packet);
  const task = safeObject(source.task?.taskId || source.task?.id || source.task?.title ? source.task : source);
  const review = safeObject(source.review);
  const outcome = safeObject(review.outcome || source.outcome || source.rewardOutcome);
  const sourcePointers = safeObject(source.sourcePointers || source.source_pointers);
  const timeline = safeArray(source.timeline).map(normalizeTimelineEvent);
  const submissions = safeArray(
    review.submissions?.length ? review.submissions : source.submissions || source.evidenceSubmissions || source.evidence_submissions
  ).map((submission, index) => normalizeSubmission(submission, index + 1));
  const verification = safeObject(review.verification || source.verification || {});
  const evaluationPackets = safeArray(source.evaluationPackets || source.evaluation_packets)
    .map(normalizeEvaluationPacket)
    .filter((entry) => entry.id || entry.summary || entry.recommendation);

  const cids = uniqueStrings([
    ...collectFromObject(sourcePointers, [
      "requestBundleCid",
      "offerCid",
      "submissionCid",
      "verificationRequestCid",
      "verificationResponseCid",
      "rewardDecisionCid",
      "rewardCid",
      "lastEventCid",
      "contextCid",
    ]),
    ...timeline.map((event) => event.cid),
    ...submissions.map((submission) => submission.sourceCid),
  ]);
  const txHashes = uniqueStrings([
    ...collectFromObject(sourcePointers, [
      "offerTxHash",
      "submissionTxHash",
      "verificationRequestTxHash",
      "verificationResponseTxHash",
      "rewardDecisionTxHash",
      "rewardTxHash",
      "lastEventTxHash",
    ]),
    ...timeline.map((event) => event.txHash),
    ...submissions.map((submission) => submission.sourceTxHash),
  ]);

  return {
    packetType: firstText(source.packetType, source.schema, "task_node.orc_review_evidence_packet.v1"),
    promptVersion: ORC_REVIEW_FORMATTER_PROMPT_VERSION,
    referenceTaskId: safeText(source.referenceTaskId, 180),
    task: {
      taskId: firstText(task.taskId, task.id, source.taskId),
      requestId: firstText(task.requestId, source.requestId),
      title: safeText(task.title, 260),
      state: firstText(task.state, task.status, source.status),
      kind: firstText(task.kind, task.taskKind, source.taskKind),
      project: safeObject(task.project),
      assigneeWallet: firstText(task.assignee, task.walletAddress, task.subjectWallet, source.walletAddress),
      assigneeAccountId: firstText(task.assigneeAccountId, task.accountId, source.accountId),
      assigneeHandle: firstText(task.assigneeHandle, task.handle, source.handle),
      rewardOfferPft: numeric(firstText(task.rewardOfferPft, task.pft, source.rewardOfferPft)),
      rewardActualPft: numeric(firstText(task.rewardActualPft, outcome.rewardPft, source.rewardActualPft)),
      summary: firstText(task.summary, task.description, source.description),
      statusPacket: safeObject(task.statusPacket || source.statusPacket),
    },
    sourcePointers: {
      requestBundleCid: firstText(sourcePointers.requestBundleCid, task.requestBundleCid, source.requestBundleCid),
      cids,
      txHashes,
    },
    review: {
      submissions,
      verification: {
        request: firstText(verification.request, verification.ask, source.verificationRequest),
        response: firstText(verification.response, source.verificationResponse),
      },
      outcome: {
        decision: firstText(outcome.decision, outcome.status, source.rewardDecision),
        rewardPft: numeric(firstText(outcome.rewardPft, source.rewardActualPft)),
        reason: firstText(outcome.reason, outcome.summary, source.rewardReason),
      },
    },
    evaluationPackets,
    timeline,
    publicFields: safeArray(source.publicFields || source.public_fields).map((field) => safeText(field, 240)).filter(Boolean),
  };
}

export function buildOrcReviewPrompt(packet = {}) {
  const normalized = normalizeEvidencePacket(packet);
  return [
    "# Orc Network Task Evidence Review Prompt",
    "",
    `Prompt version: ${ORC_REVIEW_FORMATTER_PROMPT_VERSION}`,
    "",
    "## Reviewer Role",
    "",
    "You are a Task Node Orc reviewer. Review the supplied Network Task evidence packet and produce a concise machine-readable review result.",
    "",
    "You are not executing a reward, clawback, ban, lifecycle transition, or board-state mutation. This is an advisory review-formatting layer only.",
    "",
    "## What To Judge",
    "",
    "- Whether the submitted evidence appears to satisfy the task objective and verification requirement.",
    "- Whether the reward recommendation should be kept, reduced, zeroed, escalated for follow-up, or manually reviewed.",
    "- Whether there are integrity, abuse, duplication, missing-proof, or archival flags.",
    "- What should be archived so a future Board Manager, Nazgûl, or Orc can audit the packet.",
    "",
    "## Required Orc Response JSON",
    "",
    "Return exactly one JSON object. Do not wrap it in prose unless your caller explicitly needs Markdown.",
    "",
    "```json",
    JSON.stringify({
      disposition: "verified|partial|insufficient|integrity_follow_up",
      recommendedAction: "keep_reward|reduce_reward|zero_reward|request_followup|manual_review|archive_only",
      recommendedRewardPft: "number or null",
      integritySignals: ["missing_proof|external_claim_unverified|duplicate_work|reward_accounting|other concise flags"],
      archival: {
        archive: true,
        instructions: "what packet, prompt, result, CIDs, tx hashes, and notes should be retained",
      },
      notes: "short reviewer rationale grounded in packet fields",
    }, null, 2),
    "```",
    "",
    "## Evidence Packet",
    "",
    "```json",
    JSON.stringify(normalized, null, 2),
    "```",
    "",
  ].join("\n");
}

function extractJsonObject(text = "") {
  const raw = safeText(text, 100000);
  if (!raw) return {};
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fence?.[1] || "";
  if (!candidate) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("no_json_object_found");
    candidate = raw.slice(start, end + 1);
  }
  if (!candidate.trim().startsWith("{")) throw new Error("no_json_object_found");
  const parsed = JSON.parse(candidate);
  return safeObject(parsed);
}

function gradeFromDisposition(disposition = "", fallback = "") {
  const value = safeText(disposition || fallback, 80).toLowerCase();
  if (["pass", "passed", "verified", "approved", "complete", "keep_reward", "archive_only"].includes(value)) return "pass";
  if (["partial", "mixed", "follow_up", "request_followup", "integrity_follow_up", "manual_review"].includes(value)) return "partial";
  if (["fail", "failed", "insufficient", "reject", "zero_reward", "no_reward"].includes(value)) return "fail";
  return fallback ? safeText(fallback, 80) : "partial";
}

function rewardRecommendationFrom(parsed = {}) {
  const direct = firstText(parsed.rewardRecommendation, parsed.reward_recommendation);
  if (direct) return direct;
  const action = firstText(parsed.recommendedAction, parsed.recommended_action, parsed.action);
  const amount = parsed.recommendedRewardPft ?? parsed.recommended_reward_pft ?? parsed.rewardPft ?? parsed.reward_pft;
  const amountText = amount === null || amount === undefined || amount === "" ? "" : `${numeric(amount)} PFT`;
  if (action && amountText) return `${action}: ${amountText}`;
  if (action) return action;
  if (amountText) return `recommended reward: ${amountText}`;
  return "manual_review";
}

function archivalInstructionsFrom(parsed = {}) {
  const direct = firstText(parsed.archivalInstructions, parsed.archival_instructions);
  if (direct) return direct;
  const archival = safeObject(parsed.archival || parsed.archive);
  const instructions = firstText(archival.instructions, archival.summary, archival.path);
  if (instructions) return instructions;
  if (archival.archive === true) return "Archive the input packet, generated prompt, Orc response, parsed verdict, CIDs, tx hashes, and reviewer notes.";
  return "Archive the input packet, generated prompt, Orc response, parsed verdict, CIDs, tx hashes, and reviewer notes if this review is retained.";
}

export function parseOrcReviewResponse(responseText = "") {
  let parsed = {};
  let parseError = "";
  try {
    parsed = extractJsonObject(responseText);
  } catch (error) {
    parseError = error?.message || "invalid_json";
    parsed = {};
  }

  const flags = uniqueStrings([
    ...safeArray(parsed.flagIndicators || parsed.flag_indicators),
    ...safeArray(parsed.integritySignals || parsed.integrity_signals),
    ...safeArray(parsed.riskSignals || parsed.risk_signals),
    ...(parseError ? [`unparseable_orc_response:${parseError}`] : []),
  ], 12);
  const notes = firstText(
    parsed.reviewerNotes,
    parsed.reviewer_notes,
    parsed.notes,
    parsed.summary,
    parsed.reasoning,
    parseError ? `Orc response could not be parsed as JSON: ${parseError}` : ""
  );

  return {
    taskGrade: firstText(parsed.taskGrade, parsed.task_grade) || gradeFromDisposition(parsed.disposition, parsed.recommendedAction),
    rewardRecommendation: rewardRecommendationFrom(parsed),
    flagIndicators: flags,
    archivalInstructions: archivalInstructionsFrom(parsed),
    reviewerNotes: notes || "No reviewer notes supplied; manual review recommended before consuming this result.",
  };
}

export function buildDiscordSummary({ packet = {}, result = {} } = {}) {
  const normalized = normalizeEvidencePacket(packet);
  const flags = safeArray(result.flagIndicators).length ? result.flagIndicators.join(", ") : "none";
  return [
    `Orc review formatter demo for ${normalized.task.taskId || "sample task"}:`,
    `- Input: normalized Network Task evidence packet (${normalized.review.submissions.length} submission event(s), ${normalized.sourcePointers.cids.length} CID(s), ${normalized.sourcePointers.txHashes.length} tx hash(es)).`,
    `- Prompt: generated ${ORC_REVIEW_FORMATTER_PROMPT_VERSION} Orc review prompt with packet JSON embedded for review.`,
    `- Parsed JSON: grade=${result.taskGrade}; reward=${result.rewardRecommendation}; flags=${flags}.`,
    `- Archive: ${result.archivalInstructions}`,
    `- Notes: ${result.reviewerNotes}`,
  ].join("\n");
}

function parseArgs(argv = []) {
  const args = { input: "", response: "", promptOut: "", jsonOut: "", summaryOut: "", outDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") args.input = argv[++index] || "";
    else if (arg === "--response") args.response = argv[++index] || "";
    else if (arg === "--prompt-out") args.promptOut = argv[++index] || "";
    else if (arg === "--json-out") args.jsonOut = argv[++index] || "";
    else if (arg === "--summary-out") args.summaryOut = argv[++index] || "";
    else if (arg === "--out-dir") args.outDir = argv[++index] || "";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.outDir) {
    args.promptOut ||= path.join(args.outDir, "generated_review_prompt.md");
    args.jsonOut ||= path.join(args.outDir, "review_output.json");
    args.summaryOut ||= path.join(args.outDir, "discord_summary.md");
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/orc-review-evidence-formatter.mjs --input <packet.json> [--response <orc-response.md>] [--out-dir <dir>]",
    "",
    "Outputs:",
    "  --prompt-out <path>   Generated Orc review prompt Markdown.",
    "  --json-out <path>     Parsed five-field review JSON.",
    "  --summary-out <path>  Discord-ready summary.",
    "",
    "The script does not call a model, submit a task, move PFT, or mutate board state.",
  ].join("\n");
}

async function readJsonFile(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function writeTextFile(filePath, text) {
  if (!filePath) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text);
}

export async function runFormatterCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.input) {
    console.log(usage());
    return args.help ? 0 : 1;
  }
  const packet = await readJsonFile(args.input);
  const prompt = buildOrcReviewPrompt(packet);
  await writeTextFile(args.promptOut, prompt);

  let result = null;
  if (args.response) {
    const responseText = await readFile(args.response, "utf8");
    result = parseOrcReviewResponse(responseText);
    await writeTextFile(args.jsonOut, `${JSON.stringify(result, null, 2)}\n`);
    await writeTextFile(args.summaryOut, `${buildDiscordSummary({ packet, result })}\n`);
  }

  const payload = {
    ok: true,
    promptOut: args.promptOut || "",
    jsonOut: result ? args.jsonOut || "" : "",
    summaryOut: result ? args.summaryOut || "" : "",
    result,
  };
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runFormatterCli().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
