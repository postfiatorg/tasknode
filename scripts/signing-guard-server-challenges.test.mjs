import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

// The real server challenge builders run on their database path; each test stubs pg.
const storeDir = await mkdtemp(path.join(os.tmpdir(), "tasknode-signing-guard-flows-"));
process.env.TASKNODE_STORE_PATH = path.join(storeDir, "runtime-store.json");
process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/fixture";
process.env.TASKNODE_DATABASE_ENABLED = "true";
process.env.TASKNODE_DATABASE_DISABLED = "false";
process.env.TASKNODE_POSTGRES_DISABLED = "false";

const { closePool } = await import("../server/db/pool.js");
const { consumeCollaborationProof, createCollaborationChallenge } = await import("../server/repositories/collaboration-proofs.js");
const { walletCreateStart, walletLinkStart, walletRelinkStart } = await import("../server/product-wallet-contracts.js");
const { passwordEnableStart } = await import("../server/account-password-auth.js");
const { authWalletStart } = await import("../server/auth-wallet-login.js");
const { verifyWalletSignature } = await import("../server/wallet-proof.js");
const { signedCollaborationProof } = await import("../src/features/collaboration/collaboration-client.js");
const {
  PASSWORD_ENABLE_PROOF_PURPOSES,
  WALLET_LINK_PROOF_PURPOSES,
  deriveWalletSummary,
  generateTaskNodeMnemonic,
  signWalletChallenge,
} = await import("../src/wallet-core.js");

after(async () => {
  await closePool();
  await rm(storeDir, { recursive: true, force: true });
});

const ACCOUNT_ID = "acct_signing_flow";
const serverDir = fileURLToPath(new URL("../server/", import.meta.url));

// Every purpose the server writes into a "Post Fiat Task Node wallet proof" challenge.
function serverWalletProofPurposes() {
  const purposes = new Set();
  for (const name of readdirSync(serverDir, { recursive: true })) {
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(path.join(serverDir, name), "utf8");
    const calls = source.match(/(?<!function )\bcreateWalletChallenge\(/g) || [];
    const named = [...source.matchAll(/(?<!function )\bcreateWalletChallenge\(\{[^}]*?\bpurpose: "([a-z_]+)"/g)];
    assert.equal(named.length, calls.length, `${name}: every createWalletChallenge call must name its purpose as a string literal`);
    for (const [, purpose] of named) purposes.add(purpose);
  }
  return [...purposes].sort();
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function linkedWalletRow(wallet) {
  return { account_id: ACCOUNT_ID, wallet_address: wallet.address, status: "linked", public_key: wallet.publicKey, proof_json: {} };
}

test("a browser collaboration proof signs the real server challenge and the server accepts it", async (t) => {
  const mnemonic = generateTaskNodeMnemonic();
  const wallet = deriveWalletSummary(mnemonic);
  const challenges = new Map();
  t.mock.method(pg.Pool.prototype, "query", async (sql, params) => {
    if (sql.includes("FROM account_linked_wallets")) return { rows: [linkedWalletRow(wallet)] };
    if (sql.includes("INSERT INTO collaboration_wallet_challenges")) {
      const [challengeId, accountId, walletAddress, action, resourceId, payloadDigest, message, expiresAt] = params;
      challenges.set(challengeId, {
        challenge_id: challengeId,
        account_id: accountId,
        wallet_address: walletAddress,
        action,
        resource_id: resourceId,
        payload_digest: payloadDigest,
        message,
        expires_at: expiresAt.toISOString(),
        consumed_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  const action = "docs_share";
  const resourceId = "doc_ünïcode_1";
  const payload = {
    zeta: { omega: [3, { b: "Žena čita — 你好 🙂", a: null }], alpha: true },
    title: "Plan für Q4 ✓",
    access: { role: "editor", expiresAt: undefined },
  };
  // The digest the server has always committed to for this request; it must not change.
  const serverCanonicalJson = '{"action":"docs_share","payload":{"access":{"role":"editor"},"title":"Plan für Q4 ✓","zeta":{"alpha":true,"omega":[3,{"a":null,"b":"Žena čita — 你好 🙂"}]}},"resourceId":"doc_ünïcode_1"}';

  const proof = await signedCollaborationProof({
    action,
    resourceId,
    payload,
    walletSecret: { mnemonic, accountId: ACCOUNT_ID },
    requestImpl: async (pathname, options) => {
      assert.equal(pathname, "/api/collaboration/challenge");
      const body = JSON.parse(options.body);
      const result = await createCollaborationChallenge({
        accountId: ACCOUNT_ID,
        action: body.action,
        resourceId: body.resourceId,
        payload: body.payload,
      });
      return { ok: result.ok !== false, body: result };
    },
  });

  const issued = challenges.get(proof.challengeId);
  assert.equal(issued.payload_digest, sha256Hex(serverCanonicalJson));

  const client = {
    query: async (sql, params) => {
      if (sql.includes("FROM collaboration_wallet_challenges")) return { rows: [challenges.get(params[0])].filter(Boolean) };
      if (sql.includes("UPDATE collaboration_wallet_challenges")) {
        challenges.get(params[0]).consumed_at = new Date().toISOString();
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const consumed = await consumeCollaborationProof({
    client,
    accountId: ACCOUNT_ID,
    action,
    resourceId,
    payload: JSON.parse(JSON.stringify(payload)),
    proof,
  });
  assert.equal(consumed.walletAddress, wallet.address);
  assert.ok(challenges.get(proof.challengeId).consumed_at);
});

test("every wallet challenge the server issues passes the guard at the browser call site that signs it", async (t) => {
  const mnemonic = generateTaskNodeMnemonic();
  const wallet = deriveWalletSummary(mnemonic);
  const session = { accountId: ACCOUNT_ID };
  const transactionClient = { query: async () => ({ rows: [], rowCount: 1 }), on() {}, off() {}, release() {} };
  t.mock.method(pg.Pool.prototype, "connect", async () => transactionClient);
  t.mock.method(pg.Pool.prototype, "query", async (sql) => {
    if (sql.includes("FROM account_linked_wallets")) return { rows: [linkedWalletRow(wallet)] };
    if (sql.includes("FROM account_password_credentials")) return { rows: [] };
    if (sql.includes("INSERT INTO auth_challenges")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${sql}`);
  });

  // The signing options of WalletLinkModal (WalletComponents.jsx) and PasswordSecurity (AppDialogs.jsx).
  const walletDialogOptions = (challenge) => ({
    purpose: "wallet_proof",
    allowedSubPurposes: WALLET_LINK_PROOF_PURPOSES,
    expectedAccountId: challenge.accountId,
  });
  const passwordDialogOptions = () => ({
    purpose: "wallet_proof",
    allowedSubPurposes: PASSWORD_ENABLE_PROOF_PURPOSES,
    expectedAccountId: session.accountId,
  });
  const flows = [
    { purpose: "wallet_link", start: () => walletLinkStart("POST", session), signOptions: walletDialogOptions },
    { purpose: "wallet_create", start: () => walletCreateStart("POST", session), signOptions: walletDialogOptions },
    { purpose: "wallet_relink", start: () => walletRelinkStart("POST", session), signOptions: walletDialogOptions },
    { purpose: "password_enable", start: () => passwordEnableStart({}, session), signOptions: passwordDialogOptions },
  ];
  assert.deepEqual(flows.map((flow) => flow.purpose).sort(), serverWalletProofPurposes());

  for (const flow of flows) {
    const started = await flow.start();
    assert.equal(started.status, 200, flow.purpose);
    const { challenge } = started.body;
    assert.ok(challenge.message.startsWith(`Post Fiat Task Node wallet proof\nPurpose: ${flow.purpose}\n`), flow.purpose);
    const proof = signWalletChallenge(mnemonic, challenge.message, flow.signOptions(challenge));
    assert.ok(verifyWalletSignature({ message: challenge.message, signature: proof.signature, publicKey: proof.publicKey, address: wallet.address }), flow.purpose);
  }

  // No browser screen signs wallet login on main; agents do, and the guard's wallet_login purpose must accept it.
  const login = await authWalletStart({ address: wallet.address, publicKey: wallet.publicKey });
  assert.equal(login.status, 200);
  const loginMessage = login.body.challenge.message;
  assert.ok(loginMessage.startsWith("Post Fiat Task Node wallet login\nPurpose: wallet_login\n"));
  const loginProof = signWalletChallenge(mnemonic, loginMessage, { purpose: "wallet_login" });
  assert.ok(verifyWalletSignature({ message: loginMessage, signature: loginProof.signature, publicKey: loginProof.publicKey, address: wallet.address }));
});
