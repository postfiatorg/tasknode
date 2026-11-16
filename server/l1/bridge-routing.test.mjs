import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleBridgeRoutes } from './bridge-routes.js';
import { registerL1Gateway } from './gateway.js';

function context(overrides = {}) {
  const responses = [];
  return { req: { method: 'GET', headers: { host: 'tasknode.test' } },
    res: { setHeader() {} }, url: new URL('https://tasknode.test/api/l1/bridge/readiness'),
    session: { accountId: 'bob' }, json: (_res, status, body) => responses.push({ status, body }),
    readJson: async () => null, proxyUrl: 'ws://127.0.0.1:8080/rpc', responses, ...overrides };
}

test('bridge converts WebSocket RPC origin to HTTP without changing the configured RPC URL', async () => {
  const original = globalThis.fetch;
  const ctx = context();
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url.href, 'http://127.0.0.1:8080/api/bridge/readiness?route=ethereum-mainnet-usdc-v1');
      return { status: 200, json: async () => ({ ready: false, code: 'anchor_missing' }) };
    };
    await handleBridgeRoutes(ctx);
    assert.equal(ctx.proxyUrl, 'ws://127.0.0.1:8080/rpc');
    assert.equal(ctx.responses[0].body.ready, false);
  } finally { globalThis.fetch = original; }
});

test('dedicated bridge upstream uses only server credentials and preserves honest readiness', async () => {
  const original = globalThis.fetch;
  const ctx = context({ bridgeProxyUrl: 'http://127.0.0.1:18082', proxyToken: 'synthetic-test-token', proxyOrigin: 'http://127.0.0.1:18082' });
  ctx.req.headers.authorization = 'Bearer browser-value';
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url.port, '18082');
      assert.equal(options.headers.Authorization, 'Bearer synthetic-test-token');
      assert.equal(options.headers.Origin, 'http://127.0.0.1:18082');
      assert.equal(options.redirect, 'error');
      return { status: 200, json: async () => ({ ready: false, code: 'pfusdc_beacon_anchor_unavailable' }) };
    };
    await handleBridgeRoutes(ctx);
    assert.equal(ctx.responses[0].body.code, 'pfusdc_beacon_anchor_unavailable');
    assert.ok(!JSON.stringify(ctx.responses).includes('synthetic-test-token'));
  } finally { globalThis.fetch = original; }
});

test('invalid dedicated upstream and logged-out requests cannot reach upstream', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('must not fetch'); };
    for (const bridgeProxyUrl of ['file:///tmp/x', 'https://user:password@example.test']) {
      const ctx = context({ bridgeProxyUrl });
      await handleBridgeRoutes(ctx);
      assert.equal(ctx.responses[0].status, 502);
    }
    const ctx = context({ session: null });
    await handleBridgeRoutes(ctx);
    assert.equal(ctx.responses[0].status, 401);
  } finally { globalThis.fetch = original; }
});

test('gateway reaches dedicated HTTP bridge with server auth, and blocks credential echoes', async () => {
  const token = 'synthetic-gateway-bridge-token';
  let echo = false;
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers.origin, 'http://bridge.test');
    assert.equal(req.url, '/api/bridge/readiness?route=ethereum-mainnet-usdc-v1');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(echo ? { unsafe: token } : { ready: false, code: 'anchor_missing' }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const server = createServer();
  const gateway = registerL1Gateway(server, {
    env: { L1_WALLET_PROXY_URL: 'ws://127.0.0.1:1/rpc',
      L1_BRIDGE_PROXY_URL: `http://127.0.0.1:${upstream.address().port}`,
      L1_BRIDGE_PROXY_ORIGIN: 'http://bridge.test', L1_WALLET_PROXY_TOKEN: token },
    getSession: async () => ({ accountId: 'synthetic', authenticated: true }),
    sessionCookieName: 'sid', cookieValue: () => '', readJson: async () => ({}),
    json: (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); },
  });
  try {
    await gateway.ready;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/l1/bridge/readiness`;
    const response = await fetch(url, { headers: { Authorization: 'Bearer browser-token' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ready: false, code: 'anchor_missing' });
    echo = true;
    const rejected = await fetch(url);
    assert.equal(rejected.status, 502);
    assert.ok(!(await rejected.text()).includes(token));
  } finally {
    gateway.close();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
});
