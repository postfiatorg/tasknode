import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createRelayServer } from './relay.js';
import { registerL1Gateway } from './gateway.js';
import { l1Enabled, relaySettings, relayRead } from './release-config.js';
import { createProfileRpc } from './profile/rpc.js';
import { localRpc } from './read-rpc.js';

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { await new Promise(resolve => server.close(resolve)); }
async function deniedSocket(url, origin, status) {
  const socket = new WebSocket(url.replace('http', 'ws'), { origin }); socket.on('error', () => {});
  const [, response] = await once(socket, 'unexpected-response'); assert.equal(response.statusCode, status); socket.terminate();
}

test('production defaults dark and rejects HTTP/profile/bridge/WebSocket access before authentication', async () => {
  assert.equal(l1Enabled({ NODE_ENV: 'production' }), false);
  assert.equal(l1Enabled({ TASKNODE_ENV: 'production' }), false);
  assert.equal(l1Enabled({ NODE_ENV: 'production', TASKNODE_L1_ENABLED: 'true' }), true);
  assert.equal(l1Enabled({ TASKNODE_L1_ENABLED: 'false' }), false);
  let authenticated = 0;
  const server = createServer((_req, res) => res.end('base app'));
  const gateway = registerL1Gateway(server, { env: { NODE_ENV: 'production' },
    getSession: async () => { authenticated++; return {}; }, cookieValue: () => '', json, readJson: async () => ({}) });
  const origin = await listen(server);
  try {
    for (const path of ['/api/l1/history', '/api/l1/navcoin/registry', '/api/l1/navcoin/profiles/test', '/api/l1/bridge/readiness']) assert.equal((await fetch(origin + path)).status, 404);
    await deniedSocket(origin + '/api/l1/rpc', origin, 404);
    assert.equal(await (await fetch(origin)).text(), 'base app'); assert.equal(authenticated, 0);
  } finally { gateway.close(); await close(server); }
});

test('relay configuration requires TLS, a separate credential, and a fixed origin', () => {
  const token = randomBytes(32).toString('hex');
  const credentialUrl = new URL('https://relay.example'); credentialUrl.username = 'fixture'; credentialUrl.password = 'fixture';
  for (const url of ['http://relay.example', credentialUrl.href, 'https://relay.example/path', 'https://relay.example/?target=other']) {
    assert.throws(() => relaySettings({ L1_RELAY_URL: url, L1_RELAY_TOKEN: token }));
  }
  assert.throws(() => relaySettings({ L1_RELAY_URL: 'https://relay.example' }));
  assert.equal(relaySettings({ L1_RELAY_URL: 'https://relay.example', L1_RELAY_TOKEN: token }).origin, 'https://relay.example');
});

test('two-hop relay authenticates reads, bridge and signed submissions; rejects custody/governance and strips credentials', async () => {
  const token = randomBytes(32).toString('hex'), proxyToken = randomBytes(32).toString('hex');
  const observed = [], reads = [], bridgeRequests = [];
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(upstream, 'listening');
  upstream.on('connection', ws => ws.on('message', data => {
    const request = JSON.parse(data); observed.push(request);
    ws.send(JSON.stringify({ id: request.id, ok: true, result: { method: request.method } }));
  }));
  const bridge = createServer((req, res) => { bridgeRequests.push({ url: req.url, auth: req.headers.authorization, origin: req.headers.origin }); json(res, 200, { ready: false, code: 'fixture_blocked' }); });
  const bridgeOrigin = await listen(bridge);
  const relayEnv = { L1_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1', L1_RELAY_TOKEN: token,
    L1_WALLET_PROXY_URL: `ws://127.0.0.1:${upstream.address().port}`, L1_WALLET_PROXY_ORIGIN: 'http://127.0.0.1',
    L1_WALLET_PROXY_TOKEN: proxyToken, L1_BRIDGE_PROXY_URL: bridgeOrigin, L1_BRIDGE_PROXY_ORIGIN: bridgeOrigin };
  // Reserve an ephemeral port, then set the configured origin before accepting traffic.
  const reservation = createServer(); const relayOrigin = await listen(reservation); await close(reservation);
  relayEnv.L1_RELAY_PUBLIC_ORIGIN = relayOrigin;
  const relay = createRelayServer(relayEnv, async (method, params) => { reads.push({ method, params }); return { method, fixture: true }; });
  relay.listen(Number(new URL(relayOrigin).port), '127.0.0.1'); await once(relay, 'listening');
  const env = { TASKNODE_L1_ENABLED: 'true', L1_RELAY_URL: relayOrigin, L1_RELAY_TOKEN: token };
  const server = createServer();
  const gateway = registerL1Gateway(server, { env, getSession: async () => ({ accountId: 'alice', authenticated: true }), cookieValue: () => '', json,
    readJson: async req => { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks)); } });
  const origin = await listen(server);
  let client;
  try {
    assert.equal((await fetch(relayOrigin + '/health')).status, 401);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const body of [{ method: 'governance_authorize', params: {} }, { method: 'status', params: { seed_hex: 'fixture' } }, { method: 'status', params: {}, target: 'other' }]) {
      assert.equal((await fetch(relayOrigin + '/read', { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(reads.length, 0);
    assert.equal((await fetch(relayOrigin + '/api/l1/navcoin/profiles/test', { headers })).status, 404);
    await deniedSocket(relayOrigin + '/api/l1/rpc', relayOrigin, 403);
    for (const rpc of [localRpc(env), createProfileRpc(env), relayRead(env)]) assert.equal((await rpc('status')).fixture, true);
    await assert.rejects(relayRead(env)('mempool_submit_signed_asset_transaction', {}), /not allowed/);
    const readiness = await (await fetch(origin + '/api/l1/bridge/readiness')).json();
    assert.equal(readiness.ready, false); assert.equal(readiness.code, 'fixture_blocked');
    assert.equal(bridgeRequests.length, 1); assert.equal(bridgeRequests[0].auth, `Bearer ${proxyToken}`);
    assert.equal(bridgeRequests[0].origin, bridgeOrigin); assert.match(bridgeRequests[0].url, /^\/api\/bridge\/readiness/);
    client = new WebSocket(origin.replace('http', 'ws') + '/api/l1/rpc', { origin }); await once(client, 'open');
    let id = 0;
    const call = async (method, params = {}) => { const response = once(client, 'message'); client.send(JSON.stringify({ version: 'postfiat-local-rpc-v1', id: ++id, method, params, proxy_auth_token: 'browser-override' })); return JSON.parse((await response)[0]); };
    assert.equal((await call('status')).ok, true);
    assert.equal((await call('governance_authorize')).ok, false);
    assert.equal((await call('account', { private_key: 'fixture' })).ok, false);
    assert.equal((await call('mempool_submit_signed_offer_transaction_finality', { signed_offer_transaction_json: '{"seed_hex":"fixture"}' })).ok, false);
    assert.equal((await call('mempool_submit_signed_offer_transaction_finality', { signed_offer_transaction_json: '{"unsigned":{},"public_key_hex":"fixture","signature_hex":"fixture"}' })).ok, true);
    assert.equal(observed.length, 2, 'one submission, no retries and no denied requests forwarded');
    assert.ok(observed.every(request => request.proxy_auth_token === proxyToken));
    assert.ok(!JSON.stringify(observed).includes(token));
  } finally {
    client?.terminate(); gateway.close(); for (const ws of upstream.clients) ws.terminate();
    await close(server); await close(relay); await close(bridge); await new Promise(resolve => upstream.close(resolve));
  }
});
