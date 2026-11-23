import { createRoot } from 'react-dom/client';
import Withdraw from './Withdraw.jsx';
import { burn, ready, recipient } from './withdraw-fixtures.mjs';
const client = {
  address: 'pf' + '1'.repeat(40), chainId: 'fixture-network', accountId: 'fixture-account',
  async getBalances() { return { assets: { lines: [] } }; },
  async call(method, params) {
    if (method !== 'account_assets' || params.account !== this.address || params.asset_id !== ready.series_asset_id) throw Error('Unexpected RPC');
    return { ok: true, result: { assets: [{ asset_id: ready.asset_id, balance: '99000000' },
      { asset_id: ready.series_asset_id, source_bucket_id: ready.bucket_id, balance: '20000' }] } };
  },
  async quote(intent) { window.quoted = intent; return { minimum_fee: 1 }; },
  async sign(intent) {
    if (intent !== window.quoted) throw Error('Unexpected signing request');
    localStorage.setItem('test-signatures', String(Number(localStorage.getItem('test-signatures')) + 1));
    return { fixture: true };
  },
  async submit(signed) { if (!signed.fixture) throw Error('Unexpected submission'); return { txId: burn }; },
};
window.phantom = { solana: { publicKey: recipient, request() { throw Error('Unexpected Phantom signature'); } } };
createRoot(document.getElementById('root')).render(<Withdraw client={client} />);
