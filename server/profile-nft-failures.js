function safeText(value = "", max = 500) {
  return String(value || "").trim().slice(0, max);
}

export function classifyProfileNftGenerationFailure(error = {}) {
  const status = Number(error?.status || error?.httpStatus || 0);
  const messageCode = /^profile_nft_[a-z0-9_]+$/i.test(String(error?.message || "").trim())
    ? String(error.message).trim()
    : "";
  const rawCode = safeText(error?.code || error?.error || messageCode, 160).toLowerCase();
  const message = safeText(error?.message || error || "Profile NFT generation failed.")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted_api_key]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  const text = `${rawCode} ${message}`.toLowerCase();
  const permanent = rawCode === "profile_nft_openai_not_configured" || rawCode === "pinata_not_configured" ||
    status === 401 || status === 403 ||
    (status >= 400 && status < 500 && status !== 408 && status !== 429) ||
    /unauthori[sz]ed|forbidden|invalid.*(api|key|model|request)|model.*(not.*found|invalid)|not_configured|invalid_request|ipfs_file_empty|too_large/.test(text);
  const transient = status === 408 || status === 429 || status >= 500 || error?.name === "AbortError" ||
    /timeout|timed out|network|fetch failed|econn|enotfound|temporar/.test(text);
  const code = rawCode || (permanent ? "profile_nft_provider_permanent" : transient ? "profile_nft_provider_transient" : "profile_nft_generation_failed");
  return { code, message, retryable: !permanent };
}

export function publicProfileNftGenerationMessage(error = {}) {
  const failure = classifyProfileNftGenerationFailure(error);
  if (failure.code.startsWith("profile_nft_privacy_")) {
    return "Your private context could not be safely summarized on this attempt. Nothing was generated; try again.";
  }
  return failure.message;
}
