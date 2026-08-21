import assert from "node:assert/strict";
import {
  decodeHexToUtf8,
  imageGatewayUrlForCid,
  ipfsCidFromUri,
  normalizeAccountNftRecord,
} from "../server/pftl-nfts.js";

const metadataUri = "ipfs://bafkreiew5ibtmvyrq3gjpxqsfeae6nvjkdfk3zguihtsa44am5nsyvob5y";
const uriHex = Buffer.from(metadataUri, "utf8").toString("hex").toUpperCase();

assert.equal(decodeHexToUtf8(uriHex), metadataUri);
assert.equal(ipfsCidFromUri(metadataUri), "bafkreiew5ibtmvyrq3gjpxqsfeae6nvjkdfk3zguihtsa44am5nsyvob5y");
assert.equal(
  ipfsCidFromUri("https://dweb.link/ipfs/bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbq"),
  "bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbq"
);
assert.equal(
  imageGatewayUrlForCid("bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbq"),
  "https://dweb.link/ipfs/bafybeiguzrsynnzxpsm7k2oacvhfqbn6z42ysq3cr43ptwznfwivieshbq"
);

const normalized = normalizeAccountNftRecord({
  NFTokenID: "00090000FA2BB13BA1C9DA4F153670D4F67DD7871F2F5DD1F39FFABC00000021",
  URI: uriHex,
  NFTokenTaxon: 0,
  Flags: 9,
});

assert.equal(normalized.metadataUri, metadataUri);
assert.equal(normalized.metadataCid, "bafkreiew5ibtmvyrq3gjpxqsfeae6nvjkdfk3zguihtsa44am5nsyvob5y");
assert.equal(normalized.nftTokenId, "00090000FA2BB13BA1C9DA4F153670D4F67DD7871F2F5DD1F39FFABC00000021");

console.log("wallet-nft-inventory-smoke ok");
