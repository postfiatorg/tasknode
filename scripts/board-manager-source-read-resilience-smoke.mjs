import assert from "node:assert/strict";
import {
  isBoardManagerSourceReadTimeout,
  runBoardManagerSourceReads,
} from "../server/repositories/board-manager.js";

function timeoutError(message = "connection read timeout") {
  return Object.assign(new Error(message), { code: "ETIMEDOUT" });
}

let activeReads = 0;
let peakReads = 0;
const boundedResults = await runBoardManagerSourceReads(
  Array.from({ length: 12 }, (_, index) => ({
    label: `bounded_${index}`,
    read: async () => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeReads -= 1;
      return index;
    },
  })),
  { concurrency: 3, retryDelayMs: 0 }
);
assert.deepEqual(boundedResults, Array.from({ length: 12 }, (_, index) => index));
assert.equal(peakReads, 3);

let transientAttempts = 0;
const [transientResult] = await runBoardManagerSourceReads([
  {
    label: "transient_timeout",
    read: async () => {
      transientAttempts += 1;
      if (transientAttempts === 1) throw timeoutError();
      return "recovered";
    },
  },
], { retryDelayMs: 0 });
assert.equal(transientResult, "recovered");
assert.equal(transientAttempts, 2);

let nonTimeoutAttempts = 0;
await assert.rejects(
  runBoardManagerSourceReads([
    {
      label: "non_timeout_failure",
      read: async () => {
        nonTimeoutAttempts += 1;
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      },
    },
  ], { retryDelayMs: 0 }),
  /permission denied/
);
assert.equal(nonTimeoutAttempts, 1);

let optionalAttempts = 0;
const [fallbackResult] = await runBoardManagerSourceReads([
  {
    label: "optional_non_timeout",
    read: async () => {
      optionalAttempts += 1;
      throw new Error("optional source unavailable");
    },
    fallback: { status: "unavailable" },
  },
], { retryDelayMs: 0 });
assert.deepEqual(fallbackResult, { status: "unavailable" });
assert.equal(optionalAttempts, 1);

let persistentAttempts = 0;
let writes = 0;
await assert.rejects(
  (async () => {
    await runBoardManagerSourceReads([
      {
        label: "persistent_timeout",
        read: async () => {
          persistentAttempts += 1;
          throw timeoutError("query timeout");
        },
        fallback: "must-not-mask-timeouts",
      },
    ], { maxAttempts: 3, retryDelayMs: 0 });
    writes += 1;
  })(),
  (error) => {
    assert.equal(error.boardManagerSourceRead, "persistent_timeout");
    assert.equal(error.boardManagerSourceAttempts, 3);
    return true;
  }
);
assert.equal(persistentAttempts, 3);
assert.equal(writes, 0);

assert.equal(isBoardManagerSourceReadTimeout({ code: "57014" }), true);
assert.equal(isBoardManagerSourceReadTimeout(new Error("statement timeout")), true);
assert.equal(
  isBoardManagerSourceReadTimeout(new Error("Connection terminated due to connection timeout")),
  true
);
assert.equal(isBoardManagerSourceReadTimeout(new Error("syntax error")), false);

console.log(JSON.stringify({
  boundedConcurrency: {
    readers: boundedResults.length,
    configured: 3,
    observedPeak: peakReads,
  },
  transientTimeout: {
    attempts: transientAttempts,
    result: transientResult,
  },
  nonTimeoutFailure: {
    attempts: nonTimeoutAttempts,
    failedImmediately: true,
  },
  optionalFallback: {
    attempts: optionalAttempts,
    result: fallbackResult,
  },
  persistentTimeout: {
    attempts: persistentAttempts,
    partialWrites: writes,
  },
}, null, 2));
console.log("board-manager-source-read-resilience-smoke ok");
