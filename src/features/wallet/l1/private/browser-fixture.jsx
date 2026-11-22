import { createRoot } from 'react-dom/client';
import L1WalletView from '../L1WalletView.jsx';
import { L1WalletCore } from '../core.js';
import '../l1-wallet.css';

// Only public ledger reads are synthetic here. Vault creation, account proofs and shield signing are real.
L1WalletCore.prototype.getBalances = async () => ({ pft: { balance: 10000000 }, assets: { lines: [
  { code: 'PFUSDC', precision: 6, issuer: 'pf' + '2'.repeat(40), asset_id: 'a'.repeat(96), balance: 12000000 },
] } });
L1WalletCore.prototype.call = async () => ({ ok: true, result: { rows: [] } });
L1WalletCore.prototype.subscribe = async () => () => {};
createRoot(document.getElementById('root')).render(<L1WalletView accountId="browser" privatePayments />);
