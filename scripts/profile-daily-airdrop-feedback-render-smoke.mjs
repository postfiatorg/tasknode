#!/usr/bin/env node
// Issue #356: the profile's daily airdrop panel must show the member-safe
// reason the server recorded when feedback could not be written, and keep the
// generic "temporarily unavailable" text only when no reason exists.
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { dailyAirdropFeedbackNotice } from "../server/profile-daily-airdrop-feedback-notice.js";

const FILLER = {
  whatRaisedToday: "This airdrop uses the rewarded tasks in the lookback window.",
  whatKeptItLower: "Detailed feedback is temporarily unavailable.",
  toImproveTomorrow: "No corrective action is being requested while feedback is unavailable.",
  reasoningText: "The airdrop amount and payout status are shown above. Detailed task feedback is temporarily unavailable.",
};
const base = { dailyAirdropPft: 45, retentionValueScore: 80, runDate: "2026-11-26", completedAt: "2026-11-26T06:00:00Z", issuance: { status: "submitted", amountPft: 45, txHash: "ABCDEF0123456789", submittedAt: "2026-11-26T06:05:00Z" } };

const server = await createServer({ appType: "custom", logLevel: "error", optimizeDeps: { entries: [], noDiscovery: true }, server: { middlewareMode: true } });
try {
  const { TodaysBriefing, airdropFeedbackView } = await server.ssrLoadModule("/src/features/profile/ProfileBriefing.jsx");
  const render = (airdrop) => renderToStaticMarkup(React.createElement(TodaysBriefing, { airdrop }));

  // 1. Reason supplied: a run whose reviewer was cut off (the #356 failure).
  const feedbackReview = { status: "unavailable", error: { code: "inference_response_truncated" } };
  const supplied = { ...base, ...FILLER, feedbackStatus: "unavailable", feedbackNotice: dailyAirdropFeedbackNotice(feedbackReview) };
  const suppliedHtml = render(supplied);
  assert.match(suppliedHtml, /ran out of room before it finished/, "The recorded reason is shown");
  assert.doesNotMatch(suppliedHtml, /temporarily unavailable/, "The supplied reason replaces the generic message");
  assert.doesNotMatch(suppliedHtml, /Full reasoning/, "No reasoning toggle for filler text");
  assert.doesNotMatch(suppliedHtml, /What contributed|What held it back|Next step/, "No filler columns");
  assert.match(suppliedHtml, /Your airdrop amount and payout are unaffected/);
  assert.match(suppliedHtml, /45/, "Payout amount still renders");

  // 2. Genuinely unavailable: an older run with filler and no recorded reason.
  const legacyHtml = render({ ...base, ...FILLER });
  assert.match(legacyHtml, /Detailed feedback is temporarily unavailable\./, "Honest fallback when no reason exists");
  assert.doesNotMatch(legacyHtml, /Full reasoning/);
  assert.doesNotMatch(legacyHtml, /What contributed/);
  const noCodeHtml = render({ ...base, ...FILLER, feedbackStatus: "unavailable", feedbackNotice: dailyAirdropFeedbackNotice({ status: "unavailable" }) });
  assert.match(noCodeHtml, /Detailed feedback is temporarily unavailable\./);

  // 3. Completed review: real feedback and the reasoning toggle, no notice.
  const completed = { ...base, feedbackStatus: "completed", feedbackNotice: "", whatRaisedToday: "Accepted the local restore task.",
    whatKeptItLower: "No specific gap is supported.", toImproveTomorrow: "No corrective action is needed.", reasoningText: "The review accepted the restore." };
  const completedHtml = render(completed);
  assert.match(completedHtml, /Accepted the local restore task\./);
  assert.match(completedHtml, /Full reasoning/);
  assert.doesNotMatch(completedHtml, /temporarily unavailable|payout are unaffected/);
  assert.equal(airdropFeedbackView(completed).reasoning, "The review accepted the restore.");
  assert.equal(airdropFeedbackView(completed).notice, "");
} finally {
  await server.close();
}
console.log("daily airdrop feedback render smoke ok: supplied reason replaces the generic message; generic fallback only without a reason; completed feedback unchanged");
