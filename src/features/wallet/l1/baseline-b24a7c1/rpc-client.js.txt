// Port of wallet-web RPC framing and custody boundary. Requests are never retried
// automatically: a submit timeout can mean an accepted transaction.
import { assertNoCustodyMaterial } from './custody-boundary.js';
import { defaultRpcEndpoint } from './vault.js';
export class RpcClient {
  constructor(url = defaultRpcEndpoint()) { this.url = url; this.pending = new Map(); this.handlers = new Set(); this.counter = 0; this.closed = false; }
  connect() {
    if (this.closed) return Promise.reject(new Error('L1 client closed'));
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url); this.socket = socket;
      const timeout = setTimeout(() => { socket.close(); reject(new Error('L1 connection timed out')); }, 10000);
      socket.onopen = () => { clearTimeout(timeout); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('L1 gateway unavailable; check sign-in and proxy configuration')); };
      socket.onclose = () => { clearTimeout(timeout); this.connecting = null; reject(new Error('L1 connection closed')); for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('L1 connection closed; check receipt before resubmitting')); } this.pending.clear(); };
      socket.onmessage = event => {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        const task = this.pending.get(message.id);
        if (task) { clearTimeout(task.timer); this.pending.delete(message.id); task.resolve(message); }
        else for (const handler of this.handlers) handler(message);
      };
    });
    return this.connecting;
  }
  async call(method, params = {}, timeoutMs = 60000) {
    assertNoCustodyMaterial(params, 'L1 RPC');
    await this.connect();
    if (this.closed) throw new Error('L1 client closed');
    const id = `tn-l1-${++this.counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('L1 RPC timed out; check receipt before resubmitting')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ version: 'postfiat-local-rpc-v1', id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('L1 RPC send failed')); }
    });
  }
  onNotification(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  close() { this.closed = true; this.socket?.close(); this.handlers.clear(); }
}
export function rpcResult(response) {
  if (response?.ok !== true) throw new Error(response?.error?.message || response?.error?.code || 'L1 RPC failed');
  return response.result;
}
