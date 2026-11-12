// Real browser WASM and review guard. Synthetic quote transport; never submits.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, appType: 'custom', plugins: [{ name: 'offer-signing-page', configureServer(vite) { vite.middlewares.use('/signing', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local signing qualification</title>'); }); } }] });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/signing`);
  const result = await page.evaluate(async () => {
    const { initWasm } = await import('/src/features/wallet/l1/lib/wasm-loader.js');
    const { TxBuilder, reviewedSignedOperation } = await import('/src/features/wallet/l1/lib/tx-builder.js');
    const { CHAIN_ID, GENESIS_HASH } = await import('/src/features/wallet/l1/lib/utils.js');
    const wasm = await initWasm(), wallet = wasm.wallet_keygen(CHAIN_ID, wasm.random_master_seed(), 0);
    const base = { operation: 'offer_create', owner: wallet.address, taker_gets_asset_id: 'a'.repeat(96), taker_gets_amount: 1000000, taker_pays_asset_id: 'b'.repeat(96), taker_pays_amount: 1000000 };
    const operations = [base, { ...base, expiration_height: 0 }, { ...base, expiration_height: 12345 }, { operation: 'offer_cancel', owner: wallet.address, offer_id: 'c'.repeat(96) }];
    const checks = [];
    for (const operation of operations) {
      const builder = new TxBuilder({ call: async method => {
        if (method !== 'offer_fee_quote') throw new Error('Signing test forbids submit');
        return { ok: true, result: { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH, protocol_version: 1, source: wallet.address, operation, minimum_fee: 33, sequence: 1, sender_meets_reserve_after_fee: true } };
      } });
      const intent = { kind: 'offer', operation }, quote = await builder.quote(intent, wallet.address);
      // Observe the original returned object without changing any signed field.
      let signed;
      const observer = { wallet_sign_offer_transaction_fields: (...args) => { signed = wasm.wallet_sign_offer_transaction_fields(...args); return signed; } };
      builder.sign(intent, quote, wallet.address, wallet.backup_json, observer);
      const reviewed = reviewedSignedOperation(signed, operation);
      if (JSON.stringify(reviewed) !== JSON.stringify(operation) || !signed.signature_hex || !signed.public_key_hex) throw new Error('Real signature dropped reviewed fields');
      if (!Object.hasOwn(operation, 'expiration_height') && Object.hasOwn(signed.unsigned, 'expiration_height')) throw new Error('Absent expiration was added');
      checks.push({ operation: operation.operation, expiration: operation.expiration_height ?? 'absent', reviewedFieldsPreserved: true, signed: true });
    }
    return { checks, signerShim: false, submissions: 0 };
  });
  assert.equal(result.checks.length, 4);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); await server.close(); }
