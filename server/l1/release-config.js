export function l1Enabled(env = process.env) {
  if (env.TASKNODE_L1_ENABLED !== undefined) return env.TASKNODE_L1_ENABLED === 'true';
  return env.NODE_ENV !== 'production' && env.TASKNODE_ENV !== 'production';
}

export function relaySettings(env = process.env) {
  if (!env.L1_RELAY_URL) return null;
  const url = new URL(env.L1_RELAY_URL);
  const local = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('L1 relay requires an HTTPS origin (HTTP loopback is allowed for tests)');
  }
  const token = String(env.L1_RELAY_TOKEN || '');
  if (token.length < 32 || token.length > 16384 || /\s/.test(token)) throw Error('L1 relay credential unavailable');
  return { origin: url.origin, token };
}

// Only server-side archive/registry reads use this transport. Browser method
// permissions remain the gateway's narrower existing allowlist.
export const L1_SERVER_READ_METHODS = new Set([
  'status', 'asset_info', 'navcoin_bridge_routes', 'navcoin_bridge_supply_status',
  'nav_reserve_proof_status', 'book_offers', 'blocks', 'batch_archive', 'receipts', 'tx',
]);

export function relayRead(env = process.env, timeoutMs = 60000) {
  const settings = relaySettings(env);
  if (!settings) return null;
  return async (method, params = {}) => {
    if (!L1_SERVER_READ_METHODS.has(method)) throw Error('L1 relay read method not allowed');
    const response = await fetch(`${settings.origin}/read`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${settings.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    if (!response.ok) throw Error('L1 relay read unavailable');
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) throw Error('L1 relay response too large');
      chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (result.ok !== true) throw Error('L1 relay read failed');
    return result.result;
  };
}
