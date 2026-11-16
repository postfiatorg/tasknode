import { connect } from 'node:net';
import { relayRead } from './release-config.js';
export function readRpc(endpoint, method, params, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    let chunks = [], size = 0, complete = false;
    const fail = error => { socket.destroy(); reject(error); };
    socket.setTimeout(timeoutMs, () => fail(Error('History read timed out')));
    socket.on('error', fail);
    socket.on('close', () => { if (!complete) reject(Error(`History ${method} connection ended before a complete response`)); });
    socket.on('connect', () => socket.write(JSON.stringify({ version: 'postfiat-local-rpc-v1', id: 'wallet-history', method, params }) + '\n'));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { fail(Error('History response too large')); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      complete = true;
      socket.destroy();
      try { const response = JSON.parse(Buffer.concat(chunks).toString().split('\n')[0]); chunks = [];
        if (response.ok !== true) throw Error(`History ${method} could not be read`);
        resolve(response.result);
      } catch (error) { reject(error); }
    });
  });
}
export function localRpc(env = process.env, timeoutMs = 60000) {
 const remote = relayRead(env, timeoutMs);
 if (remote) return remote;
 const endpoint = new URL(env.L1_HISTORY_RPC_URL);
 if (endpoint.protocol !== 'tcp:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || !endpoint.port || endpoint.username || endpoint.password) throw Error('NAVCoin RPC must be a loopback TCP endpoint');
 return (method, params = {}) => readRpc(endpoint, method, params, timeoutMs);
}
