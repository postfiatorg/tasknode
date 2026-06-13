import assert from "node:assert/strict";

import { publicProfileFromParts } from "../server/repositories/profile-public.js";

const accountId = "acct_profile_hero_nft_smoke";
const imageCid = "QmProfileHeroNftSmoke";

const profile = publicProfileFromParts({
  accountId,
  input: {
    account_id: accountId,
    identity: {
      primary_wallet: "rActiveWallet",
      active_wallet: "rActiveWallet",
      wallet_count: 1,
    },
    reward_totals: {},
    alignment: {},
  },
  heroNft: {
    id: "nft_historical_wallet",
    accountId,
    walletAddress: "rHistoricalRewardedWallet",
    title: "Historical wallet profile NFT",
    status: "minted",
    imageCid,
    imageGatewayUrl: `https://dweb.link/ipfs/${imageCid}`,
  },
  nfts: [],
});

assert.equal(profile.heroNft?.imageCid, imageCid);
assert.equal(profile.nfts.length, 1);
assert.equal(profile.nfts[0]?.imageCid, imageCid);

const hiddenProfile = publicProfileFromParts({
  accountId,
  input: {
    account_id: accountId,
    identity: {},
    reward_totals: {},
    alignment: {},
  },
  heroNft: {
    id: "nft_generating",
    accountId,
    status: "generating",
    imageCid,
  },
  nfts: [],
});

assert.equal(hiddenProfile.heroNft, null);

console.log("profile public hero nft smoke ok");
