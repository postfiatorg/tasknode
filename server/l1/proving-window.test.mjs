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

async function answer(path, env, method = 'GET', options = {}) {
  let sent;
  const res = { setHeader() {} };
  await handleBridgeRoutes({
    req: { method, headers: {} }, res, url: new URL('http://tasknode.test/api/l1/bridge' + path), session: { accountId: 'acct' },
    json: (_res, status, payload) => { sent = { status, payload }; }, readJson: async () => ({}), env, ...options,
  });
  return sent;
}

// The test owns the payout services: fetch is replaced for its duration and restored afterwards.
async function withPayoutServices(answers, run) {
  const original = globalThis.fetch, asked = [];
  globalThis.fetch = async (url) => {
    const target = String(url), path = new URL(target).pathname;
    asked.push(path);
    const body = answers[path];
    if (!body) throw new Error(`unexpected upstream ${target}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try { return await run(asked); } finally { globalThis.fetch = original; }
}

test('the three readiness routes name the window on ready and refused answers; other routes and an unset setting do not', async () => {
  const env = { L1_PROVING_WINDOW_UTC: '17:00-19:00', L1_SOLANA_READINESS_FRESH_MS: '0' };
  const solanaOrigin = 'http://payout.test';
  const job = 'ab'.repeat(48);
  for (const ready of [true, false]) {
    await withPayoutServices({
      '/api/bridge/withdrawals/readiness': { ok: true, ready, message: ready ? '' : 'payout service is closed' },
      '/solana/withdrawals/readiness': { ok: true, ready, message: ready ? '' : 'payout service is closed' },
      [`/api/bridge/withdrawals/${job}`]: { ok: true, stage: 'paid' },
    }, async (asked) => {
      const ethereum = await answer('/withdrawals/readiness', env);
      assert.deepEqual([ethereum.status, ethereum.payload.ready, ethereum.payload.proving_window.opens_utc], [200, ready, '17:00']);
      assert.ok(Number.isFinite(ethereum.payload.proving_window.now_unix_ms));
      const solana = await answer('/solana/withdrawals/readiness', env, 'GET', { solanaOrigin });
      assert.deepEqual([solana.status, solana.payload.ready, solana.payload.proving_window.closes_utc], [200, ready, '19:00']);
      // A job read is not a readiness answer: no window.
      const status = await answer(`/withdrawals/${job}`, env);
      assert.deepEqual([status.status, status.payload.stage, status.payload.proving_window], [200, 'paid', undefined]);
      assert.equal((await answer('/withdrawals/readiness', {})).payload.proving_window, undefined);
      assert.deepEqual(asked, ['/api/bridge/withdrawals/readiness', '/solana/withdrawals/readiness', `/api/bridge/withdrawals/${job}`, '/api/bridge/withdrawals/readiness']);
    });
  }
  // Without any payout service: the closed answers carry the window too, and nothing upstream is asked.
  await withPayoutServices({}, async (asked) => {
    const solana = await answer('/solana/withdrawals/readiness', env);
    assert.deepEqual([solana.status, solana.payload.ready, solana.payload.proving_window.opens_utc], [200, false, '17:00']);
    const deposit = await answer('/solana/readiness', env);
    assert.ok(deposit.status >= 400);
    assert.equal(deposit.payload.proving_window.closes_utc, '19:00');
    assert.equal((await answer('/solana/withdrawals/' + job, env)).payload.proving_window, undefined);
    assert.deepEqual(asked, []);
  });
});
