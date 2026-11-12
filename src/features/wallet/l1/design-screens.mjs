// Design review harness: drives the real Task Node #l1-wallet page against a
// fully local stub (HTTP routes, the /api/l1/rpc WebSocket, and a mocked
// MetaMask provider) and screenshots every wallet state. Real WASM creates the
// wallet and signs locally; nothing leaves the machine and no chain is touched.
//   L1_WEB_ORIGIN=http://127.0.0.1:5211 DESIGN_OUT=/tmp/design node src/features/wallet/l1/design-screens.mjs
import { mkdir } from 'node:fs/promises';
import { Interface, keccak256 } from 'ethers';
import { owner, profile, routeReport, readyPayload } from './bridge/fixtures.mjs';
import { STAGES } from './bridge/stages.js';
import { CHAIN_ID, GENESIS_HASH } from './lib/utils.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/home/postfiat/repos/postfiatl1v2-fastswap/wallet-web/node_modules/playwright/index.mjs');
const WEB = process.env.L1_WEB_ORIGIN || 'http://127.0.0.1:5198';
const OUT = process.env.DESIGN_OUT || '/home/postfiat/repos/b23-coord/evidence/design';
const ONLY = process.env.DESIGN_ONLY ? new Set(process.env.DESIGN_ONLY.split(',')) : null;
await mkdir(OUT, { recursive: true });

// ---------- synthetic world (illustrative values, never live data) ----------
const M = 1_000_000;
const B23 = 'ca7845134c8e95819082fcd2f1612808e20a37dfabab98dab120f99fd2c54c18ffb50d98c0664480420c881773244627';
const PFUSDC = '02c46a36eb0da3516b4d8affea8f4028ad3f36825a3e8f0e009ea9dbbbcfb3c233f6830bd5221fe2717fb6a1a7005d7b';
const CHILD = '6e'.repeat(48);
const ISSUER = 'pffcb93d9f87a843a8aa34e1adf241f5d58143e81b', ALICE = 'pfab9b9228942e5c529633a13aa271d5297bec6353', MANAGER = 'pfee68d0a5a89e8f554bcd942d2f38659f45bfab1b', PAYER = 'pf7c41e2a09b3d55f6e18a2c7d90b4e3f12a6c8d05';
const ROUTE = 'pftl-pfdep-schwab-primary-pfusdc-v1';
const PACKET = 'c7ce34807fe97962793973a36133f23fc7b523867b25266b0ae58e6c5ff3e01aafc1aa5327056d2209acc167b9b142df';
const config = { b23_asset_id: B23, pfusdc_asset_id: PFUSDC, route_id: ROUTE, issuer_address: ISSUER, alice_holder_address: ALICE, management_address: MANAGER, proof_profile: '15bdad1e278ef0a146abd64d537c557d136fbcc95925f1db105ef4956ba2c55a51cb8c7eb980f2bed4281f24bd946ce9', g1_passed: true, pfusdc_source_asset_ids: [CHILD] };
const cutoff = new Date(Date.now() - 50 * 60 * 1000);
const world = {
  supply: 419_234_350_000, height: 1240,
  pool: { route_id: ROUTE, native_nav_asset_id: B23, settlement_asset_id: PFUSDC, live_value_enabled: true, paused: false, invariant_holds: true, settlement_reserve_atoms: 400 * M, available_redeem_atoms: 400 * M, min_order_atoms: 1 * M, max_order_atoms: 1_000 * M, redeem_multiplier_bps: 9980, spread_recipient: MANAGER, pricing_nav_epoch: 3, pricing_reserve_packet_hash: PACKET, route_epoch: 4, policy_epoch: 4, policy_hash: 'e'.repeat(96), policy_valid_from_height: 1227, policy_expires_at_height: 501185 },
  nav: { state: 'finalized', epoch: 3, reserve_packet_hash: PACKET, nav_per_unit: M, verified_net_assets: 419_234_350_000, circulating_supply: 419_234_350_000, submitted_at_height: 1231 },
  lines: {}, pft: {}, offers: [], history: [], counter: 0, emptyBook: false, rejectNext: false, failActivity: false, delayMs: 0,
  eth: { balance: 2_500n * 1_000_000n, allowance: 0n, log: null }, bridge: { stage: 'proving', request: null, created: 0 },
};
const LEGACY = '521c6c630bb48d4a37ab4a7bd4900dd2caa2d9e99499e452da3c7ce75b3d74b62d20e18555642bec32174498cbee5e2c';
function account(address) {
  if (!world.lines[address]) {
    const bob = ![ISSUER, ALICE, MANAGER, PAYER].includes(address);
    world.lines[address] = bob ? { [PFUSDC]: 2_500 * M, [B23]: 0, [CHILD]: 0, [LEGACY]: 0 } : address === ALICE ? { [PFUSDC]: 5_400 * M, [B23]: 400_000 * M } : { [PFUSDC]: 0, [B23]: 0 };
    world.pft[address] = bob ? 25_400_000 : 90 * M;
    if (bob) world.history.push({ tx_id: 'b7e0c2' + '5a'.repeat(45), accepted: true, kind: 'transfer', from: PAYER, to: address, amount: 25_500_000 });
  }
  return world.lines[address];
}
const CODES = { [PFUSDC]: 'PFUSDC', [B23]: 'B23', [CHILD]: 'PFUSDC', [LEGACY]: 'A666' };
function lineReport(address) {
  const lines = account(address);
  return { truncated: false, lines: Object.entries(lines).map(([asset_id, balance]) => ({ asset_id, balance, code: CODES[asset_id], precision: 6, ...(asset_id === CHILD ? { asset_family_id: PFUSDC } : {}) })) };
}
function seedBook() {
  world.offers = [
    [ALICE, 500, 500], [ALICE, 1_200, 1_204.8], [ALICE, 2_500, 2_525],
  ].map(([who, qty, total], i) => ({ offer_id: `ask-${i}-` + 'a1'.repeat(20), owner: who, state: 'open', taker_gets_asset_id: B23, taker_pays_asset_id: PFUSDC, original_taker_gets_amount: qty * M, original_taker_pays_amount: Math.round(total * M), taker_gets_amount_remaining: qty * M, taker_pays_amount_remaining: Math.round(total * M) }))
    .concat([[PAYER, 300, 298.5], [PAYER, 800, 792]].map(([who, qty, total], i) => ({ offer_id: `bid-${i}-` + 'b2'.repeat(20), owner: who, state: 'open', taker_gets_asset_id: PFUSDC, taker_pays_asset_id: B23, original_taker_gets_amount: Math.round(total * M), original_taker_pays_amount: qty * M, taker_gets_amount_remaining: Math.round(total * M), taker_pays_amount_remaining: qty * M })));
}
seedBook();
const txid = () => (++world.counter).toString(16).padStart(8, '0') + 'd3'.repeat(44);
function applySigned(method, params) {
  const field = Object.keys(params).find(key => key.startsWith('signed_'));
  const signed = JSON.parse(params[field]);
  const unsigned = signed.unsigned || signed;
  const tx_id = txid();
  if (world.rejectNext) { world.rejectNext = false; return { tx_id, finality: { receipt: { tx_id, accepted: false, code: 'offer_unfunded', reject_reason: 'offer_unfunded: the offer budget exceeds the spendable PFUSDC balance' } } }; }
  const receipt = { tx_id, accepted: true, code: 'accepted' };
  if (method === 'mempool_submit_signed_transfer_finality') {
    const from = unsigned.from || signed.from, to = unsigned.to || signed.to, amount = Number(unsigned.amount || signed.amount);
    account(from); account(to); world.pft[from] -= amount + 1; world.pft[to] += amount;
    world.history.push({ tx_id, accepted: true, kind: 'transfer', from, to, amount });
    return { tx_id, round_ok: true, finality: { receipt } };
  }
  const op = typeof unsigned.operation === 'object' ? unsigned.operation : unsigned;
  const source = unsigned.source || op.owner;
  const lines = account(source);
  if (op.operation === 'offer_create') {
    const buy = op.taker_gets_asset_id === PFUSDC;
    let budget = op.taker_gets_amount, want = op.taker_pays_amount; const fills = [];
    const limit = buy ? op.taker_gets_amount / op.taker_pays_amount : op.taker_pays_amount / op.taker_gets_amount;
    const book = world.offers.filter(o => o.state === 'open' && o.taker_gets_asset_id === op.taker_pays_asset_id).sort((a, b) => (a.taker_pays_amount_remaining / a.taker_gets_amount_remaining) - (b.taker_pays_amount_remaining / b.taker_gets_amount_remaining));
    for (const maker of book) {
      if (!buy || want <= 0) break;
      const price = maker.taker_pays_amount_remaining / maker.taker_gets_amount_remaining;
      if (price > limit + 1e-12) break;
      const qty = Math.min(want, maker.taker_gets_amount_remaining), pay = Math.round(qty * price);
      maker.taker_gets_amount_remaining -= qty; maker.taker_pays_amount_remaining -= pay; if (!maker.taker_gets_amount_remaining) maker.state = 'filled';
      account(maker.owner)[PFUSDC] += pay; want -= qty; budget -= pay;
      fills.push({ taker: source, maker_owner: maker.owner, taker_sends_asset_id: PFUSDC, maker_sends_asset_id: B23, taker_sends_amount: pay, maker_sends_amount: qty });
    }
    const spent = fills.reduce((s, f) => s + f.taker_sends_amount, 0), received = fills.reduce((s, f) => s + f.maker_sends_amount, 0);
    lines[op.taker_gets_asset_id] -= spent; lines[op.taker_pays_asset_id] += received;
    if (want > 0) {
      const resting = { offer_id: `mine-${world.counter}-` + 'c3'.repeat(20), owner: source, state: 'open', taker_gets_asset_id: op.taker_gets_asset_id, taker_pays_asset_id: op.taker_pays_asset_id, original_taker_gets_amount: op.taker_gets_amount, original_taker_pays_amount: op.taker_pays_amount, taker_gets_amount_remaining: op.taker_gets_amount - spent, taker_pays_amount_remaining: want };
      lines[op.taker_gets_asset_id] -= resting.taker_gets_amount_remaining; world.offers.push(resting); receipt.offer_id = resting.offer_id;
    }
    receipt.offer_fills = fills;
    world.history.push({ tx_id, accepted: true, kind: 'offer_create', from: source, amount: received || op.taker_pays_amount });
  } else if (op.operation === 'pftl_uniswap_primary_redeem') {
    const gross = Math.floor(op.nav_amount_atoms * world.nav.nav_per_unit / M), holder = Math.floor(gross * world.pool.redeem_multiplier_bps / 10000), spread = gross - holder;
    lines[B23] -= op.nav_amount_atoms; lines[PFUSDC] += holder; account(MANAGER)[PFUSDC] += spread;
    world.supply -= op.nav_amount_atoms; world.pool.settlement_reserve_atoms -= gross; world.pool.available_redeem_atoms -= op.nav_amount_atoms;
    receipt.redemption_settlement = { settlement_asset_id: PFUSDC, settlement_recipient: source, settlement_value_atoms: holder, spread_recipient: MANAGER, spread_value_atoms: spread };
    world.history.push({ tx_id, accepted: true, kind: 'pftl_uniswap_primary_redeem', from: source, amount: op.nav_amount_atoms });
  } else if (op.operation === 'pftl_uniswap_redemption_fund') {
    lines[PFUSDC] -= op.amount_atoms; world.pool.settlement_reserve_atoms += op.amount_atoms; world.pool.available_redeem_atoms += op.amount_atoms;
  }
  return { tx_id, finality: { receipt } };
}
function rpc(method, params = {}) {
  switch (method) {
    case 'server_info': return { chain_id: CHAIN_ID, height: world.height };
    case 'account': account(params.address); return { account: { balance: world.pft[params.address], sequence: 3 } };
    case 'account_lines': return lineReport(params.account);
    case 'account_assets': return { assets: lineReport(params.account).lines.map(({ asset_id, balance }) => ({ asset_id, balance })) };
    case 'wallet_subscribe': return { subscription_id: 'design-subscription' };
    case 'wallet_unsubscribe': return {};
    case 'account_tx': if (world.failActivity) throw new Error('rpc account_tx failed: receipt log is being rebuilt; try again shortly'); return { rows: world.history.filter(r => r.from === params.address || r.to === params.address).slice().reverse() };
    case 'navcoin_bridge_supply_status': return structuredClone(world.pool);
    case 'nav_reserve_proof_status': return { asset_id: B23, current_height: world.height, packets: [structuredClone(world.nav), { ...structuredClone(world.nav), epoch: 2, reserve_packet_hash: 'f'.repeat(96), submitted_at_height: 1181 }] };
    case 'asset_info': return { asset: { asset_id: B23, code: 'B23', outstanding_supply: world.supply } };
    case 'book_offers': return { truncated: false, limit: 100, offers: world.emptyBook ? [] : world.offers.filter(o => o.state === 'open' && o.taker_gets_asset_id === params.taker_gets_asset_id && o.taker_pays_asset_id === params.taker_pays_asset_id) };
    case 'account_offers': return { truncated: false, limit: 100, offers: world.offers.filter(o => o.owner === params.account) };
    case 'vault_bridge_route': return routeReport().result;
    case 'transfer_fee_quote': account(params.from); account(params.to); return { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH, protocol_version: 1, ...params, sequence: 4, sequence_source: 'ledger', sender_balance: world.pft[params.from], sender_sequence: 3, mempool_pending_for_sender: 0, recipient_exists: true, will_create_recipient_account: false, base_transfer_fee: 1, state_expansion_fee: 0, minimum_fee: 1, account_reserve: 1, transfer_account_creation_fee: 0, transfer_fee_byte_quantum: 1024, transfer_fee_per_quantum: 0, transfer_weight_bytes: 1, sender_balance_after_amount_and_fee: world.pft[params.from] - params.amount - 1, sender_meets_reserve_after_transfer: true, recipient_balance_after_amount: world.pft[params.to] + params.amount, recipient_meets_reserve_after_transfer: true };
    case 'asset_fee_quote': case 'offer_fee_quote': return { chain_id: CHAIN_ID, genesis_hash: GENESIS_HASH, protocol_version: 1, source: params.source, operation: JSON.parse(params.operation_json), minimum_fee: 120, sequence: 4, sender_meets_reserve_after_fee: true };
    case 'mempool_submit_signed_transfer_finality': case 'mempool_submit_signed_asset_transaction_finality': case 'mempool_submit_signed_offer_transaction': case 'mempool_submit_signed_asset_transaction': return applySigned(method, params);
    case 'receipts': return { receipts: [] };
    default: throw new Error(`design stub: unexpected ${method}`);
  }
}

// ---------- bridge relay + MetaMask ----------
profile.vault_runtime_code_hash = keccak256('0x6000');
profile.token_runtime_code_hash = keccak256('0x6000');
const iface = new Interface(['function approve(address spender,uint256 amount)', 'function depositV2(uint256 amount,string recipient,bytes32 nonce,bytes32 binding)', 'event ERC20BridgeDepositedV2(bytes32 indexed depositId,address indexed depositor,bytes32 indexed recipientHash,string recipient,uint256 amount,bytes32 nonce,bytes32 binding,uint256 chain,address vault,address token)']);
function ethereum({ method, params }) {
  if (['eth_requestAccounts', 'eth_accounts'].includes(method)) return [owner];
  if (method === 'eth_chainId') return '0x1';
  if (method === 'eth_getCode') return '0x6000';
  if (method === 'eth_call') {
    const data = params[0].data;
    if (data.startsWith('0x70a08231')) return '0x' + world.eth.balance.toString(16);
    return '0x' + world.eth.allowance.toString(16);
  }
  if (method === 'eth_sendTransaction') {
    const tx = params[0];
    if (tx.to.toLowerCase() === profile.token_address.toLowerCase()) { world.eth.allowance = iface.decodeFunctionData('approve', tx.data).amount; return '0x' + 'ef'.repeat(32); }
    const args = iface.decodeFunctionData('depositV2', tx.data);
    world.eth.balance -= args.amount; world.eth.allowance -= args.amount;
    world.eth.log = { ...iface.encodeEventLog(iface.getEvent('ERC20BridgeDepositedV2'), ['0x' + 'aa'.repeat(32), owner, '0x' + 'bb'.repeat(32), args.recipient, args.amount, args.nonce, args.binding, 1, profile.vault_address, profile.token_address]), address: profile.vault_address };
    world.bridge.depositAmount = Number(args.amount);
    return '0x' + 'cd'.repeat(32);
  }
  if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x15f0a2c', logs: [world.eth.log].filter(Boolean) };
  throw new Error(`Unexpected provider method ${method}`);
}
function bridgeJob() {
  const b = world.bridge, accepted = b.stage === 'accepted';
  const current = STAGES.findIndex(([name]) => name === b.stage), done = accepted ? STAGES.length : Math.max(current, 0);
  const span = [22, 768, 41, 214, 19, 12, 9];
  let t = b.created;
  const history = STAGES.slice(0, accepted ? STAGES.length : done + 1).map(([stage], index) => { const started = t; const finished = index < done ? started + span[index] : null; t = finished ?? t; return { stage, status: index < done ? 'complete' : 'running', started_at_unix: started, completed_at_unix: finished }; });
  if (accepted) { world.lines[b.request.pftl_recipient][CHILD] = Number(b.request.amount_atoms); }
  return { ok: true, job_id: '0x' + '9f'.repeat(32), status: b.stage, created_at_unix: b.created, receipt_code: accepted ? 'ACCEPTED' : '', receipt_id: accepted ? '5e'.repeat(48) : '', credited_asset_id: CHILD, asset_id: profile.asset_id, request: b.request, stage_history: history };
}

// ---------- browser ----------
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
async function makePage({ scheme = 'light', width = 1440, height = 1000 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => console.error('PAGE ERROR', error.message));
  await page.exposeFunction('designEthereum', request => { try { return { ok: true, value: JSON.parse(JSON.stringify(ethereum(request), (_k, v) => typeof v === 'bigint' ? '0x' + v.toString(16) : v)) }; } catch (error) { return { ok: false, error: error.message }; } });
  await page.addInitScript(() => { window.ethereum = { on() {}, removeListener() {}, async request(request) { const r = await window.designEthereum(request); if (!r.ok) throw new Error(r.error); return r.value; } }; });
  await page.route('**/runtime-config*', route => route.fulfill({ contentType: 'application/json', body: '{}' }));
  // KNOWN GAP (see status/design.md): the bundled release-1 WASM drops offer_create.expiration_height from the
  // signed envelope, so tx-builder refuses every market offer. To screenshot the post-signing states, this
  // harness-only shim copies the reviewed field back into the local signed object. Never used by the product.
  await page.route(/postfiat_wallet_wasm\.js/, async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('export function wallet_sign_offer_transaction_fields(', 'function __design_sign_offer(')
      + '\nexport function wallet_sign_offer_transaction_fields(backup, fields) { const signed = __design_sign_offer(backup, fields); const op = JSON.parse(fields).operation; if (op && "expiration_height" in op && signed && signed.unsigned && !("expiration_height" in signed.unsigned)) signed.unsigned.expiration_height = op.expiration_height; return signed; }\n';
    await route.fulfill({ response, body });
  });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/app-state')) return route.fulfill({ json: { session: { status: 'signed_in', accountId: 'design-review-bob' }, wallet: {}, tasks: {}, chat: { conversations: [], messages: [] } } });
    if (url.pathname === '/api/l1/navcoin/config') return route.fulfill({ json: config });
    if (url.pathname === '/api/l1/navcoin/equity') {
      const packet = { schema: 'postfiat.b23.account_equity.v1', source_field: 'securitiesAccount.currentBalances.liquidationValue', valuation_unit: 'usd_1e6', scale_atoms_per_usd: 1000000, adjustments: [], liquidation_value_atoms: 419_234_350_000, liquidation_value_usd: '419234.35', cutoff_at_utc: cutoff.toISOString(), observed_at_utc: new Date(cutoff.getTime() + 20000).toISOString(), account_commitment_sha256: '4f'.repeat(32), packet_hash: PACKET };
      const base = { issuer: ISSUER, asset_id: B23, epoch: 3, reserve_packet_hash: PACKET };
      return route.fulfill({ json: { packet, pfdep_retired: true, current_supply_atoms: world.supply, target_supply_atoms: 419_234_350_000, additional_mint_atoms: 419_234_350_000 - world.supply, operations: [
        { ...base, operation: 'nav_reserve_submit', submitter: ISSUER, nav_per_unit: M, circulating_supply: 419_234_350_000, verified_net_assets: 419_234_350_000, proof_profile: config.proof_profile, source_root: 'a'.repeat(96), attestor_root: 'b'.repeat(96), reserve_accounts: [], sp1_proof_bytes: [], sp1_public_values: [] },
        { ...base, operation: 'nav_epoch_finalize' }, { ...base, operation: 'nav_mint_at_nav', to: ALICE, amount: Math.max(1, 419_234_350_000 - world.supply) }] } });
    }
    if (url.pathname.startsWith('/api/l1/bridge')) {
      if (url.pathname.includes('readiness')) return route.fulfill({ json: world.bridgeBlocked ? { ok: false, ready: false, message: 'Authenticated on-ledger beacon anchor is missing.' } : readyPayload() });
      if (route.request().method() === 'POST') { world.bridge.request = JSON.parse(route.request().postData()); world.bridge.created = Math.floor(Date.now() / 1000) - 1080; return route.fulfill({ json: { ok: true, job_id: '0x' + '9f'.repeat(32) } }); }
      return route.fulfill({ json: bridgeJob() });
    }
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket(/\/api\/l1\/rpc/, ws => {
    ws.onMessage(async message => {
      const request = JSON.parse(String(message));
      if (world.delayMs) await new Promise(resolve => setTimeout(resolve, world.delayMs));
      try { ws.send(JSON.stringify({ version: 'postfiat-local-rpc-v1', id: request.id, ok: true, result: rpc(request.method, request.params) })); }
      catch (error) { ws.send(JSON.stringify({ version: 'postfiat-local-rpc-v1', id: request.id, ok: false, result: null, error: { code: 'rpc_error', message: error.message } })); }
    });
  });
  return page;
}
const shots = [];
async function shot(page, name, { full = true } = {}) {
  if (ONLY && !ONLY.has(name)) return;
  await page.waitForTimeout(350);
  const size = page.viewportSize();
  // The app shell scrolls inside a container; grow the viewport to the content instead of fullPage.
  const extra = full ? await page.evaluate(() => { let el = document.querySelector('.l1w'); while (el && !(el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement; return el ? el.scrollHeight - el.clientHeight : 0; }) : 0;
  if (extra > 0) { await page.setViewportSize({ width: size.width, height: size.height + extra }); await page.waitForTimeout(250); }
  await page.screenshot({ path: `${OUT}/${name}.png` });
  if (extra > 0) await page.setViewportSize(size);
  shots.push(`${OUT}/${name}.png`); console.log('shot', name);
}
const tab = (page, name) => page.getByRole('navigation', { name: 'L1 wallet tabs' }).getByRole('button', { name, exact: true }).click();
async function create(page, passphrase = 'design-review-passphrase') {
  await page.goto(`${WEB}/#l1-wallet`);
  await page.getByLabel('Wallet passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Create L1 wallet', exact: true }).click();
  await page.getByTestId('l1-address').waitFor();
}

try {
  const page = await makePage();
  await page.goto(`${WEB}/#l1-wallet`);
  await page.getByRole('button', { name: 'Create L1 wallet', exact: true }).waitFor();
  await shot(page, '01-gate-create');
  await page.getByLabel('Wallet passphrase', { exact: true }).fill('design-review-passphrase');
  await page.getByRole('button', { name: 'Create L1 wallet', exact: true }).click();
  await page.getByTestId('l1-address').waitFor();
  await page.getByText('Net assets at last NAV').first().waitFor();
  await shot(page, '02-home-new-wallet');
  await page.getByRole('button', { name: 'Wallet menu' }).click();
  await shot(page, '03-wallet-menu', { full: false });
  await page.getByRole('button', { name: 'Lock L1 wallet' }).click();
  await page.getByRole('button', { name: 'Unlock L1 wallet', exact: true }).waitFor();
  await shot(page, '04-gate-unlock');
  await page.getByLabel('Wallet passphrase', { exact: true }).fill('design-review-passphrase');
  await page.getByRole('button', { name: 'Unlock L1 wallet', exact: true }).click();
  await page.getByTestId('l1-address').waitFor();

  // Bridge
  await tab(page, 'Add funds');
  await page.getByText('Bridge ready').waitFor();
  await shot(page, '05-bridge-idle');
  await page.getByRole('button', { name: 'Connect MetaMask', exact: true }).click();
  await page.getByTestId('bridge-owner').waitFor();
  await page.getByLabel('USDC amount', { exact: true }).fill('2500');
  await shot(page, '06-bridge-connected');
  await page.getByRole('button', { name: 'Approve USDC', exact: true }).click();
  await page.getByRole('link', { name: /Approval on Etherscan/ }).waitFor();
  world.bridge.stage = 'proving';
  await page.getByRole('button', { name: 'Deposit', exact: true }).click();
  await page.getByText('Generate proof').first().waitFor();
  await page.waitForTimeout(1200);
  await shot(page, '07-bridge-in-progress');
  world.bridge.stage = 'accepted';
  await page.getByText('PFUSDC credited', { exact: true }).waitFor({ timeout: 15000 });
  await shot(page, '08-bridge-credited');

  // Market
  await tab(page, 'Market');
  await page.getByRole('heading', { name: 'Order book' }).waitFor();
  await shot(page, '09-market-book');
  await page.getByLabel('B23 quantity', { exact: true }).fill('1700');
  await page.getByLabel('PFUSDC total', { exact: true }).fill('1700');
  await page.getByRole('button', { name: 'Review buy offer' }).click();
  await page.getByRole('button', { name: 'Get fee quote' }).click();
  await page.getByRole('button', { name: 'Sign and submit' }).waitFor();
  await shot(page, '10-market-buy-review');
  await page.getByRole('button', { name: 'Sign and submit' }).click();
  await page.getByRole('heading', { name: 'Accepted and verified' }).waitFor();
  await shot(page, '11-market-buy-success');
  // Rejected order
  await page.getByLabel('B23 quantity', { exact: true }).fill('100');
  await page.getByLabel('PFUSDC total', { exact: true }).fill('100');
  await page.getByRole('button', { name: 'Review buy offer' }).click();
  await page.getByRole('button', { name: 'Get fee quote' }).click();
  world.rejectNext = true;
  await page.getByRole('button', { name: 'Sign and submit' }).click();
  await page.getByRole('heading', { name: 'Rejected by the chain' }).waitFor();
  await shot(page, '12-market-rejected');
  world.emptyBook = true;
  await page.getByRole('button', { name: 'Refresh state' }).click();
  await page.getByText('No one is selling B23 right now.').waitFor();
  await shot(page, '13-market-empty-book');
  world.emptyBook = false;

  // Cash in
  await tab(page, 'Cash in');
  await page.getByLabel('B23 to cash in', { exact: true }).fill('100');
  await shot(page, '14-cashin-preview');
  await page.getByRole('button', { name: 'Review cash-in' }).click();
  await page.getByRole('button', { name: 'Get fee quote' }).click();
  await page.getByRole('button', { name: 'Sign and submit' }).waitFor();
  await shot(page, '15-cashin-review');
  await page.getByRole('button', { name: 'Sign and submit' }).click();
  await page.getByRole('heading', { name: /Accepted/ }).waitFor();
  await shot(page, '16-cashin-success');
  await page.getByLabel('B23 to cash in', { exact: true }).fill('350');
  await page.getByText('More than the reserve can pay right now').waitFor();
  await shot(page, '17-cashin-over-reserve');

  // Send
  await tab(page, 'Send');
  await shot(page, '18-send-empty');
  await page.getByLabel('Recipient pf address', { exact: true }).fill(PAYER);
  await page.getByLabel('PFT amount', { exact: true }).fill('2.5');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await page.getByRole('button', { name: 'Confirm and send PFT' }).waitFor();
  await shot(page, '19-send-review');
  await page.getByRole('button', { name: 'Confirm and send PFT' }).click();
  await page.getByText('Both balance changes match the payment and fee.').waitFor();
  await shot(page, '20-send-success');

  // Activity
  await tab(page, 'Activity');
  await page.locator('.l1-tx').first().waitFor();
  await shot(page, '21-activity');
  world.failActivity = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByText('Activity could not be read from the chain').waitFor();
  await shot(page, '22-activity-error');
  world.failActivity = false;

  // Home with holdings
  await tab(page, 'Home');
  await page.getByText('Net assets at last NAV').first().waitFor();
  await page.waitForTimeout(600);
  await shot(page, '23-home-balances');

  // Issuer desk
  await tab(page, 'Issuer desk');
  await page.getByRole('button', { name: 'Load account-equity opening plan' }).click();
  await page.getByText('Schwab net liquidation value').waitFor();
  await shot(page, '24-issuer-desk');
  await page.getByLabel('PFUSDC to add', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Review reserve funding' }).click();
  await page.getByRole('button', { name: 'Get fee quote' }).click();
  await page.getByRole('button', { name: 'Sign and submit' }).waitFor();
  await shot(page, '25-issuer-fund-review');
  await page.context().close();

  // Loading skeleton
  world.delayMs = 4000;
  const slow = await makePage();
  await create(slow, 'design-review-passphrase-2').catch(() => {});
  await slow.waitForTimeout(600);
  await shot(slow, '26-home-loading', { full: false });
  world.delayMs = 0;
  await slow.context().close();

  // Dark mode + narrow
  for (const [scheme, width, prefix] of [['dark', 1440, '27-dark'], ['light', 720, '30-narrow']]) {
    const p = await makePage({ scheme, width, height: 1000 });
    await create(p, `design-review-${prefix}`);
    await p.getByText('Net assets at last NAV').first().waitFor();
    await shot(p, `${prefix}-home`);
    await tab(p, 'Add funds'); await p.getByText('Bridge ready').waitFor();
    if (scheme === 'dark') {
      world.bridge.stage = 'proving';
      await p.getByRole('button', { name: 'Connect MetaMask', exact: true }).click(); await p.getByTestId('bridge-owner').waitFor();
      world.eth.balance = 2_500n * 1_000_000n;
      await p.getByLabel('USDC amount', { exact: true }).fill('750');
      await p.getByRole('button', { name: 'Approve USDC', exact: true }).click(); await p.getByRole('link', { name: /Approval on Etherscan/ }).waitFor();
      await p.getByRole('button', { name: 'Deposit', exact: true }).click(); await p.getByText('Generate proof').first().waitFor(); await p.waitForTimeout(1200);
    }
    await shot(p, `${prefix}-bridge`);
    await tab(p, 'Market'); await p.getByRole('heading', { name: 'Order book' }).waitFor();
    await shot(p, `${prefix}-market`);
    await p.context().close();
  }
  console.log(JSON.stringify({ screenshots: shots.length, out: OUT, chainWrites: 0, liveCalls: 0 }));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) { await page.screenshot({ path: `${OUT}/failure.png` }).catch(() => {}); console.error((await page.locator('body').innerText().catch(() => '')).slice(-3000)); }
  throw error;
} finally { await browser.close(); }
