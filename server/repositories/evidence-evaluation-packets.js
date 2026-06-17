import { createHash } from "node:crypto";

import { databaseEnabled, query } from "../db/pool.js";
import { fetchUrlExcerpt } from "../task-review-worker.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonValue(value) {
  return JSON.stringify(value && typeof value === "object" ? value : {});
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

async function packetTableExists(queryImpl = query) {
  if (!databaseEnabled() && queryImpl === query) return false;
  const result = await queryImpl("SELECT to_regclass('public.board_manager_evidence_evaluation_packets') AS name");
  return Boolean(result.rows[0]?.name);
}

function artifactDigest(value = "") {
  const text = safeText(value, 4000);
  return text ? `sha256:${sha256(text)}` : "";
}

function extractUrls(text = "") {
  return [...String(text || "").matchAll(/https?:\/\/[^\s<>"')\]]+/gi)]
    .map((match) => safeText(match[0].replace(/[.,;:!?]+$/g, ""), 1000))
    .filter(Boolean)
    .slice(0, 12);
}

function parseUrl(value = "") {
  try {
    return new URL(safeText(value, 1000));
  } catch {
    return null;
  }
}

function githubArtifact(url = "") {
  const parsed = parseUrl(url);
  const hostname = safeText(parsed?.hostname, 260).toLowerCase();
  if (!["github.com", "www.github.com"].includes(hostname)) return null;
  const [owner, repo, kind, id] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repo || !kind || !id) return null;
  if (kind === "pull") {
    return { resolver: "github_pr", owner, repo, id: safeText(id, 80), label: `${owner}/${repo}#${id}` };
  }
  if (kind === "commit") {
    return { resolver: "github_commit", owner, repo, id: safeText(id, 80), label: `${owner}/${repo}@${safeText(id, 12)}` };
  }
  return null;
}

function discordArtifact(url = "") {
  const parsed = parseUrl(url);
  const hostname = safeText(parsed?.hostname, 260).toLowerCase();
  if (!["discord.com", "www.discord.com", "discordapp.com", "www.discordapp.com"].includes(hostname)) return null;
  const [channels, guildId, channelId, messageId] = parsed.pathname.split("/").filter(Boolean);
  if (channels !== "channels" || !guildId || !channelId || !messageId) return null;
  return {
    resolver: "discord_message_link",
    guildId: safeText(guildId, 80),
    channelId: safeText(channelId, 80),
    messageId: safeText(messageId, 80),
    label: `discord:${safeText(channelId, 12)}/${safeText(messageId, 12)}`,
  };
}

function artifactValue(item = {}, payload = {}) {
  return safeText(
    item.value ||
      item.url ||
      item.href ||
      item.evidence_url ||
      item.evidenceUrl ||
      item.text ||
      item.summary ||
      payload.evidence_text ||
      payload.response_text ||
      payload.submission_text ||
      "",
    8000
  );
}

function evidenceItemsForPayload(payload = {}) {
  const input = safeObject(payload);
  const evidence = safeObject(input.evidence || input.submission || input.response);
  const rawItems = safeArray(input.evidence_items).length
    ? safeArray(input.evidence_items)
    : safeArray(evidence.evidence_items).length
      ? safeArray(evidence.evidence_items)
      : safeArray(evidence.items).length
        ? safeArray(evidence.items)
        : [evidence];
  return rawItems
    .map((item) => {
      const source = safeObject(item);
      const value = artifactValue(source, input);
      return {
        artifact_type: safeText(source.artifact_type || source.evidence_type || input.artifact_type || input.evidence_type || "text", 80) || "text",
        value,
        urls: extractUrls(value),
      };
    })
    .filter((item) => item.value || item.urls.length)
    .slice(0, 20);
}

function eventEvidenceItems(eventRows = []) {
  return safeArray(eventRows)
    .filter((event) => [
      "pf.task.submission.v1",
      "pf.task.verification_response.v1",
    ].includes(safeText(event.event_type || event.eventType, 120)))
    .flatMap((event) => {
      const payload = safeObject(event.payload_json || event.payloadJson || event.rawPayload);
      return evidenceItemsForPayload(payload).map((item) => ({
        ...item,
        event_id: safeText(event.id, 180),
        event_type: safeText(event.event_type || event.eventType, 120),
        event_cid: safeText(event.source_cid || event.cid, 240),
        event_tx_hash: safeText(event.source_tx_hash || event.txHash, 240),
      }));
    })
    .slice(0, 24);
}

async function resolveUrlArtifact(url = "", { fetchUrlExcerptImpl = fetchUrlExcerpt } = {}) {
  const discord = discordArtifact(url);
  if (discord) {
    return {
      artifact_type: "discord_message",
      resolver: discord.resolver,
      status: "self_attested",
      label: discord.label,
      reason: "Discord message-link verification requires reviewed bot credentials and channel policy.",
      url,
    };
  }

  const github = githubArtifact(url);
  const fetched = await fetchUrlExcerptImpl(url).catch((error) => ({
    ok: false,
    error: safeText(error?.message || error, 300),
  }));
  const fetchedOk = fetched?.ok === true || fetched?.status === "extracted";
  if (!fetchedOk) {
    return {
      artifact_type: github?.resolver || "url",
      resolver: github?.resolver || "safe_url",
      status: "unverified",
      label: github?.label || safeText(url, 180),
      reason: safeText(fetched?.error || "url_fetch_failed", 300),
      url,
    };
  }
  return {
    artifact_type: github?.resolver || "url",
    resolver: github?.resolver || "safe_url",
    status: "verified",
    label: github?.label || safeText(fetched.title || url, 180),
    title: safeText(fetched.title, 240),
    excerpt: safeText(fetched.excerpt, 900),
    reason: github ? "Public GitHub artifact resolved through SSRF-safe URL fetch." : "Public URL resolved through SSRF-safe evidence fetch.",
    url,
  };
}

async function evaluateEvidenceItem(item = {}, options = {}) {
  const urls = safeArray(item.urls);
  if (urls.length) {
    const resolved = [];
    for (const url of urls.slice(0, 4)) {
      resolved.push(await resolveUrlArtifact(url, options));
    }
    return resolved.map((artifact) => ({
      event_id: item.event_id,
      event_type: item.event_type,
      event_cid: item.event_cid,
      event_tx_hash: item.event_tx_hash,
      value_digest: artifactDigest(artifact.url || item.value),
      ...artifact,
    }));
  }
  return [{
    event_id: item.event_id,
    event_type: item.event_type,
    event_cid: item.event_cid,
    event_tx_hash: item.event_tx_hash,
    value_digest: artifactDigest(item.value),
    artifact_type: safeText(item.artifact_type, 80) || "text",
    resolver: "text_claim",
    status: "self_attested",
    label: "Text evidence",
    reason: "Text evidence was submitted without an independently resolvable public artifact.",
  }];
}

function packetSummary(verdicts = []) {
  const verified = verdicts.filter((item) => item.status === "verified").length;
  const selfAttested = verdicts.filter((item) => item.status === "self_attested").length;
  const unverified = verdicts.filter((item) => item.status === "unverified").length;
  const status = unverified > 0 ? "needs_review" : "ready";
  const summary = `${verified} verified artifact(s), ${selfAttested} self-attested claim(s), ${unverified} unverified artifact(s).`;
  const recommendation = unverified > 0
    ? "Ask for a resolvable artifact or operator attestation before using this evidence for follow-up routing."
    : selfAttested > 0
      ? "Treat self-attested claims as context and prefer follow-up work that produces public artifacts."
      : "Evidence includes independently resolvable public artifacts.";
  return { verified, selfAttested, unverified, status, summary, recommendation };
}

export async function buildEvidenceEvaluationPacket({
  task = {},
  eventRows = [],
  evaluatorId = "evidence_evaluation_orc",
  fetchUrlExcerptImpl = fetchUrlExcerpt,
} = {}) {
  const taskId = safeText(task.task_id || task.taskId, 180);
  const projectId = safeText(task.project_id || task.projectId, 180);
  const items = eventEvidenceItems(eventRows);
  const verdicts = [];
  for (const item of items) {
    verdicts.push(...await evaluateEvidenceItem(item, { fetchUrlExcerptImpl }));
  }
  const counts = packetSummary(verdicts);
  const packet = {
    schema: "pf.hive.evidence_evaluation_packet.v1",
    task_id: taskId,
    project_id: projectId,
    evaluator_id: safeText(evaluatorId, 180),
    packet_status: counts.status,
    summary: counts.summary,
    recommendation: counts.recommendation,
    counts: {
      verified: counts.verified,
      self_attested: counts.selfAttested,
      unverified: counts.unverified,
    },
    artifact_verdicts: verdicts.slice(0, 24),
    lifecycle_boundary: "context_only_no_task_state_or_reward_mutation",
    generated_at: new Date().toISOString(),
  };
  const sourceDigest = sha256({
    taskId,
    projectId,
    eventIds: safeArray(eventRows).map((event) => event.id || event.event_id),
    verdicts: verdicts.map((verdict) => ({
      value_digest: verdict.value_digest,
      status: verdict.status,
      resolver: verdict.resolver,
    })),
  });
  return {
    id: `evalpkt_${sourceDigest.slice(0, 32)}`,
    taskId,
    projectId,
    packetStatus: counts.status,
    evaluatorId: safeText(evaluatorId, 180),
    summary: counts.summary,
    recommendation: counts.recommendation,
    sourceDigest,
    packet,
  };
}

export function normalizeEvidenceEvaluationPacketRow(row = {}) {
  const packet = safeObject(row.packet_json || row.packet);
  return {
    id: safeText(row.id || packet.id, 180),
    taskId: safeText(row.task_id || row.taskId || packet.task_id, 180),
    projectId: safeText(row.project_id || row.projectId || packet.project_id, 180),
    packetStatus: safeText(row.packet_status || row.packetStatus || packet.packet_status, 80),
    evaluatorId: safeText(row.evaluator_id || row.evaluatorId || packet.evaluator_id, 180),
    summary: safeText(row.summary || packet.summary, 700),
    recommendation: safeText(row.recommendation || packet.recommendation, 700),
    sourceDigest: safeText(row.source_digest || row.sourceDigest, 120),
    counts: safeObject(packet.counts),
    artifactVerdicts: safeArray(packet.artifact_verdicts || packet.artifactVerdicts)
      .slice(0, 12)
      .map((item) => {
        const verdict = safeObject(item);
        return {
          artifactType: safeText(verdict.artifact_type || verdict.artifactType, 80),
          resolver: safeText(verdict.resolver, 120),
          status: safeText(verdict.status, 80),
          label: safeText(verdict.label || verdict.title, 240),
          reason: safeText(verdict.reason, 500),
          cid: safeText(verdict.event_cid || verdict.cid, 240),
          txHash: safeText(verdict.event_tx_hash || verdict.txHash, 240),
        };
      }),
    createdAt: toIso(row.created_at || row.createdAt),
    updatedAt: toIso(row.updated_at || row.updatedAt),
  };
}

export async function persistEvidenceEvaluationPacket(packetResult = {}, { queryImpl = query } = {}) {
  if (!databaseEnabled() && queryImpl === query) return { ok: false, skipped: true, reason: "database_not_configured" };
  if (!(await packetTableExists(queryImpl))) return { ok: false, status: 409, error: "evidence_evaluation_packets_not_migrated" };
  const result = await queryImpl(
    `
      INSERT INTO board_manager_evidence_evaluation_packets (
        id,
        task_id,
        project_id,
        packet_status,
        evaluator_id,
        summary,
        recommendation,
        source_digest,
        packet_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        packet_status = EXCLUDED.packet_status,
        evaluator_id = EXCLUDED.evaluator_id,
        summary = EXCLUDED.summary,
        recommendation = EXCLUDED.recommendation,
        source_digest = EXCLUDED.source_digest,
        packet_json = EXCLUDED.packet_json,
        updated_at = now()
      RETURNING *
    `,
    [
      packetResult.id,
      packetResult.taskId,
      packetResult.projectId,
      packetResult.packetStatus,
      packetResult.evaluatorId,
      packetResult.summary,
      packetResult.recommendation,
      packetResult.sourceDigest,
      jsonValue(packetResult.packet),
    ]
  );
  return { ok: true, packet: normalizeEvidenceEvaluationPacketRow(result.rows[0]) };
}

export async function createEvidenceEvaluationPacketForTask({
  taskId = "",
  evaluatorId = "evidence_evaluation_orc",
  fetchUrlExcerptImpl = fetchUrlExcerpt,
  queryImpl = query,
  persist = true,
} = {}) {
  const normalizedTaskId = safeText(taskId, 180);
  if (!normalizedTaskId) return { ok: false, status: 400, error: "task_id_required" };
  const taskResult = await queryImpl(
    `
      SELECT refs.task_id, refs.project_id, refs.title, projection.status
      FROM network_project_task_refs refs
      JOIN task_projections projection
        ON projection.task_id = refs.task_id
      WHERE refs.task_id = $1
        AND refs.source = 'network_task_generation'
      LIMIT 1
    `,
    [normalizedTaskId]
  );
  const task = taskResult.rows[0] || null;
  if (!task) return { ok: false, status: 404, error: "network_task_not_found" };
  const eventsResult = await queryImpl(
    `
      SELECT *
      FROM task_events
      WHERE task_id = $1
      ORDER BY occurred_at ASC, id ASC
      LIMIT 200
    `,
    [normalizedTaskId]
  );
  const built = await buildEvidenceEvaluationPacket({
    task,
    eventRows: eventsResult.rows,
    evaluatorId,
    fetchUrlExcerptImpl,
  });
  if (!persist) return { ok: true, packet: normalizeEvidenceEvaluationPacketRow({ ...built, packet_json: built.packet }) };
  const persisted = await persistEvidenceEvaluationPacket(built, { queryImpl });
  return persisted.ok ? persisted : { ...persisted, packet: built };
}

export async function listEvidenceEvaluationPackets({
  taskIds = [],
  projectIds = [],
  limit = 50,
  queryImpl = query,
  databaseReady = databaseEnabled(),
} = {}) {
  if (!databaseReady && queryImpl === query) return [];
  if (!(await packetTableExists(queryImpl))) return [];
  const normalizedTaskIds = [...new Set(safeArray(taskIds).map((item) => safeText(item, 180)).filter(Boolean))];
  const normalizedProjectIds = [...new Set(safeArray(projectIds).map((item) => safeText(item, 180)).filter(Boolean))];
  const result = await queryImpl(
    `
      SELECT *
      FROM board_manager_evidence_evaluation_packets
      WHERE packet_status <> 'superseded'
        AND (
          cardinality($1::text[]) = 0
          OR task_id = ANY($1::text[])
        )
        AND (
          cardinality($2::text[]) = 0
          OR project_id = ANY($2::text[])
        )
      ORDER BY updated_at DESC, id DESC
      LIMIT $3
    `,
    [
      normalizedTaskIds,
      normalizedProjectIds,
      Math.min(Math.max(Number(limit) || 50, 1), 200),
    ]
  );
  return result.rows.map(normalizeEvidenceEvaluationPacketRow);
}

export async function listEvidenceEvaluationPacketsForBoardManager({ limit = 24 } = {}) {
  return listEvidenceEvaluationPackets({
    limit: Math.min(Math.max(Number(limit) || 24, 1), 60),
  }).catch(() => []);
}
