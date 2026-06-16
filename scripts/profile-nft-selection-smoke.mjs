import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";

const {
  createGeneratedProfileNft,
  listProfileNfts,
  setSelectedProfileNft,
} = await import("../server/repositories/profile-nfts.js");
const { getPublicProfile } = await import("../server/repositories/profile-public.js");
const { handleProfileRoute } = await import("../server/profile-routes.js");

function createResponseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = { ...headers };
    },
    end(body = "") {
      this.body = body ? JSON.parse(String(body)) : null;
    },
  };
}

function json(res, statusCode, body = {}, headers = {}) {
  res.writeHead(statusCode, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function callProfileRoute({ method = "GET", path = "/api/profile/nfts", session, payload = {} } = {}) {
  const res = createResponseCapture();
  const handled = await handleProfileRoute({
    getState: async () => ({}),
    json,
    readJson: async () => payload,
    req: { method, headers: {} },
    res,
    session,
    url: new URL(`http://tasknode.local${path}`),
  });
  assert.equal(handled, true);
  return res;
}

const accountId = "account_profile_nft_selection_smoke";
const walletAddress = "rSelectionSmokeCurrentWallet";
const oldWalletAddress = "rSelectionSmokeOldWallet";
const otherAccountId = "account_profile_nft_selection_other";

const first = await createGeneratedProfileNft({
  accountId,
  walletAddress,
  title: "First selectable NFT",
  imageCid: "QmSelectionSmokeProfileNftImageCid111111111111",
});
const second = await createGeneratedProfileNft({
  accountId,
  walletAddress: oldWalletAddress,
  title: "Old wallet selectable NFT",
  imageCid: "QmSelectionSmokeProfileNftImageCid222222222222",
});
const foreign = await createGeneratedProfileNft({
  accountId: otherAccountId,
  walletAddress,
  title: "Foreign NFT",
  imageCid: "QmSelectionSmokeProfileNftImageCid333333333333",
});

let selected = await setSelectedProfileNft({ accountId, nftId: first.id });
assert.equal(selected?.id, first.id);
let listed = await listProfileNfts({ accountId, limit: 240 });
assert.equal(listed.find((nft) => nft.id === first.id)?.selected, true);
assert.equal(listed.find((nft) => nft.id === second.id)?.selected, false);

selected = await setSelectedProfileNft({ accountId, nftId: second.id });
assert.equal(selected?.id, second.id);
listed = await listProfileNfts({ accountId, limit: 240 });
assert.equal(listed.find((nft) => nft.id === first.id)?.selected, false);
assert.equal(listed.find((nft) => nft.id === second.id)?.selected, true);
assert.equal(await setSelectedProfileNft({ accountId, nftId: foreign.id }), null);

const selectRoute = await callProfileRoute({
  method: "POST",
  path: "/api/profile/nft/select",
  session: { accountId },
  payload: { nftId: first.id },
});
assert.equal(selectRoute.statusCode, 200);
assert.equal(selectRoute.body.ok, true);
assert.equal(selectRoute.body.nft.id, first.id);
assert.equal(selectRoute.body.nft.selected, true);

const notOwnedRoute = await callProfileRoute({
  method: "POST",
  path: "/api/profile/nft/select",
  session: { accountId },
  payload: { nftId: foreign.id },
});
assert.equal(notOwnedRoute.statusCode, 404);

const ownerList = await callProfileRoute({
  method: "GET",
  path: "/api/profile/nfts?limit=240",
  session: { accountId },
});
assert.equal(ownerList.statusCode, 200);
assert.equal(ownerList.body.total, 2);
assert.ok(ownerList.body.nfts.some((nft) => nft.id === first.id && nft.walletAddress === walletAddress));
assert.ok(ownerList.body.nfts.some((nft) => nft.id === second.id && nft.walletAddress === oldWalletAddress));

const publicAccountId = "account_profile_nft_public_full_list_smoke";
for (let index = 0; index < 31; index += 1) {
  await createGeneratedProfileNft({
    accountId: publicAccountId,
    walletAddress: index % 2 ? "rPublicFullListWalletA" : "rPublicFullListWalletB",
    title: `Public profile NFT ${index + 1}`,
    imageCid: `QmPublicFullListProfileNftImageCid${String(index + 1).padStart(3, "0")}`,
  });
}
const publicProfile = await getPublicProfile({ accountId: publicAccountId });
assert.equal(publicProfile.nfts.length, 31);
assert.equal(publicProfile.nftTotal, 31);

console.log("profile-nft-selection-smoke ok");
