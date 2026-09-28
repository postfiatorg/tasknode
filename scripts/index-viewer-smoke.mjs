import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { closePool, query } from "../server/db/pool.js";
import { migrateDatabase } from "../server/db/migrate.js";
import {
  consumeCode,
  getIndex,
  issueCode,
  issueViewerToken,
  listIndices,
  resolveViewerToken,
  upsertIndex,
} from "../server/repositories/index-viewer.js";
import {
  accountMeetsTier,
  allowedStaticOrigins,
  corsHeadersFor,
  safeReturnTo,
} from "../server/index-viewer-routes.js";

const indexId = `smoke_index_${randomUUID()}`;
const accountId = `smoke_account_${randomUUID()}`;
const walletAccountId = `smoke_wallet_account_${randomUUID()}`;
const contentKey = Buffer.from(randomUUID()).toString("base64");

try {
  await migrateDatabase();

  // ---------------------------------------------------------------- publish
  const published = await upsertIndex({
    indexId,
    title: "Smoke index",
    summary: "Fixture",
    contentKey,
    contentUrl: "/gated/smoke.enc.json",
    contentHash: "deadbeef",
    metadata: { fixture: true },
  });
  assert.equal(published.indexId, indexId);
  assert.equal(published.contentKey, contentKey);

  // Republishing rotates the key rather than creating a duplicate row.
  const rotated = await upsertIndex({ indexId, title: "Smoke index", contentKey: "rotated-key" });
  assert.equal(rotated.contentKey, "rotated-key");
  assert.equal((await query("SELECT count(*)::int n FROM index_viewer_indices WHERE index_id=$1", [indexId])).rows[0].n, 1);
  await upsertIndex({ indexId, title: "Smoke index", contentKey });

  // The catalog must never expose a content key.
  const catalog = await listIndices();
  const listed = catalog.find((row) => row.indexId === indexId);
  assert.ok(listed, "published index is listed");
  assert.equal(listed.contentKey, undefined);
  assert.ok(!JSON.stringify(catalog).includes(contentKey), "catalog leaks no content key");

  // ------------------------------------------------------------ code is single use
  const { code } = await issueCode({ indexId, accountId, returnOrigin: "https://agti.net" });
  const claimed = await consumeCode({ code, indexId });
  assert.equal(claimed.accountId, accountId);
  assert.equal(await consumeCode({ code, indexId }), null, "a code cannot be replayed");

  // A code is bound to its index.
  const other = await issueCode({ indexId, accountId });
  assert.equal(await consumeCode({ code: other.code, indexId: "some_other_index" }), null);

  // An expired code is refused.
  const stale = await issueCode({ indexId, accountId });
  await query("UPDATE index_viewer_codes SET expires_at = now() - interval '1 minute' WHERE code_hash = encode(digest($1,'sha256'),'hex')", [stale.code])
    .catch(async () => {
      // pgcrypto may be absent; expire every outstanding code for this account instead.
      await query("UPDATE index_viewer_codes SET expires_at = now() - interval '1 minute' WHERE account_id = $1 AND consumed_at IS NULL", [accountId]);
    });
  assert.equal(await consumeCode({ code: stale.code, indexId }), null, "an expired code is refused");

  // ---------------------------------------------------------- token scoping
  const { token } = await issueViewerToken({ indexId, accountId, walletAddress: "rSmokeWallet" });
  const grant = await resolveViewerToken({ token, indexId });
  assert.equal(grant.accountId, accountId);
  assert.equal(grant.walletAddress, "rSmokeWallet");

  // A token for one index must not unlock another.
  assert.equal(await resolveViewerToken({ token, indexId: "some_other_index" }), null);
  assert.equal(await resolveViewerToken({ token: "not-a-real-token", indexId }), null);

  // Revocation and expiry both close the token.
  await query("UPDATE index_viewer_tokens SET revoked_at = now() WHERE account_id = $1", [accountId]);
  assert.equal(await resolveViewerToken({ token, indexId }), null, "a revoked token is refused");

  // ------------------------------------------------------------- tier gate
  const noWallet = await accountMeetsTier({ accountId: walletAccountId });
  assert.equal(noWallet.ok, false);
  assert.equal(noWallet.reason, "wallet_required");
  assert.equal((await accountMeetsTier({ accountId: "" })).reason, "not_signed_in");
  // An unknown tier fails closed rather than granting access.
  assert.equal((await accountMeetsTier({ accountId, tier: "everyone" })).ok, false);

  // --------------------------------------------------------- return_to guard
  assert.equal(safeReturnTo("https://agti.net/gated/x/").origin, "https://agti.net");
  assert.equal(safeReturnTo("http://evil.example.com/"), null, "plain http is refused");
  assert.equal(safeReturnTo("javascript:alert(1)"), null, "a javascript url is refused");
  assert.equal(safeReturnTo(""), null);
  assert.equal(safeReturnTo("not a url"), null);

  // ------------------------------------------------------------------- cors
  const allowed = allowedStaticOrigins({});
  assert.ok(allowed.includes("https://agti.net"));
  const good = corsHeadersFor({ headers: { origin: "https://agti.net" } }, {});
  assert.equal(good["access-control-allow-origin"], "https://agti.net");
  assert.ok(good["access-control-allow-headers"].includes("authorization"));
  assert.equal(corsHeadersFor({ headers: { origin: "https://evil.example.com" } }, {}), null);
  assert.equal(corsHeadersFor({ headers: {} }, {}), null, "no origin means no cors headers");
  // The allowlist is configurable without a code change.
  const configured = allowedStaticOrigins({ INDEX_VIEWER_ALLOWED_ORIGINS: "https://a.test, https://b.test" });
  assert.deepEqual(configured, ["https://a.test", "https://b.test"]);

  // --------------------------------------------------------------- cleanup
  await query("DELETE FROM index_viewer_tokens WHERE account_id = $1", [accountId]);
  await query("DELETE FROM index_viewer_codes WHERE account_id = $1", [accountId]);
  await query("DELETE FROM index_viewer_indices WHERE index_id = $1", [indexId]);
  assert.equal(await getIndex(indexId), null);

  console.log("index-viewer-smoke ok");
} finally {
  await closePool();
}
