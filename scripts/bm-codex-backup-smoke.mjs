import assert from "node:assert/strict";
import { backupDecision, backupLeaseActive, deliveryHeldByBackup, providerLimited, LEASE_TTL_MS } from "../ops/bm-runtime/codex-backup.mjs";

const now = Date.parse("2026-11-04T15:30:00Z");
const iso = (ms) => new Date(ms).toISOString();
const ready = { version: 1, pid: 42, threadId: "t", ready: true, updatedAt: iso(now - 1000) };
const busy = { ...ready, ready: false };
const pending = { id: "round_a", attempts: 3 };
const decide = (input) => backupDecision({ pending, status: ready, now, ...input });

assert.equal(decide({ pending: null }), "idle");
assert.equal(decide({ pending: { id: "round_a", attempts: 1 } }), "wait_attempts");
assert.equal(decide({ pending: { id: "round_a", attempts: 1 }, kimiLimited: true }), "take_over", "provider-limited Kimi is a stall without three deliveries");
assert.equal(decide({}), "take_over");
assert.equal(decide({ mark: { roundId: "round_a", at: iso(now - 10 * 60_000) } }), "wait_retry");
assert.equal(decide({ mark: { roundId: "round_a", at: iso(now - 61 * 60_000) } }), "take_over");
assert.equal(decide({ status: busy }), "kimi_busy", "never beside a live Kimi turn");
assert.equal(decide({ status: busy, force: true }), "kimi_busy", "not even forced");
assert.equal(decide({ status: { ...busy, updatedAt: iso(now - 60_000) } }), "take_over", "a stale busy flag is not a live turn");
assert.equal(decide({ pending: { id: "round_a", attempts: 0 }, force: true }), "take_over");

const alive = (pid) => pid === 7;
const lease = { roundId: "round_a", pid: 7, expiresAt: iso(now + LEASE_TTL_MS) };
assert.equal(backupLeaseActive(lease, now, alive), true);
assert.equal(backupLeaseActive({ ...lease, pid: 8 }, now, alive), false, "dead owner releases the round");
assert.equal(backupLeaseActive({ ...lease, expiresAt: iso(now - 1) }, now, alive), false, "expired lease");
assert.equal(deliveryHeldByBackup(lease, { id: "round_a" }, now, alive), true);
assert.equal(deliveryHeldByBackup(lease, { id: "round_b" }, now, alive), false, "only the leased round is held");
assert.equal(deliveryHeldByBackup(null, { id: "round_a" }, now, alive), false);

const done = (message) => ({ type: "event_msg", payload: { type: "task_complete", ...(message ? { error: { message } } : {}) } });
assert.equal(providerLimited([done("rate limited by provider (429 Too Many Requests)"), done("You've reached your weekly (7-day) usage limit")]), true);
assert.equal(providerLimited([done("rate limited by provider (429 Too Many Requests)"), done(null)]), false, "a successful last turn clears it");
assert.equal(providerLimited([done("429")]), false, "one failure is not a stall");
console.log("bm codex backup smoke ok: stall detection, exclusive lease, no takeover beside a live Kimi turn, provider-limit detection");
