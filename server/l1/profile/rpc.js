import { connect } from 'node:net';
import { relayRead } from '../release-config.js';
export function createProfileRpc(env = process.env) {
  const remote = relayRead(env, 45000);
  if (remote) return remote;
  const endpoint = new URL(env.L1_PROFILE_RPC_URL || env.L1_HISTORY_RPC_URL || 'tcp://127.0.0.1:39655');
  if (endpoint.protocol !== 'tcp:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || !endpoint.port || endpoint.username || endpoint.password) throw Error('Profile RPC must use a local validator tunnel');
  return (method, params = {}) => new Promise((resolve, reject) => {
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    let chunks = [], size = 0, finished = false;
    const fail = error => { finished = true; socket.destroy(); reject(error); };
    socket.setTimeout(45000, () => fail(Error(`Validator ${method} read timed out`)));
    socket.on('error', fail);
    socket.on('close', () => { if (!finished) fail(Error(`Validator ${method} response incomplete`)); });
    socket.on('connect', () => socket.write(JSON.stringify({ version: 'postfiat-local-rpc-v1', id: 'navcoin-profile', method, params }) + '\n'));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) return fail(Error('Validator response too large'));
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      finished = true; socket.destroy();
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString().split('\n')[0]); chunks = [];
        if (!response.ok) throw Error(`Validator ${method} read unavailable: ${String(response.error?.message || response.error?.code || 'unknown').slice(0, 300)}`);
        resolve(response.result);
      } catch (error) { reject(error); }
    });
  });
}
export function memoRead(fn, ttl = 60000) {
  const entries = new Map();
  return (...args) => {
    const key = JSON.stringify(args), prior = entries.get(key);
    if (prior && prior.expires > Date.now()) return prior.promise;
    const entry = { expires: Infinity, promise: null };
    entry.promise = Promise.resolve().then(() => fn(...args)).then(value => { entry.expires = Date.now() + ttl; return value; }, error => { entries.delete(key); throw error; });
    entries.set(key, entry); return entry.promise;
  };
}
