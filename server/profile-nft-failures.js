const privateFailures = new Set([
  "profile_nft_privacy_not_approved", "profile_nft_privacy_mechanical_leak", "profile_nft_privacy_source_overlap",
  "profile_nft_spec_invalid", "profile_nft_spec_grounding_invalid", "profile_nft_spec_digest_mismatch",
  "profile_nft_generated_image_privacy_rejected", "profile_nft_generated_image_art_direction_rejected",
  "profile_nft_title_invalid",
]);
const configFailures = new Set(["profile_nft_openai_not_configured", "profile_nft_zdr_not_configured", "pinata_not_configured"]);

export function classifyProfileNftGenerationFailure(error = {}) {
  const status = Number(error?.status || error?.httpStatus || 0);
  const typedCode = error?.code || error?.message;
  // Provider messages can echo inputs or secrets. Persist only known codes and
  // fixed user-facing copy; no regex classification or redaction of free text.
  const permanent = configFailures.has(typedCode) || (status >= 400 && status < 500 && ![408,429].includes(status));
  const code = privateFailures.has(typedCode) || configFailures.has(typedCode) || typedCode === "profile_nft_render_lease_lost"
    ? typedCode : permanent ? "profile_nft_provider_permanent" : "profile_nft_provider_transient";
  const message = privateFailures.has(code)
    ? "The artwork did not pass its privacy or art review. Please try again."
    : permanent ? "Artwork generation is unavailable. The service needs attention."
      : "Artwork generation was interrupted. It will retry automatically.";
  return { code, message, retryable: !permanent };
}

export function publicProfileNftGenerationMessage(error = {}) {
  return classifyProfileNftGenerationFailure(error).message;
}
