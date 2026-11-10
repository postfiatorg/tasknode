// Child helper for scripts/airdrop-exactly-once-crash.test.mjs.
// Each invocation is a separate OS process that drives the real issuance
// module against the isolated test database. Phases ending in "crash" kill the
// process with SIGKILL at the named point so the database is left exactly as a
// dead worker would leave it. Nothing here signs or broadcasts a real
// transaction; the marker transition is the broadcast authorization boundary.

const phase = process.argv[2] || "";
const accountId = process.argv[3] || "";
const runId = process.argv[4] || "";
const issuanceId = process.argv[5] || "";
const attemptCount = Number(process.argv[6] || 0);
const signedTxHash = process.argv[7] || `crash-test-${Date.now()}`;

const report = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

try {
  const { claimDailyAirdropIssuanceForPublish: claim, markIssuanceSubmitting: submit,
    markDailyAirdropIssuancePublishFailure: fail } =
    await import("../server/profile-daily-airdrop-issuance.js");
  if (phase === "claim" || phase === "claim-crash" || phase === "claim-marker-crash" ||
      phase === "claim-marker-unknown" || phase === "claim-fail-before-submit" || phase === "claim-marker") {
    const claimed = await claim({ accountId, runId });
    if (phase === "claim-crash") {
      // Database holds a committed pre-submit claim; the worker dies here.
      process.kill(process.pid, "SIGKILL");
    }
    if (phase === "claim" || phase === "claim-fail-before-submit" || phase === "claim-marker-unknown" || phase === "claim-marker") {
      report({ phase, ok: true, claim: {
        issuanceId: claimed.issuance.id,
        attemptCount: claimed.issuance.attempt_count,
        status: claimed.issuance.status,
        alreadySubmitted: Boolean(claimed.alreadySubmitted),
      } });
    }
    if (phase === "claim-marker-unknown" || phase === "claim-marker") {
      await submit({
        issuanceId: claimed.issuance.id,
        signedTxHash,
        attemptCount: claimed.issuance.attempt_count,
        cid: `cid-${signedTxHash}`,
        digest: `digest-${signedTxHash}`,
      });
      if (phase === "claim-marker") {
        report({ phase, ok: true, marked: true, issuanceId: claimed.issuance.id,
          attemptCount: claimed.issuance.attempt_count });
        process.exit(0);
      }
    }
    if (phase === "claim-marker-crash") {
      await submit({
        issuanceId: claimed.issuance.id,
        signedTxHash,
        attemptCount: claimed.issuance.attempt_count,
        cid: `cid-${signedTxHash}`,
        digest: `digest-${signedTxHash}`,
      });
      // Durable submission marker + signed hash are committed; the worker dies
      // before any broadcast outcome is learned.
      process.kill(process.pid, "SIGKILL");
    }
    if (phase === "claim-marker-unknown") {
      // The publish catch path after an unknown broadcast outcome.
      await fail({ issuanceId: claimed.issuance.id, error: new Error("simulated_unknown_submit"),
        submissionAttempted: true, attemptCount: claimed.issuance.attempt_count });
      report({ phase, ok: true, unknown: true, issuanceId: claimed.issuance.id });
      process.exit(0);
    }
    if (phase === "claim-fail-before-submit") {
      await fail({ issuanceId: claimed.issuance.id, error: new Error("simulated_pre_submit_failure"),
        submissionAttempted: false, attemptCount: claimed.issuance.attempt_count });
      report({ phase, ok: true, failedBeforeSubmit: true, issuanceId: claimed.issuance.id });
      process.exit(0);
    }
    process.exit(0);
  }
  if (phase === "marker-race") {
    await submit({ issuanceId, signedTxHash, attemptCount, cid: `cid-${signedTxHash}`, digest: `digest-${signedTxHash}` });
    report({ phase, ok: true, marked: true, issuanceId });
    process.exit(0);
  }
  report({ phase, ok: false, error: `unknown_phase:${phase}` });
  process.exit(2);
} catch (error) {
  report({ phase, ok: false, error: String(error?.message || error) });
  process.exit(1);
}
