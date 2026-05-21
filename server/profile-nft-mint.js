import { pinContextIpfsJson } from "./context-ipfs.js";
import {
  pftUriToHex,
  preparePftNftMintTransaction,
  submitSignedPftNftMintTransaction,
} from "./pftl-submit.js";
import {
  getProfileNft,
  markProfileNftFailed,
  markProfileNftMinted,
  markProfileNftMintPrepared,
} from "./repositories/profile-nfts.js";

const defaultTitle = "Task Node Profile NFT";

function safeText(value = "", max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function linkedWalletAddressFromState(state = {}) {
  return safeText(state?.wallet?.pftWallet?.address || state?.session?.walletLink?.address || "", 120);
}

function metadataForNft(nft = {}) {
  return {
    schema: "erc721",
    name: nft.title || defaultTitle,
    description:
      nft.description ||
      "Task Node profile NFT generated from private account context. Prompt text is intentionally not published.",
    image: `ipfs://${nft.imageCid}`,
    attributes: [
      { trait_type: "Source", value: "Task Node Official" },
      { trait_type: "Model", value: nft.model || "gpt-image-2" },
      { trait_type: "Prompt digest", value: nft.promptDigest || "unavailable" },
      { trait_type: "Template digest", value: nft.templateDigest || "unavailable" },
    ],
  };
}

function validateSessionAndWallet({ session = null, state = null, nft = null } = {}) {
  if (!session?.accountId) {
    const error = new Error("profile_nft_login_required");
    error.status = 401;
    throw error;
  }
  const walletAddress = linkedWalletAddressFromState(state);
  if (!walletAddress) {
    const error = new Error("profile_nft_wallet_required");
    error.status = 400;
    throw error;
  }
  if (nft?.walletAddress && nft.walletAddress !== walletAddress) {
    const error = new Error("profile_nft_wallet_mismatch");
    error.status = 400;
    throw error;
  }
  return walletAddress;
}

async function prepareProfileNftMint({ nft, session, state, env }) {
  const walletAddress = validateSessionAndWallet({ session, state, nft });
  if (!nft?.imageCid) {
    const error = new Error("profile_nft_image_missing");
    error.status = 400;
    throw error;
  }

  const metadataJson = metadataForNft(nft);
  const metadataPin = await pinContextIpfsJson({
    payload: metadataJson,
    name: `profile_nft_metadata_${nft.id}`,
    keyvalues: {
      type: "profile_nft_metadata",
      accountId: session.accountId,
      nftId: nft.id,
    },
    env,
  });
  const metadataUri = `ipfs://${metadataPin.cid}`;
  const uriHex = pftUriToHex(metadataUri);
  const prepared = await preparePftNftMintTransaction({
    account: walletAddress,
    uriHex,
    flags: 9,
    taxon: 0,
    transferFee: 0,
    env,
  });
  const updated = await markProfileNftMintPrepared({
    accountId: session.accountId,
    nftId: nft.id,
    metadataCid: metadataPin.cid,
    metadataUri,
    metadataJson,
    mintTxJson: prepared.txJson,
  });

  return {
    ok: true,
    phase: "prepared",
    nft: updated,
    txJson: prepared.txJson,
    metadataCid: metadataPin.cid,
    metadataUri,
    uriHex,
    networkId: prepared.networkId,
  };
}

async function submitProfileNftMint({ nft, payload, session, state, env }) {
  const walletAddress = validateSessionAndWallet({ session, state, nft });
  const signedTxBlob = safeText(payload?.signedTxBlob, 100000);
  if (!signedTxBlob) {
    const error = new Error("profile_nft_signed_transaction_required");
    error.status = 400;
    throw error;
  }
  if (!nft?.mintTxJson?.URI) {
    const error = new Error("profile_nft_mint_not_prepared");
    error.status = 400;
    throw error;
  }

  const submitted = await submitSignedPftNftMintTransaction({
    signedTxBlob,
    expectedAccount: walletAddress,
    expectedUriHex: nft.mintTxJson.URI,
    env,
  });
  const updated = await markProfileNftMinted({
    accountId: session.accountId,
    nftId: nft.id,
    txHash: submitted.txHash || "",
    nftTokenId: submitted.nftTokenId || "",
  });

  return {
    ok: true,
    phase: "minted",
    nft: updated,
    txHash: submitted.txHash,
    nftTokenId: submitted.nftTokenId,
    ledgerIndex: submitted.ledgerIndex,
    networkId: submitted.networkId,
  };
}

export async function profileNftMintStart({
  method,
  payload = {},
  session = null,
  state = null,
  env = process.env,
} = {}) {
  if (method !== "POST") {
    return {
      status: 405,
      body: {
        ok: false,
        error: "profile_nft_method_not_allowed",
        message: "Profile NFT minting requires POST.",
      },
    };
  }

  if (!session?.accountId) {
    return {
      status: 401,
      body: {
        ok: false,
        error: "profile_nft_login_required",
        message: "Sign in before minting a profile NFT.",
      },
    };
  }

  const phase = safeText(payload?.phase || "prepare", 40);
  const nftId = safeText(payload?.nftId, 120);
  const nft = await getProfileNft({ accountId: session.accountId, nftId });
  if (!nft) {
    return {
      status: 404,
      body: {
        ok: false,
        error: "profile_nft_not_found",
        message: "Profile NFT record was not found.",
      },
    };
  }

  try {
    const body =
      phase === "submit"
        ? await submitProfileNftMint({ nft, payload, session, state, env })
        : await prepareProfileNftMint({ nft, session, state, env });
    return { status: 200, body };
  } catch (error) {
    await markProfileNftFailed({
      accountId: session.accountId,
      nftId,
      error: error?.message || "profile_nft_mint_failed",
    });
    return {
      status: error?.status || 500,
      body: {
        ok: false,
        error: error?.message || "profile_nft_mint_failed",
        message: error?.message || "Profile NFT minting failed.",
      },
    };
  }
}
