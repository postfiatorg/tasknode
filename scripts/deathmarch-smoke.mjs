import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

import {
  callDeepSeekSummary,
  classifyEventAnonymity,
  databaseRowsToDeathmarchEvents,
  deathmarchEnvWithSeedFile,
  decryptTasknodeUserMnemonicPayload,
  formatDeathmarchDiscordMessage,
  observeDeathmarchDatabasePool,
  postToDiscord,
  processDeathmarchEvents,
  sanitizeEventForAnonymity,
  tasknodePublicKeyFromUserMnemonic,
} from "./deathmarch.mjs";
import { encryptTasknodePayload } from "../server/task-payloads.js";

function deepseekResponse(content) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content } }],
    }),
  };
}

function deepseekClassifierResponse({
  level,
  category,
  sensitive_entities = [],
  sensitive_strategy_details = [],
}) {
  return deepseekResponse(JSON.stringify({
    level,
    category,
    sensitive_entities,
    sensitive_strategy_details,
  }));
}

const databasePoolErrors = [];
const observedDatabasePool = observeDeathmarchDatabasePool(new EventEmitter(), {
  logger: { error: (message) => databasePoolErrors.push(message) },
});
assert.doesNotThrow(() => {
  observedDatabasePool.emit("error", new Error("Connection terminated unexpectedly"));
});
assert.deepEqual(databasePoolErrors, [
  "deathmarch_database_pool_error:Connection_terminated_unexpectedly",
]);

const sensitiveEvent = {
  schema: "pf.task.request.v1",
  actionKind: "task_request",
  taskId: "task_sensitive",
  txHash: "ABCDEF1234567890",
  cid: "QmSensitive",
  memoIndex: 0,
  occurredAt: "2026-06-01T00:00:00.000Z",
  eventKey: "ABCDEF1234567890:0:QmSensitive:pf.task.request.v1",
  payload: {
    schema: "pf.task.request.v1",
    task_id: "task_sensitive",
    title: "Model autocorrelation on tech sector names for client ACME Capital",
    description: "Buy NVDA when the five-day residual autocorrelation exceeds 0.4, then hedge with AMD at the specified weight.",
  },
};

const protectedStrategySentence = sensitiveEvent.payload.description;
const levelOne = sanitizeEventForAnonymity(sensitiveEvent, 1, {
  category: "market or trading-related task",
  sensitive_entities: [{ kind: "client", name: "ACME Capital" }],
  sensitive_strategy_details: [protectedStrategySentence],
});
const levelOneText = JSON.stringify(levelOne);
assert.equal(levelOne.category, "market or trading-related task");
assert.equal(levelOneText.includes("Model autocorrelation on tech sector names"), true);
assert.equal(levelOneText.includes("ACME"), false);
assert.equal(levelOneText.includes("NVDA"), false);
assert.equal(levelOneText.includes("[redacted client]"), true);
assert.equal(levelOneText.includes("[redacted strategy detail]"), true);

const levelTwo = sanitizeEventForAnonymity(sensitiveEvent, 2, {
  level: 2,
  category: "client strategy work",
  sensitive_entities: [{ kind: "client", name: "ACME Capital" }],
});
const levelTwoText = JSON.stringify(levelTwo);
assert.equal(levelTwo.public_instruction.includes("already been replaced"), true);
assert.equal(levelTwoText.includes("ACME Capital"), false);
assert.equal(levelTwoText.includes("[redacted client]"), true);
assert.equal(levelTwoText.includes("NVDA"), true);

const clientWorkEvent = {
  schema: "pf.task.offer.v1",
  actionKind: "task_offer",
  taskId: "task_client_work",
  txHash: "CLIENTWORK1234567890",
  cid: "QmClientWork",
  memoIndex: 0,
  occurredAt: "2026-06-01T00:00:00.000Z",
  eventKey: "CLIENTWORK1234567890:0:QmClientWork:pf.task.offer.v1",
  payload: {
    schema: "pf.task.offer.v1",
    task_id: "task_client_work",
    title: "Prepare ACME Capital onboarding notes",
    description: "Summarize the client onboarding plan and legal review status.",
  },
};
const clientPacket = sanitizeEventForAnonymity(clientWorkEvent, 2, {
  level: 2,
  category: "client work",
  sensitive_entities: [{ kind: "client", name: "ACME Capital" }],
});
assert.equal(JSON.stringify(clientPacket).includes("ACME Capital"), false);
assert.equal(JSON.stringify(clientPacket).includes("[redacted client] onboarding notes"), true);
assert.equal(JSON.stringify(clientPacket).includes("legal review status"), true);

const genericStrategyEvent = {
  ...clientWorkEvent,
  taskId: "task_generic_strategy",
  txHash: "GENERICSTRATEGY123",
  eventKey: "GENERICSTRATEGY123:0:QmGenericStrategy:pf.task.offer.v1",
  payload: {
    schema: "pf.task.offer.v1",
    task_id: "task_generic_strategy",
    title: "Explore semiconductor momentum research",
    description: "Survey public approaches for a possible NVDA and AMD strategy without specifying proprietary mechanics.",
  },
};
const genericStrategyPacket = sanitizeEventForAnonymity(genericStrategyEvent, 3, {
  level: 3,
  category: "market research",
  sensitive_entities: [],
});
assert.equal(JSON.stringify(genericStrategyPacket).includes("semiconductor momentum research"), true);
assert.equal(JSON.stringify(genericStrategyPacket).includes("NVDA and AMD"), true);

const investorEvent = {
  ...clientWorkEvent,
  taskId: "task_investor_update",
  txHash: "INVESTORUPDATE123",
  eventKey: "INVESTORUPDATE123:0:QmInvestorUpdate:pf.task.offer.v1",
  payload: {
    schema: "pf.task.offer.v1",
    task_id: "task_investor_update",
    title: "Prepare Northstar Ventures update",
    description: "Summarize product traction for investor Northstar Ventures and keep the operating metrics visible.",
  },
};
const investorPacket = sanitizeEventForAnonymity(investorEvent, 2, {
  level: 2,
  category: "investor update",
  sensitive_entities: [{ kind: "investor", name: "Northstar Ventures" }],
});
const investorPacketText = JSON.stringify(investorPacket);
assert.equal(investorPacketText.includes("Northstar Ventures"), false);
assert.equal(investorPacketText.includes("[redacted investor]"), true);
assert.equal(investorPacketText.includes("operating metrics visible"), true);

const requestEvent = {
  schema: "pf.task.request.v1",
  actionKind: "task_request",
  taskId: "",
  txHash: "74E110C201208A97A88FEDFF1F4DF8DD1C315C6A99E07B0ABFB0F92BE93D61DF",
  cid: "QmRequest",
  memoIndex: 0,
  occurredAt: "2026-06-01T19:10:00.000Z",
  eventKey: "74E110:0:QmRequest:pf.task.request.v1",
  payload: {
    schema: "pf.task.request.v1",
    request_text: "Request a task using my current context document, account memory, recent messages, and the additional task details I just provided.",
    user_detail_text: "Please make it about Discord task notifications.",
    requested_task_kind: "personal",
    request_bundle: { summary: "Recent conversation asked for deathmarch Discord updates." },
  },
};
const requestPacket = sanitizeEventForAnonymity(requestEvent, 3);
assert.equal(requestPacket.event.request_text.includes("current context document"), true);
assert.equal(requestPacket.event.user_detail_text, "Please make it about Discord task notifications.");
assert.equal(requestPacket.event.request_bundle_summary.includes("deathmarch Discord updates"), true);

const formattedOffer = formatDeathmarchDiscordMessage({
  event: sanitizeEventForAnonymity({
    schema: "pf.task.offer.v1",
    actionKind: "task_offer",
    taskId: "task_cdd241775a0a65ddae909bae3b771d29",
    txHash: "7005B006FDFF2C30F8914BC050A4B3B6C6FC72305F65A1ACD8CE8CB77BBF7C0C",
    cid: "QmDeathmarchOffer",
    eventKey: "7005:0:QmDeathmarchOffer:pf.task.offer.v1",
    payload: {
      schema: "pf.task.offer.v1",
      task_id: "task_cdd241775a0a65ddae909bae3b771d29",
      title: "Launch Death March Discord Protocol",
    },
  }, 3),
  summary:
    "A task was proposed to enable Death March Discord updates with the Green/Yellow/Red visibility model. tx: 7005B006FDFF2C30F8914BC050A4B3B6C6FC72305F65A1ACD8CE8CB77BBF7C0C",
});
assert.equal(formattedOffer.includes("**Task proposed**"), true);
assert.equal(formattedOffer.includes("**Launch Death March Discord Protocol**"), true);
assert.equal(formattedOffer.includes("Green/Yellow/Red"), false);
assert.equal(formattedOffer.includes("visibility model"), false);
assert.equal((formattedOffer.match(/tx:/g) || []).length, 1);
assert.equal(formattedOffer.endsWith("tx: 7005B006FDFF2C30F8914BC050A4B3B6C6FC72305F65A1ACD8CE8CB77BBF7C0C"), true);

const submissionEvent = {
  schema: "pf.task.submission.v1",
  actionKind: "initial_verification",
  taskId: "task_cdd241775a0a65ddae909bae3b771d29",
  txHash: "4A22F4CA999E9582504EDB9E7134268784CDC0F9F051822D1E0CAAEB6D86EBCC",
  cid: "QmDeathmarchSubmission",
  eventKey: "4A22:0:QmDeathmarchSubmission:pf.task.submission.v1",
  payload: {
    schema: "pf.task.submission.v1",
    task_id: "task_cdd241775a0a65ddae909bae3b771d29",
    phase: "initial_submission",
    evidence_items: [{
      index: 1,
      artifact_type: "text",
      value: "Published the Death March Discord protocol and posted the first compliant update.",
      notes: "Includes public-envelope/private-payload guidance.",
    }],
  },
};
const submissionPacket = sanitizeEventForAnonymity(submissionEvent, 3);
assert.equal(
  submissionPacket.event.submission_detail.includes("Published the Death March Discord protocol"),
  true
);
const formattedSubmission = formatDeathmarchDiscordMessage({
  event: submissionPacket,
  summary: "A new task was submitted and is now in initial verification.",
});
assert.equal(formattedSubmission.includes("**Evidence submitted**"), true);
assert.equal(formattedSubmission.includes("Submitted evidence: text: Published the Death March Discord protocol"), true);
assert.equal(formattedSubmission.includes("A new task was submitted and is now in initial verification."), false);
assert.equal((formattedSubmission.match(/tx:/g) || []).length, 1);
assert.equal(formattedSubmission.endsWith("tx: 4A22F4CA999E9582504EDB9E7134268784CDC0F9F051822D1E0CAAEB6D86EBCC"), true);

const rewardPaymentEvent = {
  schema: "pf.reward.v1",
  actionKind: "reward_outcome",
  taskId: "task_cdd241775a0a65ddae909bae3b771d29",
  txHash: "B3D7B19EA7E5D9CB7A5BE9E70696D3E6",
  cid: "QmDeathmarchReward",
  eventKey: "B3D7:0:QmDeathmarchReward:pf.reward.v1",
  payload: {
    schema: "pf.reward.v1",
    task_id: "task_cdd241775a0a65ddae909bae3b771d29",
    reward_pft: "12000.00",
    reward_tier: "task_engine_live",
    reward_summary: "Evidence was accepted but before/after artifacts were incomplete.",
  },
};
const rewardPacket = sanitizeEventForAnonymity(rewardPaymentEvent, 3);
assert.equal(rewardPacket.event.reward_detail.includes("Recorded terminal reward outcome: 12,000 PFT."), true);
const formattedReward = formatDeathmarchDiscordMessage({
  event: rewardPacket,
  summary: "A reward was paid for the task.",
});
assert.equal(formattedReward.includes("**Reward outcome**"), true);
assert.equal(formattedReward.includes("Recorded terminal reward outcome: 12,000 PFT."), true);
assert.equal(formattedReward.includes("Evidence was accepted but before/after artifacts were incomplete."), true);
assert.equal(formattedReward.includes("A reward was paid for the task."), false);
assert.equal((formattedReward.match(/tx:/g) || []).length, 1);
assert.equal(formattedReward.endsWith("tx: B3D7B19EA7E5D9CB7A5BE9E70696D3E6"), true);

const zeroRewardPacket = sanitizeEventForAnonymity({
  schema: "pf.reward.v1",
  actionKind: "reward_outcome",
  taskId: "task_zero_reward",
  txHash: "ZERO000000000000000000000000000000000000000000000000000000000000",
  cid: "QmDeathmarchZeroReward",
  eventKey: "ZERO:0:QmDeathmarchZeroReward:pf.reward.v1",
  payload: {
    schema: "pf.reward.v1",
    task_id: "task_zero_reward",
    reward_pft: "0.00",
    economic_reward_pft: "0.00",
    carrier_amount_drops: "1",
    reward_summary: "Evidence did not meet the task acceptance standard.",
  },
}, 3);
const formattedZeroReward = formatDeathmarchDiscordMessage({
  event: zeroRewardPacket,
  summary: "Reward decision: rejected.",
});
assert.equal(formattedZeroReward.includes("**Reward outcome**"), true);
assert.equal(formattedZeroReward.includes("0 PFT"), true);
assert.equal(formattedZeroReward.includes("one-drop carrier"), true);
assert.equal(formattedZeroReward.includes("Reward decision"), false);
assert.equal((formattedZeroReward.match(/tx:/g) || []).length, 1);

await assert.rejects(
  () => callDeepSeekSummary({
    event: sensitiveEvent,
    anonymity: 3,
    classification: { level: 3, category: "public protocol work" },
    env: {
      AMBIENT_API_KEY: "test",
      AMBIENT_BASE_URL: "https://ambient.invalid",
    },
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: { message: "provider unavailable" } }),
    }),
  }),
  /ambient_http_503:provider unavailable/
);

let deepseekRequestBody = null;
const deterministicFallback = await callDeepSeekSummary({
  event: rewardPaymentEvent,
  anonymity: 3,
  classification: { level: 3, category: "public protocol work" },
  env: {
    AMBIENT_API_KEY: "test",
    AMBIENT_BASE_URL: "https://ambient.invalid",
  },
  fetchImpl: async (url, options) => {
    deepseekRequestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          finish_reason: "length",
          message: { reasoning_content: "reasoning only" },
        }],
      }),
    };
  },
});
assert.equal(Object.prototype.hasOwnProperty.call(deepseekRequestBody, "max_tokens"), false);
assert.equal(deterministicFallback.includes("**Reward outcome**"), true);
assert.equal(deterministicFallback.includes("Recorded terminal reward outcome: 12,000 PFT."), true);
assert.equal(deterministicFallback.endsWith("tx: B3D7B19EA7E5D9CB7A5BE9E70696D3E6"), true);

const posted = [];
const deepseekBodies = [];
const result = await processDeathmarchEvents({
  events: [sensitiveEvent],
  anonymity: 3,
  dryRun: false,
  noState: true,
  env: {
    AMBIENT_API_KEY: "test",
    AMBIENT_BASE_URL: "https://ambient.invalid",
    DEATHMARCH_DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
  },
  fetchImpl: async (url, options) => {
    if (String(url).includes("ambient")) {
      const body = JSON.parse(options.body);
      deepseekBodies.push(body);
      return deepseekBodies.length === 1
        ? deepseekClassifierResponse({
          level: 1,
          category: "market or trading-related task",
          sensitive_entities: [{ kind: "client", name: "ACME Capital" }],
          sensitive_strategy_details: [protectedStrategySentence],
        })
        : deepseekResponse("User requested a market or trading-related task. tx: ABCDEF1234567890");
    }
    posted.push(JSON.parse(options.body));
    return { ok: true, status: 204, text: async () => "" };
  },
});

assert.equal(result.posted, 1);
assert.equal(deepseekBodies.length, 2);
const classifierInstructions = deepseekBodies[0].messages[0].content;
assert.equal(classifierInstructions.includes("Do not use level 1 for a general topic"), true);
assert.equal(classifierInstructions.includes("exact client names, exact investor names"), true);
const l1SummarizerBody = JSON.stringify(deepseekBodies[1]);
assert.equal(l1SummarizerBody.includes("Model autocorrelation on tech sector names"), true);
assert.equal(l1SummarizerBody.includes("ACME"), false);
assert.equal(l1SummarizerBody.includes("NVDA"), false);
assert.equal(l1SummarizerBody.includes("[redacted strategy detail]"), true);
assert.equal(l1SummarizerBody.includes("market or trading-related task"), true);
assert.equal(posted.length, 1);
assert.equal(posted[0].content.includes("**Task requested**"), true);
assert.equal(posted[0].content.includes("User requested a market or trading-related task."), true);
assert.equal(posted[0].content.includes("Model autocorrelation on tech sector names"), true);
assert.equal(posted[0].content.includes("ACME"), false);
assert.equal(posted[0].content.includes("NVDA"), false);
assert.equal((posted[0].content.match(/tx:/g) || []).length, 1);
assert.equal(posted[0].content.endsWith("tx: ABCDEF1234567890"), true);
assert.deepEqual(posted[0].allowed_mentions, { parse: [] });

const publicProtocolEvent = {
  schema: "pf.task.offer.v1",
  actionKind: "task_offer",
  taskId: "task_public_protocol",
  txHash: "PUBLIC1234567890",
  cid: "QmPublicProtocol",
  memoIndex: 0,
  occurredAt: "2026-06-01T00:00:00.000Z",
  eventKey: "PUBLIC1234567890:0:QmPublicProtocol:pf.task.offer.v1",
  payload: {
    schema: "pf.task.offer.v1",
    task_id: "task_public_protocol",
    title: "Publish Death March Protocol Notes",
    description: "Write public Task Node protocol notes for Discord operators.",
  },
};
const publicPosts = [];
const publicDeepseekBodies = [];
const publicResult = await processDeathmarchEvents({
  events: [publicProtocolEvent],
  anonymity: 3,
  dryRun: false,
  noState: true,
  env: {
    AMBIENT_API_KEY: "test",
    AMBIENT_BASE_URL: "https://ambient.invalid",
    DEATHMARCH_DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
  },
  fetchImpl: async (url, options) => {
    if (String(url).includes("ambient")) {
      const body = JSON.parse(options.body);
      publicDeepseekBodies.push(body);
      return publicDeepseekBodies.length === 1
        ? deepseekClassifierResponse({ level: 3, category: "public protocol work" })
        : deepseekResponse("A public protocol task was proposed.");
    }
    publicPosts.push(JSON.parse(options.body));
    return { ok: true, status: 204, text: async () => "" };
  },
});
assert.equal(publicResult.posted, 1);
assert.equal(publicDeepseekBodies.length, 2);
assert.equal(JSON.stringify(publicDeepseekBodies[1]).includes("Publish Death March Protocol Notes"), true);
assert.equal(publicPosts[0].content.includes("**Publish Death March Protocol Notes**"), true);
assert.equal(publicPosts[0].content.includes("A public protocol task was proposed."), true);

const failedClassifierPosts = [];
const failedClassifierBodies = [];
const failedClassifierResult = await processDeathmarchEvents({
  events: [sensitiveEvent],
  anonymity: 3,
  dryRun: false,
  noState: true,
  env: {
    AMBIENT_API_KEY: "test",
    AMBIENT_BASE_URL: "https://ambient.invalid",
    DEATHMARCH_DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
  },
  fetchImpl: async (url, options) => {
    if (String(url).includes("ambient")) {
      const body = JSON.parse(options.body);
      failedClassifierBodies.push(body);
      return failedClassifierBodies.length === 1
        ? deepseekResponse("not json")
        : deepseekResponse("User requested a confidential task. tx: ABCDEF1234567890");
    }
    failedClassifierPosts.push(JSON.parse(options.body));
    return { ok: true, status: 204, text: async () => "" };
  },
});
assert.equal(failedClassifierResult.posted, 1);
assert.equal(failedClassifierBodies.length, 2);
const failedClassifierSummaryBody = JSON.stringify(failedClassifierBodies[1]);
assert.equal(failedClassifierSummaryBody.includes("autocorrelation"), true);
assert.equal(failedClassifierSummaryBody.includes("ACME"), true);
assert.equal(failedClassifierSummaryBody.includes("classification unavailable"), true);
assert.equal(failedClassifierPosts[0].content.includes("autocorrelation"), true);
assert.equal(failedClassifierPosts[0].content.includes("confidential task"), true);

const classifiedDirect = await classifyEventAnonymity({
  event: publicProtocolEvent,
  env: {
    AMBIENT_API_KEY: "test",
    AMBIENT_BASE_URL: "https://ambient.invalid",
  },
  fetchImpl: async () => deepseekClassifierResponse({ level: 3, category: "public protocol work" }),
});
assert.deepEqual(classifiedDirect, {
  level: 3,
  category: "public protocol work",
  sensitive_entities: [],
  sensitive_strategy_details: [],
});

const classifiedNamedEntities = await classifyEventAnonymity({
  event: investorEvent,
  env: {
    AMBIENT_API_KEY: "test",
    AMBIENT_BASE_URL: "https://ambient.invalid",
  },
  fetchImpl: async () => deepseekClassifierResponse({
    level: 2,
    category: "investor update",
    sensitive_entities: [
      { kind: "investor", name: "Northstar Ventures" },
      { kind: "vendor", name: "Ignored Vendor" },
      { kind: "investor", name: "northstar ventures" },
    ],
    sensitive_strategy_details: [],
  }),
});
assert.deepEqual(classifiedNamedEntities, {
  level: 2,
  category: "investor update",
  sensitive_entities: [{ kind: "investor", name: "Northstar Ventures" }],
  sensitive_strategy_details: [],
});

let deepseekCalls = 0;
const continuedPosts = [];
const continuedAfterEventFailure = await processDeathmarchEvents({
  events: [sensitiveEvent, rewardPaymentEvent],
  anonymity: 3,
  dryRun: false,
  noState: true,
  env: {
    AMBIENT_API_KEY: "test",
    AMBIENT_BASE_URL: "https://ambient.invalid",
    DEATHMARCH_DISCORD_WEBHOOK_URL: "https://discord.invalid/webhook",
  },
  fetchImpl: async (url, options) => {
    if (String(url).includes("ambient")) {
      deepseekCalls += 1;
      if (deepseekCalls === 1) return deepseekClassifierResponse({ level: 1, category: "confidential task" });
      if (deepseekCalls === 2) throw new Error("deepseek_api_timeout");
      if (deepseekCalls === 3) return deepseekClassifierResponse({ level: 3, category: "public reward outcome" });
      return deepseekResponse("Reward was recorded. tx: B3D7B19EA7E5D9CB7A5BE9E70696D3E6");
    }
    continuedPosts.push(JSON.parse(options.body));
    return { ok: true, status: 204, text: async () => "" };
  },
});
assert.equal(continuedAfterEventFailure.ok, false);
assert.equal(continuedAfterEventFailure.failed, 1);
assert.equal(continuedAfterEventFailure.posted, 1);
assert.equal(continuedPosts.length, 1);
assert.equal(continuedPosts[0].content.includes("**Reward outcome**"), true);

const marked = await processDeathmarchEvents({
  events: [sensitiveEvent],
  markExisting: true,
  noState: true,
  env: {},
  fetchImpl: async () => {
    throw new Error("mark_existing_should_not_call_network");
  },
});
assert.equal(marked.marked, 1);
assert.equal(marked.posted, 0);

const ignoredAirdrop = await processDeathmarchEvents({
  events: [{
    schema: "pf.daily_airdrop.v1",
    actionKind: "daily_airdrop",
    txHash: "AIRDROP123",
    eventKey: "AIRDROP123:0:QmAirdrop:pf.daily_airdrop.v1",
    payload: { schema: "pf.daily_airdrop.v1" },
    pointerKind: "REWARD",
  }],
  markExisting: true,
  noState: true,
});
assert.equal(ignoredAirdrop.checked, 1);
assert.equal(ignoredAirdrop.marked, 0);

const ignoredLegacyRewardDecision = await processDeathmarchEvents({
  events: [{
    schema: "pf.task.reward_decision.v1",
    actionKind: "reward_decision",
    taskId: "task_legacy_reward_decision",
    txHash: "LEGACYREWARDDECISION123",
    eventKey: "LEGACYREWARDDECISION123:0:QmLegacy:pf.task.reward_decision.v1",
    payload: { schema: "pf.task.reward_decision.v1", reward_pft: "12.00" },
    pointerKind: "TASK_UPDATE",
  }],
  markExisting: true,
  noState: true,
});
assert.equal(ignoredLegacyRewardDecision.checked, 1);
assert.equal(ignoredLegacyRewardDecision.marked, 0);

const ignoredUnreadableRewardPointer = await processDeathmarchEvents({
  events: [{
    schema: "",
    actionKind: "task_pointer",
    taskId: "task_unreadable_reward_pointer",
    txHash: "UNREADABLEREWARD123",
    eventKey: "UNREADABLEREWARD123:0:QmUnreadable:no_schema",
    payload: { payload_error: "task_payload_decrypt_failed" },
    pointerKind: "REWARD",
  }],
  markExisting: true,
  noState: true,
});
assert.equal(ignoredUnreadableRewardPointer.checked, 1);
assert.equal(ignoredUnreadableRewardPointer.marked, 0);

const databaseEvents = databaseRowsToDeathmarchEvents([{
  event_type: "pf.task.offer.v1",
  task_id: "task_offchain_offer",
  source_tx_hash: "offchain:evt_offchain_offer",
  source_cid: "postgres:evt_offchain_offer",
  occurred_at: "2026-06-30T22:06:57.757Z",
  wallet_address: "rPo8GkCA9YMKzuJGTHbj11kdVfPqSJHxNx",
  payload_json: {
    schema: "pf.task.offer.v1",
    task_id: "task_offchain_offer",
    title: "Draft direct-write Deathmarch feed support",
  },
  pointer_json: {
    schema: "pf.task.offer.v1",
    source: "direct_write",
    offchain: true,
  },
}]);
assert.equal(databaseEvents.length, 1);
assert.equal(databaseEvents[0].txHash, "OFFCHAIN:EVT_OFFCHAIN_OFFER");
assert.equal(databaseEvents[0].eventKey, "OFFCHAIN:EVT_OFFCHAIN_OFFER:0:postgres:evt_offchain_offer:pf.task.offer.v1");

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "deathmarch-smoke-"));
const seedFile = path.join(tempDir, "deathmarchseed.txt");
await fs.writeFile(seedFile, "sTestDeathmarchSeed\n", "utf8");
const fileSeedEnv = await deathmarchEnvWithSeedFile({
  env: { AMBIENT_API_KEY: "test" },
  seedFile,
  explicitSeedFile: true,
});
assert.equal(fileSeedEnv.TASKNODE_SERVICE_SEED, "sTestDeathmarchSeed");

const existingSeedEnv = await deathmarchEnvWithSeedFile({
  env: { TASKNODE_SERVICE_SEED: "env-wins" },
  seedFile,
  explicitSeedFile: true,
});
assert.equal(existingSeedEnv.TASKNODE_SERVICE_SEED, "env-wins");

const userMnemonic = generateMnemonic(wordlist, 256);
const userSeedFile = path.join(tempDir, "user-deathmarchseed.txt");
await fs.writeFile(userSeedFile, `${userMnemonic}\n`, "utf8");
const userSeedEnv = await deathmarchEnvWithSeedFile({
  env: { TASKNODE_SERVICE_SEED: "service-stays" },
  seedFile: userSeedFile,
  explicitSeedFile: true,
});
assert.equal(userSeedEnv.TASKNODE_SERVICE_SEED, "service-stays");
assert.equal(userSeedEnv.DEATHMARCH_USER_MNEMONIC, userMnemonic);
const userPublicKey = await tasknodePublicKeyFromUserMnemonic(userMnemonic);
const encryptedForUser = await encryptTasknodePayload({
  plaintext: JSON.stringify({ ok: true, schema: "deathmarch.user_decrypt.smoke" }),
  recipientPublicKeys: [userPublicKey],
});
const decryptedForUser = await decryptTasknodeUserMnemonicPayload({
  blob: encryptedForUser,
  mnemonic: userMnemonic,
});
assert.equal(decryptedForUser.schema, "deathmarch.user_decrypt.smoke");

const originalCwd = process.cwd();
const childDir = path.join(tempDir, "child");
await fs.mkdir(childDir);
await fs.writeFile(path.join(tempDir, "deathmarchseed.txt"), "sParentDeathmarchSeed\n", "utf8");
try {
  process.chdir(childDir);
  const parentSeedEnv = await deathmarchEnvWithSeedFile({ env: {} });
  assert.equal(parentSeedEnv.TASKNODE_SERVICE_SEED, "sParentDeathmarchSeed");
} finally {
  process.chdir(originalCwd);
}

await assert.rejects(
  () => deathmarchEnvWithSeedFile({
    env: {},
    seedFile: path.join(tempDir, "missing.txt"),
    explicitSeedFile: true,
  }),
  /deathmarch_seed_file_missing/
);

await assert.rejects(
  () => postToDiscord({
    content: "hello",
    env: {},
    fetchImpl: async () => ({ ok: true, status: 204, text: async () => "" }),
  }),
  /discord_destination_missing/
);

let legacyChannelRequest = null;
const legacyChannelPost = await postToDiscord({
  content: "legacy channel compatibility",
  env: {
    DISCORD_BOT_TOKEN: "test-token",
    DEATHMARCH_CHANNEL_ID: "123456789012345678",
  },
  fetchImpl: async (url, options) => {
    legacyChannelRequest = { url, options };
    return { ok: true, status: 200, text: async () => "{}" };
  },
});
assert.equal(legacyChannelPost.ok, true);
assert.equal(legacyChannelRequest.url.endsWith("/channels/123456789012345678/messages"), true);

console.log("deathmarch smoke ok");
