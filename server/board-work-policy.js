// What the board manager may pay for (operator decisions 2026-11-15 and
// 2026-11-25). One table answers three questions: which boards take new work,
// which kinds of work each board takes, and what proof a payment needs. Every
// task also has to come from an open item on the board's Wanted list.
//
//   Layer 1           L1 code changes, L1 code reviews, new validators running.
//   Task Node         Task Node code changes; reproduced bugs that end in a fix.
//   Corbanu Terminal  Corbanu Terminal code changes and reproduced bugs.
//   Trading           actionable trading information; spreading goodalexander
//                     trade ideas and research.
//   Media             explaining and promoting Post Fiat, hype content,
//                     community; bug reports on public surfaces.
//
// AI Layer 1 Governance is closed to new tasks; its in-flight work is still
// reviewed and paid under its own terms. Board ids predate the names.

const CODE_CHANGE = ["code_task", "core_repo_work", "private_repo_code", "capability_gating_task"];
const POSTS = ["amplification", "amplification_x", "public_announcement", "article_distribution", "medium_article"];

// Community events and masterminds are routed as "public_announcement": the
// proof is the public event page or recap, and the KOL badge already covers it.
// Written code review: "code_review" for core contributors, "expert_review"
// for expert badge holders.
const REVIEWS = ["code_review", "expert_review"];
// Bug reports on public surfaces: a reproduced defect filed as a public issue.
const QA = ["qa_report", "product_qa", "repro_packet"];
// A new validator, paid when it is running and listed on the network.
const VALIDATORS = ["validator_setup"];

export const BOARD_WORK_POLICY = Object.freeze({
  board_community_promotion: { open: true, workTypes: [...POSTS, ...QA] },
  board_postfiat_l1v2: { open: true, workTypes: [...CODE_CHANGE, ...REVIEWS, ...VALIDATORS] },
  board_tasknode_fixes: { open: true, workTypes: [...CODE_CHANGE, ...QA] },
  board_capital_markets: { open: true, workTypes: ["domain_analysis", ...POSTS] },
  board_pf_terminal: { open: true, workTypes: [...CODE_CHANGE, ...QA] },
  board_ai_l1_governance: { open: false, workTypes: [] },
});

// Posts, reviews and research are paid on public proof. Everything else,
// including every task issued before this policy, keeps the merged pull
// request rule it was offered under.
export const PUBLIC_PROOF_WORK_TYPES = Object.freeze(new Set([...POSTS, ...REVIEWS, ...VALIDATORS, "domain_analysis"]));

export const PUBLIC_PROOF_REQUIREMENT_TEXT =
  "Payment requirement: this task pays only for public proof you produced after this task was created. Submit the link to the published post, review, bug report, event page, research note or validator listing, from the account linked to your Task Node profile. A draft, a private document, a screenshot without a public link, or work that already paid another task is not evidence and will not be paid.";

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
// On the code boards (Task Node, Corbanu Terminal) testing pays only when it
// ends in a merged fix (operator decision 2026-11-25); elsewhere a reproduced
// public issue is the proof.
const QA_ENDS_IN_PR_BOARDS = new Set(["board_tasknode_fixes", "board_pf_terminal"]);
function qaOnOpenBoard({ boardId = "", workType = "" } = {}) {
  const policy = boardWorkPolicy(boardId);
  if (QA_ENDS_IN_PR_BOARDS.has(String(boardId || "").trim())) return false;
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
