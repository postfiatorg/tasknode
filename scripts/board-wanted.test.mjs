import assert from "node:assert/strict";
import test from "node:test";
import { wantedState, wantedTaskNeed, WANTED_REFUSALS_BEFORE_REWRITE } from "../server/board-wanted.js";

const item = { id: "wanted_x", status: "open", created_at: "2026-11-25T00:00:00Z", revised_at: "2026-11-25T00:00:00Z" };
const attempt = (status, createdAt = "2026-11-25T01:00:00Z", allocation = "") => ({ task_status: status, allocation_status: allocation || status, created_at: createdAt, task_id: `t_${status}_${createdAt}` });

test("a Wanted item's state comes from its tasks", () => {
  assert.equal(wantedState(item, []).state, "open");
  assert.equal(wantedState(item, [attempt("", undefined, "queued")]).state, "in_progress", "a task being generated holds the item");
  assert.equal(wantedState(item, [attempt("accepted")]).state, "in_progress");
  assert.equal(wantedState(item, [attempt("refused")]).state, "open", "one refusal reopens the item");
  assert.equal(wantedState(item, [attempt("refused"), attempt("cancelled", "2026-11-25T02:00:00Z")]).state, "rewrite");
  assert.equal(WANTED_REFUSALS_BEFORE_REWRITE, 2);
  assert.equal(wantedState(item, [attempt("refused"), attempt("rewarded", "2026-11-25T02:00:00Z")]).state, "done");
  assert.equal(wantedState({ ...item, status: "dropped" }, [attempt("accepted")]).state, "dropped");
});

test("a rewrite resets the refusal count", () => {
  const revised = { ...item, revised_at: "2026-11-25T03:00:00Z" };
  assert.equal(wantedState(revised, [attempt("refused"), attempt("refused", "2026-11-25T02:00:00Z")]).state, "open");
  assert.equal(wantedState(revised, [attempt("refused", "2026-11-25T04:00:00Z"), attempt("refused", "2026-11-25T05:00:00Z")]).state, "rewrite");
});

test("the task text carries why it exists and its source", () => {
  const need = wantedTaskNeed({ title: "Fix the RPC flood", why: "Validators fall over.", sourceUrl: "https://github.com/x/y/issues/1" }, "Add a regression test.");
  assert.ok(need.startsWith("Fix the RPC flood."));
  assert.ok(need.includes("Why this matters: Validators fall over."));
  assert.ok(need.includes("Source: https://github.com/x/y/issues/1"));
  assert.ok(need.includes("Details: Add a regression test."));
});
