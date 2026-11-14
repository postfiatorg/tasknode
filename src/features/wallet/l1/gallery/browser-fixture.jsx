// Synthetic browser checks only; this module is not imported by the application.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Gallery from './index.jsx';
import WalletHome from '../WalletHome.jsx';
import Market from '../market/index.jsx';
import Redeem from '../redeem/index.jsx';
import Activity from '../Activity.jsx';
import { validateConfig } from '../market/constants.js';
import { config, bob, state } from '../market/fixtures.mjs';
const a666 = '6'.repeat(96);
const isB24 = new URLSearchParams(location.search).get('coin') === 'b24';
const retired = { asset_id: config.b23_asset_id, name: 'B23', symbol: 'B23', slug: 'b23', route_id: config.route_id, retired: true, market_quote_asset_id: config.market_quote_asset_id, description: 'Retired NAVCoin. Existing holdings remain visible.', methodology: 'Historical reading only.' };
Object.assign(config, validateConfig({ ...config, ...(isB24 ? { b23_asset_id: '5'.repeat(96), symbol: 'B24', slug: 'b24', route_id: 'synthetic-b24-route', redemption_mode: 'unsupported', management_address: null, issue_multiplier_bps: 10050, redeem_multiplier_bps: 9995, retired_assets: [retired], ethereum: { available: false } } : {}) }));
const coins = [
  { slug: config.slug, name: config.symbol, asset_id: config.b23_asset_id, description: 'Backed by a Schwab brokerage account.', methodology: 'Schwab reported net liquidation value, daily 18:15 UTC, without adjustments.', market_quote_asset_id: config.market_quote_asset_id, route_id: config.route_id },
  { slug: 'a666', name: 'A666', asset_id: a666, description: 'Synthetic reserve portfolio.', methodology: 'Synthetic methodology for browser testing.', market_quote_asset_id: config.market_quote_asset_id, route_id: 'synthetic-a666-route' },
];
if (isB24) coins.push(retired);
const ledger = state();
if (isB24) { ledger.pool.issue_multiplier_bps = 10050; ledger.pool.redeem_multiplier_bps = 9995; ledger.pool.spread_recipient = null; ledger.pool.settlement_reserve_atoms = 0; ledger.pool.available_redeem_atoms = 0; }
let updated = false, calls = [];
const proof = id => ({ asset_id: id, current_height: 1500, active_profile: {
  verifier_kind: isB24 && id === config.b23_asset_id ? 'sp1-groth16' : updated && id === config.b23_asset_id ? 'sp1-groth16' : id === a666 ? 'multi-fetch-quorum' : 'placeholder',
  min_attestations: id === a666 ? 1 : 0, max_snapshot_age_blocks: 1000, max_epoch_gap_blocks: id === a666 ? 1000 : 128,
}, packets: [
  { state: 'finalized', epoch: 1, submitted_at_height: 100, nav_per_unit: 1000000, circulating_supply: 1000000, verified_net_assets: 1000000, attested_value: 0, cryptographically_verified_value: 0 },
  { state: 'finalized', epoch: updated && id !== a666 ? 3 : 2, reserve_packet_hash: ledger.nav.reserve_packet_hash, submitted_at_height: id === a666 ? 300 : 1450, nav_per_unit: id === a666 ? 100000000000 : updated ? 2000000 : 1000000, circulating_supply: id === a666 ? 200000 : 400000000000, verified_net_assets: id === a666 ? 20000000000 : 400000000000, attested_value: isB24 && id === config.b23_asset_id ? 400000000000 : updated && id !== a666 ? 100000000000 : 0, cryptographically_verified_value: updated && id !== a666 ? 200000000000 : 0 },
] });
window.fetch = async url => Response.json(String(url).endsWith('/registry') ? { coins } : String(url).endsWith('/equity') ? {} : config);
const client = { accountId: 'synthetic-gallery', address: bob, unlocked: true,
  async getBalances() { const result = structuredClone(ledger.balances); result.address = bob; if (isB24) result.assets.lines.push({ asset_id: retired.asset_id, balance: 1000000, precision: 6 }); result.assets.lines.push({ asset_id: a666, balance: 100000, precision: 6 }); return result; },
  async subscribe() { return () => {}; },
  async call(method, args) {
    calls.push(method);
    if (method === 'nav_reserve_proof_status') return proof(args.asset_id);
    if (method === 'asset_info') return { asset: { asset_id: args.asset_id, issuer: config.issuer_address, precision: 6, outstanding_supply: args.asset_id === a666 ? 100000 : 400000000000 } };
    if (method === 'navcoin_bridge_supply_status' && isB24 && args.route_id === retired.route_id) return { ...ledger.pool, route_id: retired.route_id, native_nav_asset_id: retired.asset_id, paused: true, live_value_enabled: false };
    if (method === 'navcoin_bridge_supply_status') return args.route_id === 'synthetic-a666-route' ? { ...structuredClone(ledger.pool), route_id: args.route_id, native_nav_asset_id: a666, live_value_enabled: false } : structuredClone(ledger.pool);
    if (method === 'book_offers') return { offers: [], truncated: false };
    if (method === 'account_offers') return { offers: [], truncated: false };
    if (method === 'account_tx') return { ok: true, result: { transactions: isB24 ? [{ tx_id: 'fixture-buy', market_side: 'buy', market_symbol: config.symbol, transaction_kind: 'offer_create', from: bob, accepted: true }, { tx_id: 'fixture-old', transaction_kind: 'pftl_uniswap_primary_redeem', from: bob, amount: 1000000, unit: 'B23', accepted: true }] : [] } };
    throw Error(`Unexpected synthetic read: ${method}`);
  },
  quote: () => { throw Error('This gallery fixture forbids quotes and writes'); },
};
function App() {
  const [selectedCoin, onSelectCoin] = useState(null), [view, setView] = useState("Gallery");
  window.galleryFixture = { update: () => { updated = true; }, calls, home: () => setView("Home"), view: setView };
  const navigate = (tab, coin) => { setView(tab); onSelectCoin(coin || null); };
  return <main className="l1w"><p>SYNTHETIC GALLERY — NO CHAIN WRITES</p>{view === "Market" ? <Market client={client} onNavigate={navigate} /> : view === "Redeem" ? <Redeem client={client} onNavigate={navigate} /> : view === "Activity" ? <Activity client={client} /> : view === "Home" ? <WalletHome client={client} onNavigate={navigate} /> : <Gallery client={client} selectedCoin={selectedCoin} onSelectCoin={onSelectCoin} onNavigate={navigate} />}</main>;
}
createRoot(document.getElementById('root')).render(<App />);
