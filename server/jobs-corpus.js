import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { databaseEnabled, databaseStatus, query, transaction } from "./db/pool.js";
import {
  embedTexts,
  jobsEffectiveEmbeddingModel,
  jobsEmbeddingDimensions,
  jobsEmbeddingModel,
  jobsEmbeddingProvider,
} from "./embedding-provider.js";

export const defaultJobsCorpusUrl =
  "https://gist.githubusercontent.com/goodalexander/3246640dcf10db350fbae9fab8e6a473/raw/bd144a47532fbcba8dd4e8a6f81b605a034c4d16/jobs.md";

const maxChunkChars = Math.min(Math.max(Number(process.env.TASKNODE_JOBS_CHUNK_MAX_CHARS) || 1600, 600), 3200);
const chunkOverlapChars = Math.min(Math.max(Number(process.env.TASKNODE_JOBS_CHUNK_OVERLAP_CHARS) || 180, 0), 500);
const maxRetrievalChunkChars = Math.min(
  Math.max(Number(process.env.TASKNODE_JOBS_RETRIEVAL_CHUNK_MAX_CHARS) || 950, 300),
  1600
);
const defaultRetrievalLimit = Math.min(Math.max(Number(process.env.TASKNODE_JOBS_RETRIEVAL_LIMIT) || 3, 1), 5);
// 2500ms proved too tight in production: embedding-provider tail latency
// (cold starts) intermittently exceeded it and dropped the Jobs corpus from
// live turns. Retrieval is worth a slightly longer wait; 8000ms clamp holds.
const retrievalTimeoutMs = Math.min(Math.max(Number(process.env.TASKNODE_JOBS_RETRIEVAL_TIMEOUT_MS) || 5000, 250), 8000);

function chatSpiritEnabled() {
  const value = String(process.env.TASKNODE_CHAT_SPIRIT_ENABLED || "true").trim().toLowerCase();
  return !["0", "false", "off", "disabled"].includes(value);
}

function sha256(value = "") {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

function cleanText(value = "") {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ \u00a0]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function titleFromParagraph(paragraph = "", fallback = "") {
  const heading = paragraph.match(/^#{1,6}\s+(.+)$/m)?.[1];
  if (heading) return safeText(heading.replace(/[*_`]/g, ""), 160);
  const firstLine = paragraph.split("\n").find((line) => line.trim()) || fallback;
  return safeText(firstLine.replace(/^[>#*\-\s]+/, "").replace(/[*_`]/g, ""), 160);
}

function chunkLongParagraph(text = "", { title = "", packetLabel = "" } = {}) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + maxChunkChars);
    const content = cleanText(text.slice(start, end));
    if (content) {
      chunks.push({
        title,
        packetLabel,
        content,
      });
    }
    if (end >= text.length) break;
    start = Math.max(0, end - chunkOverlapChars);
  }
  return chunks;
}

export function chunkJobsCorpus(raw = "") {
  const normalized = cleanText(raw);
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let currentTitle = "Jobs corpus";
  let currentPacket = "Jobs corpus";
  let buffer = "";

  function flush() {
    const content = cleanText(buffer);
    if (content) {
      chunks.push({
        title: currentTitle,
        packetLabel: currentPacket,
        content,
      });
    }
    buffer = "";
  }

  for (const paragraph of paragraphs) {
    const heading = paragraph.match(/^#{1,6}\s+(.+)$/m);
    if (heading) {
      flush();
      currentTitle = titleFromParagraph(paragraph, currentTitle);
      currentPacket = currentTitle;
    }

    if (paragraph.length > maxChunkChars) {
      flush();
      chunks.push(...chunkLongParagraph(paragraph, { title: currentTitle, packetLabel: currentPacket }));
      continue;
    }

    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChunkChars) {
      flush();
      buffer = paragraph;
    } else {
      buffer = candidate;
    }
  }
  flush();

  return chunks.map((chunk, index) => ({
    ...chunk,
    chunkIndex: index,
    contentSha256: sha256(chunk.content),
    tokenEstimate: Math.ceil(chunk.content.length / 4),
  }));
}

function vectorLiteral(vector = []) {
  return `[${vector.map((value) => Number(value).toFixed(8)).join(",")}]`;
}

function publicChunk(row) {
  const distance = Number(row.distance ?? 0);
  const similarity = Number((1 - distance).toFixed(6));
  return {
    id: row.id,
    sourceId: row.source_id,
    chunkIndex: Number(row.chunk_index || 0),
    packetLabel: row.packet_label || "",
    title: row.title || "",
    content: row.content || "",
    contentSha256: row.content_sha256 || "",
    tokenEstimate: Number(row.token_estimate || 0),
    embeddingModel: row.embedding_model || "",
    embeddingDimensions: Number(row.embedding_dimensions || 0),
    embeddingProvider: row.embedding_provider || "",
    sourceSha256: row.raw_sha256 || "",
    sourceUrl: row.source_url || "",
    distance,
    similarity,
  };
}

export function jobsCorpusStatus() {
  return databaseStatus();
}

export async function loadJobsCorpusSource({ filePath = "", sourceUrl = "" } = {}) {
  if (filePath) {
    const raw = await readFile(filePath, "utf8");
    return {
      raw,
      sourceUrl: sourceUrl || `file://${filePath}`,
      fetchedAt: null,
    };
  }

  const url = sourceUrl || process.env.TASKNODE_JOBS_CORPUS_URL || defaultJobsCorpusUrl;
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error("jobs_corpus_fetch_failed");
    error.status = response.status;
    throw error;
  }
  return {
    raw: await response.text(),
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
  };
}

export async function existingJobsCorpusCount({ rawSha256, embeddingModel, dimensions }) {
  if (!databaseEnabled()) return 0;
  const result = await query(
    `
      SELECT count(*)::integer AS count
      FROM jobs_corpus_sources AS source
      JOIN jobs_corpus_chunks AS chunk
        ON chunk.source_id = source.id
      WHERE source.raw_sha256 = $1
        AND chunk.embedding_model = $2
        AND chunk.embedding_dimensions = $3
    `,
    [rawSha256, embeddingModel, dimensions]
  );
  return Number(result.rows[0]?.count || 0);
}

export async function ingestJobsCorpus({
  raw,
  sourceUrl,
  fetchedAt = null,
  sourceLabel = "Jobs corpus",
  provider = jobsEmbeddingProvider(),
  model = jobsEmbeddingModel(),
  dimensions = jobsEmbeddingDimensions(),
  force = false,
  batchSize = 48,
} = {}) {
  if (!databaseEnabled()) {
    return { ok: false, skipped: true, reason: "database_not_configured" };
  }
  const sourceText = cleanText(raw);
  if (!sourceText) throw new Error("jobs_corpus_source_empty");

  const rawSha256 = sha256(sourceText);
  const effectiveProvider = jobsEmbeddingProvider(provider);
  const effectiveModel = jobsEffectiveEmbeddingModel({ provider: effectiveProvider, model });
  const chunks = chunkJobsCorpus(sourceText);
  const existingCount = await existingJobsCorpusCount({ rawSha256, embeddingModel: effectiveModel, dimensions });
  if (!force && existingCount === chunks.length && chunks.length > 0) {
    return {
      ok: true,
      skipped: true,
      reason: "already_ingested",
      rawSha256,
      chunkCount: chunks.length,
      embeddingModel: effectiveModel,
      embeddingDimensions: dimensions,
      embeddingProvider: effectiveProvider,
    };
  }

  const embeddingResult = await embedTexts(chunks.map((chunk) => chunk.content), {
    provider: effectiveProvider,
    model: effectiveModel,
    dimensions,
    batchSize,
  });
  if (embeddingResult.embeddings.length !== chunks.length) {
    throw new Error("jobs_corpus_embedding_count_mismatch");
  }

  const sourceId = `jobs_src_${rawSha256.slice(0, 24)}`;
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('jobs_corpus_ingest'))");
    await client.query(
      `
        INSERT INTO jobs_corpus_sources (
          id,
          source_url,
          raw_sha256,
          raw_size_bytes,
          source_label,
          fetched_at,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (raw_sha256) DO UPDATE
        SET source_url = EXCLUDED.source_url,
            raw_size_bytes = EXCLUDED.raw_size_bytes,
            source_label = EXCLUDED.source_label,
            fetched_at = COALESCE(EXCLUDED.fetched_at, jobs_corpus_sources.fetched_at),
            metadata_json = EXCLUDED.metadata_json,
            updated_at = now()
      `,
      [
        sourceId,
        sourceUrl || defaultJobsCorpusUrl,
        rawSha256,
        Buffer.byteLength(sourceText, "utf8"),
        sourceLabel,
        fetchedAt,
        JSON.stringify({ chunker: "jobs-corpus-v1", maxChunkChars, chunkOverlapChars }),
      ]
    );

    if (force) {
      await client.query(
        `
          DELETE FROM jobs_corpus_chunks
          WHERE source_id = $1
            AND embedding_model = $2
            AND embedding_dimensions = $3
        `,
        [sourceId, embeddingResult.model, embeddingResult.dimensions]
      );
    }

    for (const chunk of chunks) {
      const embedding = embeddingResult.embeddings[chunk.chunkIndex];
      await client.query(
        `
          INSERT INTO jobs_corpus_chunks (
            id,
            source_id,
            chunk_index,
            packet_label,
            title,
            content,
            content_sha256,
            token_estimate,
            embedding_model,
            embedding_dimensions,
            embedding_provider,
            embedding,
            metadata_json
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector, $13::jsonb)
          ON CONFLICT (source_id, embedding_model, embedding_dimensions, chunk_index) DO UPDATE
          SET packet_label = EXCLUDED.packet_label,
              title = EXCLUDED.title,
              content = EXCLUDED.content,
              content_sha256 = EXCLUDED.content_sha256,
              token_estimate = EXCLUDED.token_estimate,
              embedding_provider = EXCLUDED.embedding_provider,
              embedding = EXCLUDED.embedding,
              metadata_json = EXCLUDED.metadata_json,
              updated_at = now()
        `,
        [
          `jobs_chunk_${rawSha256.slice(0, 16)}_${String(chunk.chunkIndex).padStart(5, "0")}`,
          sourceId,
          chunk.chunkIndex,
          safeText(chunk.packetLabel, 220),
          safeText(chunk.title, 220),
          chunk.content,
          chunk.contentSha256,
          chunk.tokenEstimate,
          embeddingResult.model,
          embeddingResult.dimensions,
          embeddingResult.provider,
          vectorLiteral(embedding),
          JSON.stringify({ source: "jobs-corpus-ingest", contentChars: chunk.content.length }),
        ]
      );
    }
  });

  return {
    ok: true,
    sourceId,
    rawSha256,
    chunkCount: chunks.length,
    embeddingModel: embeddingResult.model,
    embeddingDimensions: embeddingResult.dimensions,
    embeddingProvider: embeddingResult.provider,
  };
}

export async function searchJobsCorpus({
  queryText = "",
  embedding = null,
  limit = defaultRetrievalLimit,
  model = jobsEmbeddingModel(),
  dimensions = jobsEmbeddingDimensions(),
  provider = jobsEmbeddingProvider(),
} = {}) {
  if (!databaseEnabled()) return { ok: false, skipped: true, reason: "database_not_configured", chunks: [] };
  const normalizedLimit = Math.min(Math.max(Number(limit) || defaultRetrievalLimit, 1), 5);
  let queryEmbedding = embedding;
  let embeddingProvider = provider;
  let embeddingModel = model;
  if (!queryEmbedding) {
    const embedded = await embedTexts([queryText], { provider, model, dimensions, batchSize: 1, timeoutMs: 8000 });
    queryEmbedding = embedded.embeddings[0];
    embeddingProvider = embedded.provider;
    embeddingModel = embedded.model;
  }

  const result = await query(
    `
      SELECT
        chunk.*,
        source.raw_sha256,
        source.source_url,
        chunk.embedding <=> $1::vector AS distance
      FROM jobs_corpus_chunks AS chunk
      JOIN jobs_corpus_sources AS source
        ON source.id = chunk.source_id
      WHERE chunk.embedding_model = $2
        AND chunk.embedding_dimensions = $3
      ORDER BY chunk.embedding <=> $1::vector ASC, chunk.chunk_index ASC
      LIMIT $4
    `,
    [vectorLiteral(queryEmbedding), embeddingModel, dimensions, normalizedLimit]
  );

  return {
    ok: true,
    queryText,
    embeddingModel,
    embeddingProvider,
    embeddingDimensions: dimensions,
    chunks: result.rows.map(publicChunk),
  };
}

export function formatJobsRetrieval(chunks = []) {
  const source = Array.isArray(chunks) ? chunks.slice(0, defaultRetrievalLimit) : [];
  if (source.length === 0) return "";

  const lines = [`<jobs_retrieval_context count="${source.length}">`];
  source.forEach((chunk, index) => {
    const content = cleanText(chunk.content).slice(0, maxRetrievalChunkChars);
    lines.push(
      `  <chunk rank="${index + 1}" chunk_id="${chunk.id}" source_sha256="${chunk.sourceSha256}" similarity="${chunk.similarity}" title="${safeText(chunk.title, 120)}">`,
      "<![CDATA[",
      content,
      "]]>",
      "  </chunk>"
    );
  });
  lines.push("</jobs_retrieval_context>");
  return lines.join("\n");
}

export function jobsRetrievalEstimateText() {
  if (!chatSpiritEnabled()) return "";
  if (process.env.TASKNODE_JOBS_RETRIEVAL_ENABLED === "false") return "";
  const estimatedContent = "x".repeat(maxRetrievalChunkChars);
  const chunks = Array.from({ length: defaultRetrievalLimit }, (_, index) => ({
    id: `jobs_estimated_chunk_${index + 1}`,
    sourceSha256: "estimated",
    similarity: 0,
    title: "Estimated Jobs retrieval context",
    content: estimatedContent,
  }));
  return formatJobsRetrieval(chunks);
}

export function buildJobsRetrievalQuery({ message = "", contextDocument = null, memoryContext = null, taskContext = null } = {}) {
  const parts = [`User message:\n${safeText(message, 1200)}`];
  if (contextDocument?.body) parts.push(`Context document:\n${safeText(contextDocument.body.replace(/<[^>]*>/g, " "), 2200)}`);
  const deep = Array.isArray(memoryContext?.deepMemories) ? memoryContext.deepMemories : [];
  const recent = Array.isArray(memoryContext?.memories) ? memoryContext.memories : [];
  const memoryLines = [...deep, ...recent].map((entry) => entry.memoryText || entry.userRequestSummary || "").filter(Boolean);
  if (memoryLines.length) parts.push(`Memory:\n${safeText(memoryLines.join("\n"), 1800)}`);
  const taskGroups = ["outstanding", "verification", "refused", "rewarded"];
  const taskLines = taskGroups.flatMap((group) =>
    (Array.isArray(taskContext?.[group]) ? taskContext[group] : [])
      .slice(0, 6)
      .map((task) => [task.title, task.description, task.status].filter(Boolean).join(" - "))
  );
  if (taskLines.length) parts.push(`Tasks:\n${safeText(taskLines.join("\n"), 1800)}`);
  return parts.filter(Boolean).join("\n\n").slice(0, 7000);
}

export async function jobsRetrievalForChat({ message = "", contextDocument = null, memoryContext = null, taskContext = null } = {}) {
  if (!chatSpiritEnabled()) {
    return { ok: false, skipped: true, reason: "chat_spirit_disabled", text: "", chunks: [] };
  }
  if (process.env.TASKNODE_JOBS_RETRIEVAL_ENABLED === "false") {
    return { ok: false, skipped: true, reason: "disabled", text: "", chunks: [] };
  }
  const queryText = buildJobsRetrievalQuery({ message, contextDocument, memoryContext, taskContext });
  if (!queryText.trim()) return { ok: false, skipped: true, reason: "empty_query", text: "", chunks: [] };

  const startedAt = Date.now();
  try {
    const result = await Promise.race([
      searchJobsCorpus({ queryText }),
      new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ ok: false, skipped: true, reason: "jobs_retrieval_timeout", chunks: [] }),
          retrievalTimeoutMs
        );
        if (typeof timer?.unref === "function") timer.unref();
      }),
    ]);
    if (result?.reason === "jobs_retrieval_timeout") {
      console.warn(`jobs retrieval timed out after ${Date.now() - startedAt}ms (budget ${retrievalTimeoutMs}ms)`);
    }
    return {
      ...result,
      elapsedMs: Date.now() - startedAt,
      retrievalId: `jobs_ret_${randomUUID()}`,
      text: formatJobsRetrieval(result.chunks),
    };
  } catch (error) {
    console.warn(`jobs retrieval skipped: ${error?.message || error}`);
    return { ok: false, skipped: true, reason: error?.message || "retrieval_failed", text: "", chunks: [] };
  }
}
