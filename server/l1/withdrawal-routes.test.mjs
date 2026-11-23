import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { createRelayServer } from './relay.js';
import { registerL1Gateway } from './gateway.js';
import { solanaWithdrawalOrigin } from './release-config.js';

const path = '/api/l1/bridge/solana/withdrawals';
const burn = 'ab'.repeat(48);
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return 'http://127.0.0.1:' + server.address().port;
}
const close = server => new Promise(resolve => server.close(resolve));
const wallet = () => bs58.encode(Buffer.from(generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, 'base64url'));
const OWNER = 'pf' + '1'.repeat(40);
const burnTx = (id, from = OWNER, accepted = true) => ({ tx_id: id, confirmed: true, receipt: { tx_id: id, accepted },
  transaction_rows: [{ tx_id: id, transaction_kind: 'vault_bridge_burn_to_redeem', from, accepted }] });
async function stack(t, enabled, accounts = {}, chain = { [burn]: burnTx(burn) }) {
  const seen = [], lookups = [], token = randomBytes(32).toString('hex');
  // A stub Solana JSON-RPC: each address answers with its fixture account, null, or an RPC failure.
  const solana = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks));
    lookups.push({ method, key: params[0], commitment: params[1]?.commitment });
    const account = accounts[params[0]];
    if (account === 'fail') return json(res, 500, { jsonrpc: '2.0', id, error: { code: -32005, message: 'node is behind' } });
    json(res, 200, { jsonrpc: '2.0', id, result: { context: { slot: 9 }, value: account ? { lamports: 1, owner: account.owner,
      executable: account.executable === true, rentEpoch: 0, data: ['', 'base64'] } : null } });
  });
  const rpcOrigin = await listen(solana);
  const payout = createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    seen.push({ url: req.url, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url.endsWith('/readiness')) return json(res, 200, { ok: true, ready: false, message: 'vault paused' });
    json(res, req.method === 'POST' ? 202 : 200, { stage: 'queued', burn_tx_id: burn });
  });
  const upstream = await listen(payout);
  const reservation = createServer(), relayOrigin = await listen(reservation); await close(reservation);
  // The chain read behind the relay: `tx` answers from the fixture burns, anything else fails.
  const read = async (method, params) => { if (method === 'tx' && chain[params.tx_id]) return chain[params.tx_id]; throw Error('unknown'); };
  const relay = createRelayServer({ L1_RELAY_PUBLIC_ORIGIN: relayOrigin, L1_RELAY_TOKEN: token,
    L1_WALLET_PROXY_URL: 'ws://127.0.0.1:1', L1_WALLET_PROXY_TOKEN: 'fixture', L1_WALLET_PROXY_ORIGIN: relayOrigin,
    L1_SOLANA_WITHDRAWALS_ENABLED: enabled, L1_SOLANA_WITHDRAW_SERVICE_URL: upstream, L1_SOLANA_RPC_URL: rpcOrigin }, read);
  relay.listen(Number(new URL(relayOrigin).port), '127.0.0.1'); await once(relay, 'listening');
  const server = createServer();
  const gateway = registerL1Gateway(server, { env: { TASKNODE_L1_ENABLED: 'true', L1_RELAY_URL: relayOrigin, L1_RELAY_TOKEN: token },
    cookieValue: req => req.headers.cookie, getSession: async cookie => cookie ? { authenticated: true, accountId: cookie } : null,
    json, readJson: async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)); } });
  const origin = await listen(server);
  t.after(async () => { gateway.close(); await close(server); await close(relay); await close(payout); await close(solana); });
  const headers = { Cookie: 'fixture=' + randomBytes(8).toString('hex'), Origin: origin, 'Content-Type': 'application/json', 'X-L1-Owner': OWNER };
  return { seen, lookups, relayOrigin, payout, get: (suffix, changes) => fetch(origin + path + suffix, { headers: { ...headers, ...changes } }),
    post: (body, changes) => fetch(origin + path, { method: 'POST', headers: { ...headers, ...changes }, body }) };
}

test('Solana withdrawal setting defaults closed and requires a loopback HTTP origin', () => {
  for (const setting of [undefined, 'https://remote.test', 'http://127.0.0.1/path', 'http://user@127.0.0.1:12']) {
    assert.equal(solanaWithdrawalOrigin({ L1_SOLANA_WITHDRAWALS_ENABLED: 'true', L1_SOLANA_WITHDRAW_SERVICE_URL: setting }), null);
  }
});
test('disabled relay returns unavailable without contacting the payout service', async t => {
  const { get, post, seen } = await stack(t);
  assert.deepEqual(await (await get('/readiness')).json(), { ok: true, ready: false, enabled: false, message: 'Solana withdrawals are not available yet' });
  assert.equal((await post(JSON.stringify({ burn_tx_id: burn }))).status, 503);
  assert.equal((await get('/' + burn)).status, 503);
  assert.equal((await get('/recipient/' + wallet())).status, 503);
  assert.deepEqual(seen, []);
});
test('the relay looks the recipient up at finalized commitment and allows only a wallet', async t => {
  const fresh = wallet(), plain = wallet(), token = wallet(), stake = wallet(), program = wallet(), held = wallet(), broken = wallet();
  const system = '11111111111111111111111111111111';
  const { get, lookups, seen } = await stack(t, 'true', { [plain]: { owner: system }, [token]: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    [stake]: { owner: 'Stake11111111111111111111111111111111111111' }, [program]: { owner: 'BPFLoaderUpgradeab1e11111111111111111111111', executable: true },
    [held]: { owner: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc' }, [broken]: 'fail' });
  const check = async key => { const response = await get('/recipient/' + key); return [response.status, await response.json()]; };
  assert.deepEqual(await check(fresh), [200, { ok: true, recipient: fresh, allowed: true, kind: 'wallet' }]);
  assert.deepEqual(await check(plain), [200, { ok: true, recipient: plain, allowed: true, kind: 'wallet' }]);
  for (const [key, kind] of [[token, 'token_account'], [stake, 'stake_account'], [program, 'program'], [held, 'program_owned']]) {
    assert.deepEqual(await check(key), [200, { ok: true, recipient: key, allowed: false, kind }]);
  }
  const [status, body] = await check(broken);
  assert.equal(status, 503); assert.equal(body.code, 'solana_recipient_unchecked');
  assert.deepEqual(lookups.map(row => [row.method, row.commitment]), Array(7).fill(['getAccountInfo', 'finalized']));
  assert.deepEqual(lookups.map(row => row.key), [fresh, plain, token, stake, program, held, broken]);
  // An off-curve address (here the zero-padded fixture used before) is refused without a lookup.
  const offCurve = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i < 2 ? 0 : i + 128));
  assert.deepEqual(await check(offCurve), [200, { ok: true, recipient: offCurve, allowed: false, kind: 'off_curve' }]);
  assert.equal((await get('/recipient/0OIl')).status, 404);
  assert.equal(lookups.length, 7);
  assert.deepEqual(seen, []);
});
test('both authenticated hops validate writes and expose readiness and idempotent payout routes', async t => {
  const { get, post, relayOrigin, seen, payout } = await stack(t, 'true');
  assert.equal((await fetch(relayOrigin + path + '/readiness')).status, 401);
  const body = JSON.stringify({ burn_tx_id: burn });
  assert.equal((await post(body, { Cookie: '' })).status, 401);
  assert.equal((await post(body, { Origin: 'https://other.test' })).status, 403);
  assert.equal((await post(body, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post(body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(body.padEnd(257))).status, 413);
  for (const invalid of ['{}', '{', JSON.stringify({ burn_tx_id: [burn] }), JSON.stringify({ burn_tx_id: burn.toUpperCase() }),
    JSON.stringify({ burn_tx_id: burn, url: 'extra' })]) assert.equal((await post(invalid)).status, 400);
  assert.equal((await get('/invalid')).status, 400);
  assert.deepEqual(seen, []);
  const paused = await (await get('/readiness')).json();
  assert.equal(paused.message, 'vault paused'); assert.equal(paused.enabled, true);
  assert.equal((await post(body)).status, 202);
  assert.equal((await (await get('/' + burn)).json()).burn_tx_id, burn);
  assert.deepEqual(seen.map(row => row.url), ['/solana/withdrawals/readiness', '/solana/withdrawals', '/solana/withdrawals/' + burn]);
  assert.equal(seen[1].body, body);
  assert.ok(seen.every(row => row.authorization === undefined));
  await close(payout);
  const down = await (await get('/readiness')).json();
  assert.equal(down.ready, false); assert.equal(down.enabled, undefined);
});

test('payout routes act only for an accepted burn owned by the named wallet, with a per-session limit', async t => {
  const theirs = 'cd'.repeat(48), rejected = 'ef'.repeat(48), unknown = '12'.repeat(48);
  const { get, post, seen } = await stack(t, 'true', {}, { [burn]: burnTx(burn), [theirs]: burnTx(theirs, 'pf' + '2'.repeat(40)),
    [rejected]: burnTx(rejected, OWNER, false) });
  const create = (id, changes) => post(JSON.stringify({ burn_tx_id: id }), changes);
  assert.equal((await create(burn, { 'X-L1-Owner': '' })).status, 400);
  assert.equal((await get('/' + burn, { 'X-L1-Owner': 'pf' + 'Z'.repeat(40) })).status, 400);
  for (const id of [theirs, rejected]) {
    const response = await create(id);
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'withdrawal_not_owner');
    assert.equal((await get('/' + id)).status, 403);
  }
  const response = await create(unknown);
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'withdrawal_owner_unchecked');
  assert.deepEqual(seen, []);
  assert.equal((await create(burn)).status, 202);
  assert.equal((await get('/' + burn)).status, 200);
  assert.deepEqual(seen.map(row => row.url), ['/solana/withdrawals', '/solana/withdrawals/' + burn]);
  // Ten registrations per session in ten minutes, refused or not; status reads have their own budget.
  for (let i = 0; i < 6; i++) assert.equal((await create(burn)).status, 202);
  const limited = await create(burn);
  assert.equal(limited.status, 429); assert.equal((await limited.json()).code, 'withdrawal_rate_limited');
  assert.equal((await create(burn, { Cookie: 'fixture=other' })).status, 202);
});
