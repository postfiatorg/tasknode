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

const selectedProfile = publicProfileFromParts({
  accountId,
  input: {
    account_id: accountId,
    identity: {},
    reward_totals: {},
    alignment: {},
  },
  nfts: [
    {
      id: "nft_newest_unselected",
      accountId,
      title: "Newest unselected",
      status: "generated",
      imageCid: "QmNewestUnselectedProfileNftSmoke",
      createdAt: "2026-06-15T12:00:00.000Z",
      selected: false,
    },
    {
      id: "nft_selected_older",
      accountId,
      title: "Selected older",
      status: "minted",
      imageCid: "QmSelectedOlderProfileNftSmoke",
      createdAt: "2026-06-01T12:00:00.000Z",
      selected: true,
    },
  ],
});
assert.equal(selectedProfile.heroNft?.id, "nft_selected_older");
assert.equal(selectedProfile.nfts[0]?.id, "nft_selected_older");

const createdAtProfile = publicProfileFromParts({
  accountId,
  input: {
    account_id: accountId,
    identity: {},
    reward_totals: {},
    alignment: {},
  },
  nfts: [
    {
      id: "nft_old_late_mint",
      accountId,
      title: "Old created but later minted",
      status: "minted",
      imageCid: "QmOldLateMintProfileNftSmoke",
      createdAt: "2026-05-01T12:00:00.000Z",
      mintedAt: "2026-06-15T12:00:00.000Z",
    },
    {
      id: "nft_new_created",
      accountId,
      title: "New created",
      status: "generated",
      imageCid: "QmNewCreatedProfileNftSmoke",
      createdAt: "2026-06-10T12:00:00.000Z",
      mintedAt: "2026-05-02T12:00:00.000Z",
    },
  ],
});
assert.equal(createdAtProfile.heroNft?.id, "nft_new_created");

console.log("profile public hero nft smoke ok");
