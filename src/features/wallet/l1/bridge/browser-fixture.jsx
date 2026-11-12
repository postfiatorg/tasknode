// Synthetic browser harness: no network RPC, no real wallet and no transaction submission.
import { createRoot } from 'react-dom/client';
import { Interface, keccak256 } from 'ethers';
import { L1WalletContext } from '../client.jsx';
import BridgeTab from './index.jsx';
import { address, owner, asset, profile, routeReport, readyPayload, jobId, depositTx } from './fixtures.mjs';
import { STAGES } from './stages.js';
const mode = new URLSearchParams(location.search).get('mode') || 'ready';
profile.vault_runtime_code_hash = keccak256('0x6000');
profile.token_runtime_code_hash = keccak256('0x6000');
const iface = new Interface([
  'function depositV2(uint256 amount,string recipient,bytes32 nonce,bytes32 binding)',
  'event ERC20BridgeDepositedV2(bytes32 indexed depositId,address indexed depositor,bytes32 indexed recipientHash,string recipient,uint256 amount,bytes32 nonce,bytes32 binding,uint256 chain,address vault,address token)',
]);
const sends = [];
window.mockSends = sends;
window.ethereum = {
  on() {}, removeListener() {},
  async request({ method, params }) {
    if (['eth_requestAccounts', 'eth_accounts'].includes(method)) return [owner];
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_call') return '0x989680';
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_sendTransaction') {
      sends.push(params[0]);
      if (params[0].to === profile.token_address) return `0x${'ef'.repeat(32)}`;
      const args = iface.decodeFunctionData('depositV2', params[0].data);
      const log = iface.encodeEventLog(iface.getEvent('ERC20BridgeDepositedV2'), [
        `0x${'aa'.repeat(32)}`, owner, `0x${'bb'.repeat(32)}`, address, args.amount, args.nonce, args.binding, 1, profile.vault_address, profile.token_address,
      ]);
      localStorage.setItem('mock:deposit-log', JSON.stringify({ ...log, address: profile.vault_address }));
      return depositTx;
    }
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', blockNumber: '0x123', logs: [JSON.parse(localStorage.getItem('mock:deposit-log'))].filter(Boolean) };
    throw new Error(`Unexpected mock provider method ${method}`);
  },
};
const realFetch = window.fetch.bind(window);
window.fetch = async (url, options = {}) => {
  if (!String(url).startsWith('/api/l1/bridge')) return realFetch(url, options);
  if (String(url).includes('readiness')) {
    if (mode === 'offline') throw new Error('Mock endpoint unreachable');
    const payload = mode === 'blocked' ? { ok: false, ready: false, message: 'Authenticated on-ledger beacon anchor is missing.' } : readyPayload();
    return Response.json(payload);
  }
  if (options.method === 'POST') {
    const request = JSON.parse(options.body);
    localStorage.setItem('mock:job-request', JSON.stringify(request));
    return Response.json({ ok: true, job_id: jobId });
  }
  const stage = sessionStorage.getItem('mock:stage') || 'proving';
  const accepted = stage === 'accepted';
  return Response.json({ ok: true, job_id: jobId, status: stage, receipt_code: accepted ? 'ACCEPTED' : '',
    receipt_id: accepted ? 'ab'.repeat(48) : '', credited_asset_id: asset, asset_id: profile.asset_id, request: JSON.parse(localStorage.getItem('mock:job-request')),
    stage_history: STAGES.slice(0, accepted ? 7 : 4).map(([name], index) => ({ stage: name,
      status: accepted || index < 3 ? 'complete' : 'running', started_at_unix: 1794480000 + index * 10,
      completed_at_unix: accepted || index < 3 ? 1794480005 + index * 10 : null })) });
};
const client = { address, accountId: 'synthetic-bob', unlocked: true,
  async call(method) {
    if (method === 'vault_bridge_route') return routeReport();
    if (method === 'account_assets') {
      if (mode === 'balance-fail') throw new Error('Mock balance RPC unavailable');
      return { ok: true, result: { assets: [{ asset_id: 'ff'.repeat(48), balance: '99000000' }, { asset_id: asset, balance: '2000000' }] } };
    }
    throw new Error(`Unexpected mock client call ${method}`);
  } };
createRoot(document.getElementById('root')).render(<L1WalletContext.Provider value={client}><BridgeTab /></L1WalletContext.Provider>);
