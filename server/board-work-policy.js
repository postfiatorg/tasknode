// What the board manager may pay for (operator scope, 2026-11-15).
//
// One table answers three questions that used to live in separate places:
// which boards take new work, which kinds of work each board takes, and what
// proof a payment needs. Work that is not listed here is not routed.
//
//   Community & Promotion  education and onboarding posts about Post Fiat,
//                          Task Node and Discord; amplification of
//                          goodalexander content; community events.
//   PostfiatL1V2           merged code changes and code reviews of the L1.
//   Task Node Fixes        merged Task Node pull requests; reproduced bug
//                          reports on Task Node.
//   (Community & Promotion also takes reproduced bug reports on the Post Fiat
//   website and blog, the goodalexander site and other public surfaces.)
//   Capital Markets        actionable alpha and amplification of existing
//                          goodalexander research. High bar, no busywork.
//
// PF Terminal and AI Layer 1 Governance are closed to new tasks. Work already
// offered or accepted there is still reviewed and paid under its own terms.

const CODE_CHANGE = ["code_task", "core_repo_work", "private_repo_code", "capability_gating_task"];
const POSTS = ["amplification", "amplification_x", "public_announcement", "article_distribution", "medium_article"];

// Community events and masterminds are routed as "public_announcement": the
// proof is the public event page or recap, and the KOL badge already covers it.
// Written code review: "code_review" for core contributors, "expert_review"
// for expert badge holders.
const REVIEWS = ["code_review", "expert_review"];
// Bug reports on public surfaces: a reproduced defect filed as a public issue.
const QA = ["qa_report", "product_qa", "repro_packet"];

export const BOARD_WORK_POLICY = Object.freeze({
  board_community_promotion: { open: true, workTypes: [...POSTS, ...QA] },
  board_postfiat_l1v2: { open: true, workTypes: [...CODE_CHANGE, ...REVIEWS] },
  board_tasknode_fixes: { open: true, workTypes: [...CODE_CHANGE, ...QA] },
  board_capital_markets: { open: true, workTypes: ["domain_analysis", ...POSTS] },
  board_pf_terminal: { open: false, workTypes: [] },
  board_ai_l1_governance: { open: false, workTypes: [] },
});

// Posts, reviews and research are paid on public proof. Everything else,
// including every task issued before this policy, keeps the merged pull
// request rule it was offered under.
export const PUBLIC_PROOF_WORK_TYPES = Object.freeze(new Set([...POSTS, ...REVIEWS, "domain_analysis"]));

export const PUBLIC_PROOF_REQUIREMENT_TEXT =
  "Payment requirement: this task pays only for public proof you produced after this task was created. Submit the link to the published post, review, bug report, event page or research note, from the account linked to your Task Node profile. A draft, a private document, a screenshot without a public link, or work that already paid another task is not evidence and will not be paid.";

function clean(value = "") {
  return String(value || "").trim().toLowerCase();
}

export function boardWorkPolicy(boardId = "") {
  return BOARD_WORK_POLICY[String(boardId || "").trim()] || null;
}

export function boardOpenForNewWork(boardId = "") {
  const policy = boardWorkPolicy(boardId);
  // Boards outside the table (value accountability, fixtures) keep their own rules.
  return policy ? policy.open : true;
}

// A bug report is paid on the public issue, on the boards that take QA today.
// QA tasks issued earlier on other boards keep their merged pull request terms.
function qaOnOpenBoard({ boardId = "", workType = "" } = {}) {
  const policy = boardWorkPolicy(boardId);
  return QA.includes(clean(workType)) && Boolean(policy?.open) && policy.workTypes.includes(clean(workType));
}

export function mergedPrRequiredForWork({ boardId = "", workType = "" } = {}) {
  if (qaOnOpenBoard({ boardId, workType })) return false;
  return !PUBLIC_PROOF_WORK_TYPES.has(clean(workType));
}

// Written findings are the work in two cases: a code review on the L1 board,
// and a bug report on a board that takes QA.
export function reviewDocumentAllowed({ boardId = "", workType = "" } = {}) {
  if (qaOnOpenBoard({ boardId, workType })) return true;
  return String(boardId || "").trim() === "board_postfiat_l1v2" && REVIEWS.includes(clean(workType));
}

export function boardWorkViolation({ boardId = "", workType = "", operatorDuty = false } = {}) {
  if (operatorDuty) return null;
  const policy = boardWorkPolicy(boardId);
  if (!policy) return null;
  if (!policy.open) {
    return { code: "board_closed_to_new_work", message: `${boardId} is closed to new tasks. In-flight work is still reviewed; route new work to an open board.` };
  }
  const type = clean(workType);
  if (!policy.workTypes.includes(type)) {
    return { code: "work_type_not_in_board_scope", message: `${boardId} takes only: ${policy.workTypes.join(", ")}. "${type || "(none)"}" is outside its scope.` };
  }
  return null;
}

export function assertBoardAcceptsWork(input = {}) {
  const violation = boardWorkViolation(input);
  if (!violation) return;
  throw Object.assign(new Error(`board_work_policy_rejected: ${violation.code}: ${violation.message}`), {
    status: 422,
    code: "board_work_policy_rejected",
    violation,
  });
}
