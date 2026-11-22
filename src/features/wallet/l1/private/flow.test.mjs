import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingDigest, shieldAuthorization } from './shield.js';
import { receiptFor } from '../../../../../scripts/private-wallet/receipt-fixture.mjs';
import { finalizedAcceptance, refusalMessage } from '../../../../../shared/private-payment.js';
import vectors from '../../../../../scripts/private-wallet/funding-vectors.json' with { type: 'json' };
import { advance, makeJob, walletAssets } from './flow.js';

const id = 'b'.repeat(96), address = 'pf' + '1'.repeat(40), recipient = 'pfs1' + '2'.repeat(158);
const assets = walletAssets([{ asset_id: id, issuer: address, precision: 3, code: 'TEST', balance: 15000 }], {
  balances: { [id]: 9500, ['f'.repeat(96)]: 3 }, available: { [id]: 1200 },
});
test('amounts use asset precision, available notes and integer atoms for unknown assets', () => {
  assert.equal(assets[0].reserved, '8300'); assert.equal(assets[1].precision, 0);
  for (const invalid of ['1.201','0','1.0001','1e2','-1']) assert.throws(() => makeJob('pay', assets[0], invalid, recipient, address));
  assert.equal(makeJob('pay', assets[0], '1.2', recipient, address).terms.amount, 1200);
  assert.throws(() => makeJob('pay', assets[0], '1', address, address));
  const largeAsset = { ...assets[0], precision: 0, available: '18446744073709551615' };
  assert.equal(makeJob('pay', largeAsset, largeAsset.available, recipient, address).terms.amount, largeAsset.available);
  assert.throws(() => makeJob('pay', largeAsset, '18446744073709551616', recipient, address));
  assert.throws(() => makeJob('exit', assets[0], '1', recipient, address));
});
test('an interrupted payment resumes the identical request and continues only after merge acceptance', async () => {
  let record = makeJob('pay', assets[0], '1', recipient, address);
  const original = record.terms.request_id, attempts = [], states = [], merge = 'a'.repeat(96);
  const options = { signal: new AbortController().signal, progress: s => states.push(s), save: async j => { record = j; }, pause: async () => {} };
  const wallet = { async request(path, body) {
    attempts.push([path, body.request_id]);
    if (attempts.length === 1) throw Error('lost acknowledgement');
    if (path === 'receipt') return receiptFor(body.intent_id);
    return body.request_id === original ? { intent_id: merge, operation: 'merge', state: 'queued', owner_tag: 'a' } :
      { intent_id: id, operation: 'pay', state: 'accepted' };
  } };
  await assert.rejects(advance(wallet, record, options), /lost acknowledgement/);
  assert.match(await advance(wallet, record, options), /payment accepted/);
  assert.notEqual(attempts[3][1], original);
  assert.deepEqual(attempts, [['pay', original], ['pay', original], ['receipt', undefined], ['pay', attempts[3][1]], ['receipt', undefined]]);
  assert.ok(states.some(s => /Combining private notes/.test(s))); assert.equal(record, null);
});
test('offline, rejected, and uncertain receipts never report completion or issue a new spend', async () => {
  for (const state of ['built','unsubmitted','refused','rejected','abandoned','queued','dispatched','pending_unknown','delivery_unknown','unknown','accepted']) {
    let record = { mode: 'exit', phase: 'receipt', action: { operation: 'exit', state, intent_id: id } };
    const message = await advance({ request: async path => {
      assert.equal(path, 'receipt'); return { intent_id: id, state: state === 'built' ? 'pending_unknown' : state, contract_receipt: state === 'rejected' ? { intent_id: id, state, accepted: false } : null };
    } }, record, { signal: new AbortController().signal, progress() {}, pause: async () => {}, save: async j => { record = j; } });
    assert.doesNotMatch(message, /^Funds moved/);
    assert.equal(Boolean(record), !['rejected','abandoned'].includes(state));
  }
});

test('settlement needs matching intent, inclusion and finality', () => {
  const c = receiptFor(id).contract_receipt;
  assert.ok(finalizedAcceptance(id, c));
  for (const change of [{ intent_id: 'a'.repeat(96) }, { accepted: false }, { inclusion_height: 42 }, { finality: null },
    { block_hash: c.state_root }, { finality: { ...c.finality, quorum: 0 } }]) assert.ok(!finalizedAcceptance(id, { ...c, ...change }));
});
test('policy refusal codes explain which asset rule blocked the transfer', () => {
  assert.match(refusalMessage('asset_orchard_transfer_facility_asset'), /redemption facility/);
  assert.match(refusalMessage('asset_orchard_transfer_reserve_outstanding'), /private reserve/);
  assert.match(refusalMessage('asset_orchard_transfer_exit_policy_governed'), /asset policy/);
});

test('private-only assets use matching ledger metadata and never acquire a public balance', () => {
  const snapshot = { balances: { [id]: 2100 }, available: { [id]: 2000 } };
  const metadata = { [id]: { asset_id: id, code: 'Coin', precision: 2, balance: 99999 } };
  const [coin] = walletAssets([], snapshot, metadata);
  assert.equal(coin.label, 'Coin'); assert.equal(coin.publicBalance, 0);
  assert.equal(makeJob('pay', coin, '1.23', recipient, address).terms.amount, 123);
  metadata[id].asset_id = '0'.repeat(96);
  assert.match(walletAssets([], snapshot, metadata)[0].label, /atoms/);
});

test('JavaScript hashes both funding vectors byte for byte like UnsignedTransferFunding::signing_digest', () => {
  for (const { unsigned_funding, signing_digest_hex } of vectors) {
    assert.deepEqual(Buffer.from(fundingDigest(unsigned_funding)), Buffer.from(signing_digest_hex, 'hex'));
  }
});

test('shield review and signing check the requested terms and all six output fields', () => {
  const prepared = { ...vectors[0], private_address: recipient }, u = prepared.unsigned_funding, t = u.terms;
  const requested = { privateAddress: recipient, account: t.source, amount: t.amount, asset: t.asset_id, issuer: t.issuer, fee: t.fee };
  assert.deepEqual(shieldAuthorization(prepared, requested), { fee: t.fee });
  let calls = 0;
  const sign = digest => { calls++; assert.deepEqual(Buffer.from(digest), Buffer.from(prepared.signing_digest_hex, 'hex')); return {}; };
  assert.deepEqual(shieldAuthorization(prepared, requested, sign).unsigned, u);
  for (const change of [{ source: t.issuer }, { owner: t.issuer }, { issuer: t.source }, { asset_id: id }, { amount: 10 },
    { fee: 2 }, { fee: -1 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { chain_id: 'other' }, { genesis_hash: id },
    { operation: 'issued_payment' }, { signature_algorithm_id: 'other' }, { unexpected: 1 }]) {
    const modified = { ...u, terms: { ...t, ...change } };
    assert.throws(() => shieldAuthorization({ ...prepared, unsigned_funding: modified }, requested, sign), /does not match/);
  }
  for (const field of Object.keys(u.intent)) {
    const pair = u.intent[field];
    for (const invalid of [[pair[1], pair[0]], [pair[0]], [pair[0], 'X'.repeat(pair[1].length)]]) {
      const modified = { ...u, intent: { ...u.intent, [field]: invalid } };
      assert.throws(() => shieldAuthorization({ ...prepared, unsigned_funding: modified }, requested, sign), /does not match/);
    }
  }
  for (const digest of [undefined, id, prepared.signing_digest_hex.toUpperCase()]) {
    const bad = { ...prepared, signing_digest_hex: digest };
    assert.throws(() => shieldAuthorization(bad, requested), /digest does not match/);
    assert.throws(() => shieldAuthorization(bad, requested, sign), /digest does not match/);
  }
  assert.throws(() => shieldAuthorization({ ...prepared, private_address: 'pfs1' + '0'.repeat(158) }, requested, sign), /private address/);
  assert.equal(calls, 1);
});

test('a rejected acknowledgement fetches the receipt reason and preserves a retryable reservation', async () => {
  const terms = makeJob('pay', assets[0], '1', recipient, address).terms;
  for (const [code, expected] of [['asset_orchard_transfer_facility_asset', /redemption facility/], ['private_action_busy', /temporarily refused/]]) {
    let record = { mode: 'pay', phase: 'submit', terms };
    const wallet = { request: async path => path === 'pay' ? { intent_id: id, operation: 'pay', state: 'rejected' } :
      { intent_id: id, state: 'rejected', contract_receipt: { intent_id: id, state: 'rejected', accepted: false, code } } };
    const message = await advance(wallet, record, { signal: new AbortController().signal, progress() {}, pause: async () => {}, save: async j => { record = j; } });
    assert.match(message, expected);
    if (code === 'private_action_busy') assert.equal(record.terms.request_id, terms.request_id);
    else assert.equal(record, null);
  }
});
