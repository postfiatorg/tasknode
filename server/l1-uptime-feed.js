// Reader of the signed validator uptime feed (postfiat-validator-uptime-v1).
//
// The contract is postfiatl1v2 docs/specs/validator-uptime-feed-v1.md, and its
// reference in code is scripts/validator_uptime_contract.py there. This file is
// the same contract for Task Node: section 4, "How a consumer reads the feed".
// Nothing in a feed is trusted until the observers' signatures verify against
// the pinned keyset, and every served row is rebuilt from the signed claims.
//
// scripts/l1-uptime-feed.test.mjs reads the fixture that the Python reference
// signs, so the two accept and reject the same feeds.

import { createHash } from "node:crypto";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

export const FEED_SCHEMA = "postfiat-validator-uptime-v1";
export const KEYSET_SCHEMA = "postfiat.observer_keyset.v1";
export const SIGNING_CONTEXT = "postfiat-l1-v2/validator-uptime-feed/v1";
const HORIZON_DAYS = 30;
const MIN_OBSERVED_DAYS = 25;
const THRESHOLD_BPS = 9500;
const GRACE_DAYS = 14;
const QUORUM = 2;
const STALE_SECONDS = 3600;
const FUTURE_SKEW_SECONDS = 60;
const DAY_MS = 86400000;
const context = new TextEncoder().encode(SIGNING_CONTEXT);

const QUORUM_POLICY = Object.freeze({
  observer_count: 3, quorum_threshold: QUORUM, algorithm_id: "ML-DSA-65", signing_context: SIGNING_CONTEXT,
  stale_after_seconds: STALE_SECONDS, max_future_skew_seconds: FUTURE_SKEW_SECONDS,
  indeterminate_behavior: "block_new_bindings_and_credits_preserve_existing_access",
});
const WINDOW_SPEC = Object.freeze({
  metric_version: "accepted-votes-observer-brackets-v1", time_basis: "observer_brackets",
  max_observation_gap_seconds: 900, evaluation_horizon_days: HORIZON_DAYS, min_observed_days: MIN_OBSERVED_DAYS,
  liveness_threshold_bps: THRESHOLD_BPS, grace_period_days: GRACE_DAYS, recovery_consecutive_days: 3,
});
const CREDIT_SOURCES = ["precommit_certificate", "prepare_certificate", "proposer_vote_record"];
const CLAIM_KEYS = ["validator_id", "ml_dsa_public_key", "registry_active", "access_state", "access_state_reason",
  "first_active_date", "ramp_in_active", "observed_days", "mean_daily_participation_bps", "consecutive_passing_days",
  "liveness_met", "grace_started_at", "grace_expires_at", "recovery_floor_date", "removal_proposal_eligible",
  "reward_eligible", "finance_hub_access", "research_api_keys_active", "days"];
const DAY_KEYS = ["date", "complete", "from_height", "to_height", "committed_blocks", "signed_blocks", "participation_bps"];
const ATTESTATION_KEYS = ["observer_id", "region", "operator_group", "observed_at", "committee_epoch", "finalized_height",
  "finalized_block_hash", "registry_root", "validator_claims", "claim_digest_sha256", "algorithm_id", "public_key_hex",
  "signature_hex"];

/** The feed as a whole is malformed, or its rows are not what the signed claims give. */
export class FeedRejected extends Error {}

// ---------------------------------------------------------------- shape

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hex = (value, length) => typeof value === "string" && value.length === length &&
  [...value].every(character => "0123456789abcdef".includes(character));
const count = value => Number.isSafeInteger(value) && value >= 0;
const digits = text => text.length > 0 && [...text].every(character => "0123456789".includes(character));

function exactKeys(value, keys, what) {
  if (!isObject(value)) throw new FeedRejected(`schema: ${what} is not an object`);
  const have = Object.keys(value);
  if (have.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new FeedRejected(`schema: ${what} has other fields than the contract names`);
  }
}

/** `YYYY-MM-DD` to a day number, or null. */
function parseDate(text) {
  if (typeof text !== "string" || text.length !== 10 || text[4] !== "-" || text[7] !== "-") return null;
  const [year, month, day] = [text.slice(0, 4), text.slice(5, 7), text.slice(8, 10)];
  if (!digits(year) || !digits(month) || !digits(day)) return null;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  return new Date(ms).toISOString().slice(0, 10) === text ? ms / DAY_MS : null;
}

/** `YYYY-MM-DDTHH:MM:SSZ` to epoch milliseconds, or null. No fraction, no offset. */
function parseTimestamp(text) {
  if (typeof text !== "string" || text.length !== 20 || text[10] !== "T" || text[19] !== "Z") return null;
  const day = parseDate(text.slice(0, 10));
  const [hour, minute, second] = [text.slice(11, 13), text.slice(14, 16), text.slice(17, 19)];
  if (day === null || text[13] !== ":" || text[16] !== ":" || !digits(hour) || !digits(minute) || !digits(second) ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  return day * DAY_MS + (Number(hour) * 3600 + Number(minute) * 60 + Number(second)) * 1000;
}

const formatTimestamp = ms => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** Sorted keys, no whitespace: the bytes every implementation signs and hashes. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function claimBody(feed, attestation) {
  return canonicalJson({
    chain: feed.chain, committee_epoch: attestation.committee_epoch,
    finalized_block_hash: attestation.finalized_block_hash, finalized_height: attestation.finalized_height,
    observed_at: attestation.observed_at, observer_id: attestation.observer_id,
    operator_group: attestation.operator_group, quorum_policy: feed.quorum_policy, region: attestation.region,
    registry_root: attestation.registry_root, schema: feed.schema, schema_version: feed.schema_version,
    validator_claims: attestation.validator_claims, window_spec: feed.window_spec,
  });
}

// ---------------------------------------------------------------- one validator row

const within30Days = (startDay, windowEndDay) => startDay !== null && windowEndDay < startDay + HORIZON_DAYS;

/** Every field of a row that follows from its facts. */
export function deriveRow(row, windowEndDay) {
  const floorDay = row.recovery_floor_date === null ? null : parseDate(row.recovery_floor_date);
  const inRecovery = within30Days(floorDay, windowEndDay);
  const scored = row.days.filter(day => day.complete && day.committed_blocks > 0 &&
    (!inRecovery || parseDate(day.date) >= floorDay));
  const observed = scored.length;
  const mean = observed ? Math.floor(scored.reduce((sum, day) => sum + day.participation_bps, 0) / observed) : null;
  let streak = 0;
  for (let index = scored.length - 1; index >= 0 && scored[index].participation_bps >= THRESHOLD_BPS; index -= 1) streak += 1;
  const rampIn = within30Days(row.first_active_date === null ? null : parseDate(row.first_active_date), windowEndDay);
  // Outside the ramp-in and a recovery, fewer than the minimum of scored days are too few to judge.
  const tooFewToJudge = !rampIn && !inRecovery && observed < MIN_OBSERVED_DAYS;
  const liveness = row.registry_active && (observed === 0 || tooFewToJudge || mean >= THRESHOLD_BPS);
  let reason, hub, reward, removal = false;
  if (row.access_state === "pending") [reason, hub, reward] = ["awaiting_ratification", false, false];
  else if (row.access_state === "active") {
    hub = true;
    if (rampIn) [reason, reward] = ["day0_ramp_in", true];
    else if (inRecovery) [reason, reward] = ["recovered_3day_streak", true];
    else if (observed >= MIN_OBSERVED_DAYS) [reason, reward] = ["healthy_liveness", true];
    // Too few days with blocks to judge. Access stays, the credit waits.
    else [reason, reward] = ["insufficient_observed_days", false];
  } else if (row.access_state === "lapsed") {
    [reason, hub, reward] = [row.registry_active ? "below_liveness_threshold" : "removed_from_registry", true, false];
  } else if (row.access_state === "revoked") {
    [reason, hub, reward, removal] = [row.registry_active ? "grace_expired" : "removed_from_registry", false, false, row.registry_active];
  } else throw new Error(`${row.validator_id}: unknown access_state`);
  const graceStart = row.grace_started_at === null ? null : parseTimestamp(row.grace_started_at);
  return {
    ramp_in_active: rampIn, observed_days: observed, mean_daily_participation_bps: mean,
    consecutive_passing_days: streak, liveness_met: liveness, access_state_reason: reason,
    grace_expires_at: graceStart === null ? null : formatTimestamp(graceStart + GRACE_DAYS * DAY_MS),
    removal_proposal_eligible: removal, reward_eligible: reward, finance_hub_access: hub,
    research_api_keys_active: hub,
  };
}

/** Throws when a signed claim does not follow from its own facts. */
function checkRow(row, windowStartDay, windowEndDay) {
  const fail = message => { throw new Error(`${row.validator_id}: ${message}`); };
  exactKeys(row, CLAIM_KEYS, "a validator claim");
  const state = row.access_state;
  if (typeof row.validator_id !== "string" || !hex(row.ml_dsa_public_key, 3904) ||
      typeof row.registry_active !== "boolean" || !Array.isArray(row.days) || row.days.length > HORIZON_DAYS) {
    fail("malformed claim");
  }
  const firstDay = row.first_active_date === null ? null : parseDate(row.first_active_date);
  if (row.first_active_date !== null && firstDay === null) fail("first_active_date is not a date");
  if ((state === "pending") !== (firstDay === null)) fail("first_active_date is null exactly while pending");
  if (state === "pending" && row.registry_active) fail("a pending validator is not in the registry");
  if (state === "active" && !row.registry_active) fail("an active validator is in the registry");
  if ((state === "lapsed") !== (row.grace_started_at !== null)) fail("grace_started_at is set exactly while lapsed");
  if (row.grace_started_at !== null) {
    const started = parseTimestamp(row.grace_started_at);
    if (started === null || started % DAY_MS !== 0 || started / DAY_MS > windowEndDay) {
      fail("grace starts at a UTC midnight, not after the evaluation day");
    }
  }
  if (row.recovery_floor_date !== null) {
    const floorDay = parseDate(row.recovery_floor_date);
    if (floorDay === null || state !== "active" || !within30Days(floorDay, windowEndDay)) {
      fail("recovery_floor_date outlived its 30 days or its active state");
    }
  }
  let expectedDay = firstDay === null ? windowEndDay : Math.max(firstDay, windowStartDay);
  let lastTo = 0;
  for (const day of row.days) {
    exactKeys(day, DAY_KEYS, "a day");
    if (parseDate(day.date) !== expectedDay || expectedDay >= windowEndDay) {
      fail("days must list every window day from first_active_date, once, in order");
    }
    expectedDay += 1;
    if (typeof day.complete !== "boolean" || !count(day.committed_blocks) || !count(day.signed_blocks)) fail(`${day.date}: malformed day`);
    if (day.signed_blocks > day.committed_blocks) fail(`${day.date}: signed_blocks exceeds committed_blocks`);
    if ((day.from_height === null) !== (day.to_height === null)) fail(`${day.date}: from_height and to_height are set together`);
    if (day.from_height === null) {
      if (day.committed_blocks !== 0) fail(`${day.date}: blocks without a height range`);
    } else {
      if (!count(day.from_height) || !count(day.to_height) || day.from_height <= lastTo || day.to_height < day.from_height) {
        fail(`${day.date}: height ranges must ascend`);
      }
      if (day.committed_blocks > day.to_height - day.from_height + 1) fail(`${day.date}: more blocks than heights`);
      lastTo = day.to_height;
    }
    const expectedBps = day.complete && day.committed_blocks > 0
      ? Math.floor(day.signed_blocks * 10000 / day.committed_blocks) : null;
    if (day.participation_bps !== expectedBps) fail(`${day.date}: participation_bps is not what its counts give`);
  }
  if (expectedDay < windowEndDay) fail("days must list every window day from first_active_date, once, in order");
  for (const [key, value] of Object.entries(deriveRow(row, windowEndDay))) {
    if (row[key] !== value) fail(`${key} is not what the signed facts give`);
  }
  if (state === "active" && !row.liveness_met) fail("active without liveness");
}

// ---------------------------------------------------------------- the feed

function checkAttestation(feed, attestation, pinned, windowStartDay, windowEndDay, nowMs, lastAccepted) {
  const fail = message => { throw new Error(message); };
  if (!pinned) fail("observer is not in the pinned keyset");
  for (const field of ["public_key_hex", "region", "operator_group"]) {
    if (attestation[field] !== pinned[field]) fail(`${field} differs from the pinned keyset`);
  }
  const body = new TextEncoder().encode(claimBody(feed, attestation));
  if (attestation.claim_digest_sha256 !== createHash("sha256").update(body).digest("hex")) {
    fail("claim_digest_sha256 does not match the claim body");
  }
  let verified = false;
  try {
    verified = attestation.algorithm_id === "ML-DSA-65" && hex(attestation.signature_hex, 6618) &&
      ml_dsa65.verify(Uint8Array.from(Buffer.from(attestation.signature_hex, "hex")), body,
        Uint8Array.from(Buffer.from(pinned.public_key_hex, "hex")), { context });
  } catch { verified = false; }
  if (!verified) fail("ML-DSA-65 signature does not verify");
  const observedAt = parseTimestamp(attestation.observed_at);
  if (observedAt === null) fail("observed_at is not a UTC timestamp");
  if (observedAt - nowMs > FUTURE_SKEW_SECONDS * 1000) fail("observed_at is in the future");
  if (nowMs - observedAt > STALE_SECONDS * 1000) fail("stale");
  const previous = lastAccepted[attestation.observer_id];
  if (previous !== undefined && observedAt < parseTimestamp(previous)) {
    fail("older than the last attestation accepted from this observer");
  }
  if (observedAt < windowEndDay * DAY_MS || observedAt >= (windowEndDay + 1) * DAY_MS) {
    fail("observed_at is outside the evaluation day of this window");
  }
  const claims = attestation.validator_claims;
  if (!Array.isArray(claims) || !claims.length || !count(attestation.finalized_height) || attestation.finalized_height < 1) {
    fail("an attestation names a finalized height and at least one validator");
  }
  const keys = new Set();
  claims.forEach((claim, index) => {
    if (!isObject(claim) || typeof claim.validator_id !== "string" ||
        (index > 0 && !(claims[index - 1].validator_id < claim.validator_id))) {
      fail("validator_claims must be sorted by validator_id without repeats");
    }
    if (keys.has(claim.ml_dsa_public_key)) fail("two validators share one key");
    keys.add(claim.ml_dsa_public_key);
    checkRow(claim, windowStartDay, windowEndDay);
  });
}

/**
 * Rows from the verified attestations, and the validators without a quorum.
 * A row is one observer's signed claim, copied whole: with three agreeing
 * observers the one with the middle score, with two the lower score; ties go
 * to the lower observer id; an unknown score counts as the lowest.
 */
export function reconcile(attestations) {
  const byValidator = new Map();
  for (const attestation of attestations) {
    for (const claim of attestation.validator_claims) {
      if (!byValidator.has(claim.validator_id)) byValidator.set(claim.validator_id, []);
      byValidator.get(claim.validator_id).push([attestation.observer_id, claim]);
    }
  }
  const rows = [], noQuorum = [];
  for (const validatorId of [...byValidator.keys()].sort()) {
    const groups = new Map();
    for (const [observerId, claim] of byValidator.get(validatorId)) {
      // Everything a consumer acts on is agreed, not only the state.
      const key = JSON.stringify([claim.ml_dsa_public_key, claim.registry_active, claim.liveness_met, claim.access_state,
        claim.reward_eligible, claim.grace_started_at]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([observerId, claim]);
    }
    const group = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (group.length < QUORUM) { noQuorum.push(validatorId); continue; }
    const score = claim => claim.mean_daily_participation_bps === null ? -1 : claim.mean_daily_participation_bps;
    group.sort((a, b) => score(a[1]) - score(b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const [sourceId, source] = group.length === 3 ? group[1] : group[0];
    rows.push({ ...structuredClone(source), source_observer_id: sourceId,
      agreeing_observer_ids: group.map(item => item[0]).sort() });
  }
  return { rows, noQuorum };
}

function sameConstants(value, expected, what) {
  for (const [key, constant] of Object.entries(expected)) {
    if (value[key] !== constant) throw new FeedRejected(`schema: ${what}.${key} differs from the contract`);
  }
}

export function validateKeyset(keyset) {
  exactKeys(keyset, ["schema", "keyset_id", "chain", "threshold", "total_observers", "algorithm_id", "signing_context", "observers"], "the keyset");
  exactKeys(keyset.chain, ["network", "chain_id", "genesis_hash"], "keyset.chain");
  if (keyset.schema !== KEYSET_SCHEMA || keyset.threshold !== QUORUM || keyset.total_observers !== 3 ||
      keyset.algorithm_id !== "ML-DSA-65" || keyset.signing_context !== SIGNING_CONTEXT ||
      !Array.isArray(keyset.observers) || keyset.observers.length !== 3) {
    throw new FeedRejected("the pinned keyset is not a 2-of-3 postfiat.observer_keyset.v1");
  }
  for (const field of ["observer_id", "region", "operator_group", "public_key_hex"]) {
    if (new Set(keyset.observers.map(observer => observer[field])).size !== 3) {
      throw new FeedRejected(`the pinned keyset repeats ${field}`);
    }
  }
  if (keyset.observers.some(observer => !hex(observer.public_key_hex, 3904))) {
    throw new FeedRejected("the pinned keyset holds a key that is not ML-DSA-65");
  }
  return keyset;
}

/**
 * Read a feed the way the contract says a consumer must.
 *
 * Throws FeedRejected when the feed as a whole must be refused. A wrong
 * observer is not an error: its attestation is dropped and named in
 * `rejectedObservers`. With fewer than two attestations that count the result
 * is `indeterminate`: new bindings and new credit wait, and nobody is revoked.
 */
export function verifyUptimeFeed(feed, { keyset, now = new Date(), lastAccepted = {} }) {
  validateKeyset(keyset);
  exactKeys(feed, ["schema", "schema_version", "generated_at", "chain", "quorum_policy", "window_spec", "validators",
    "observer_attestations"], "the feed");
  if (feed.schema !== FEED_SCHEMA || feed.schema_version !== 1 || parseTimestamp(feed.generated_at) === null) {
    throw new FeedRejected("schema: not a postfiat-validator-uptime-v1 feed");
  }
  exactKeys(feed.chain, ["network", "chain_id", "genesis_hash"], "chain");
  exactKeys(feed.quorum_policy, ["observer_keyset_id", ...Object.keys(QUORUM_POLICY)], "quorum_policy");
  exactKeys(feed.window_spec, [...Object.keys(WINDOW_SPEC), "credit_sources", "window_start", "window_end"], "window_spec");
  sameConstants(feed.quorum_policy, QUORUM_POLICY, "quorum_policy");
  sameConstants(feed.window_spec, WINDOW_SPEC, "window_spec");
  if (canonicalJson(feed.window_spec.credit_sources) !== canonicalJson(CREDIT_SOURCES)) {
    throw new FeedRejected("schema: window_spec.credit_sources differs from the contract");
  }
  if (canonicalJson(feed.chain) !== canonicalJson(keyset.chain) || feed.quorum_policy.observer_keyset_id !== keyset.keyset_id) {
    throw new FeedRejected("feed is for another chain or keyset than the pinned keyset");
  }
  const windowStart = parseTimestamp(feed.window_spec.window_start), windowEnd = parseTimestamp(feed.window_spec.window_end);
  if (windowStart === null || windowEnd === null || windowEnd % DAY_MS !== 0 || windowEnd - windowStart !== HORIZON_DAYS * DAY_MS) {
    throw new FeedRejected("the window is 30 whole UTC days");
  }
  const attestations = feed.observer_attestations;
  if (!Array.isArray(attestations) || !attestations.length || attestations.length > 3 || !Array.isArray(feed.validators)) {
    throw new FeedRejected("schema: a feed carries one to three attestations");
  }
  attestations.forEach(attestation => exactKeys(attestation, ATTESTATION_KEYS, "an attestation"));
  if (new Set(attestations.map(attestation => attestation.observer_id)).size !== attestations.length) {
    throw new FeedRejected("one observer appears twice");
  }

  const nowMs = new Date(now).getTime();
  const verified = [], rejectedObservers = {};
  for (const attestation of attestations) {
    try {
      checkAttestation(feed, attestation, keyset.observers.find(observer => observer.observer_id === attestation.observer_id),
        windowStart / DAY_MS, windowEnd / DAY_MS, nowMs, lastAccepted);
      verified.push(attestation);
    } catch (error) { rejectedObservers[String(attestation.observer_id)] = error.message; }
  }
  const indeterminate = verified.length < QUORUM;
  const result = {
    verifiedObservers: verified.map(attestation => attestation.observer_id).sort(),
    rejectedObservers, indeterminate,
    allowNewBindings: !indeterminate, allowCreditGrants: !indeterminate, revokeExistingAccess: false,
    validators: [], validatorsWithoutQuorum: [],
    accepted: Object.fromEntries(verified.map(attestation => [attestation.observer_id, attestation.observed_at])),
    windowEnd: feed.window_spec.window_end,
  };
  if (indeterminate) return result;
  const { rows, noQuorum } = reconcile(verified);
  if (canonicalJson(feed.validators) !== canonicalJson(rows)) {
    throw new FeedRejected("the validators array is not what the verified signed claims give");
  }
  result.validators = rows;
  result.validatorsWithoutQuorum = noQuorum;
  return result;
}
