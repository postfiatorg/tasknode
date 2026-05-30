import { createHash, randomUUID } from "node:crypto";
import { databaseEnabled, databaseStatus, query, transaction } from "../db/pool.js";
import { markBoardManagerFollowupsAnsweredForHiveEntry } from "./board-manager-state.js";

const maxBodyLength = 24_000;
const maxDisplayNameLength = 120;
const maxConversationTitleLength = 160;
const maxConversationIdLength = 180;
const maxLimit = 240;
const maxClaimLimit = 3;
const failedAttemptLimit = 3;
const maxAttachmentTextLength = 12_000;
const maxAttachmentSourceTextLength = 3_200;
const maxAttachmentExcerptLength = 800;
export const hiveSecretaryPromptVersion = "hive_secretary_v1";
const fallbackEntries = [];
const fallbackJobs = [];
const fallbackReports = [];

function useDatabase() {
  return databaseEnabled();
}

export function hiveContextRepositoryStatus() {
  return databaseStatus();
}

function safeText(value = "", max = 1000) {
  return String(value || "").trim().replace(/\s+\n/g, "\n").slice(0, max);
}

function safeAccountId(value = "") {
  return safeText(value, 160);
}

function safeWalletAddress(value = "") {
  return safeText(value, 80);
}

function safeDisplayName(value = "", fallback = "Unknown user") {
  return safeText(value, maxDisplayNameLength) || fallback;
}

function safeConversationId(value = "") {
  return safeText(value, maxConversationIdLength);
}

function cleanBody(value = "") {
  return safeText(value, maxBodyLength);
}

function sha256(text = "") {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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

function stableDigestValue(value) {
  if (Array.isArray(value)) return value.map(stableDigestValue);
  if (!value || typeof value !== "object") return value;
  const volatileKeys = new Set(["generated_at"]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !volatileKeys.has(key))
      .map(([key, item]) => [key, stableDigestValue(item)])
  );
}

function oneLine(value = "", max = 800) {
  return safeText(value, max).replace(/\s+/g, " ");
}

function displayWallet(value = "") {
  const wallet = safeWalletAddress(value);
  if (!wallet) return "";
  if (wallet.length <= 16) return wallet;
  return `${wallet.slice(0, 8)}...${wallet.slice(-6)}`;
}

function sourceAttachment(attachment = {}) {
  const textContent = safeText(attachment?.textContent || attachment?.text_content || "", maxAttachmentTextLength);
  const textExcerpt = safeText(
    attachment?.textExcerpt || attachment?.text_excerpt || textContent,
    maxAttachmentExcerptLength
  );
  return {
    name: safeText(attachment?.name || "attachment", 160),
    mimeType: safeText(attachment?.mimeType || attachment?.mime_type || "", 120),
    kind: safeText(attachment?.kind || "", 40),
    source: safeText(attachment?.source || "", 80),
    size: Math.max(0, Number(attachment?.size || attachment?.sizeBytes || attachment?.size_bytes || 0)),
    textContent: textContent || undefined,
    textExcerpt: textExcerpt || undefined,
  };
}

function attachmentSourceText(attachments = []) {
  const normalized = jsonArray(attachments).map(sourceAttachment).filter((attachment) => attachment.name);
  if (normalized.length === 0) return "";
  return [
    "Attachments",
    ...normalized.map((attachment, index) => [
      `Attachment ${index + 1}: ${attachment.name} (${attachment.mimeType || attachment.kind || "file"}, ${attachment.size} bytes)`,
      safeText(attachment.textContent || attachment.textExcerpt || "[No readable text extracted.]", maxAttachmentSourceTextLength),
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function publicEntry(row = {}) {
  const attachments = row.attachments_json || row.attachments || [];
  const metadata = row.metadata_json || row.metadata || {};
  return {
    id: row.id,
    accountId: row.account_id || row.accountId || "",
    displayName: row.display_name || row.displayName || "Unknown user",
    body: row.body || "",
    excerpt: safeText(row.body || "", 220),
    source: row.source || "chat_hive_input",
    sourceConversationId: row.source_conversation_id || row.sourceConversationId || "",
    sourceConversationTitle: row.source_conversation_title || row.sourceConversationTitle || "",
    walletAddress: row.wallet_address || row.walletAddress || "",
    walletValidated: Boolean(row.wallet_validated ?? row.walletValidated),
    attachments: jsonArray(attachments).map((attachment) => ({
      name: safeText(attachment?.name || "attachment", 160),
      mimeType: safeText(attachment?.mimeType || attachment?.mime_type || "", 120),
      size: Math.max(0, Number(attachment?.size || attachment?.sizeBytes || attachment?.size_bytes || 0)),
    })),
    metadata: jsonObject(metadata),
    createdAt: toIso(row.created_at || row.createdAt),
    updatedAt: toIso(row.updated_at || row.updatedAt),
  };
}

function groupedDocument(entries = []) {
  const groupsByKey = new Map();
  for (const entry of entries.map(publicEntry)) {
    const key = entry.accountId || entry.displayName;
    const existing = groupsByKey.get(key) || {
      accountId: entry.accountId,
      displayName: entry.displayName,
      latestAt: entry.createdAt,
      entryCount: 0,
      entries: [],
    };
    existing.displayName = existing.displayName || entry.displayName;
    existing.latestAt = latestIso(existing.latestAt, entry.createdAt);
    existing.entryCount += 1;
    existing.entries.push(entry);
    groupsByKey.set(key, existing);
  }

  const groups = Array.from(groupsByKey.values())
    .map((group) => ({
      ...group,
      entries: group.entries.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    }))
    .sort((a, b) => {
      const nameSort = String(a.displayName || "").toLowerCase().localeCompare(String(b.displayName || "").toLowerCase());
      if (nameSort !== 0) return nameSort;
      return String(a.accountId || "").localeCompare(String(b.accountId || ""));
    });

  return {
    id: "hive_context",
    generatedAt: new Date().toISOString(),
    entryCount: entries.length,
    userCount: groups.length,
    groups,
  };
}

function latestIso(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return String(a) > String(b) ? a : b;
}

export async function saveHiveContextEntry({
  accountId = "",
  displayName = "",
  body = "",
  sourceConversationId = "",
  sourceConversationTitle = "",
  walletAddress = "",
  walletValidated = false,
  attachments = [],
  metadata = {},
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  if (!normalizedAccountId) {
    const error = new Error("hive_context_login_required");
    error.status = 401;
    throw error;
  }

  const normalizedBody = cleanBody(body);
  if (!normalizedBody) {
    const error = new Error("hive_context_body_required");
    error.status = 400;
    throw error;
  }

  const now = new Date();
  const entry = {
    id: `hivectx_${randomUUID()}`,
    accountId: normalizedAccountId,
    displayName: safeDisplayName(displayName, normalizedAccountId),
    body: normalizedBody,
    bodySha256: sha256(normalizedBody),
    source: "chat_hive_input",
    sourceConversationId: safeConversationId(sourceConversationId),
    sourceConversationTitle: safeText(sourceConversationTitle, maxConversationTitleLength),
    walletAddress: safeWalletAddress(walletAddress),
    walletValidated: Boolean(walletValidated && safeWalletAddress(walletAddress)),
    attachments: jsonArray(attachments),
    metadata: jsonObject(metadata),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  if (!useDatabase()) {
    fallbackEntries.unshift(entry);
    return publicEntry(entry);
  }

  const result = await query(
    `
      INSERT INTO hive_context_entries (
        id,
        account_id,
        display_name,
        body,
        body_sha256,
        source,
        source_conversation_id,
        source_conversation_title,
        wallet_address,
        wallet_validated,
        attachments_json,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'chat_hive_input', $6, $7, $8, $9, $10, $11, $12, $12)
      RETURNING *
    `,
    [
      entry.id,
      entry.accountId,
      entry.displayName,
      entry.body,
      entry.bodySha256,
      entry.sourceConversationId,
      entry.sourceConversationTitle,
      entry.walletAddress,
      entry.walletValidated,
      JSON.stringify(entry.attachments),
      JSON.stringify(entry.metadata),
      now,
    ]
  );
  const saved = publicEntry(result.rows[0]);
  await markBoardManagerFollowupsAnsweredForHiveEntry({
    accountId: saved.accountId,
    hiveContextEntryId: saved.id,
    conversationId: saved.sourceConversationId,
  }).catch(() => null);
  return saved;
}

export async function markHiveContextEntriesWalletValidated({
  accountId = "",
  walletAddress = "",
} = {}) {
  const normalizedAccountId = safeAccountId(accountId);
  const normalizedWallet = safeWalletAddress(walletAddress);
  if (!normalizedAccountId || !normalizedWallet) {
    return { ok: false, updated: 0, reason: "missing_account_or_wallet" };
  }

  if (!useDatabase()) {
    let updated = 0;
    for (const entry of fallbackEntries) {
      if (entry.accountId === normalizedAccountId && !entry.walletValidated) {
        entry.walletAddress = normalizedWallet;
        entry.walletValidated = true;
        entry.updatedAt = new Date().toISOString();
        updated += 1;
      }
    }
    return { ok: true, updated };
  }

  const result = await query(
    `
      UPDATE hive_context_entries
      SET wallet_address = $2,
          wallet_validated = true,
          updated_at = now()
      WHERE account_id = $1
        AND deleted_at IS NULL
        AND wallet_validated = false
      RETURNING id
    `,
    [normalizedAccountId, normalizedWallet]
  );
  return {
    ok: true,
    updated: result.rowCount || 0,
    entryIds: result.rows.map((row) => row.id),
  };
}

function publicReport(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status || "completed",
    sourcePacketDigest: row.source_packet_digest || row.sourcePacketDigest || "",
    output: jsonObject(row.output_json || row.output),
    outputText: row.output_text || row.outputText || "",
    provider: row.provider || "",
    model: row.model || "",
    promptVersion: row.prompt_version || row.promptVersion || hiveSecretaryPromptVersion,
    promptDigest: row.prompt_digest || row.promptDigest || "",
    usage: jsonObject(row.usage_json || row.usage),
    error: row.error || "",
    createdAt: toIso(row.created_at || row.createdAt),
    completedAt: toIso(row.completed_at || row.completedAt),
  };
}

function publicJob(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status || "pending",
    reason: row.reason || "",
    sourceEntryId: row.source_entry_id || row.sourceEntryId || "",
    sourcePacketDigest: row.source_packet_digest || row.sourcePacketDigest || "",
    attemptCount: Number(row.attempt_count || row.attemptCount || 0),
    lastError: row.last_error || row.lastError || "",
    createdAt: toIso(row.created_at || row.createdAt),
    updatedAt: toIso(row.updated_at || row.updatedAt),
  };
}

function reportArray(value, { maxItems = 6, maxLength = 360 } = {}) {
  return jsonArray(value)
    .slice(0, maxItems)
    .map((item) => safeText(item, maxLength))
    .filter(Boolean);
}

function projectSignals(value) {
  return jsonArray(value)
    .slice(0, 8)
    .map((item) => ({
      projectType: safeText(item?.project_type || item?.projectType || "", 80),
      signal: safeText(item?.signal || item?.summary || "", 420),
      reason: safeText(item?.reason || "", 420),
      inputRefs: jsonArray(item?.input_refs || item?.inputRefs).slice(0, 8).map((ref) => safeText(ref, 120)).filter(Boolean),
    }))
    .filter((item) => item.signal || item.reason);
}

export function normalizeHiveSecretaryOutput(output = {}) {
  const normalized = {
    title: safeText(output.title, 160) || "Hive Secretary Report",
    summary: safeText(output.summary, 1200),
    projectSignals: projectSignals(output.project_signals || output.projectSignals),
    networkImplications: reportArray(output.network_implications || output.networkImplications, { maxItems: 6, maxLength: 420 }),
    openQuestions: reportArray(output.open_questions || output.openQuestions, { maxItems: 5, maxLength: 320 }),
    nextSystemFocus: reportArray(output.next_system_focus || output.nextSystemFocus, { maxItems: 5, maxLength: 320 }),
  };
  return normalized;
}

export function formatHiveSecretaryReport(output = {}) {
  const report = normalizeHiveSecretaryOutput(output);
  return [
    report.title,
    "",
    report.summary,
    report.projectSignals.length
      ? [
          "Project signals",
          ...report.projectSignals.map((item) => [
            `- ${item.projectType || "network"}: ${item.signal}`,
            item.reason ? `  Reason: ${item.reason}` : "",
          ].filter(Boolean).join("\n")),
        ].join("\n")
      : "",
    report.networkImplications.length
      ? ["Network implications", ...report.networkImplications.map((item) => `- ${item}`)].join("\n")
      : "",
    report.openQuestions.length
      ? ["Open questions", ...report.openQuestions.map((item) => `- ${item}`)].join("\n")
      : "",
    report.nextSystemFocus.length
      ? ["Next system focus", ...report.nextSystemFocus.map((item) => `- ${item}`)].join("\n")
      : "",
  ].filter(Boolean).join("\n\n");
}

function sourceEntry(row = {}) {
  const entry = publicEntry(row);
  const attachments = jsonArray(row.attachments_json || row.attachments).map(sourceAttachment);
  return {
    id: entry.id,
    accountId: entry.accountId,
    displayName: entry.displayName,
    walletAddress: entry.walletAddress,
    walletDisplay: displayWallet(entry.walletAddress),
    body: entry.body,
    attachments,
    createdAt: entry.createdAt,
  };
}

function secretarySourcePacketFromEntries(entries = []) {
  const normalized = entries.map(sourceEntry);
  const groupsByAccount = new Map();
  for (const entry of normalized) {
    const key = entry.accountId || entry.displayName || entry.walletAddress || entry.id;
    const existing = groupsByAccount.get(key) || {
      accountId: entry.accountId,
      displayName: entry.displayName,
      walletAddress: entry.walletAddress,
      entries: [],
    };
    existing.entries.push(entry);
    groupsByAccount.set(key, existing);
  }
  const groups = Array.from(groupsByAccount.values()).sort((a, b) =>
    String(a.displayName || "").toLowerCase().localeCompare(String(b.displayName || "").toLowerCase())
  );
  const generatedAt = new Date().toISOString();
  const sourceJson = {
    schema: "pf.hive.secretary.source.v1",
    generated_at: generatedAt,
    validated_entry_count: normalized.length,
    user_count: groups.length,
    groups: groups.map((group) => ({
      account_id: group.accountId,
      display_name: group.displayName,
      wallet_address: group.walletAddress,
      entries: group.entries.map((entry) => ({
        id: entry.id,
        created_at: entry.createdAt,
        body: entry.body,
        attachments: entry.attachments.map((attachment) => ({
          name: attachment.name,
          mime_type: attachment.mimeType,
          kind: attachment.kind,
          source: attachment.source,
          size: attachment.size,
          text_excerpt: attachment.textExcerpt,
          text_content: attachment.textContent,
        })),
      })),
    })),
  };
  const sourceText = [
    "HIVE SECRETARY SOURCE PACKET",
    "",
    `Generated At: ${generatedAt}`,
    `Validated wallet inputs: ${normalized.length}`,
    `Contributors: ${groups.length}`,
    "",
    "Validated Inputs",
    groups.length
      ? groups.map((group) => [
          `Contributor: ${group.displayName || group.accountId || "Unknown user"}`,
          group.walletAddress ? `Validated wallet: ${displayWallet(group.walletAddress)}` : "",
          ...group.entries.map((entry, index) => [
            `Input ${index + 1}: ${entry.id}`,
            `Time: ${entry.createdAt}`,
            oneLine(entry.body, 3200),
            attachmentSourceText(entry.attachments),
          ].join("\n")),
        ].filter(Boolean).join("\n")).join("\n\n")
      : "No validated wallet inputs.",
  ].join("\n");

  return {
    sourceJson,
    sourceText,
    sourcePacketDigest: sha256(JSON.stringify(stableDigestValue(sourceJson))),
    counts: {
      entryCount: normalized.length,
      userCount: groups.length,
    },
  };
}

export async function buildHiveSecretarySourcePacket({ limit = 120, accountId = "" } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 120, 1), maxLimit);
  const normalizedAccountId = safeAccountId(accountId);
  if (!useDatabase()) {
    return secretarySourcePacketFromEntries(
      fallbackEntries
        .filter((entry) => entry.walletValidated)
        .filter((entry) => !normalizedAccountId || entry.accountId === normalizedAccountId)
        .slice(0, normalizedLimit)
    );
  }

  const result = await query(
    `
      SELECT *
      FROM hive_context_entries
      WHERE deleted_at IS NULL
        AND wallet_validated = true
        AND ($2::text = '' OR account_id = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT $1
    `,
    [normalizedLimit, normalizedAccountId]
  );
  return secretarySourcePacketFromEntries(result.rows);
}

export async function enqueueHiveSecretaryJob({
  reason = "hive_input",
  sourceEntryId = "",
  sourcePacket = null,
} = {}) {
  const packet = sourcePacket || await buildHiveSecretarySourcePacket({ limit: 120 });
  if (!packet?.sourcePacketDigest || !packet.counts?.entryCount) {
    return { queued: false, reason: "no_validated_hive_inputs", sourcePacket: packet };
  }
  if (!useDatabase()) {
    const existing = fallbackJobs.find((job) =>
      job.sourcePacketDigest === packet.sourcePacketDigest && ["pending", "processing"].includes(job.status)
    );
    const job = existing || {
      id: `hivesecretaryjob_${randomUUID()}`,
      status: "pending",
      reason: safeText(reason, 120),
      sourceEntryId: safeText(sourceEntryId, 160),
      sourcePacketDigest: packet.sourcePacketDigest,
      sourcePacketJson: packet.sourceJson,
      sourcePacketText: packet.sourceText,
      attemptCount: 0,
      lastError: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!existing) fallbackJobs.push(job);
    return { queued: true, job: publicJob(job), sourcePacket: packet };
  }

  const result = await query(
    `
      INSERT INTO hive_secretary_jobs (
        id,
        reason,
        source_entry_id,
        source_packet_digest,
        source_packet_json,
        source_packet_text
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (source_packet_digest)
        WHERE status IN ('pending', 'processing')
      DO UPDATE SET
        reason = EXCLUDED.reason,
        source_entry_id = EXCLUDED.source_entry_id,
        source_packet_json = EXCLUDED.source_packet_json,
        source_packet_text = EXCLUDED.source_packet_text,
        updated_at = now()
      RETURNING *
    `,
    [
      `hivesecretaryjob_${randomUUID()}`,
      safeText(reason, 120),
      safeText(sourceEntryId, 160),
      packet.sourcePacketDigest,
      jsonValue(packet.sourceJson),
      packet.sourceText,
    ]
  );
  return { queued: true, job: publicJob(result.rows[0]), sourcePacket: packet };
}

export async function getLatestHiveSecretaryReport() {
  if (!useDatabase()) {
    const report = fallbackReports
      .filter((item) => item.status === "completed" && !item.supersededAt)
      .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")))[0];
    return publicReport(report || null);
  }
  const result = await query(
    `
      SELECT *
      FROM hive_secretary_reports
      WHERE status = 'completed'
        AND superseded_at IS NULL
      ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC
      LIMIT 1
    `
  );
  return publicReport(result.rows[0] || null);
}

export async function getLatestHiveSecretaryJob() {
  if (!useDatabase()) {
    return publicJob(
      fallbackJobs
        .filter((job) => ["pending", "processing"].includes(job.status))
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null
    );
  }
  const result = await query(
    `
      SELECT *
      FROM hive_secretary_jobs
      WHERE status IN ('pending', 'processing')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `
  );
  return publicJob(result.rows[0] || null);
}

export async function getHiveSecretaryState() {
  const [report, job, sourcePacket] = await Promise.all([
    getLatestHiveSecretaryReport(),
    getLatestHiveSecretaryJob(),
    buildHiveSecretarySourcePacket({ limit: 120 }).catch(() => null),
  ]);
  return {
    report,
    job,
    sourcePacket: sourcePacket ? {
      digest: sourcePacket.sourcePacketDigest,
      counts: sourcePacket.counts,
    } : null,
  };
}

export async function claimHiveSecretaryJobs({ limit = 1 } = {}) {
  if (!useDatabase()) return [];
  const normalizedLimit = Math.min(Math.max(Number(limit) || 1, 1), maxClaimLimit);
  return transaction(async (client) => {
    await client.query(
      `
        UPDATE hive_secretary_jobs
        SET status = 'pending',
            next_attempt_at = now(),
            locked_at = NULL,
            updated_at = now()
        WHERE status = 'processing'
          AND locked_at < now() - interval '5 minutes'
      `
    );
    const result = await client.query(
      `
        WITH picked AS (
          SELECT id
          FROM hive_secretary_jobs
          WHERE status = 'pending'
            AND next_attempt_at <= now()
          ORDER BY created_at ASC, id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE hive_secretary_jobs AS job
        SET status = 'processing',
            attempt_count = attempt_count + 1,
            locked_at = now(),
            updated_at = now()
        FROM picked
        WHERE job.id = picked.id
        RETURNING job.*
      `,
      [normalizedLimit]
    );
    return result.rows;
  });
}

export async function completeHiveSecretaryJob({
  job,
  output = {},
  provider = "",
  model = "",
  promptDigest = "",
  promptVersion = hiveSecretaryPromptVersion,
  usage = {},
} = {}) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const outputJson = normalizeHiveSecretaryOutput(output);
  const outputText = formatHiveSecretaryReport(outputJson);
  return transaction(async (client) => {
    await client.query(
      `
        UPDATE hive_secretary_reports
        SET superseded_at = now()
        WHERE status = 'completed'
          AND superseded_at IS NULL
      `
    );
    const inserted = await client.query(
      `
        INSERT INTO hive_secretary_reports (
          id,
          status,
          source_packet_digest,
          source_packet_json,
          source_packet_text,
          output_json,
          output_text,
          provider,
          model,
          prompt_version,
          prompt_digest,
          usage_json,
          completed_at
        )
        VALUES ($1, 'completed', $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::jsonb, now())
        RETURNING *
      `,
      [
        `hivesecretary_${randomUUID()}`,
        safeText(job.source_packet_digest, 120),
        jsonValue(job.source_packet_json),
        safeText(job.source_packet_text, 120_000),
        jsonValue(outputJson),
        outputText,
        safeText(provider, 80),
        safeText(model, 160),
        safeText(promptVersion, 120),
        safeText(promptDigest, 120),
        jsonValue(usage),
      ]
    );
    await client.query(
      `
        UPDATE hive_secretary_jobs
        SET status = 'completed',
            locked_at = NULL,
            last_error = '',
            updated_at = now()
        WHERE id = $1
      `,
      [job.id]
    );
    return { ok: true, report: publicReport(inserted.rows[0]) };
  });
}

export async function failHiveSecretaryJob(job, error) {
  if (!useDatabase() || !job?.id) return { ok: false };
  const attemptCount = Number(job.attempt_count || 0);
  const finalFailure = attemptCount >= failedAttemptLimit;
  const backoffSeconds = Math.min(900, Math.max(30, 30 * attemptCount * attemptCount));
  await query(
    `
      UPDATE hive_secretary_jobs
      SET status = $2,
          next_attempt_at = CASE
            WHEN $2 = 'failed' THEN next_attempt_at
            ELSE now() + ($3::text || ' seconds')::interval
          END,
          locked_at = NULL,
          last_error = $4,
          updated_at = now()
      WHERE id = $1
    `,
    [
      job.id,
      finalFailure ? "failed" : "pending",
      String(backoffSeconds),
      safeText(error?.message || error || "hive_secretary_job_failed", 1000),
    ]
  );
  return { ok: true, retry: !finalFailure };
}

export async function getHiveContextDocument({ limit = 120 } = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 120, 1), maxLimit);
  if (!useDatabase()) {
    return groupedDocument(fallbackEntries.slice(0, normalizedLimit));
  }

  const result = await query(
    `
      SELECT *
      FROM hive_context_entries
      WHERE deleted_at IS NULL
      ORDER BY lower(display_name) ASC, account_id ASC, created_at DESC, id DESC
      LIMIT $1
    `,
    [normalizedLimit]
  );
  return groupedDocument(result.rows);
}
