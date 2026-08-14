import { AMBIENT_MODELS, ambientChatCompletion } from "./ambient-inference.js";

function parse(text = "") {
  const raw = String(text).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
}

function imageReviewSchema() {
  return { type: "json_schema", json_schema: { name: "profile_nft_image_privacy_review", strict: true, schema: {
    type: "object", additionalProperties: false, required: ["approved", "violations"],
    properties: {
      approved: { type: "boolean" },
      violations: { type: "array", maxItems: 8, items: { type: "string", enum: [
        "text", "numbers", "username", "logo_or_brand", "wallet_or_qr", "document_or_code", "recognizable_person", "financial_symbol", "other_sensitive_detail",
      ] } },
    },
  } } };
}

export async function reviewRenderedProfileNftImage({ imageBase64, mimeType = "image/png", env = process.env, fetchImpl = fetch } = {}) {
  const encoded = String(imageBase64 || "").trim();
  if (!encoded) throw new Error("profile_nft_privacy_review_image_missing");
  const result = await ambientChatCompletion({ env, fetchImpl, capability: "verification_vision", timeoutMs: 120_000, body: {
    model: env.PROFILE_NFT_PRIVACY_VISION_MODEL || AMBIENT_MODELS.vision,
    messages: [
      { role: "system", content: "Privacy-review this generated profile NFT. Reject any visible text, letters, numbers, usernames, logos, brands, wallet addresses, QR codes, documents, source code, financial symbols, or recognizable real people. Return only the required JSON." },
      { role: "user", content: [
        { type: "text", text: "Inspect the image itself. Be conservative: approved is true only when violations is empty." },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${encoded}` } },
      ] },
    ],
    response_format: imageReviewSchema(), reasoning: { effort: "high", exclude: true }, temperature: 0,
  } });
  const review = parse(result.text);
  if (!review.approved || !Array.isArray(review.violations) || review.violations.length) {
    throw Object.assign(new Error("profile_nft_generated_image_privacy_rejected"), { code: "profile_nft_generated_image_privacy_rejected" });
  }
  return { approved: true, model: result.model };
}
