import { relaySettings } from './release-config.js';

// Public, read-only block explorer data for postfiat.org. No session: everything served here is
// already public on the ledger. Only GET, only the paths below, answers cached briefly so page
// views never become validator reads.
const PREFIX = '/api/l1/explorer/v1';
const ALLOWED = [
  /^\/(summary|blocks|stream|coins|journeys|private|network|search)$/,
  /^\/block\/\d{1,12}$/,
  /^\/tx\/[0-9a-f-]{3,96}$/,
  /^\/account\/pf[0-9a-f]{40}$/,
  /^\/coin\/[0-9A-Za-z]{1,96}$/,
  /^\/journey\/[a-z]{3,12}\/[0-9a-f-]{3,96}$/,
];
const QUERY_KEYS = new Set(['lens', 'before', 'kind', 'rejected', 'asset', 'q']);
const ORIGINS = new Set(['https://postfiat.org', 'https://www.postfiat.org']);
const TTL_MS = 5000;
const MAX_ENTRIES = 600;
const MAX_ACTIVE = 12;

export function explorerTarget(pathname, searchParams) {
  if (!pathname.startsWith(`${PREFIX}/`)) return null;
  const path = pathname.slice(PREFIX.length);
  if (!ALLOWED.some((pattern) => pattern.test(path))) return null;
  const query = new URLSearchParams();
  for (const [key, value] of searchParams) {
    if (!QUERY_KEYS.has(key) || value.length > 128) return null;
    query.append(key, value);
  }
  const text = query.toString();
  return `${path}${text ? `?${text}` : ''}`;
}

export function createExplorerHandler(env = process.env, fetcher = fetch) {
  const relay = relaySettings(env);
  const local = (env.L1_EXPLORER_URL || 'http://127.0.0.1:18086/api/explorer/v1').replace(/\/$/, '');
  const cache = new Map();
  let active = 0;
  return async function handleExplorer({ req, res, url }) {
    if (!url.pathname.startsWith(PREFIX)) return false;
    const origin = req.headers.origin;
    const headers = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
    if (ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const send = (status, body, cacheControl = 'no-store') => { res.writeHead(status, { ...headers, 'Cache-Control': cacheControl }); res.end(body); return true; };
    if (req.method === 'OPTIONS') return send(204, '');
    if (req.method !== 'GET') return send(405, '{"ok":false,"error":"explorer_read_only"}');
    const target = explorerTarget(url.pathname, url.searchParams);
    if (!target) return send(404, '{"ok":false,"error":"not_found"}');
    const hit = cache.get(target);
    if (hit && Date.now() - hit.at < TTL_MS) return send(hit.status, hit.body, 'public, max-age=5');
    if (active >= MAX_ACTIVE) return hit ? send(hit.status, hit.body, 'public, max-age=5') : send(503, '{"ok":false,"error":"explorer_busy"}');
    active += 1;
    try {
      const response = await fetcher(relay ? `${relay.origin}/explorer${target}` : `${local}${target}`, {
        redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', ...(relay ? { Authorization: `Bearer ${relay.token}` } : {}) },
      });
      const body = await response.text();
      if (relay && body.includes(relay.token)) throw new Error('Unsafe explorer response');
      JSON.parse(body);
      const status = [200, 400, 404].includes(response.status) ? response.status : 502;
      if (status !== 502) {
        if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(target, { at: Date.now(), status, body });
      }
      return send(status, status === 502 ? '{"ok":false,"error":"explorer_unavailable"}' : body, status === 200 ? 'public, max-age=5' : 'no-store');
    } catch {
      return hit ? send(hit.status, hit.body, 'no-store') : send(502, '{"ok":false,"error":"explorer_unavailable"}');
    } finally { active -= 1; }
  };
}
