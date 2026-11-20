// Serves the live Phantom harness on 127.0.0.1:5199 and forwards the bridge API to the wallet server.
import { createServer } from 'vite';
import net from 'node:net';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const origin = process.env.L1_RELAY_PUBLIC_ORIGIN, token = process.env.L1_RELAY_TOKEN;
const body = req => new Promise(resolve => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks))); });
const ledger = request => new Promise((resolve, reject) => {
  const socket = net.connect(39650, '127.0.0.1'); let data = '';
  socket.on('connect', () => socket.write(JSON.stringify({ version: 'postfiat-local-rpc-v1', id: 'h', ...request }) + '\n'));
  socket.on('data', chunk => { data += chunk; if (data.includes('\n')) { socket.end(); resolve(data.split('\n')[0]); } });
  socket.on('error', reject);
});
const server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 5199, strictPort: true }, appType: 'custom',
  plugins: [{ name: 'phantom-live', configureServer(server) { server.middlewares.use(async (req, res, next) => {
    try {
      if (req.url.split('?')[0] === '/phantom-live') {
        const html = await readFile(new URL('../src/features/wallet/l1/bridge/phantom-live.html', import.meta.url), 'utf8');
        res.setHeader('Content-Type', 'text/html');
        return res.end(await server.transformIndexHtml('/src/features/wallet/l1/bridge/phantom-live.html', html));
      }
      if (req.url.startsWith('/api/l1/bridge/')) {
        const payload = req.method === 'POST' ? await body(req) : undefined;
        // The wallet server accepts only its public origin and host.
        const answer = await new Promise((resolve, reject) => {
          const out = http.request({ host: '127.0.0.1', port: 8870, path: req.url, method: req.method,
            headers: { Authorization: 'Bearer ' + token, Origin: origin, Host: new URL(origin).host, 'Content-Type': 'application/json',
              ...(payload && { 'Content-Length': payload.length }) } }, reply => {
            const chunks = []; reply.on('data', c => chunks.push(c)); reply.on('end', () => resolve([reply.statusCode, Buffer.concat(chunks)]));
          });
          out.on('error', reject); out.end(payload);
        });
        res.statusCode = answer[0]; res.setHeader('Content-Type', 'application/json');
        return res.end(answer[1]);
      }
      if (req.url === '/pftl-rpc') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(await ledger(JSON.parse(await body(req))));
      }
    } catch (error) { res.statusCode = 502; return res.end(JSON.stringify({ ok: false, message: String(error) })); }
    next();
  }); } }] });
await server.listen();
console.log('phantom-live harness on http://127.0.0.1:5199/phantom-live');
