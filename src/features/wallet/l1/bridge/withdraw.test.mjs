import assert from 'node:assert/strict';
import test from 'node:test';
import { WITHDRAW_STUCK_AFTER_MS, canDiscardBurn, resendBurn, stalledAction, withdrawalStalled } from './withdraw-recovery.js';
const burn = 'c'.repeat(96);
function chain(answer) {
  const calls = [];
  const client = { call: async (method, params) => { calls.push(method); assert.equal(params.tx_id, burn); return answer; },
    sign: async () => calls.push('sign'), submit: async () => calls.push('submit') };
  return { client, calls };
}
const accepted = { ok: true, result: { tx_id: burn, confirmed: true, receipt: { tx_id: burn, accepted: true } } };
const missing = { ok: false, error: { code: 'rpc_tx_not_found', message: 'no receipt' } };
test('withdrawal recovery appears only when the service has not taken the burn after the limit', () => {
  const since = Date.now();
  assert.equal(withdrawalStalled(burn, null, since, since), false);
  assert.equal(withdrawalStalled(burn, null, since, since + WITHDRAW_STUCK_AFTER_MS - 1), false);
  assert.equal(withdrawalStalled(burn, null, since, since + WITHDRAW_STUCK_AFTER_MS), true);
  assert.equal(withdrawalStalled(burn, { stage: 'queued' }, since, since + WITHDRAW_STUCK_AFTER_MS), false);
  assert.equal(withdrawalStalled(burn, { stage: 'failed' }, since, since + WITHDRAW_STUCK_AFTER_MS), false);
  assert.equal(withdrawalStalled('', null, since, since + WITHDRAW_STUCK_AFTER_MS), false);
});
test('a stalled burn offers Try again when accepted and discard only when it never reached the chain', async () => {
  assert.equal(await stalledAction(chain(accepted).client, burn), 'retry');
  assert.equal(await stalledAction(chain(missing).client, burn), 'discard');
  assert.equal(await stalledAction(chain({ tx_id: burn, confirmed: true, receipt: { tx_id: burn, accepted: false } }).client, burn), 'discard');
  assert.equal(await stalledAction(chain({ tx_id: burn, confirmed: false }).client, burn), null);
  await assert.rejects(stalledAction(chain({ ok: false, error: { code: 'rpc_unavailable', message: 'offline' } }).client, burn), /offline/);
  await assert.rejects(canDiscardBurn(chain(accepted).client, burn), /cannot be discarded/);
  await assert.rejects(canDiscardBurn(chain({ tx_id: burn, confirmed: false }).client, burn), /cannot be discarded/);
  assert.equal(await canDiscardBurn(chain(missing).client, burn), true);
});
test('Try again re-sends the same burn id and never signs or submits a second burn', async () => {
  const { client, calls } = chain(accepted), posts = [];
  const post = async (path, options) => { posts.push([path, options.method, JSON.parse(options.body)]); return { ok: true, stage: 'queued' }; };
  assert.equal(await stalledAction(client, burn), 'retry');
  for (let i = 0; i < 3; i++) assert.deepEqual(await resendBurn(burn, post), { ok: true, stage: 'queued' });
  assert.deepEqual(posts, Array(3).fill(['/withdrawals', 'POST', { burn_tx_id: burn }]));
  assert.deepEqual(calls, ['tx']);
});
