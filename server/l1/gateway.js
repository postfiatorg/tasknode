import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { requestOrigin } from '../server-http-boundary.js';
import { findCustodyMaterial } from '../../src/features/wallet/l1/lib/custody-boundary.js';
import { handleBridgeRoutes } from './bridge-routes.js';
import { handleNavcoinRoutes } from './navcoin-routes.js';

import { L1_READ_METHODS, L1_SUBMIT_METHODS } from '../../src/features/wallet/l1/lib/rpc-methods.js';
const MAX_BYTES = 1024 * 1024;
const signedIn = session => Boolean(session?.accountId && (session?.authenticated === true || session?.status === 'signed_in'));
const sameOrigin = req => req.headers.origin === requestOrigin(req);
export async function readProxyToken(env = process.env) {
  let token = String(env.L1_WALLET_PROXY_TOKEN || '').trim();
  if (env.L1_WALLET_PROXY_TOKEN_FILE) {
    let content;
    try { content = (await readFile(env.L1_WALLET_PROXY_TOKEN_FILE, 'utf8')).trim(); }
    catch { throw new Error('L1 proxy credential file unavailable'); }
    if (/^[{["]/.test(content)) {
      try {
        const parsed = JSON.parse(content);
        token = typeof parsed === 'string' ? parsed : parsed?.['local-demo'];
      } catch { throw new Error('L1 proxy credential file invalid'); }
    } else token = content;
    if (typeof token !== 'string' || !token.trim()) throw new Error('L1 proxy credential file invalid');
    token = token.trim();
  }
  if (token.length > 16384 || Array.from(token).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) throw new Error('L1 proxy credential invalid');
  return token;
}
function proxyOriginFromEnv(env) {
  const origin = String(env.L1_WALLET_PROXY_ORIGIN || '').trim();
  if (!origin) return '';
  try {
    const parsed = new URL(origin);
    if (['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin) return origin;
  } catch { /* Report only the configuration error, never its value. */ }
  throw new Error('L1 proxy Origin configuration invalid');
}
function proxyWebSocketUrl(value) {
  const url = new URL(value);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid proxy URL');
  return url.toString();
}
function validateRequest(request) {
  if (!request || Array.isArray(request) || request.version !== 'postfiat-local-rpc-v1'
    || !['string', 'number'].includes(typeof request.id)
    || typeof request.method !== 'string' || !request.params || Array.isArray(request.params) || typeof request.params !== 'object') return 'l1_invalid_request';
  if (!L1_READ_METHODS.has(request.method) && !L1_SUBMIT_METHODS.has(request.method)) return 'l1_method_not_allowed';
  if (findCustodyMaterial(request.params).length) return 'l1_custody_material_rejected';
  return null;
}
export function registerL1Gateway(server, { getSession, sessionCookieName, cookieValue, json, readJson, env = process.env }) {
  // Snapshot credentials at registration/startup, never from browser input.
  const proxyOrigin = proxyOriginFromEnv(env);
  const credentials = readProxyToken(env).then(token => ({ token })).catch(() => null);
  const sessions = new Set();
  const authenticate = req => getSession(cookieValue(req, sessionCookieName));
  const handlers = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { json(res, 400, { error: 'l1_invalid_url' }); return; }
    if (!url.pathname.startsWith('/api/l1/')) { for (const handler of handlers) handler(req, res); return; }
    void (async () => {
      res.setHeader('cache-control', 'no-store');
      const session = await authenticate(req);
      if (!signedIn(session)) { json(res, 401, { error: 'l1_login_required' }); return; }
      if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) { json(res, 403, { error: 'l1_origin_rejected' }); return; }
      const context = { req, res, url, session, json, readJson, proxyUrl: env.L1_WALLET_PROXY_URL || '' };
      if (url.pathname.startsWith('/api/l1/bridge/')) {
        const credential = await credentials;
        if (!credential) { json(res, 503, { error: 'l1_proxy_credential_unavailable' }); return; }
        if (await handleBridgeRoutes({ ...context, bridgeProxyUrl: env.L1_BRIDGE_PROXY_URL || '',
          proxyToken: credential.token, proxyOrigin: env.L1_BRIDGE_PROXY_ORIGIN || proxyOrigin })) return;
      }
      if (await handleNavcoinRoutes(context)) return;
      json(res, url.pathname === '/api/l1/rpc' ? 426 : 404, { error: url.pathname === '/api/l1/rpc' ? 'l1_websocket_required' : 'l1_route_not_found' });
    })().catch(() => { if (!res.headersSent) json(res, 502, { error: 'l1_gateway_unavailable' }); else res.destroy(); });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    if (req.url !== '/api/l1/rpc') { reject('404 Not Found'); return; }
    void (async () => {
      if (!sameOrigin(req)) { reject('403 Forbidden'); return; }
      const session = await authenticate(req);
      if (!signedIn(session)) { reject('401 Unauthorized'); return; }
      if (!env.L1_WALLET_PROXY_URL) { reject('503 Service Unavailable'); return; }
      const upstreamUrl = proxyWebSocketUrl(env.L1_WALLET_PROXY_URL);
      const authentication = await credentials;
      if (!authentication) { reject('503 Service Unavailable'); return; }
      const proxyToken = authentication.token;
      wss.handleUpgrade(req, socket, head, client => {
        sessions.add(client);
        const upstream = new WebSocket(upstreamUrl, { maxPayload: MAX_BYTES, handshakeTimeout: 10000,
          ...(proxyOrigin ? { origin: proxyOrigin } : {}) });
        let queue = Promise.resolve();
        const opened = new Promise((resolve, rejectOpen) => { upstream.once('open', resolve); upstream.once('error', rejectOpen); });
        opened.catch(() => {});
        const stop = () => { sessions.delete(client); if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream.close(); };
        client.on('close', stop);
        client.on('error', stop);
        upstream.on('error', () => client.close(1011, 'L1 proxy unavailable'));
        upstream.on('close', () => client.close(1011, 'L1 proxy disconnected'));
        const current = async () => { const latest = await authenticate(req); return signedIn(latest) && latest.accountId === session.accountId; };
        upstream.on('message', data => {
          void (async () => {
            if (!await current()) { client.close(1008, 'L1 session changed'); return; }
            const payload = data.toString();
            if (proxyToken && payload.includes(proxyToken)) { client.close(1011, 'Unsafe L1 proxy response'); return; }
            if (client.readyState === WebSocket.OPEN) client.send(payload);
          })().catch(() => client.close(1011, 'L1 session unavailable'));
        });
        let queued = 0;
        client.on('message', (data, binary) => {
          if (binary || ++queued > 32) { client.close(1008, 'Invalid L1 request'); return; }
          queue = queue.then(async () => {
            if (!await current()) { client.close(1008, 'L1 session changed'); return; }
            let request;
            try { request = JSON.parse(data.toString()); } catch { client.close(1008, 'Invalid L1 JSON'); return; }
            const error = validateRequest(request);
            if (error) { client.send(JSON.stringify({ version: 'postfiat-local-rpc-v1', id: request?.id ?? null, ok: false, error: { code: error, message: error } })); return; }
            await opened;
            if (!await current() || client.readyState !== WebSocket.OPEN) { client.close(1008, 'L1 session changed'); return; }
            // Rebuild the envelope: browser-supplied proxy credentials and unknown fields never pass through.
            upstream.send(JSON.stringify({ version: request.version, id: request.id, method: request.method, params: request.params,
              ...(proxyToken ? { proxy_auth_token: proxyToken } : {}) }));
          }).catch(() => client.close(1011, 'L1 gateway unavailable')).finally(() => { queued -= 1; });
        });
      });
    })().catch(() => reject('503 Service Unavailable'));
  });
  server.on('close', () => { for (const client of sessions) client.close(1001, 'Server stopping'); wss.close(); });
  return { ready: credentials.then(Boolean), close: () => { for (const client of sessions) client.close(); wss.close(); } };
}
