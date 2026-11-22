// Invoked by local-chain.py with the path to its disposable chain configuration.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { createServer as createVite } from 'vite';
import { createRelayServer } from '../../server/l1/relay.js';
import { readRpc } from '../../server/l1/read-rpc.js';
import { encryptVault } from '../../src/features/wallet/l1/lib/vault.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const configFile = process.argv[2], dir = dirname(configFile);
const config = JSON.parse(await readFile(configFile, 'utf8'));
assert.ok(config.ports.length === 2 && config.ports.every(p => Number.isInteger(p) && p > 0 && p <= 65535));
assert.match(config.listen, /^127\.0\.0\.1:\d+$/);
const host = '127.0.0.1', token = () => randomBytes(32).toString('hex');
async function listen(server, port = 0) {
  server.listen(port, host); await once(server, 'listening'); return server.address().port;
}
const close = server => new Promise(resolve => server.close(resolve));
async function freePort() { const server = createServer(), port = await listen(server); await close(server); return port; }
const relayPort = await freePort(), proxyPort = await freePort();
const relayOrigin = 'http://' + host + ':' + relayPort;
const proxyTokenFile = join(dir, 'proxy-token.json');
await writeFile(proxyTokenFile, JSON.stringify({ 'local-demo': token() }), { mode: 0o600 });
const env = { TASKNODE_L1_ENABLED: 'true', TASKNODE_L1_PRIVATE_PAYMENTS_ENABLED: 'true',
  L1_RELAY_PUBLIC_ORIGIN: relayOrigin, L1_RELAY_URL: relayOrigin, L1_RELAY_TOKEN: token(),
  L1_PRIVATE_PROVER_URL: 'http://' + config.listen, L1_PRIVATE_PROVER_TOKEN_FILE: join(dir, 'bearer'),
  L1_WALLET_PROXY_URL: 'ws://' + host + ':' + proxyPort, L1_WALLET_PROXY_ORIGIN: relayOrigin,
  L1_WALLET_PROXY_TOKEN_FILE: proxyTokenFile, L1_HISTORY_RPC_URL: 'tcp://' + host + ':' + config.ports[0] };
const dirEvidence = 'artifacts/private-payments/real';
const proxySource = dirname(process.env.WALLET_PROXY_SOURCE), proxyDir = join(dir, 'wallet-proxy');
await mkdir(proxyDir);
for (const name of await readdir(proxySource)) {
  if ((name.endsWith('.js') && !name.startsWith('test_')) || name === 'package.json') {
    await copyFile(join(proxySource, name), join(proxyDir, name));
  }
}
const proxy = spawn(process.execPath, [join(proxyDir, 'server.js')], { cwd: dir, env: {
  PATH: process.env.PATH, HOME: dir, NODE_PATH: resolve('node_modules'), LISTEN_HOST: host, LISTEN_PORT: String(proxyPort),
  RPC_HOST: host, RPC_PORT: String(config.ports[0]), ALLOWED_ORIGINS: relayOrigin, WALLET_PROXY_API_TOKENS_FILE: proxyTokenFile,
  RPC_FLEET: config.ports.map((p, i) => 'validator-' + i + '=' + host + ':' + p).join(','),
  NAVSWAP_IDEMPOTENCY_STORE_PATH: 'off', NAVSWAP_RUN_STORE_PATH: 'off',
}, stdio: ['ignore', 'pipe', 'inherit'] });
let vite, app, relay, browser;
const pages = [];
try {
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(Error('Local wallet proxy startup timed out')), 20000);
    proxy.once('exit', code => { clearTimeout(timer); reject(Error('Local wallet proxy exited ' + code)); });
    proxy.stdout.on('data', chunk => {
      if (chunk.includes('RPC proxy listening')) { clearTimeout(timer); resolveReady(); }
    });
  });
  relay = createRelayServer(env); await listen(relay, relayPort);
  const apiPort = await freePort(), webPort = await freePort(), origin = 'http://' + host + ':' + webPort;
  process.env.TASKNODE_API_ORIGIN = 'http://' + host + ':' + apiPort;
  process.env.VITE_POSTFIAT_CHAIN_ID = config.chain;
  process.env.VITE_POSTFIAT_GENESIS_HASH = config.genesis;
  app = spawn(process.execPath, ['server/index.js'], { env: {
    ...env, PATH: process.env.PATH, HOME: dir, TMPDIR: dir, PORT: String(apiPort), TASKNODE_BIND_HOST: host,
    NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
    TASKNODE_PUBLIC_URL: origin, TASKNODE_PROCESS_ROLE: 'web', TASKNODE_ENV: 'development',
    TASKNODE_DEV_AUTH_ENABLED: 'true', TASKNODE_AUTH_SECRET: token(), TASKNODE_DATABASE_DISABLED: 'true',
    TASKNODE_DATABASE_ENABLED: 'false', TASKNODE_STORE_PATH: join(dir, 'tasknode-store.json'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(Error('Task Node startup timed out')), 30000);
    app.once('exit', code => { clearTimeout(timer); reject(Error('Task Node exited ' + code)); });
    app.stdout.on('data', chunk => {
      if (chunk.includes('tasknodeofficial listening on')) { clearTimeout(timer); ready(); }
    });
    app.stderr.resume();
  });
  vite = await createVite({ cacheDir: 'node_modules/.vite-real-wallet', server: { host, port: webPort, hmr: false,
    fs: { deny: ['**/.tmp/**', '**/.git/**', '**/.env*'] } } });
  await vite.listen();
  await mkdir(dirEvidence, { recursive: true });
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  async function wallet(id, backupFile) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 1100 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket(url => url.host !== new URL(origin).host, route => route.close());
    const login = await context.request.post(origin + '/api/auth/dev/start', {
      headers: { origin }, data: { email: id.toLowerCase() + '@tasknode.local' },
    });
    assert.equal(login.status(), 200);
    assert.equal((await login.json()).session.status, 'signed_in');
    const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(90000);
    await page.goto(origin + '/#l1-wallet');
    await page.getByLabel('Wallet passphrase', { exact: true }).waitFor();
    const dialog = page.getByRole('dialog');
    if (await dialog.isVisible()) await dialog.getByRole('button', { name: /close|later|skip/i }).first().click();
    const pass = token();
    await page.getByLabel('Wallet passphrase', { exact: true }).fill(pass);
    if (backupFile) {
      const { master_seed_hex } = JSON.parse(await readFile(backupFile, 'utf8'));
      const file = join(dir, 'browser.encrypted.json');
      await writeFile(file, JSON.stringify({ vault: await encryptVault(master_seed_hex, pass),
        metadata: { chain_id: config.chain, address: config.account } }), { mode: 0o600 });
      await page.getByLabel('Encrypted backup', { exact: true }).setInputFiles(file);
    } else await page.getByRole('button', { name: 'Create L1 wallet', exact: true }).click();
    await page.getByRole('button', { name: 'Private', exact: true }).click();
    await page.getByText('Your private address', { exact: true }).waitFor();
    return page;
  }
  const alice = await wallet('Alice', join(dir, 'browser.backup.json')), bob = await wallet('Bob');
  assert.equal(await alice.getByTestId('l1-address').textContent(), config.account);
  const recipient = await bob.locator('.l1-chip .l1-mono[title^="pfs1"]').textContent();
  const button = (page, name) => page.getByRole('button', { name, exact: true });
  const expectBalance = (page, n) => page.getByText(n + ' available', { exact: true }).waitFor();
  async function publicBalance() {
    const lines = await readRpc(new URL(env.L1_HISTORY_RPC_URL), 'account_lines', { account: config.account, asset_id: config.asset });
    assert.equal(lines.line_count, 1);
    return lines.lines[0].balance;
  }
  assert.equal(await publicBalance(), 40);
  await alice.getByLabel('Amount', { exact: true }).fill('9'); await button(alice, 'Review move to private').click();
  await alice.getByText(/Funding fee/).waitFor(); await alice.screenshot({ path: join(dirEvidence, 'funding-review.png') });
  await button(alice, 'Sign and move to private').click();
  await alice.getByText('Funds moved to your private balance.').waitFor(); await expectBalance(alice, 9);
  assert.equal(await publicBalance(), 31);
  console.log('Shield accepted. Private 9, public 31.');
  await alice.getByLabel('Action').selectOption('pay'); await alice.getByLabel('Amount', { exact: true }).fill('4');
  await alice.getByLabel('Recipient private address').fill(recipient); await button(alice, 'Send privately').click();
  await alice.getByText('Private payment accepted.').waitFor(); await expectBalance(alice, 5);
  await alice.screenshot({ path: join(dirEvidence, 'sender-5.png') });
  await button(bob, 'Refresh balances').click(); await expectBalance(bob, 4);
  console.log('Payment accepted. Sender 5, recipient 4.');
  await bob.getByLabel('Action').selectOption('exit'); await bob.getByLabel('Amount', { exact: true }).fill('1');
  await bob.getByLabel('Public destination').fill(config.account); await button(bob, 'Move to public').click();
  await bob.getByText('Funds moved to the public destination.').waitFor(); await expectBalance(bob, 3);
  await button(alice, 'Refresh balances').click(); await expectBalance(alice, 5);
  assert.equal(await publicBalance(), 32);
  await bob.screenshot({ path: join(dirEvidence, 'recipient-3.png') });
  console.log('Exit accepted. Wallets show 5 and 3. Node account_lines shows 32 public.');
} catch (error) {
  for (const page of pages) {
    const status = await page.locator('[role="status"], [role="alert"]').allTextContents();
    console.error('Wallet status', status.join(' '));
  }
  throw error;
} finally {
  await browser?.close(); await vite?.close();
  if (app && app.exitCode === null) app.kill();
  if (relay?.listening) await close(relay);
  if (proxy.exitCode === null) proxy.kill();
}
