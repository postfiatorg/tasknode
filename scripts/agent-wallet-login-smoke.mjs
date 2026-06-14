import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as keypairs from "ripple-keypairs";
import { Wallet } from "xrpl";

const tempDir = await mkdtemp(path.join(os.tmpdir(), "tasknode-agent-wallet-login-smoke-"));
process.env.TASKNODE_STORE_PATH = path.join(tempDir, "runtime-store.json");
process.env.TASKNODE_DATABASE_DISABLED = "true";
process.env.TASKNODE_WALLET_LOGIN_CHALLENGE_CAP = "3";
delete process.env.TASKNODE_AGENT_WALLET_ALLOWLIST;

const { authWalletStart, authWalletVerify } = await import("../server/auth-wallet-login.js");
const {
  createWalletLoginChallenge,
  findAccountByLinkedWallet,
  getLinkedWallet,
  getSession,
} = await import("../server/runtime-store.js");
const { messageToHex } = await import("../server/wallet-proof.js");

function walletAddress(wallet) {
  return wallet.classicAddress || wallet.address;
}

function walletProof(wallet, message) {
  const keypair = keypairs.deriveKeypair(wallet.seed);
  return {
    address: walletAddress(wallet),
    publicKey: keypair.publicKey,
    signature: keypairs.sign(messageToHex(message), keypair.privateKey),
  };
}

function badSignatureFor(wallet, message) {
  const keypair = keypairs.deriveKeypair(wallet.seed);
  return keypairs.sign(messageToHex(`${message}\nwrong-purpose`), keypair.privateKey);
}

async function verifyChallenge(wallet, challenge, overrides = {}) {
  const proof = walletProof(wallet, challenge.message);
  return authWalletVerify({
    challengeId: challenge.id,
    address: proof.address,
    publicKey: proof.publicKey,
    signature: proof.signature,
    ...overrides,
  }, "POST");
}

try {
  const invalidVerify = await authWalletVerify({
    challengeId: "missing",
    address: "not-a-wallet",
    publicKey: "",
    signature: "",
  }, "POST");
  assert.equal(invalidVerify.status, 400);
  assert.equal(invalidVerify.body.error, "wallet_address_invalid");

  const wallet = Wallet.generate();
  const address = walletAddress(wallet);
  const start = authWalletStart({ address }, "POST");
  assert.equal(start.status, 200);
  assert.equal(start.body.ok, true);
  assert.equal(start.body.verifyPath, "/api/auth/wallet/verify");
  assert.match(start.body.challenge.message, /Post Fiat Task Node wallet login/);
  assert.match(start.body.challenge.message, /Purpose: wallet_login/);
  assert.match(start.body.challenge.message, new RegExp(`Address: ${address}`));
  assert.doesNotMatch(start.body.challenge.message, /Post Fiat Task Node wallet proof/);

  const firstVerify = await verifyChallenge(wallet, start.body.challenge);
  assert.equal(firstVerify.status, 200);
  assert.equal(firstVerify.body.ok, true);
  assert.equal(firstVerify.body.address, address);
  assert.equal(firstVerify.body.session.status, "signed_in");
  assert.equal(firstVerify.body.session.primaryProvider, "wallet");
  assert.equal(firstVerify.body.session.assurance, "high");
  assert.equal(getSession(firstVerify.sessionId).accountId, firstVerify.body.accountId);
  assert.equal(getLinkedWallet({ accountId: firstVerify.body.accountId }).address, address);
  assert.equal(findAccountByLinkedWallet({ address }).accountId, firstVerify.body.accountId);

  const replay = await verifyChallenge(wallet, start.body.challenge);
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_or_expired_challenge");

  const expiredWallet = Wallet.generate();
  const expiredAddress = walletAddress(expiredWallet);
  const expiredChallenge = createWalletLoginChallenge({
    address: expiredAddress,
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  }).challenge;
  const expired = await verifyChallenge(expiredWallet, expiredChallenge);
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error, "invalid_or_expired_challenge");

  const wrongSigWallet = Wallet.generate();
  const wrongSigAddress = walletAddress(wrongSigWallet);
  const wrongSigStart = authWalletStart({ address: wrongSigAddress }, "POST");
  const wrongSigProof = walletProof(wrongSigWallet, wrongSigStart.body.challenge.message);
  const wrongSig = await authWalletVerify({
    challengeId: wrongSigStart.body.challenge.id,
    address: wrongSigProof.address,
    publicKey: wrongSigProof.publicKey,
    signature: badSignatureFor(wrongSigWallet, wrongSigStart.body.challenge.message),
  }, "POST");
  assert.equal(wrongSig.status, 401);
  assert.equal(wrongSig.body.error, "wallet_signature_invalid");
  const wrongSigReplay = await verifyChallenge(wrongSigWallet, wrongSigStart.body.challenge);
  assert.equal(wrongSigReplay.status, 400);
  assert.equal(wrongSigReplay.body.error, "invalid_or_expired_challenge");

  const startDeniedWallet = Wallet.generate();
  const startDeniedAddress = walletAddress(startDeniedWallet);
  process.env.TASKNODE_AGENT_WALLET_ALLOWLIST = walletAddress(Wallet.generate());
  const startDenied = authWalletStart({ address: startDeniedAddress }, "POST");
  assert.equal(startDenied.status, 403);
  assert.equal(startDenied.body.error, "wallet_login_not_allowed");
  process.env.TASKNODE_AGENT_WALLET_ALLOWLIST = startDeniedAddress;
  const startAllowed = authWalletStart({ address: startDeniedAddress }, "POST");
  assert.equal(startAllowed.status, 200);
  const startAllowedVerify = await verifyChallenge(startDeniedWallet, startAllowed.body.challenge);
  assert.equal(startAllowedVerify.status, 200);
  delete process.env.TASKNODE_AGENT_WALLET_ALLOWLIST;

  const mismatchWallet = Wallet.generate();
  const mismatchSigner = Wallet.generate();
  const mismatchStart = authWalletStart({ address: walletAddress(mismatchWallet) }, "POST");
  const mismatchProof = walletProof(mismatchSigner, mismatchStart.body.challenge.message);
  const mismatch = await authWalletVerify({
    challengeId: mismatchStart.body.challenge.id,
    address: walletAddress(mismatchWallet),
    publicKey: mismatchProof.publicKey,
    signature: mismatchProof.signature,
  }, "POST");
  assert.equal(mismatch.status, 401);
  assert.equal(mismatch.body.error, "wallet_signature_invalid");

  const deniedWallet = Wallet.generate();
  const deniedAddress = walletAddress(deniedWallet);
  const deniedStart = authWalletStart({ address: deniedAddress }, "POST");
  process.env.TASKNODE_AGENT_WALLET_ALLOWLIST = walletAddress(Wallet.generate());
  const denied = await verifyChallenge(deniedWallet, deniedStart.body.challenge);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, "wallet_login_not_allowed");
  process.env.TASKNODE_AGENT_WALLET_ALLOWLIST = deniedAddress;
  const allowedAfterDeny = await verifyChallenge(deniedWallet, deniedStart.body.challenge);
  assert.equal(allowedAfterDeny.status, 200);
  assert.equal(allowedAfterDeny.body.address, deniedAddress);
  delete process.env.TASKNODE_AGENT_WALLET_ALLOWLIST;

  const secondStart = authWalletStart({ address }, "POST");
  const secondVerify = await verifyChallenge(wallet, secondStart.body.challenge);
  assert.equal(secondVerify.status, 200);
  assert.equal(secondVerify.body.accountId, firstVerify.body.accountId);

  const newWallet = Wallet.generate();
  const newStart = authWalletStart({ address: walletAddress(newWallet) }, "POST");
  const newVerify = await verifyChallenge(newWallet, newStart.body.challenge);
  assert.equal(newVerify.status, 200);
  assert.notEqual(newVerify.body.accountId, firstVerify.body.accountId);
  assert.equal(getLinkedWallet({ accountId: newVerify.body.accountId }).address, walletAddress(newWallet));

  const capWallets = [Wallet.generate(), Wallet.generate(), Wallet.generate(), Wallet.generate()];
  const capStarts = capWallets.map((capWallet) => authWalletStart({ address: walletAddress(capWallet) }, "POST"));
  for (const capStart of capStarts) assert.equal(capStart.status, 200);
  const evictedOldest = await verifyChallenge(capWallets[0], capStarts[0].body.challenge);
  assert.equal(evictedOldest.status, 400);
  assert.equal(evictedOldest.body.error, "invalid_or_expired_challenge");
  const retainedNewest = await verifyChallenge(capWallets[3], capStarts[3].body.challenge);
  assert.equal(retainedNewest.status, 200);

  console.log("agent wallet login smoke ok");
} finally {
  delete process.env.TASKNODE_AGENT_WALLET_ALLOWLIST;
  delete process.env.TASKNODE_WALLET_LOGIN_CHALLENGE_CAP;
  await rm(tempDir, { recursive: true, force: true });
}
