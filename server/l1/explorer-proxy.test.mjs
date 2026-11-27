import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorerHandler, explorerTarget } from './explorer-proxy.js';

const q = (text = '') => new URLSearchParams(text);

test('only the listed read paths and query keys pass', () => {
  assert.equal(explorerTarget('/api/l1/explorer/v1/summary', q()), '/summary');
  assert.equal(explorerTarget('/api/l1/explorer/v1/block/1392', q()), '/block/1392');
  assert.equal(explorerTarget('/api/l1/explorer/v1/stream', q('lens=bridge&before=10-0')), '/stream?lens=bridge&before=10-0');
  assert.equal(explorerTarget(`/api/l1/explorer/v1/account/pf${'a'.repeat(40)}`, q()), `/account/pf${'a'.repeat(40)}`);
  for (const bad of ['/api/l1/explorer/v1/tasknode/summary', '/api/l1/explorer/v1/../rpc', '/api/l1/explorer/v1/account/0xabc', '/api/l1/explorer/v2/summary', '/api/l1/explorer/v1/block/abc']) {
    assert.equal(explorerTarget(bad, q()), null, bad);
  }
  assert.equal(explorerTarget('/api/l1/explorer/v1/stream', q('secret=1')), null);
});

function call(handler, { method = 'GET', path, origin } = {}) {
  return new Promise((resolve) => {
    const out = { status: 0, headers: {}, body: '' };
    const res = { writeHead(status, headers) { out.status = status; out.headers = headers; }, end(body) { out.body = body; resolve(out); } };
    const url = new URL(path, 'http://localhost');
    handler({ req: { method, headers: origin ? { origin } : {} }, res, url }).then((handled) => { if (!handled) resolve({ handled: false }); });
  });
}

test('answers are cached, read-only, and CORS is limited to postfiat.org', async () => {
  let calls = 0;
  const fetcher = async (target) => { calls += 1; assert.equal(target, 'http://127.0.0.1:18086/api/explorer/v1/summary'); return { status: 200, text: async () => '{"ok":true,"data":{}}' }; };
  const handler = createExplorerHandler({}, fetcher);
  const first = await call(handler, { path: '/api/l1/explorer/v1/summary', origin: 'https://postfiat.org' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['Access-Control-Allow-Origin'], 'https://postfiat.org');
  assert.equal(first.headers['Cache-Control'], 'public, max-age=5');
  const second = await call(handler, { path: '/api/l1/explorer/v1/summary', origin: 'https://evil.example' });
  assert.equal(second.status, 200);
  assert.equal(second.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(calls, 1);
  assert.equal((await call(handler, { method: 'POST', path: '/api/l1/explorer/v1/summary' })).status, 405);
  assert.equal((await call(handler, { path: '/api/l1/explorer/v1/nope' })).status, 404);
  assert.equal((await call(handler, { path: '/api/l1/other' })).handled, false);
});

test('an unreachable explorer service is a 502, never a hang or a leak', async () => {
  const handler = createExplorerHandler({}, async () => { throw new Error('down'); });
  const out = await call(handler, { path: '/api/l1/explorer/v1/coins' });
  assert.equal(out.status, 502);
  assert.equal(out.body, '{"ok":false,"error":"explorer_unavailable"}');
});
