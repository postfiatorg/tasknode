// Synthetic harness for the Send screen: no network, no keys, no submission.
import { createRoot } from 'react-dom/client';
import Send from './Send.jsx';
const address = 'pf' + '33'.repeat(20), issuer = 'pf' + '22'.repeat(20), series = '5e'.repeat(48);
const world = { pft: 4_999_944, held: { [address]: 299_000_000 }, quotes: [], submitted: [] };
window.mockSend = world;
const lines = () => ({ lines: [
  { code: 'B24', asset_id: 'b2'.repeat(48), issuer: 'pf' + '44'.repeat(20), balance: 1_000_000 },
  { code: 'PFUSDC', asset_id: series, asset_family_id: 'fa'.repeat(48), issuer, balance: world.held[address], frozen: false },
] });
const client = { address, accountId: 'synthetic', unlocked: true,
  async getBalances() { return { address, pft: { balance: world.pft, sequence: 3 }, assets: lines() }; },
  async call(method, params) {
    if (method === 'account_assets') return { ok: true, result: { assets: [{ asset_id: series, balance: world.held[params.account] || 0 }] } };
    if (method === 'account') return { ok: true, result: { balance: 0, sequence: 0 } };
    throw new Error(`Unexpected mock client call ${method}`);
  },
  async quote(intent) { world.quotes.push(intent); return { minimum_fee: 22, sequence: 4, operation: intent.operation }; },
  async sign(intent) { return { intent }; },
  async submit({ intent }) {
    world.submitted.push(intent);
    if (intent.kind === 'asset') { world.held[address] -= intent.operation.amount; world.held[intent.to] = (world.held[intent.to] || 0) + intent.operation.amount; }
    return { txId: 'ab'.repeat(48), accepted: true };
  },
};
createRoot(document.getElementById('root')).render(<Send client={client} />);
