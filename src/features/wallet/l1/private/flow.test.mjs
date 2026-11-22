import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.throws(() => makeJob('exit', assets[0], '1', recipient, address));
});
test('an interrupted payment resumes the identical request and continues only after merge acceptance', async () => {
  let record = makeJob('pay', assets[0], '1', recipient, address);
  const original = record.terms.request_id, attempts = [], states = [], merge = 'a'.repeat(96);
  const options = { signal: new AbortController().signal, progress: s => states.push(s), save: async j => { record = j; }, pause: async () => {} };
  const wallet = { async request(path, body) {
    attempts.push([path, body.request_id]);
    if (attempts.length === 1) throw Error('lost acknowledgement');
    if (path === 'receipt') return { intent_id: merge, state: 'accepted' };
    return body.request_id === original ? { intent_id: merge, operation: 'merge', state: 'queued', owner_tag: 'a' } :
      { intent_id: id, operation: 'pay', state: 'accepted' };
  } };
  await assert.rejects(advance(wallet, record, options), /lost acknowledgement/);
  assert.match(await advance(wallet, record, options), /payment accepted/);
  assert.deepEqual(attempts, [['pay', original], ['pay', original], ['receipt', undefined], ['pay', merge.slice(0,64)]]);
  assert.ok(states.some(s => /Combining private notes/.test(s))); assert.equal(record, null);
});
test('offline, rejected, and uncertain receipts never report completion or issue a new spend', async () => {
  for (const state of ['built','rejected','abandoned','pending_unknown']) {
    let record = { mode: 'exit', phase: 'receipt', action: { operation: 'exit', state, intent_id: id } };
    const message = await advance({ request: async path => { assert.equal(path, 'receipt'); return { state }; } }, record, {
      signal: new AbortController().signal, progress() {}, pause: async () => {}, save: async j => { record = j; },
    });
    assert.doesNotMatch(message, /^Funds moved/);
    assert.equal(Boolean(record), state === 'pending_unknown');
  }
});
