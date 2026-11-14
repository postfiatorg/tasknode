import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { registerL1Gateway } from './gateway.js';

test('gateway recovers only connection-failed writes, sends once and rechecks session after recovery', async () => {
  const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(upstream, 'listening');
  const observed = [], recovered = []; let account = 'alice', switchDuringRecovery = false;
  upstream.on('connection', ws => ws.on('message', data => {
    const request = JSON.parse(data); observed.push(request);
    ws.send(JSON.stringify({ version: request.version, id: request.id, ok: false, error: { code: request.params.error || 'proxy_connection_error' } }));
  }));
  const server = createServer();
  const gateway = registerL1Gateway(server, { env: { L1_WALLET_PROXY_URL: `ws://127.0.0.1:${upstream.address().port}` },
    getSession: async () => ({ accountId: account, authenticated: true }), cookieValue: () => 'fixture', json: () => {}, readJson: async () => ({}),
    recoverSubmit: async request => { recovered.push(request); if (switchDuringRecovery) account = 'bob'; return { tx_id: 'committed', finality: { confirmed: true, receipt: { tx_id: 'committed', accepted: true } } }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new WebSocket(origin.replace('http', 'ws') + '/api/l1/rpc', { origin }); await once(client, 'open');
  let id = 0;
  const send = (method, params = {}) => client.send(JSON.stringify({ version: 'postfiat-local-rpc-v1', id: ++id, method, params }));
  const call = async (method, params) => { const reply = once(client, 'message'); send(method, params); return JSON.parse((await reply)[0]); };
  try {
    assert.equal((await call('account')).ok, false); assert.equal(recovered.length, 0);
    const method = 'mempool_submit_signed_offer_transaction_finality';
    assert.equal((await call(method, { error: 'rejected' })).ok, false); assert.equal(recovered.length, 0);
    assert.equal((await call(method, { signed_offer_transaction_json: '{"public":"signature"}' })).result.tx_id, 'committed');
    assert.equal(recovered.length, 1); assert.equal(observed.length, 3, 'one upstream write per browser request');
    switchDuringRecovery = true;
    const closed = once(client, 'close'); send(method);
    assert.equal((await closed)[0], 1008); assert.equal(observed.length, 4); assert.equal(recovered.length, 2);
  } finally {
    client.terminate(); gateway.close(); for (const ws of upstream.clients) ws.terminate();
    await new Promise(resolve => server.close(resolve)); await new Promise(resolve => upstream.close(resolve));
  }
});
