import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { solanaPath } from './solana-bridge.js';
import { registerL1Gateway } from './gateway.js';
import { localRpc } from './read-rpc.js';
import { getNavcoinRegistry } from './navcoin-registry.js';
import { L1_SERVER_READ_METHODS, relaySettings } from './release-config.js';
import { findCustodyMaterial } from '../../src/features/wallet/l1/lib/custody-boundary.js';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function readJson(req, maxBytes = 16384) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

// Run only on the trusted host which already reaches wallet-proxy and its
// validator tunnels. A TLS reverse proxy must forward to this loopback listener.
// No wallet keys, signer, governance methods or arbitrary destinations exist here.
export function createRelayServer(env = process.env, injectedRead) {
  const settings = relaySettings({ ...env, L1_RELAY_URL: env.L1_RELAY_PUBLIC_ORIGIN });
  if (!settings || !env.L1_WALLET_PROXY_URL || !env.L1_WALLET_PROXY_ORIGIN
      || (!env.L1_WALLET_PROXY_TOKEN && !env.L1_WALLET_PROXY_TOKEN_FILE)) throw Error('L1 relay configuration incomplete');
  const expected = Buffer.from(`Bearer ${settings.token}`);
  const authorized = req => {
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const rpc = injectedRead || localRpc({ ...env, L1_RELAY_URL: '' });
  const inner = new EventEmitter();
  const gateway = registerL1Gateway(inner, {
    env: { ...env, L1_RELAY_URL: '', TASKNODE_L1_ENABLED: 'true', TASKNODE_PUBLIC_URL: settings.origin },
    getSession: async () => ({ accountId: 'relay-service', authenticated: true }),
    cookieValue: () => '', json, readJson, recoverSubmit: null,
  });
  // The coin list is read here, beside the validators, and kept warm so the public site gets it in one request.
  const registry = () => injectedRead ? Promise.reject(Error('unavailable')) : getNavcoinRegistry({ ...env, L1_RELAY_URL: '' });
  const warm = injectedRead ? null : setInterval(() => { registry().catch(() => {}); }, 10000);
  warm?.unref();
  let activeReads = 0;
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (!authorized(req)) { json(res, 401, { error: 'relay_auth_required' }); return; }
    if (req.url === '/health' && req.method === 'GET') { json(res, 200, { ok: true }); return; }
    if (req.url === '/registry' && req.method === 'GET') {
      registry().then(coins => {
        if (JSON.stringify(coins).includes(settings.token)) throw Error('Unsafe response');
        json(res, 200, { ok: true, coins });
      }).catch(() => { if (!res.headersSent) json(res, 502, { error: 'relay_registry_unavailable' }); else res.destroy(); });
      return;
    }
    if (req.url === '/read' && req.method === 'POST') {
      if (activeReads >= 16) { json(res, 429, { error: 'relay_busy' }); return; }
      activeReads++;
      void (async () => {
        const body = await readJson(req);
        if (!body || Array.isArray(body) || Object.keys(body).some(key => !['method', 'params'].includes(key))
            || !L1_SERVER_READ_METHODS.has(body.method) || !body.params || typeof body.params !== 'object'
            || Array.isArray(body.params) || findCustodyMaterial(body.params).length) {
          json(res, 400, { error: 'relay_read_not_allowed' }); return;
        }
        const result = await rpc(body.method, body.params);
        if (JSON.stringify(result).includes(settings.token)) throw Error('Unsafe response');
        json(res, 200, { ok: true, result });
      })().catch(() => { if (!res.headersSent) json(res, 502, { error: 'relay_read_unavailable' }); else res.destroy(); })
        .finally(() => { activeReads--; });
      return;
    }
    if (/^\/api\/l1\/bridge\/(?:readiness(?:\?route=ethereum-mainnet-usdc-v1)?|jobs(?:\/0x[0-9a-f]{64})?|(?:solana\/)?withdrawals(?:\/readiness|\/[0-9a-f]{96})?|faucet)$/.test(req.url) ||
        (req.url.startsWith('/api/l1/bridge/solana/') && solanaPath(req.url.slice('/api/l1/bridge'.length)))) {
      inner.emit('request', req, res); return;
    }
    json(res, 404, { error: 'relay_route_not_found' });
  });
  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req) || req.headers.origin !== settings.origin || req.url !== '/api/l1/rpc') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    if (sockets.size >= 64) { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    inner.emit('upgrade', req, socket, head);
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.on('close', () => { clearInterval(warm); gateway.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.L1_RELAY_PORT || 8870);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid relay port');
  const server = createRelayServer();
  server.listen(port, '127.0.0.1', () => console.log('L1 relay listening on loopback'));
}
