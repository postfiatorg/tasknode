import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { readFile } from "node:fs/promises";
import * as wasm from "../wasm/postfiat_wallet_wasm.js";
import { TxBuilder } from "../lib/tx-builder.js";
import { CHAIN_ID, GENESIS_HASH } from "../lib/utils.js";
import { destinationRef, matchedBalance, trackingKey, withdrawalAtoms, withdrawalIntent } from "./solana-withdrawal.js";

const bytes = Uint8Array.from({ length: 32 }, (_, i) => i < 2 ? 0 : i + 128);
const owner = bs58.encode(bytes);
const ready = { asset_id: "a".repeat(96), series_asset_id: "b".repeat(96), bucket_id: "c".repeat(96),
  issuer: "pf" + "d".repeat(40), epoch: 73, destination_prefix: "solana-spl:" + "e".repeat(64) + ":",
  reserve_packet_hash: "f".repeat(96), bucket_outstanding_atoms: "20000" };
test("Solana destination preserves every owner byte, including leading zeroes", () => {
  assert.equal(destinationRef(ready.destination_prefix, owner), ready.destination_prefix + Buffer.from(bytes).toString("hex"));
  assert.equal(destinationRef("", "1".repeat(32)), "00".repeat(32));
  for (const invalid of ["1".repeat(31), "1".repeat(33), "0", " " + owner, owner + " "]) assert.throws(() => destinationRef("", invalid));
});
test("only the current Solana series and its bucket can fund the burn", () => {
  const lines = [{ asset_id: ready.asset_id, balance: "30000000" }, { asset_id: "1".repeat(96), balance: "90000000" }];
  assert.equal(matchedBalance({ assets: lines }, ready), 0n);
  const row = { asset_id: ready.series_asset_id, balance: "20000" };
  assert.equal(matchedBalance({ assets: [...lines, row] }, ready), 20000n);
  assert.equal(matchedBalance({ assets: [{ ...row, source_bucket_id: ready.bucket_id }] }, ready), 20000n);
  assert.equal(matchedBalance({ assets: [{ ...row, frozen: true }] }, ready), 0n);
  assert.equal(matchedBalance({ assets: [{ ...row, spendable_balance: "150" }] }, ready), 150n);
  for (const result of [{ assets: [{ ...row, source_bucket_id: "old" }] }, { assets: [row, row] }, { assets: [], truncated: true },
    { assets: [{ ...row, balance: Number.MAX_SAFE_INTEGER + 1 }] }]) assert.throws(() => matchedBalance(result, ready));
});
test("burn limits enforce six decimals, exact integers, balance and reserve", () => {
  assert.equal(withdrawalAtoms("0.02", 20000n, "20000"), 20000);
  assert.equal(withdrawalAtoms("9007199254.740991", 2n ** 64n, String(2n ** 64n)), Number.MAX_SAFE_INTEGER);
  for (const [amount, held, reserve] of [["0", 1, "1"], ["0.0000001", 1, "1"], ["0.000002", 1, "2"],
    ["0.000002", 2, "1"], ["9007199254.740992", 2n ** 64n, String(2n ** 64n)]]) assert.throws(() => withdrawalAtoms(amount, BigInt(held), reserve));
  const client = { address: "pf" + "1".repeat(40), chainId: "test", accountId: "fixture" };
  assert.deepEqual(withdrawalIntent(client, { held: 20000n, ready }, "0.02", owner), { kind: "asset", operation: {
    operation: "vault_bridge_burn_to_redeem", owner: client.address, issuer: ready.issuer, asset_id: ready.asset_id,
    bucket_id: ready.bucket_id, amount_atoms: 20000, epoch: 73, reserve_packet_hash: ready.reserve_packet_hash,
    destination_ref: ready.destination_prefix + Buffer.from(bytes).toString("hex") } });
  for (const field of ["address", "chainId", "accountId"]) assert.notEqual(trackingKey(client), trackingKey({ ...client, [field]: "different" }));
});

test("the bundled L1 signer preserves the reviewed Solana burn and submits it once to a stub", async () => {
  wasm.initSync({ module: await readFile(new URL("../wasm/postfiat_wallet_wasm_bg.wasm", import.meta.url)) });
  const wallet = wasm.wallet_keygen(CHAIN_ID, wasm.random_master_seed(), 0);
  const intent = withdrawalIntent(wallet, { held: 20000n, ready }, "0.02", owner);
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
