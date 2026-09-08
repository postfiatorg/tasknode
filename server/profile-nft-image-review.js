import { parseInferenceJson } from "./inference-text.js";
import { privateProfileNftCompletion } from "./profile-nft-art-spec.js";
import { profileNftTitlePrompt, profileNftTitlePromptDigest, profileNftTitleSchema, validateProfileNftTitle } from "./profile-nft-title.js";

function parse(text = "") { return parseInferenceJson(text); }

function imageReviewSchema() {
  return { type: "json_schema", json_schema: { name: "profile_nft_image_art_review", strict: true, schema: {
    type: "object", additionalProperties: false, required: ["approved", "privacy_violations", "art_direction_violations", "title"],
    properties: {
      title: profileNftTitleSchema,
      approved: { type: "boolean" },
      privacy_violations: { type: "array", maxItems: 8, items: { type: "string", enum: [
        "text", "numbers", "username", "logo_or_brand", "wallet_or_qr", "document_or_code", "identifiable_real_person", "financial_symbol", "other_sensitive_detail",
      ] } },
      art_direction_violations: { type: "array", maxItems: 8, items: { type: "string", enum: [
        "prompt_mismatch", "no_readable_central_figure", "no_clear_action", "emblem_or_symbol_as_subject", "collage_or_diagram", "generic_or_stock", "glossy_3d_toy", "weak_profile_silhouette", "low_visual_specificity", "palette_or_style_mismatch",
      ] } },
    },
  } } };
}

export async function reviewRenderedProfileNftImage({ imageBase64, mimeType = "image/png", sanitizedPrompt = "", env = process.env, fetchImpl = fetch, signal } = {}) {
  const encoded = String(imageBase64 || "").trim();
  if (!encoded) throw new Error("profile_nft_privacy_review_image_missing");
  const result = await privateProfileNftCompletion({ env, fetchImpl, signal, capability: "verification_vision", body: {
    messages: [
      { role: "system", content: "Review this generated profile NFT for both privacy and art-direction compliance. Reject visible text, letters, numbers, usernames, logos, brands, wallet addresses, QR codes, readable or reconstructable documents or source code, account-specific financial details, recognizable branded financial marks, or a person identifiable as a specific real individual. A fictional illustrated central avatar or persona, including one with a visible face, is explicitly allowed and is required by the art direction; do not mark a merely visible or detailed fictional face as identifiable_real_person. Abstract technical tools, abstract market imagery, and non-readable document-like texture are allowed when they reveal no sensitive detail. Also reject a missing central work persona, unclear action, an emblem or symbol used as the main subject, a collage or diagram, generic stock imagery, glossy 3D-toy rendering, weak avatar-size silhouette, low visual specificity, or mismatch with the sanitized render prompt. Return only the required JSON." },
      { role: "system", content: profileNftTitlePrompt },
      { role: "user", content: [
        { type: "text", text: `Sanitized render prompt:\n${String(sanitizedPrompt || "").slice(0, 8000)}\n\nInspect the image itself. Be conservative: approved is true only when both violation arrays are empty.` },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${encoded}` } },
      ] },
    ],
    response_format: imageReviewSchema(), reasoning: { effort: "high", exclude: true }, temperature: 0,
  } });
  const review = parse(result.text);
  const privacyViolations = Array.isArray(review.privacy_violations)
    ? [...new Set(review.privacy_violations)]
    : ["review_invalid"];
  const artDirectionViolations = Array.isArray(review.art_direction_violations)
    ? [...new Set(review.art_direction_violations)]
    : ["review_invalid"];
  if (review.approved !== true || Object.keys(review).length !== 4 || privacyViolations.length || artDirectionViolations.length) {
    const code = privacyViolations.length ? "profile_nft_generated_image_privacy_rejected" : "profile_nft_generated_image_art_direction_rejected";
    throw Object.assign(new Error(code), {
      code,
      privacyViolations,
      artDirectionViolations,
    });
  }
  let title = "";
  try { title = validateProfileNftTitle(review.title); } catch (error) {
    if (error.message !== "profile_nft_title_invalid") throw error;
    // Preserve the approved image. The worker checkpoints it before obtaining
    // a replacement model title, and never publishes an invalid name.
  }
  return { approved: true, model: result.model, title, titlePromptDigest: profileNftTitlePromptDigest };
}
