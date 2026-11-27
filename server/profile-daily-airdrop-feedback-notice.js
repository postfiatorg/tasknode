// Member-safe explanation for a daily airdrop whose written feedback could not
// be produced. Only closed error codes are mapped; upstream text, prompts and
// account data never reach this sentence. With no recorded code (runs stored
// before the code was kept) the honest generic fallback is used.

export const DAILY_AIRDROP_FEEDBACK_FALLBACK_NOTICE = "Detailed feedback is temporarily unavailable.";

const NOTICE_BY_CODE = {
  inference_response_truncated: "The feedback review ran out of room before it finished, so no written feedback was saved for this run.",
  inference_empty_response: "The feedback review returned no text, so no written feedback was saved for this run.",
  inference_timeout: "The feedback review did not finish in time, so no written feedback was saved for this run.",
  inference_http_402: "The feedback service had no available credit when this run was scored, so no written feedback was saved.",
  inference_http_429: "The feedback service was busy when this run was scored, so no written feedback was saved.",
  daily_airdrop_model_output_not_json: "The feedback review returned an unreadable answer, so it was not shown.",
  daily_airdrop_empty_model_output: "The feedback review returned no text, so no written feedback was saved for this run.",
  daily_airdrop_feedback_invalid: "The feedback review returned an incomplete answer, so it was not shown.",
};

const SAFE_CODE_CHARS = new Set("abcdefghijklmnopqrstuvwxyz0123456789_");

function isSafeCode(code = "") {
  return code.length > 0 && code.length <= 80 && [...code].every((char) => SAFE_CODE_CHARS.has(char));
}

export function dailyAirdropFeedbackErrorCode(error) {
  const code = String(error?.code || error?.message || "").trim();
  return isSafeCode(code) ? code : "daily_airdrop_feedback_error";
}

export function dailyAirdropFeedbackNotice(feedbackReview = null) {
  if (!feedbackReview || feedbackReview.status !== "unavailable") return "";
  const code = String(feedbackReview.error?.code || "");
  if (NOTICE_BY_CODE[code]) return NOTICE_BY_CODE[code];
  if (code === "daily_airdrop_feedback_error" || code.startsWith("inference_")) {
    return "The feedback service returned an error when this run was scored, so no written feedback was saved.";
  }
  return DAILY_AIRDROP_FEEDBACK_FALLBACK_NOTICE;
}
