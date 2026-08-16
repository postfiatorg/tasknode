function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value);
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

export function publicChatMessage(row, attachments = []) {
  const metadata = row.metadata_json && typeof row.metadata_json === "object"
    ? row.metadata_json
    : row.metadata && typeof row.metadata === "object"
      ? row.metadata
      : {};
  const message = {
    id: row.id,
    role: row.role,
    body: row.body,
    createdAt: toIso(row.created_at || row.createdAt),
    mode: row.mode || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    responseId: row.response_id || row.responseId || undefined,
  };
  if (attachments.length > 0) message.attachments = attachments;
  if (Object.keys(metadata).length > 0) message.metadata = metadata;
  if (metadata.thinking && typeof metadata.thinking === "object") message.thinking = metadata.thinking;
  return message;
}

export function publicChatAttachment(row) {
  const attachment = {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type || undefined,
    kind: row.kind || undefined,
    source: row.source || undefined,
    size: Number(row.size_bytes || 0),
    sha256: row.sha256 || undefined,
    textExcerpt: row.text_excerpt || undefined,
    storageUri: row.storage_uri || undefined,
    createdAt: toIso(row.created_at),
  };
  if (typeof row.text_content === "string" && row.text_content.length > 0) {
    attachment.textContent = row.text_content;
  }
  return attachment;
}

export function publicBillingLedgerEntry(row, extra = {}) {
  if (!row) return null;
  const metadata = row.metadata_json && typeof row.metadata_json === "object" ? row.metadata_json : {};
  return {
    id: row.id,
    kind: row.kind,
    accountId: row.account_id || "",
    conversationId: row.conversation_id || undefined,
    source: row.source || undefined,
    amountUsd: numeric(row.amount_usd),
    note: row.note || undefined,
    createdBy: row.created_by || undefined,
    provider: row.provider || undefined,
    model: row.model || undefined,
    mode: row.mode || undefined,
    responseId: row.response_id || undefined,
    modelRunId: row.model_run_id || undefined,
    inputTokens: Number(row.input_tokens || 0),
    promptCacheHitTokens: Number(row.prompt_cache_hit_tokens || 0),
    promptCacheMissTokens: Number(row.prompt_cache_miss_tokens || 0),
    cacheUsageReported: row.cache_usage_reported === true,
    cacheSavingsUsd: numeric(row.cache_savings_usd),
    costSource: row.cost_source || undefined,
    providerCostUsd: row.provider_cost_usd === null || row.provider_cost_usd === undefined
      ? undefined
      : numeric(row.provider_cost_usd),
    outputTokens: Number(row.output_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
    webSearchCalls: Number(row.web_search_calls || 0),
    toolCostUsd: numeric(row.tool_cost_usd),
    uniqueKey: row.idempotency_key || undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    createdAt: toIso(row.created_at),
    ...extra,
  };
}
