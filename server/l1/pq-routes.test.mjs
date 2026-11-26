import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { handlePqRoutes } from './pq-routes.js';
import { createRelayServer } from './relay.js';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('handlePqRoutes enforces auth, custody boundary, byte-preserving submit, and token scrub', async t => {
  const seen = [];
  let upstreamStatus = 200;
  let upstreamBody = { ok: true, pool_id: 'PFT-PQ-SHIELDED-POOL-V1' };
  const transport = async (url, opts) => {
    seen.push({ url, opts });
    return new Response(JSON.stringify(upstreamBody), {
      status: upstreamStatus,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  let authed = true;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    void handlePqRoutes({
      req,
      res,
      url,
      session: authed ? { accountId: 'acct-1', authenticated: true } : null,
      json,
      bridgeProxyUrl: 'http://127.0.0.1:18082',
      proxyToken: 's'.repeat(40),
      proxyOrigin: 'http://127.0.0.1:18082',
      transport,
    }).then(handled => {
      if (!handled) json(res, 404, { error: 'not_found' });
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/l1/pq/`;
  const headers = { 'Content-Type': 'application/json' };

  authed = false;
  assert.equal((await fetch(`${base}snapshot`, { method: 'POST', headers, body: '{}' })).status, 401);
  authed = true;

  assert.equal((await fetch(`${base}unknown`, { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}snapshot`, { method: 'GET' })).status, 405);

  const leak = await fetch(`${base}submit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ viewing_key: 'secret', witness: 'secret' }),
  });
  assert.equal(leak.status, 400);
  assert.equal(seen.length, 0);

  for (const route of ['snapshot', 'page', 'authorize', 'receipt']) {
    upstreamStatus = 200;
    const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(seen.at(-1).url, `http://127.0.0.1:18082/api/private/v1/pq/${route}`);
    assert.equal(seen.at(-1).opts.headers.Authorization, `Bearer ${'s'.repeat(40)}`);
  }

  upstreamStatus = 202;
  upstreamBody = { ok: true, state: 'queued' };
  const submitBody = '{\n  "intent_id": "abc",\n  "action_json": "{}"\n}';
  const submitRes = await fetch(`${base}submit`, { method: 'POST', headers, body: submitBody });
  assert.equal(submitRes.status, 202);
  assert.equal(Buffer.from(seen.at(-1).opts.body).toString('utf8'), submitBody);

  upstreamStatus = 200;
  upstreamBody = { leaked: 's'.repeat(40) };
  const scrubbed = await fetch(`${base}snapshot`, { method: 'POST', headers, body: '{}' });
  assert.equal(scrubbed.status, 502);
});

test('createRelayServer routes /api/l1/pq/* with Bearer auth to wallet-proxy', async t => {
  const upstreamHits = [];
  const mockProxy = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      upstreamHits.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      json(res, 200, { ok: true, pool_id: 'PFT-PQ-SHIELDED-POOL-V1' });
    });
  }).listen(0, '127.0.0.1');
  await once(mockProxy, 'listening');
  t.after(() => mockProxy.close());

  const proxyPort = mockProxy.address().port;
  const relayToken = 'r'.repeat(40);
  const proxyToken = 'p'.repeat(40);
  const relay = createRelayServer({
    L1_RELAY_PUBLIC_ORIGIN: 'http://127.0.0.1:8870',
    L1_RELAY_TOKEN: relayToken,
    L1_WALLET_PROXY_URL: `ws://127.0.0.1:${proxyPort}/rpc`,
    L1_WALLET_PROXY_ORIGIN: `http://127.0.0.1:${proxyPort}`,
    L1_WALLET_PROXY_TOKEN: proxyToken,
    L1_BRIDGE_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
    L1_BRIDGE_PROXY_ORIGIN: `http://127.0.0.1:${proxyPort}`,
  }, async () => ({ ok: true }));
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  t.after(() => relay.close());

  const relayUrl = `http://127.0.0.1:${relay.address().port}/api/l1/pq/snapshot`;
  assert.equal((await fetch(relayUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);

  const okRes = await fetch(relayUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${relayToken}`,
      Origin: 'http://127.0.0.1:8870',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(okRes.status, 200);
  assert.equal(upstreamHits.length, 1);
  assert.equal(upstreamHits[0].url, '/api/private/v1/pq/snapshot');
  assert.equal(upstreamHits[0].auth, `Bearer ${proxyToken}`);
});

test('registerL1Gateway accepts Mac Bearer terminal token on /api/l1/pq/* without browser Origin', async t => {
  const { registerL1Gateway } = await import('./gateway.js');
  const upstreamHits = [];
  const mockRelay = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      upstreamHits.push({ url: req.url, auth: req.headers.authorization });
      json(res, 200, { ok: true, pool_id: 'PFT-PQ-SHIELDED-POOL-V1' });
    });
  }).listen(0, '127.0.0.1');
  await once(mockRelay, 'listening');
  t.after(() => mockRelay.close());

  const relayToken = 't'.repeat(40);
  const server = createServer((req, res) => json(res, 404, { error: 'fallback' }));
  const gw = registerL1Gateway(server, {
    getSession: async () => null,
    getTerminalSession: async token => (token === 'mac-oauth-token' ? { accountId: 'mac-acct' } : null),
    sessionCookieName: 'sid',
    cookieValue: () => '',
    json,
    readJson: async () => ({}),
    env: {
      TASKNODE_L1_ENABLED: 'true',
      TASKNODE_PUBLIC_URL: 'https://tasknode.postfiat.org',
      L1_RELAY_URL: `http://127.0.0.1:${mockRelay.address().port}`,
      L1_RELAY_TOKEN: relayToken,
    },
    recoverSubmit: null,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { gw.close(); server.close(); });

  const url = `http://127.0.0.1:${server.address().port}/api/l1/pq/snapshot`;
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const ok = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer mac-oauth-token', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(ok.status, 200);
  assert.equal(upstreamHits.length, 1);
  assert.equal(upstreamHits[0].url, '/api/l1/pq/snapshot');
  assert.equal(upstreamHits[0].auth, `Bearer ${relayToken}`);
});
