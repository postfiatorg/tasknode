import assert from "node:assert/strict";

const databaseUrl = String(process.env.DATABASE_URL || "").trim();
if (databaseUrl && !process.env.TASKNODE_DATABASE_ENABLED) {
  process.env.TASKNODE_DATABASE_ENABLED = "true";
}

const {
  createGeneratingProfileNft,
  failStaleGeneratingProfileNfts,
  getProfileNft,
} = await import("../server/repositories/profile-nfts.js");

const interruptedPattern = /server restarted while this image was generating/;
const staleIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const suffix = `${Date.now()}`;

// Runtime-store sweep coverage (no database required).
const previousDisabled = process.env.TASKNODE_DATABASE_DISABLED;
process.env.TASKNODE_DATABASE_DISABLED = "true";

const runtimeAccountId = `account_profile_nft_recovery_runtime_${suffix}`;
const runtimeOtherAccountId = `${runtimeAccountId}_other`;
const runtimeStale = await createGeneratingProfileNft({
  accountId: runtimeAccountId,
  title: "Stale runtime draft",
});
const runtimeFresh = await createGeneratingProfileNft({
  accountId: runtimeAccountId,
  title: "Fresh runtime draft",
});
const runtimeOtherStale = await createGeneratingProfileNft({
  accountId: runtimeOtherAccountId,
  title: "Stale runtime draft (other account)",
});
// The runtime store returns the stored record reference, so backdating the
// returned object backdates the stored row.
runtimeStale.updatedAt = staleIso;
runtimeOtherStale.updatedAt = staleIso;

const runtimeSwept = await failStaleGeneratingProfileNfts({ accountId: runtimeAccountId });
assert.equal(runtimeSwept.length, 1);
assert.equal(runtimeSwept[0].id, runtimeStale.id);
assert.equal(runtimeSwept[0].status, "failed");
assert.match(runtimeSwept[0].error, interruptedPattern);

const runtimeFreshAfter = await getProfileNft({ accountId: runtimeAccountId, nftId: runtimeFresh.id });
assert.equal(runtimeFreshAfter.status, "generating", "a fresh in-flight generation must never be swept");

const runtimeOtherAfter = await getProfileNft({
  accountId: runtimeOtherAccountId,
  nftId: runtimeOtherStale.id,
});
assert.equal(runtimeOtherAfter.status, "generating", "account-scoped sweep must not touch other accounts");

// The stale threshold is floored above the worst-case in-flight image timeout,
// so even an aggressive staleMinutes cannot sweep a fresh in-flight row.
const aggressiveSwept = await failStaleGeneratingProfileNfts({
  accountId: runtimeAccountId,
  staleMinutes: 1,
});
assert.equal(aggressiveSwept.length, 0);
const runtimeFreshFinal = await getProfileNft({ accountId: runtimeAccountId, nftId: runtimeFresh.id });
assert.equal(runtimeFreshFinal.status, "generating");

if (previousDisabled === undefined) {
  delete process.env.TASKNODE_DATABASE_DISABLED;
} else {
  process.env.TASKNODE_DATABASE_DISABLED = previousDisabled;
}

if (!databaseUrl) {
  console.log("profile-nft-recovery-smoke ok (runtime store only; set DATABASE_URL for the Postgres sweep)");
  process.exit(0);
}

const { migrateDatabase } = await import("../server/db/migrate.js");
const { closePool, query } = await import("../server/db/pool.js");

await migrateDatabase();

const accountId = `account_profile_nft_recovery_${suffix}`;
const otherAccountId = `${accountId}_other`;

const staleDraft = await createGeneratingProfileNft({
  accountId,
  title: "Stale generating draft",
});
const freshDraft = await createGeneratingProfileNft({
  accountId,
  title: "Fresh generating draft",
});
const otherStaleDraft = await createGeneratingProfileNft({
  accountId: otherAccountId,
  title: "Stale generating draft (other account)",
});

await query(
  `UPDATE profile_nfts
      SET updated_at = now() - interval '1 hour'
    WHERE id = ANY($1::text[])`,
  [[staleDraft.id, otherStaleDraft.id]]
);

const swept = await failStaleGeneratingProfileNfts({ accountId });
assert.equal(swept.length, 1);
assert.equal(swept[0].id, staleDraft.id);
assert.equal(swept[0].status, "failed");
assert.match(swept[0].error, interruptedPattern);

const staleAfter = await getProfileNft({ accountId, nftId: staleDraft.id });
assert.equal(staleAfter.status, "failed");
assert.match(staleAfter.error, interruptedPattern);
assert.ok(
  new Date(staleAfter.updatedAt).getTime() > Date.now() - 5 * 60 * 1000,
  "swept rows must get a fresh updated_at"
);

const freshAfter = await getProfileNft({ accountId, nftId: freshDraft.id });
assert.equal(freshAfter.status, "generating", "a fresh in-flight generation must never be swept");
assert.equal(freshAfter.error, "");

const otherAfter = await getProfileNft({ accountId: otherAccountId, nftId: otherStaleDraft.id });
assert.equal(otherAfter.status, "generating", "account-scoped sweep must not touch other accounts");

const globalSwept = await failStaleGeneratingProfileNfts({});
assert.ok(globalSwept.some((nft) => nft.id === otherStaleDraft.id));
const otherFinal = await getProfileNft({ accountId: otherAccountId, nftId: otherStaleDraft.id });
assert.equal(otherFinal.status, "failed");
assert.match(otherFinal.error, interruptedPattern);

await query(`DELETE FROM profile_nfts WHERE account_id = ANY($1::text[])`, [[accountId, otherAccountId]]);
await closePool();

console.log(`profile-nft-recovery-smoke ok: ${accountId}`);
