import { findCustodyMaterial } from '../../src/features/wallet/l1/lib/custody-boundary.js';

const ROOT = '/api/l1/pq/';
const ROUTES = new Map([
  ['snapshot', { maxRequestBytes: 4 * 1024, timeoutMs: 30_000 }],
  ['page', { maxRequestBytes: 4 * 1024, timeoutMs: 30_000 }],
  ['authorize', { maxRequestBytes: 4 * 1024, timeoutMs: 30_000 }],
  ['submit', { maxRequestBytes: 1024 * 1024, timeoutMs: 120_000 }],
  ['receipt', { maxRequestBytes: 8 * 1024, timeoutMs: 30_000 }],
]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function isPqRoute(pathname) {
  if (!pathname.startsWith(ROOT)) return false;
  return ROUTES.has(pathname.slice(ROOT.length));
}

async function readBodyBytes(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(Error('Request too large'), { statusCode: 413, code: 'pq_request_too_large' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(Error('Request too large'), { statusCode: 413, code: 'pq_request_too_large' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBoundedResponse(response, forbiddenTokens) {
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) throw Error('Oversized PQ response');
      chunks.push(chunk);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  for (const token of forbiddenTokens) {
    if (token && text.includes(token)) throw Error('Unsafe PQ response');
  }
  const payload = JSON.parse(text);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Invalid PQ response');
  if (findCustodyMaterial(payload).length) throw Error('Unsafe PQ response');
  return payload;
}

export async function handlePqRoutes({
  req,
  res,
  url,
  session,
  json,
  proxyUrl = '',
  bridgeProxyUrl = '',
  proxyToken = '',
  proxyOrigin = '',
  pqPathPrefix = '/api/private/v1/pq',
  transport = fetch,
}) {
  if (!url.pathname.startsWith(ROOT)) return false;
  res.setHeader('Cache-Control', 'no-store');
  const fail = (status, code, message) => {
    json(res, status, { ok: false, code, message });
    return true;
  };
  if (!session?.accountId) return fail(401, 'l1_login_required', 'Sign in to use private payments.');
  const route = url.pathname.slice(ROOT.length);
  const spec = ROUTES.get(route);
  if (!spec) return fail(404, 'pq_route_not_found', 'Unknown private payment endpoint.');
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST required.');
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') return fail(415, 'json_required', 'application/json required.');

  const target = bridgeProxyUrl || proxyUrl;
  if (!target) return fail(503, 'pq_proxy_unconfigured', 'Private payment proxy is not configured.');

  let rawBytes;
  let parsed;
  try {
    rawBytes = await readBodyBytes(req, spec.maxRequestBytes);
    parsed = JSON.parse(rawBytes.toString('utf8'));
  } catch (err) {
    if (err?.statusCode === 413) return fail(413, 'pq_request_too_large', 'Request exceeds private payment size limit.');
    return fail(400, 'pq_request_invalid', 'Invalid JSON body.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(400, 'pq_request_invalid', 'JSON object required.');
  }
  if (findCustodyMaterial(parsed).length) {
    return fail(400, 'l1_custody_material_rejected', 'Private wallet material cannot be sent to a gateway.');
  }

  try {
    const upstream = new URL(target);
    if (upstream.protocol === 'ws:') upstream.protocol = 'http:';
    if (upstream.protocol === 'wss:') upstream.protocol = 'https:';
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) {
      throw Error('Invalid PQ proxy URL');
    }
    upstream.pathname = `${pqPathPrefix.replace(/\/$/, '')}/${route}`;
    upstream.search = '';
    upstream.hash = '';

    const response = await transport(upstream.toString(), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(spec.timeoutMs),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(proxyToken ? { Authorization: `Bearer ${proxyToken}` } : {}),
        ...(proxyOrigin ? { Origin: proxyOrigin } : {}),
      },
      body: rawBytes,
    });
    const payload = await readBoundedResponse(response, [proxyToken]);
    json(res, response.status, payload);
    return true;
  } catch {
    return fail(502, 'pq_upstream_unavailable', 'Private payment service is unreachable.');
  }
}
