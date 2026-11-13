// Synthetic browser checks only; this module is not imported by the application.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Gallery from './index.jsx';
import WalletHome from '../WalletHome.jsx';
import { config, bob, state } from '../market/fixtures.mjs';
const a666 = '6'.repeat(96);
const coins = [
  { slug: 'b23', name: 'B23', asset_id: config.b23_asset_id, description: 'Backed by a Schwab brokerage account.', methodology: 'Schwab reported net liquidation value, daily 18:15 UTC, without adjustments.', market_quote_asset_id: config.market_quote_asset_id, route_id: config.route_id },
  { slug: 'a666', name: 'A666', asset_id: a666, description: 'Synthetic reserve portfolio.', methodology: 'Synthetic methodology for browser testing.', market_quote_asset_id: config.market_quote_asset_id, route_id: 'synthetic-a666-route' },
];
const ledger = state();
let updated = false, calls = [];
const proof = id => ({ asset_id: id, current_height: 1500, active_profile: {
  verifier_kind: updated && id === config.b23_asset_id ? 'sp1-groth16' : id === a666 ? 'multi-fetch-quorum' : 'placeholder',
  min_attestations: id === a666 ? 1 : 0, max_snapshot_age_blocks: 1000, max_epoch_gap_blocks: id === a666 ? 1000 : 128,
}, packets: [
  { state: 'finalized', epoch: 1, submitted_at_height: 100, nav_per_unit: 1000000, circulating_supply: 1000000, verified_net_assets: 1000000, attested_value: 0, cryptographically_verified_value: 0 },
  { state: 'finalized', epoch: updated && id !== a666 ? 3 : 2, reserve_packet_hash: ledger.nav.reserve_packet_hash, submitted_at_height: id === a666 ? 300 : 1450, nav_per_unit: id === a666 ? 100000000000 : updated ? 2000000 : 1000000, circulating_supply: id === a666 ? 200000 : 400000000000, verified_net_assets: id === a666 ? 20000000000 : 400000000000, attested_value: updated && id !== a666 ? 100000000000 : 0, cryptographically_verified_value: updated && id !== a666 ? 200000000000 : 0 },
] });
window.fetch = async url => Response.json(String(url).endsWith('/registry') ? { coins } : String(url).endsWith('/equity') ? {} : config);
const client = { accountId: 'synthetic-gallery', address: bob, unlocked: true,
  async getBalances() { const result = structuredClone(ledger.balances); result.address = bob; result.assets.lines.push({ asset_id: a666, balance: 100000, precision: 6 }); return result; },
  async subscribe() { return () => {}; },
  async call(method, args) {
    calls.push(method);
    if (method === 'nav_reserve_proof_status') return proof(args.asset_id);
    if (method === 'asset_info') return { asset: { asset_id: args.asset_id, issuer: config.issuer_address, precision: 6, outstanding_supply: args.asset_id === a666 ? 100000 : 400000000000 } };
    if (method === 'navcoin_bridge_supply_status') return args.route_id === 'synthetic-a666-route' ? { ...structuredClone(ledger.pool), route_id: args.route_id, native_nav_asset_id: a666, live_value_enabled: false } : structuredClone(ledger.pool);
    if (method === 'book_offers') return { offers: [], truncated: false };
    if (method === 'account_offers') return { offers: [], truncated: false };
    if (method === 'account_tx') return { transactions: [] };
    throw Error(`Unexpected synthetic read: ${method}`);
  },
  quote: () => { throw Error('This gallery fixture forbids quotes and writes'); },
};
function App() {
  const [selectedCoin, onSelectCoin] = useState(null), [home, setHome] = useState(false);
  window.galleryFixture = { update: () => { updated = true; }, calls, home: () => setHome(true) };
  const navigate = (tab, coin) => { if (tab === 'Gallery') { setHome(false); onSelectCoin(coin); } };
  return <main className="l1w"><p>SYNTHETIC GALLERY — NO CHAIN WRITES</p>{home ? <WalletHome client={client} onNavigate={navigate} /> : <Gallery client={client} selectedCoin={selectedCoin} onSelectCoin={onSelectCoin} onNavigate={navigate} />}</main>;
}
createRoot(document.getElementById('root')).render(<App />);
