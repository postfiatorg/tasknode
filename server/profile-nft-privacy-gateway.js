import { parseInferenceJson, sensitiveSourceTokens, replaceSensitiveSourceTokens, splitWhitespace, hasPrivateLiterals } from "./inference-text.js";
import { INFERENCE_MODELS, inferenceChatCompletion } from "./inference.js";
import { profileNftImagePromptPath, renderProfileNftPrompt } from "./profile-nft-prompts.js";
import { loadPrompt } from "./prompt-registry.js";

const abstractionPrompt = loadPrompt("profile/profile_nft_privacy_abstraction_v1.md");
const reviewPrompt = loadPrompt("profile/profile_nft_privacy_review_v1.md");

function schema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "profile_nft_private_summary",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "approved",
          "privacy_risk",
          "instruction_risk",
          "literal_artifact_risk",
          "privacy_findings",
          "profile_summary",
          "context_summary",
        ],
        properties: {
          approved: { type: "boolean" },
          privacy_risk: { type: "string", enum: ["low", "high"] },
          instruction_risk: { type: "string", enum: ["low", "high"] },
          literal_artifact_risk: { type: "string", enum: ["low", "high"] },
          privacy_findings: { type: "array", maxItems: 5, items: { type: "string" } },
          profile_summary: { type: "string" },
          context_summary: { type: "string" },
        },
      },
    },
  };
}

function parse(text = "") { return parseInferenceJson(text); }





export function sanitizeProfileNftSummaryLiterals(summary = {}, source = "") {
    return { ...summary, profile_summary: replaceSensitiveSourceTokens(summary.profile_summary, source), context_summary: replaceSensitiveSourceTokens(summary.context_summary, source) };
  }

export function validateProfileNftSummary(summary = {}, source = "") {
  if (
    summary.approved !== true ||
    summary.privacy_risk !== "low" ||
    summary.instruction_risk !== "low" ||
    summary.literal_artifact_risk !== "low"
  ) {
    throw new Error("profile_nft_privacy_not_approved");
  }

  const profileSummary = String(summary.profile_summary || "").trim();
  const contextSummary = String(summary.context_summary || "").trim();
  if (!profileSummary || !contextSummary || profileSummary.length > 2_000 || contextSummary.length > 4_000) {
    throw new Error("profile_nft_privacy_summary_invalid");
  }

  const profileWords = splitWhitespace(profileSummary).length;
  const contextWords = splitWhitespace(contextSummary).length;
  if (profileWords > 90 || contextWords > 70) {
    throw new Error("profile_nft_privacy_summary_too_detailed");
  }

  // The independent schema-constrained reviewer classifies instruction risk above.
  const rendered = profileSummary + "\n" + contextSummary;
  if (hasPrivateLiterals(rendered)) throw new Error("profile_nft_privacy_mechanical_leak");

  const overlap = [...sensitiveSourceTokens(source)].filter((token) => rendered.toLowerCase().includes(token));
  if (overlap.length) throw new Error("profile_nft_privacy_source_overlap");

  return {
    ...summary,
    profile_summary: profileSummary,
    context_summary: contextSummary,
  };
}

export function renderSanitizedProfileNftPrompt(summary = {}, env = process.env) {
  // The privacy layer is deliberately not an art director. It supplies only the
  // two sanitized text blocks consumed by the canonical, tracked v1 image prompt.
  return renderProfileNftPrompt({
    nftUserData: summary.profile_summary,
    contextDocument: summary.context_summary,
    env: {
      ...env,
      PROFILE_NFT_PROMPT_PATH: profileNftImagePromptPath,
      PROFILE_NFT_PROMPT_TEXT: "",
      PROFILE_NFT_PROMPT_B64: "",
    },
  });
}

export async function createPrivateProfileNftSummary({
  sourcePacket,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const source = JSON.stringify(sourcePacket || {});
  const first = await inferenceChatCompletion({
    env,
    fetchImpl,
    capability: "strict_json",
    timeoutMs: 120_000,
    body: {
      model: env.PROFILE_NFT_PRIVACY_MODEL || INFERENCE_MODELS.structured,
      messages: [
        { role: "system", content: abstractionPrompt },
        { role: "user", content: source },
      ],
      response_format: schema(),
      reasoning: { effort: "high", exclude: true },
      temperature: 0,
    },
  });
  const candidate = parse(first.text);
  const review = async ({ candidateSummary, validationFailure = "" } = {}) =>
    inferenceChatCompletion({
      env,
      fetchImpl,
      capability: "strict_json",
      timeoutMs: 120_000,
      body: {
        model: env.PROFILE_NFT_PRIVACY_MODEL || INFERENCE_MODELS.structured,
        messages: [
          { role: "system", content: reviewPrompt },
          {
            role: "user",
            content: JSON.stringify({
              private_source: sourcePacket,
              candidate_summary: candidateSummary,
              ...(validationFailure ? { validation_failure: validationFailure } : {}),
            }),
          },
        ],
        response_format: schema(),
        reasoning: { effort: "high", exclude: true },
        temperature: 0,
      },
    });

  let reviewed = await review({ candidateSummary: candidate });
  let summary;
  try {
    summary = validateProfileNftSummary(
      sanitizeProfileNftSummaryLiterals(parse(reviewed.text), source),
      source
    );
  } catch (error) {
    // One bounded repair pass lets the reviewer remove an identifier or an
    // accidental imperative instead of turning a safe reroll into a dead end.
    // The same deterministic validator still owns the final decision.
    reviewed = await review({
      candidateSummary: parse(reviewed.text),
      validationFailure: String(error?.message || "profile_nft_privacy_validation_failed"),
    });
    summary = validateProfileNftSummary(
      sanitizeProfileNftSummaryLiterals(parse(reviewed.text), source),
      source
    );
  }
  const rendered = renderSanitizedProfileNftPrompt(summary, env);
  return {
    ...rendered,
    summary,
    source: "tracked_profile_nft_prompt_with_private_summary",
    metadata: {
      ...rendered.metadata,
      privacyModel: reviewed.model,
    },
  };
}
