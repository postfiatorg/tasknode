import { readFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { requestOriginFromBoundary } from '../trusted-proxy.js';
import { l1Enabled, relaySettings } from './release-config.js';
import { findCustodyMaterial } from '../../src/features/wallet/l1/lib/custody-boundary.js';
import { handlePrivateRoutes } from './private-routes.js';
import { handleBridgeRoutes } from './bridge-routes.js';
import { handleNavcoinRoutes } from './navcoin-routes.js';
import { createHistoryReader } from './history.js';
import { createSubmitRecovery } from './submit-recovery.js';
import { createProfileHandler } from './navcoin-profile.js';

import { L1_READ_METHODS, L1_SUBMIT_METHODS } from '../../src/features/wallet/l1/lib/rpc-methods.js';
const MAX_BYTES = 1024 * 1024;
const signedIn = session => Boolean(session?.accountId && (session?.authenticated === true || session?.status === 'signed_in'));
const sameOrigin = (req, env) => req.headers.origin === requestOriginFromBoundary(req, env);
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
export function registerL1Gateway(server, { getSession, sessionCookieName, cookieValue, json, readJson, env = process.env, recoverSubmit = createSubmitRecovery(env) }) {
  const enabled = l1Enabled(env);
  const relay = enabled ? relaySettings(env) : null;
  // Snapshot credentials at registration/startup, never from browser input.
  const proxyOrigin = proxyOriginFromEnv(env);
  const credentials = (relay ? Promise.resolve('') : readProxyToken(env)).then(token => ({ token })).catch(() => null);
  const sessions = new Set();
  const readHistory = createHistoryReader(env);
  const handleProfile = createProfileHandler();
  const authenticate = req => getSession(cookieValue(req, sessionCookieName));
  const handlers = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { json(res, 400, { error: 'l1_invalid_url' }); return; }
    if (!url.pathname.startsWith('/api/l1/')) { for (const handler of handlers) handler(req, res); return; }
    if (!enabled) { json(res, 404, { error: 'l1_unavailable' }); return; }
    void (async () => {
      res.setHeader('cache-control', 'no-store');
      if (await handleProfile({ req, res, url, json })) return;
      const session = await authenticate(req);
      if (!signedIn(session)) { json(res, 401, { error: 'l1_login_required' }); return; }
      if (url.pathname === '/api/l1/history' && req.method === 'GET') {
        if (!readHistory) { json(res, 503, { error: 'History recovery is unavailable' }); return; }
        try { json(res, 200, await readHistory(url.searchParams.get('address') || '', url.searchParams.get('limit'))); }
        catch (error) { json(res, 502, { error: error.message }); }
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req, env)) { json(res, 403, { error: 'l1_origin_rejected' }); return; }
      const context = { req, res, url, session, json, readJson, proxyUrl: env.L1_WALLET_PROXY_URL || '' };
      if (url.pathname.startsWith('/api/l1/private/')) return handlePrivateRoutes({ ...context, env, relay });
      if (url.pathname.startsWith('/api/l1/bridge/')) {
        const credential = await credentials;
        if (!credential) { json(res, 503, { error: 'l1_proxy_credential_unavailable' }); return; }
        if (await handleBridgeRoutes({ ...context, env, bridgeProxyUrl: relay?.origin || env.L1_BRIDGE_PROXY_URL || '',
          proxyToken: relay?.token || credential.token, proxyOrigin: relay?.origin || env.L1_BRIDGE_PROXY_ORIGIN || proxyOrigin,
          bridgePathPrefix: relay ? '/api/l1/bridge' : '/api/bridge', withdrawViaRelay: Boolean(relay) })) return;
      }
      if (await handleNavcoinRoutes(context)) return;
      json(res, url.pathname === '/api/l1/rpc' ? 426 : 404, { error: url.pathname === '/api/l1/rpc' ? 'l1_websocket_required' : 'l1_route_not_found' });
    })().catch(() => { if (!res.headersSent) json(res, 502, { error: 'l1_gateway_unavailable' }); else res.destroy(); });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    if (!enabled || req.url !== '/api/l1/rpc') { reject('404 Not Found'); return; }
    void (async () => {
      if (!sameOrigin(req, env)) { reject('403 Forbidden'); return; }
      const session = await authenticate(req);
      if (!signedIn(session)) { reject('401 Unauthorized'); return; }
      if (!relay && !env.L1_WALLET_PROXY_URL) { reject('503 Service Unavailable'); return; }
      const upstreamUrl = proxyWebSocketUrl(relay ? `${relay.origin}/api/l1/rpc` : env.L1_WALLET_PROXY_URL);
      const authentication = await credentials;
      if (!authentication) { reject('503 Service Unavailable'); return; }
      const proxyToken = authentication.token;
      wss.handleUpgrade(req, socket, head, client => {
        sessions.add(client);
        const upstream = new WebSocket(upstreamUrl, { maxPayload: MAX_BYTES, handshakeTimeout: 10000,
          ...(relay ? { origin: relay.origin, headers: { Authorization: `Bearer ${relay.token}` } } : proxyOrigin ? { origin: proxyOrigin } : {}) });
        let queue = Promise.resolve();
        const submissions = new Map();
        const opened = new Promise((resolve, rejectOpen) => { upstream.once('open', resolve); upstream.once('error', rejectOpen); });
        opened.catch(() => {});
        const stop = () => { submissions.clear(); sessions.delete(client); if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate(); else upstream.close(); };
        client.on('close', stop);
        client.on('error', stop);
        upstream.on('error', () => client.close(1011, 'L1 proxy unavailable'));
        upstream.on('close', () => client.close(1011, 'L1 proxy disconnected'));
        const current = async () => { const latest = await authenticate(req); return signedIn(latest) && latest.accountId === session.accountId; };
        upstream.on('message', data => {
          void (async () => {
            if (!await current()) { client.close(1008, 'L1 session changed'); return; }
            let payload = data.toString();
            if ((proxyToken && payload.includes(proxyToken)) || (relay && payload.includes(relay.token))) { client.close(1011, 'Unsafe L1 proxy response'); return; }
            const response = JSON.parse(payload), submitted = submissions.get(response.id);
            submissions.delete(response.id);
            if (submitted && response.ok === false && response.error?.code === 'proxy_connection_error' && recoverSubmit) {
              const recovered = await recoverSubmit(submitted).catch(() => null);
              if (!await current()) { client.close(1008, 'L1 session changed'); return; }
              if (recovered) payload = JSON.stringify({ version: response.version, id: response.id, ok: true, result: recovered });
            }
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
            if (submissions.has(request.id)) { client.close(1008, 'Duplicate L1 request id'); return; }
            if (L1_SUBMIT_METHODS.has(request.method)) {
              if (submissions.size >= 8) { client.close(1008, 'Too many pending submissions'); return; }
              submissions.set(request.id, request);
            }
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
