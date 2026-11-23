import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createRelayServer } from './relay.js';
import { registerL1Gateway } from './gateway.js';
import { solanaWithdrawalOrigin } from './release-config.js';

const path = '/api/l1/bridge/solana/withdrawals';
const burn = 'ab'.repeat(48);
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
const close = server => new Promise(resolve => server.close(resolve));
async function stack(t, enabled) {
  const seen = [], token = randomBytes(32).toString('hex');
  const payout = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    seen.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url.endsWith('/readiness')) return json(res, 200, { ok: true, ready: false, message: 'vault paused' });
    json(res, req.method === 'POST' ? 202 : 200, { stage: 'queued', burn_tx_id: burn });
  });
  const upstream = await listen(payout);
  const reservation = createServer(), relayOrigin = await listen(reservation); await close(reservation);
  const relay = createRelayServer({ L1_RELAY_PUBLIC_ORIGIN: relayOrigin, L1_RELAY_TOKEN: token,
    L1_WALLET_PROXY_URL: 'ws://127.0.0.1:1', L1_WALLET_PROXY_TOKEN: 'fixture', L1_WALLET_PROXY_ORIGIN: relayOrigin,
    L1_SOLANA_WITHDRAWALS_ENABLED: enabled, L1_SOLANA_WITHDRAW_SERVICE_URL: upstream }, async () => ({}));
  relay.listen(Number(new URL(relayOrigin).port), '127.0.0.1'); await once(relay, 'listening');
  const server = createServer();
  const gateway = registerL1Gateway(server, { env: { TASKNODE_L1_ENABLED: 'true', L1_RELAY_URL: relayOrigin, L1_RELAY_TOKEN: token },
    cookieValue: req => req.headers.cookie, getSession: async cookie => cookie ? { authenticated: true, accountId: 'fixture' } : null,
    json, readJson: async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); } });
  const origin = await listen(server);
  t.after(async () => { gateway.close(); await close(server); await close(relay); await close(payout); });
  const headers = { Cookie: 'fixture=yes', Origin: origin, 'Content-Type': 'application/json' };
  return { seen, relayOrigin, payout, get: suffix => fetch(origin + path + suffix, { headers }),
    post: (body, changes) => fetch(origin + path, { method: 'POST', headers: { ...headers, ...changes }, body }) };
}

test('Solana withdrawal setting defaults closed and requires a loopback HTTP origin', () => {
  for (const setting of [undefined, 'https://remote.test', 'http://127.0.0.1/path', 'http://user@127.0.0.1:12']) {
    assert.equal(solanaWithdrawalOrigin({ L1_SOLANA_WITHDRAWALS_ENABLED: 'true', L1_SOLANA_WITHDRAW_SERVICE_URL: setting }), null);
  }
});
test('disabled relay returns unavailable without contacting the payout service', async t => {
  const { get, post, seen } = await stack(t);
  assert.deepEqual(await (await get('/readiness')).json(), { ok: true, ready: false, message: 'Solana withdrawals are not available yet' });
  assert.equal((await post(JSON.stringify({ burn_tx_id: burn }))).status, 503);
  assert.equal((await get('/' + burn)).status, 503);
  assert.deepEqual(seen, []);
});
test('both authenticated hops validate writes and expose readiness and idempotent payout routes', async t => {
  const { get, post, relayOrigin, seen, payout } = await stack(t, 'true');
  assert.equal((await fetch(relayOrigin + path + '/readiness')).status, 401);
  const body = JSON.stringify({ burn_tx_id: burn });
  assert.equal((await post(body, { Cookie: '' })).status, 401);
  assert.equal((await post(body, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await post(body, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post(body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(body.padEnd(257))).status, 413);
  for (const invalid of ['{}', '{', JSON.stringify({ burn_tx_id: [burn] }), JSON.stringify({ burn_tx_id: burn.toUpperCase() }),
    JSON.stringify({ burn_tx_id: burn, url: 'extra' })]) assert.equal((await post(invalid)).status, 400);
  assert.equal((await get('/invalid')).status, 400);
  assert.deepEqual(seen, []);
  assert.equal((await (await get('/readiness')).json()).message, 'vault paused');
  assert.equal((await post(body)).status, 202);
  assert.equal((await (await get('/' + burn)).json()).burn_tx_id, burn);
  assert.deepEqual(seen.map(row => row.url), ['/solana/withdrawals/readiness', '/solana/withdrawals', '/solana/withdrawals/' + burn]);
  assert.equal(seen[1].body, body);
  assert.ok(seen.every(row => row.authorization === undefined));
  await close(payout);
  assert.equal((await (await get('/readiness')).json()).ready, false);
});
