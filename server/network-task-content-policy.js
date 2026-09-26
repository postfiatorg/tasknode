// Operator content policy for network tasks (2026-09-26).
//
// Two task shapes are banned outright, whatever board, agent or prompt asks
// for them, because they pay for commentary instead of work and attract
// low-effort sybil farming:
//
//  1. Critiques of published writing: critiques, fact-checks, claim audits,
//     falsifiability reviews, stress tests, rebuttals or scorecards of essays,
//     posts, articles or threads (including the operator's public writing).
//  2. Audits delivered as documents: audit / review / assessment tasks whose
//     deliverable is a gist, write-up, report, memo or coverage map rather than
//     a code change.
//
// Real engineering stays allowed: pull requests, fixes, tests, reproductions
// that land a patch, backtests with code.

const WRITING_TARGET =
  /\b(essays?|blog ?posts?|posts?|articles?|primers?|threads?|newsletters?|substack|medium (?:article|post|critique)|op-?eds?|writing|goodalexander\.github\.io|content\/posts)\b/i;
const CRITIQUE_ACTION =
  /\b(critiqu\w*|critic\w*|fact[- ]?check\w*|claim[- ]?(?:by[- ]?claim|audit\w*)|retrospective claim|falsifiab\w*|stress[- ]?test\w*|rebut\w*|rebuttal|refut\w*|scorecard|steelman\w*|contradict\w*|debunk\w*|tear[- ]?down|red[- ]?team\w*)/i;

const AUDIT_ACTION =
  /\b(audit\w*|review\w*|assess\w*|evaluat\w*|inspect\w*|critiqu\w*|fact[- ]?check\w*|coverage (?:map|gap|plan)|merge[- ]readiness)\b/i;
const DOCUMENT_DELIVERABLE =
  /\b(gists?|write[- ]?ups?|reports?|memos?|scorecards?|findings (?:doc|document|note)|coverage (?:map|plan)|decision gist|public note)\b/i;
const CODE_DELIVERABLE =
  /\b(open (?:a )?(?:pull request|PR)|submit (?:a )?(?:pull request|PR)|pull request that|patch(?:es)?|fix(?:es|ed)? (?:the|a)|land (?:a|the) fix|failing test|regression test|unit test|pytest|cargo test|write (?:a )?test)\b/i;

export const NETWORK_TASK_CONTENT_POLICY_VERSION = "network_task_content_policy_v1";

export function networkTaskContentViolation(...texts) {
  const text = texts
    .flat()
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n");
  if (!text) return null;
  if (CRITIQUE_ACTION.test(text) && WRITING_TARGET.test(text)) {
    return {
      code: "critique_of_published_writing",
      message:
        "Network tasks may not critique, fact-check, audit or stress-test essays, posts or other published writing.",
    };
  }
  if (AUDIT_ACTION.test(text) && DOCUMENT_DELIVERABLE.test(text) && !CODE_DELIVERABLE.test(text)) {
    return {
      code: "audit_document_deliverable",
      message:
        "Network tasks may not pay for audits or reviews delivered as a gist, report or write-up; route a code change instead.",
    };
  }
  return null;
}

export function assertNetworkTaskContentAllowed(...texts) {
  const violation = networkTaskContentViolation(...texts);
  if (!violation) return;
  throw Object.assign(
    new Error(`network_task_content_policy_rejected: ${violation.code}: ${violation.message}`),
    { status: 422, code: "network_task_content_policy_rejected", violation, policy: NETWORK_TASK_CONTENT_POLICY_VERSION }
  );
}
