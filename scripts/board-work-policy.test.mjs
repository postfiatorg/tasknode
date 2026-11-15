import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_PROOF_REQUIREMENT_TEXT,
  assertBoardAcceptsWork,
  boardOpenForNewWork,
  boardWorkViolation,
  mergedPrRequiredForWork,
  reviewDocumentAllowed,
} from "../server/board-work-policy.js";
import { networkTaskContentViolation } from "../server/network-task-content-policy.js";

test("only the boards the operator named take new work", () => {
  for (const board of ["board_community_promotion", "board_postfiat_l1v2", "board_tasknode_fixes", "board_capital_markets"]) {
    assert.equal(boardOpenForNewWork(board), true, board);
  }
  assert.equal(boardOpenForNewWork("board_pf_terminal"), false);
  assert.equal(boardOpenForNewWork("board_ai_l1_governance"), false);
  assert.throws(() => assertBoardAcceptsWork({ boardId: "board_pf_terminal", workType: "code_task" }), { code: "board_work_policy_rejected" });
  // Operator referrals (merge and badge decisions) still reach the operator on any board.
  assert.equal(boardWorkViolation({ boardId: "board_pf_terminal", workType: "project_management", operatorDuty: true }), null);
  // Boards outside the table keep their own rules.
  assert.equal(boardWorkViolation({ boardId: "board_value_accountability", workType: "anything" }), null);
});

test("each board takes only its own kinds of work", () => {
  assert.equal(boardWorkViolation({ boardId: "board_community_promotion", workType: "amplification_x" }), null);
  assert.equal(boardWorkViolation({ boardId: "board_community_promotion", workType: "public_announcement" }), null);
  assert.equal(boardWorkViolation({ boardId: "board_community_promotion", workType: "code_task" }).code, "work_type_not_in_board_scope");
  assert.equal(boardWorkViolation({ boardId: "board_postfiat_l1v2", workType: "code_review" }), null);
  assert.equal(boardWorkViolation({ boardId: "board_postfiat_l1v2", workType: "expert_review" }), null);
  assert.equal(boardWorkViolation({ boardId: "board_postfiat_l1v2", workType: "qa_report" }).code, "work_type_not_in_board_scope");
  assert.equal(boardWorkViolation({ boardId: "board_tasknode_fixes", workType: "code_review" }).code, "work_type_not_in_board_scope");
  assert.equal(boardWorkViolation({ boardId: "board_capital_markets", workType: "domain_analysis" }), null);
  // The task that prompted this change: a project-management memo on Capital Markets.
  assert.equal(boardWorkViolation({ boardId: "board_capital_markets", workType: "project_management" }).code, "work_type_not_in_board_scope");
  assert.equal(boardWorkViolation({ boardId: "board_capital_markets", workType: "" }).code, "work_type_not_in_board_scope");
});

test("posts, reviews and research are paid on public proof; everything else needs a merged pull request", () => {
  // Code changes, plus every kind of task issued under the old rule (QA reports,
  // repro packets, project management, tasks with no recorded work type).
  for (const type of ["code_task", "core_repo_work", "private_repo_code", "capability_gating_task", "qa_report", "repro_packet", "project_management", ""]) {
    assert.equal(mergedPrRequiredForWork({ workType: type }), true, type || "(legacy, no work type)");
  }
  for (const type of ["amplification", "amplification_x", "public_announcement", "article_distribution", "medium_article", "domain_analysis", "code_review", "expert_review"]) {
    assert.equal(mergedPrRequiredForWork({ workType: type }), false, type);
  }
  assert.ok(PUBLIC_PROOF_REQUIREMENT_TEXT.includes("public proof"));
});

test("written review findings are paid only as an L1 code review", () => {
  const need = "Review the Orchard note-commitment code in postfiatl1v2 and publish a findings report with file and line references.";
  assert.equal(networkTaskContentViolation(need).code, "audit_document_deliverable");
  assert.equal(reviewDocumentAllowed({ boardId: "board_postfiat_l1v2", workType: "code_review" }), true);
  assert.equal(reviewDocumentAllowed({ boardId: "board_tasknode_fixes", workType: "code_review" }), false);
  assert.equal(reviewDocumentAllowed({ boardId: "board_postfiat_l1v2", workType: "code_task" }), false);
  assert.equal(networkTaskContentViolation(need, { allowReviewDocument: true }), null);
  // Critiques of published writing stay banned everywhere, review allowance or not.
  const critique = "Fact-check the latest goodalexander blog post claim by claim.";
  assert.equal(networkTaskContentViolation(critique, { allowReviewDocument: true }).code, "critique_of_published_writing");
  // Amplifying a post is not a critique of it.
  assert.equal(networkTaskContentViolation("Quote-post the latest goodalexander blog post on X with your own one-line takeaway."), null);
});
