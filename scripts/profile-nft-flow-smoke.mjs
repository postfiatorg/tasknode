import assert from "node:assert/strict";

process.env.TASKNODE_DATABASE_DISABLED = "true";

const {
  createGeneratedProfileNft,
  getProfileNft,
  listProfileNfts,
  markProfileNftMintPrepared,
  markProfileNftMinted,
} = await import("../server/repositories/profile-nfts.js");
const { pftUriToHex } = await import("../server/pftl-submit.js");

const accountId = "account_profile_nft_smoke";
const walletAddress = "rwdm72S9YVKkZjeADKU2bbUMuY4vPnSfH7";

const generated = await createGeneratedProfileNft({
  accountId,
  walletAddress,
  title: "Smoke Profile NFT",
  imageCid: "QmSmokeProfileNftImageCid1111111111111111111",
  imageGatewayUrl: "https://dweb.link/ipfs/QmSmokeProfileNftImageCid1111111111111111111",
  imageMimeType: "image/png",
  imageSizeBytes: 1234,
  imageSha256: "abc123",
  promptSource: "placeholder",
  promptDigest: "prompt_digest",
  templateDigest: "template_digest",
  model: "gpt-image-2",
  size: "1024x1024",
  quality: "low",
  outputFormat: "png",
});

assert.equal(generated.status, "generated");
assert.equal(generated.accountId, accountId);

const listed = await listProfileNfts({ accountId });
assert.equal(listed.length, 1);
assert.equal(listed[0].id, generated.id);

const metadataUri = "ipfs://QmSmokeProfileNftMetadataCid1111111111111111";
const uriHex = pftUriToHex(metadataUri);
assert.equal(Buffer.from(uriHex, "hex").toString("utf8"), metadataUri);

const prepared = await markProfileNftMintPrepared({
  accountId,
  nftId: generated.id,
  metadataCid: "QmSmokeProfileNftMetadataCid1111111111111111",
  metadataUri,
  metadataJson: { schema: "erc721", image: `ipfs://${generated.imageCid}` },
  mintTxJson: {
    TransactionType: "NFTokenMint",
    Account: walletAddress,
    URI: uriHex,
  },
});
assert.equal(prepared.status, "prepared");
assert.equal(prepared.mintTxJson.URI, uriHex);

const minted = await markProfileNftMinted({
  accountId,
  nftId: generated.id,
  txHash: "ABCDEF123456",
  nftTokenId: "000B013A95F14B0044F78A264E41713C64B5F89242540EE2",
});
assert.equal(minted.status, "minted");
assert.equal(minted.txHash, "ABCDEF123456");

const fetched = await getProfileNft({ accountId, nftId: generated.id });
assert.equal(fetched.nftTokenId, "000B013A95F14B0044F78A264E41713C64B5F89242540EE2");

console.log("profile-nft-flow-smoke ok");
