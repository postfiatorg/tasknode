import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { readFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { getProgramDerivedAddress } from "@solana/addresses";
import * as wasm from "../wasm/postfiat_wallet_wasm.js";
import { TxBuilder } from "../lib/tx-builder.js";
import { CHAIN_ID, GENESIS_HASH } from "../lib/utils.js";
import { checkRecipient, destinationRef, matchedBalance, phantomRecipient, submitBurn, trackingKey, walletBurns, withdrawalAtoms, withdrawalIntent } from "./solana-withdrawal.js";
import { recipientKind } from "./solana-recipient.js";

// A real Ed25519 wallet key, with leading zero bytes so base58 keeps its leading "1"s.
function walletKey(leadingZero) {
  for (;;) {
    const raw = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x, "base64url");
    if (!leadingZero || raw[0] === 0) return Uint8Array.from(raw);
  }
}
const bytes = walletKey(true);
const owner = bs58.encode(bytes);
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const ata = async wallet => (await getProgramDerivedAddress({ programAddress: ATA,
  seeds: [bs58.decode(wallet), bs58.decode(TOKEN), bs58.decode("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")] }))[0];
function stubFetch(t, reply) {
  const seen = [], original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { seen.push(url); return reply(url, options); };
  t.after(() => { globalThis.fetch = original; });
  return seen;
}
const answer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ready = { asset_id: "a".repeat(96), series_asset_id: "b".repeat(96), bucket_id: "c".repeat(96),
  issuer: "pf" + "d".repeat(40), epoch: 73, destination_prefix: "solana-spl:" + "e".repeat(64) + ":",
  reserve_packet_hash: "f".repeat(96), bucket_outstanding_atoms: "20000" };
test("Solana destination preserves every owner byte, including leading zeroes", () => {
  assert.equal(destinationRef(ready.destination_prefix, owner), ready.destination_prefix + Buffer.from(bytes).toString("hex"));
  assert.equal(destinationRef("", "1".repeat(32)), "00".repeat(32));
  for (const invalid of ["1".repeat(31), "1".repeat(33), "0", " " + owner, owner + " "]) assert.throws(() => destinationRef("", invalid));
});
test("a program-derived address, including every associated token account, is refused before any lookup", async () => {
  const account = await ata(owner);
  assert.throws(() => destinationRef("", account), /program-derived address.*Enter your Solana wallet address/);
  assert.throws(() => destinationRef("", bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i < 2 ? 0 : i + 128))), /program-derived/);
  for (let i = 0; i < 20; i++) assert.equal(destinationRef("", bs58.encode(walletKey())).length, 64);
});
test("the relay lookup decides before a burn is built, and a failed lookup refuses", async t => {
  const replies = [answer(200, { ok: true, recipient: owner, allowed: true, kind: "wallet" }),
    answer(200, { ok: true, recipient: owner, allowed: false, kind: "token_account" }),
    answer(200, { ok: true, recipient: owner, allowed: false, kind: "stake_account" }),
    answer(200, { ok: true, recipient: owner, allowed: false, kind: "program" }),
    answer(503, { ok: false, code: "solana_recipient_unchecked", message: "down" }),
    answer(200, { ok: true, recipient: "1".repeat(32), allowed: true, kind: "wallet" }),
    answer(200, { ok: true, recipient: owner }),
    "throw"];
  const seen = stubFetch(t, () => { const next = replies.shift(); if (next === "throw") throw TypeError("offline"); return next; });
  assert.equal(await checkRecipient(owner), owner);
  await assert.rejects(checkRecipient(owner), /This address is a token account, not a wallet\. Enter your Solana wallet address/);
  await assert.rejects(checkRecipient(owner), /stake account, not a wallet/);
  await assert.rejects(checkRecipient(owner), /Solana program, not a wallet/);
  for (let i = 0; i < 4; i++) await assert.rejects(checkRecipient(owner), /could not be checked.*No burn was built/);
  assert.deepEqual(seen, Array(8).fill("/api/l1/bridge/solana/withdrawals/recipient/" + owner));
  await assert.rejects(checkRecipient(await ata(owner)), /program-derived/);
  assert.equal(seen.length, 8);
});
test("a Phantom-supplied address passes the same checks", async t => {
  const replies = [answer(200, { ok: true, recipient: owner, allowed: true, kind: "wallet" }),
    answer(200, { ok: true, recipient: owner, allowed: false, kind: "token_account" })];
  stubFetch(t, () => replies.shift());
  const phantom = key => ({ publicKey: null, connect: async () => ({ publicKey: { toString: () => key } }) });
  assert.equal(await phantomRecipient(phantom(owner)), owner);
  await assert.rejects(phantomRecipient(phantom(owner)), /token account/);
  await assert.rejects(phantomRecipient(phantom(await ata(owner))), /program-derived/);
  assert.equal(replies.length, 0);
});
test("only a missing account or a System-owned non-program account is a wallet", () => {
  assert.equal(recipientKind(null), "wallet");
  assert.equal(recipientKind({ owner: "11111111111111111111111111111111", executable: false }), "wallet");
  assert.equal(recipientKind({ owner: "11111111111111111111111111111111", executable: true }), "program");
  assert.equal(recipientKind({ owner: TOKEN, executable: false }), "token_account");
  assert.equal(recipientKind({ owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", executable: false }), "token_account");
  assert.equal(recipientKind({ owner: "Stake11111111111111111111111111111111111111", executable: false }), "stake_account");
  assert.equal(recipientKind({ owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true }), "program");
  assert.equal(recipientKind({ owner: "Vote111111111111111111111111111111111111111", executable: false }), "program_owned");
  assert.equal(recipientKind({ executable: false }), "program_owned");
});
const series = { issuer: ready.issuer, asset_id: ready.asset_id, bucket_id: ready.bucket_id };
test("the burn's series, bucket and issuer come from the wallet's own chain row, and readiness must name that row", () => {
  const row = { asset_id: ready.series_asset_id, asset_family_id: ready.asset_id, source_series_id: "7".repeat(96),
    source_bucket_id: ready.bucket_id, issuer: ready.issuer, balance: "20000" };
  const other = { asset_id: ready.asset_id, issuer: ready.issuer, balance: "30000000" };
  assert.deepEqual(matchedBalance({ assets: [other, row] }, ready), { held: 20000n, ...series });
  assert.deepEqual(matchedBalance({ assets: [{ ...row, frozen: true }] }, ready), { held: 0n, ...series });
  assert.equal(matchedBalance({ assets: [{ ...row, spendable_balance: "150" }] }, ready).held, 150n);
  for (const result of [{ assets: [other] }, { assets: [] }]) assert.throws(() => matchedBalance(result, ready), /does not hold/);
  for (const changed of [{ issuer: "pf" + "9".repeat(40) }, { asset_family_id: "8".repeat(96) }, { source_bucket_id: "old" },
    { source_bucket_id: undefined }, { source_series_id: undefined }]) {
    assert.throws(() => matchedBalance({ assets: [{ ...row, ...changed }] }, ready), /different Solana series/);
  }
  for (const result of [{ assets: [row, row] }, { assets: [], truncated: true }, { assets: [{ ...row, balance: Number.MAX_SAFE_INTEGER + 1 }] }]) {
    assert.throws(() => matchedBalance(result, ready));
  }
});
test("burn limits enforce six decimals, exact integers, balance and reserve", () => {
  assert.equal(withdrawalAtoms("0.02", 20000n, "20000"), 20000);
  assert.equal(withdrawalAtoms("9007199254.740991", 2n ** 64n, String(2n ** 64n)), Number.MAX_SAFE_INTEGER);
  for (const [amount, held, reserve] of [["0", 1, "1"], ["0.0000001", 1, "1"], ["0.000002", 1, "2"],
    ["0.000002", 2, "1"], ["9007199254.740992", 2n ** 64n, String(2n ** 64n)]]) assert.throws(() => withdrawalAtoms(amount, BigInt(held), reserve));
  const client = { address: "pf" + "1".repeat(40), chainId: "test", accountId: "fixture" };
  const elsewhere = { ...ready, issuer: "pf" + "9".repeat(40), asset_id: "8".repeat(96), bucket_id: "6".repeat(96) };
  assert.deepEqual(withdrawalIntent(client, { held: 20000n, ready: elsewhere, series }, "0.02", owner), { kind: "asset", operation: {
    operation: "vault_bridge_burn_to_redeem", owner: client.address, issuer: ready.issuer, asset_id: ready.asset_id,
    bucket_id: ready.bucket_id, amount_atoms: 20000, epoch: 73, reserve_packet_hash: ready.reserve_packet_hash,
    destination_ref: ready.destination_prefix + Buffer.from(bytes).toString("hex") } });
  for (const field of ["address", "chainId", "accountId"]) assert.notEqual(trackingKey(client), trackingKey({ ...client, [field]: "different" }));
});

test("the bundled L1 signer preserves the reviewed Solana burn and submits it once to a stub", async () => {
  wasm.initSync({ module: await readFile(new URL("../wasm/postfiat_wallet_wasm_bg.wasm", import.meta.url)) });
  const wallet = wasm.wallet_keygen(CHAIN_ID, wasm.random_master_seed(), 0);
  const intent = withdrawalIntent(wallet, { held: 20000n, ready, series }, "0.02", owner);
  const txId = "12".repeat(48), calls = [];
  const builder = new TxBuilder({ call: async (method, params) => {
    calls.push(method);
    if (method === "asset_fee_quote") return { ok: true, result: { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH,
      protocol_version: 1, source: wallet.address, sequence: 1, minimum_fee: 30, sender_meets_reserve_after_fee: true,
      operation: JSON.parse(params.operation_json) } };
    const signed = JSON.parse(params.signed_asset_transaction_json);
    assert.ok(signed.signature_hex);
    assert.equal(signed.unsigned.destination_ref, ready.destination_prefix + Buffer.from(bytes).toString("hex"));
    return { ok: true, result: { tx_id: txId, receipt: { tx_id: txId, accepted: true } } };
  } });
  const quote = await builder.quote(intent, wallet.address);
  const signature = builder.sign(intent, quote, wallet.address, wallet.backup_json, wasm);
  assert.equal((await builder.submit(signature)).txId, txId);
  assert.deepEqual(calls, ["asset_fee_quote", "mempool_submit_signed_asset_transaction_finality"]);
});

test("the burn ID is saved as soon as the chain names it, even when the receipt never arrives", async t => {
  const store = new Map(), original = globalThis.localStorage;
  globalThis.localStorage = { setItem: (key, value) => store.set(key, value), getItem: key => store.get(key) ?? null };
  t.after(() => { globalThis.localStorage = original; });
  wasm.initSync({ module: await readFile(new URL("../wasm/postfiat_wallet_wasm_bg.wasm", import.meta.url)) });
  const wallet = wasm.wallet_keygen(CHAIN_ID, wasm.random_master_seed(), 0);
  const intent = withdrawalIntent(wallet, { held: 20000n, ready, series }, "0.02", owner);
  const txId = "34".repeat(48), order = [];
  const builder = new TxBuilder({ call: async (method, params) => {
    order.push(method);
    if (method === "asset_fee_quote") return { ok: true, result: { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH,
      protocol_version: 1, source: wallet.address, sequence: 1, minimum_fee: 30, sender_meets_reserve_after_fee: true,
      operation: JSON.parse(params.operation_json) } };
    if (method === "receipts") { order.push("saved:" + store.get("key")); return { ok: true, result: { receipts: [] } }; }
    return { ok: true, result: { tx_id: txId } };
  } });
  const signed = builder.sign(intent, await builder.quote(intent, wallet.address), wallet.address, wallet.backup_json, wasm);
  const client = { submit: (handle, options) => builder.submit(handle, { ...options, timeoutMs: 50, pollMs: 1 }) };
  const failure = await submitBurn(client, signed, "key").catch(error => error);
  assert.match(failure.message, /No execution receipt/);
  assert.equal(failure.txId, txId);
  assert.equal(store.get("key"), txId);
  assert.equal(order[2], "receipts");
  assert.equal(order[3], "saved:" + txId);
});
test("the wallet's own accepted burns are listed from its chain history so any of them can be tracked", async () => {
  const address = "pf" + "1".repeat(40), mine = "56".repeat(48), older = "78".repeat(48), calls = [];
  const burnRow = { tx_id: mine, transaction_kind: "vault_bridge_burn_to_redeem", from: address, accepted: true, amount: 20000, block_height: 1900 };
  const client = { address, call: async (method, params) => { calls.push([method, params]); return { ok: true, result: { rows: [
    burnRow, { ...burnRow, tx_id: "9a".repeat(48), accepted: false }, { ...burnRow, tx_id: "bc".repeat(48), from: "pf" + "2".repeat(40) },
    { ...burnRow, tx_id: "de".repeat(48), transaction_kind: "issued_payment" }, { ...burnRow, tx_id: "not-an-id" },
    { ...burnRow, tx_id: older, block_height: 1850 }] } }; } };
  assert.deepEqual(await walletBurns(client), [{ id: mine, amount: 20000, height: 1900 }, { id: older, amount: 20000, height: 1850 }]);
  assert.deepEqual(calls, [["account_tx", { address, limit: 100 }]]);
});
