// Live harness: the real Solana deposit card against the real wallet server and a real Phantom
// extension. Used by scripts/phantom-live.mjs. Nothing here is mocked.
import { createRoot } from 'react-dom/client';
import SolanaDeposit from './SolanaDeposit.jsx';
const address = new URLSearchParams(location.search).get('recipient');
const client = { accountId: 'phantom-live', address, unlocked: true,
  async call(method, params) {
    const response = await fetch('/pftl-rpc', { method: 'POST', body: JSON.stringify({ method, params }) });
    return response.json();
  } };
createRoot(document.getElementById('root')).render(<SolanaDeposit client={client} />);
