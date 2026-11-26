import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBridgeRoutes } from './bridge-routes.js';
import { parseProvingWindow, withProvingWindow } from './proving-window.js';

test('the proving window setting parses one UTC window and refuses anything else', () => {
  assert.deepEqual(parseProvingWindow('17:00-19:00'), { opens_utc: '17:00', closes_utc: '19:00', open_minute: 1020, close_minute: 1140 });
  assert.deepEqual(parseProvingWindow(' 00:00-23:59 '), { opens_utc: '00:00', closes_utc: '23:59', open_minute: 0, close_minute: 1439 });
  for (const value of [undefined, '', '17-19', '17:00', '17:00-19', '7:00-19:00', '17:00 - 19:00', '24:00-01:00', '17:60-19:00',
    '17:00-19:00,20:00-21:00', 'abc', 1700]) {
    assert.equal(parseProvingWindow(value), null, String(value));
  }
  // Crossing midnight and an empty window are refused, not guessed.
  assert.equal(parseProvingWindow('23:00-01:00'), null);
  assert.equal(parseProvingWindow('17:00-17:00'), null);
});

test('a readiness answer carries the window and the server clock only when the setting is valid', () => {
  const now = () => Date.UTC(2026, 10, 26, 10, 0);
  assert.deepEqual(withProvingWindow({ ok: true, ready: false }, { L1_PROVING_WINDOW_UTC: '17:00-19:00' }, now), {
    ok: true, ready: false,
    proving_window: { opens_utc: '17:00', closes_utc: '19:00', open_minute: 1020, close_minute: 1140, now_unix_ms: now() },
  });
  for (const env of [{}, { L1_PROVING_WINDOW_UTC: '19:00-17:00' }, { L1_PROVING_WINDOW_UTC: 'soon' }]) {
    assert.deepEqual(withProvingWindow({ ok: true, ready: false }, env, now), { ok: true, ready: false });
  }
});

async function answer(path, env, method = 'GET') {
  let sent;
  const res = { setHeader() {} };
  await handleBridgeRoutes({
    req: { method, headers: {} }, res, url: new URL('http://tasknode.test/api/l1/bridge' + path), session: { accountId: 'acct' },
    json: (_res, status, payload) => { sent = { status, payload }; }, readJson: async () => ({}), env,
  });
  return sent;
}

test('the three readiness routes name the window, open or closed; other routes and an unset setting do not', async () => {
  const env = { L1_PROVING_WINDOW_UTC: '17:00-19:00' };
  // Solana withdrawals on a host without a payout service: a closed readiness answer.
  const solana = await answer('/solana/withdrawals/readiness', env);
  assert.equal(solana.status, 200);
  assert.equal(solana.payload.ready, false);
  assert.equal(solana.payload.proving_window.opens_utc, '17:00');
  assert.ok(Number.isFinite(solana.payload.proving_window.now_unix_ms));
  // Solana deposits refused before the relay is asked: the error answer carries it too.
  const deposit = await answer('/solana/readiness', env);
  assert.ok(deposit.status >= 400);
  assert.equal(deposit.payload.proving_window.closes_utc, '19:00');
  // Ethereum withdrawals with no payout service at the configured address: the unavailable answer carries it too.
  const ethereum = await answer('/withdrawals/readiness', env);
  assert.equal(ethereum.payload.ok, false);
  assert.equal(ethereum.payload.proving_window.opens_utc, '17:00');
  assert.equal((await answer('/solana/withdrawals/readiness', {})).payload.proving_window, undefined);
  assert.equal((await answer('/solana/withdrawals/' + 'ab'.repeat(48), env)).payload.proving_window, undefined);
});
