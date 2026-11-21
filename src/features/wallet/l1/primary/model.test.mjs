import test from 'node:test';
import assert from 'node:assert/strict';
import { config, address, fixture } from './fixtures.js';
import { CREATE_STUCK_AFTER_MS, canDiscardAttempt, creationQuote, defaultBuyMode, createPlan, discardAttempt, primaryPreflight, subscriberQuote, subscriberRedeem, verifyPrimary } from './model.js';
import { snapshot } from '../market/model.js';

test('creation rounds NAV principal and fee upward, respects exact bounds and source', () => {
  const { state } = fixture(); assert.deepEqual(creationQuote(config, state, '1'), { amount: 1000000, gross: 1000000, due: 1005000, fee: 5000, feeBps: 50, expiry: 110 });
  state.nav.nav_per_unit = 1000001; const q = creationQuote(config, state, '1.000001'); assert.equal(q.gross, 1000003); assert.equal(q.due, 1005004);
  assert.throws(() => creationQuote(config, state, '0.1'), /bounds/); state.proof.current_height = 1002; assert.throws(() => creationQuote(config, state, '1'), /stale/);
  state.proof.current_height = 10; state.pool.source_settlement_custody[0].enabled_for_issue = false; assert.throws(() => creationQuote(config, state, '1'), /not enabled/);
});
test('default switches only beyond a complete book; explicit choice remains UI-owned', () => {
  assert.equal(defaultBuyMode(1000001n, 1000000n, true), 'create'); assert.equal(defaultBuyMode(1000000n, 1000000n, true), 'book'); assert.equal(defaultBuyMode(1n, 0n, true), 'create'); assert.equal(defaultBuyMode(2n, 1n, true, true), 'book'); assert.equal(defaultBuyMode(2n, 1n, false), 'book');
});
test('reservation, subscription, release and cash-in have exact source-aware deltas', async () => {
  const { client, state } = fixture(), plan = await createPlan(client, config, '1');
  assert.equal(plan.steps[0].intent.operation.settlement_source_asset_id, config.market_quote_asset_id);
  assert.equal(plan.steps[1].intent.operation.settlement_asset_id, config.pfusdc_asset_id);
  assert.equal(plan.steps.some(s => s.intent.operation.operation.includes('export_debit')), false);
  for (const step of plan.steps) { const before = await snapshot(client, config); primaryPreflight(config, plan, step, before, before); const result = await client.submit(step.intent); const after = await snapshot(client, config); await verifyPrimary(client, config, plan, step, before, after, result.receipt, result.txId);
    const bad = structuredClone(after); bad.supply++; await assert.rejects(verifyPrimary(client, config, plan, step, before, bad, result.receipt, result.txId), /do not match/);
  }
  assert.equal(state.pool.export_entitlement_count, 0);
  const before = await snapshot(client, config), redemption = subscriberRedeem(config, before, '1', address);
  assert.equal(redemption.quote.holder, 999500); const result = await client.submit(redemption.intent);
  await verifyPrimary(client, config, { quote: redemption.quote }, { kind: 'redeem', intent: redemption.intent }, before, await snapshot(client, config), result.receipt, result.txId);
  assert.equal(state.balances.assets.lines[1].balance, 9994500); assert.equal(state.pool.non_nav_spread_atoms, 5500); assert.equal(state.pool.settlement_reserve_atoms, 20000000);
});
test('book holdings and mismatched reserve cannot cash in; changed policy fails before signing', async () => {
  const { state, client } = fixture(); state.balances.assets.lines[0].balance = 1000000;
  assert.throws(() => subscriberQuote(config, state, '1', address), /Only your tracked/);
  state.pool.native_spendable_balances = [{ wallet: address, amount_atoms: 1000000 }]; assert.throws(() => subscriberQuote(config, state, '1', address), /matching PFUSDC/);
  const plan = await createPlan(client, config, '1'); state.pool.policy_epoch++;
  assert.throws(() => primaryPreflight(config, plan, plan.steps[0], state, state), /changed/);
});
test('accepted execution without confirmation never verifies', async () => {
  const { client } = fixture(), plan = await createPlan(client, config, '1'), step = plan.steps[0], before = await snapshot(client, config), result = await client.submit(step.intent), after = await snapshot(client, config);
  client.call = async () => ({ tx_id: result.txId, receipt: result.receipt, confirmed: false });
  await assert.rejects(verifyPrimary(client, config, plan, step, before, after, result.receipt, result.txId), /not accepted and confirmed/);
});
test('insufficient receiving limit offers only setup; funded creation cannot run early', async () => {
  const { client, state } = fixture(); state.balances.assets.lines[1].balance = 999999; state.balances.assets.lines[1].limit = 1000000;
  const setup = await createPlan(client, config, '1'); assert.equal(setup.fundingOnly, true); assert.equal(setup.steps.length, 1); assert.equal(setup.steps[0].intent.operation.limit, 1005000);
  await client.submit(setup.steps[0].intent); await assert.rejects(createPlan(client, config, '1'), /Not enough market PFUSDC/);
});
test('an unfinished creation attempt can be discarded only when stuck', async () => {
  const { client } = fixture(), plan = await createPlan(client, config, '1'), at = Date.now();
  const attempt = { plan, index: 0, receipts: [], pending: true, attemptAt: at };
  // Normal signing in this page: no discard until the limit; a reload with no transaction id is stuck at once.
  assert.equal(canDiscardAttempt(attempt, false, null, at), false);
  assert.equal(canDiscardAttempt(attempt, false, null, at + CREATE_STUCK_AFTER_MS - 1), false);
  assert.equal(canDiscardAttempt(attempt, false, null, at + CREATE_STUCK_AFTER_MS), true);
  assert.equal(canDiscardAttempt(attempt, true, null, at), true);
  assert.equal(canDiscardAttempt({ ...attempt, attemptAt: undefined }, false, null, at), true);
  assert.equal(canDiscardAttempt({ ...attempt, pending: false }, true, null, at + CREATE_STUCK_AFTER_MS), false);
  assert.equal(canDiscardAttempt(null, true, null), false);
  const late = at + CREATE_STUCK_AFTER_MS;
  for (const [status, allowed] of [['missing', true], ['rejected', true], ['accepted', false], ['unconfirmed', false], [null, false]]) {
    assert.equal(canDiscardAttempt({ ...attempt, uncertainTxId: '9'.repeat(96) }, true, status, late), allowed, String(status));
    assert.equal(canDiscardAttempt({ ...attempt, uncertainTxId: '9'.repeat(96) }, true, status, late - 1), false, String(status));
  }
  const kept = await discardAttempt(client, { ...attempt, receipts: [{ kind: 'setup', txId: '1'.repeat(96) }] }, true);
  assert.deepEqual(kept, { plan, index: 0, receipts: [{ kind: 'setup', txId: '1'.repeat(96) }], pending: false });
  await assert.rejects(discardAttempt(client, attempt, false, at), /not stuck/);
});
test('an attempt whose transaction is accepted on the chain is never discarded', async () => {
  const { client } = fixture(), plan = await createPlan(client, config, '1');
  const accepted = (await client.submit(plan.steps[0].intent)).txId, missing = '9'.repeat(96);
  const call = client.call;
  client.call = async (method, params) => method === 'tx' && params.tx_id === missing ? { ok: false, error: { code: 'rpc_tx_not_found', message: 'no receipt' } } : call(method, params);
  const old = { plan, index: 0, receipts: [], pending: true, attemptAt: Date.now() - CREATE_STUCK_AFTER_MS };
  await assert.rejects(discardAttempt(client, { ...old, uncertainTxId: accepted }, true), /accepted on the chain/);
  assert.equal((await discardAttempt(client, { ...old, uncertainTxId: missing }, true)).pending, false);
  client.call = async () => { throw new Error('L1 RPC timed out'); };
  await assert.rejects(discardAttempt(client, { ...old, uncertainTxId: missing }, true), /timed out/);
});
