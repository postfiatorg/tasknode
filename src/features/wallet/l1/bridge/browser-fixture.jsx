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
const solanaOwner = '6'.repeat(43), solanaSignature = '5'.repeat(87), solanaProgram = '7'.repeat(43);
const solanaNonce = 'ab'.repeat(32), solanaJob = '0x' + '30'.repeat(32);
const solanaStages = ['finality', 'capture', 'witness', 'proof', 'sign', 'submit', 'credit'];
window.mockSolana = [];
window.phantom = { solana: { isPhantom: true, publicKey: null,
  async connect() { this.publicKey = solanaOwner; return { publicKey: solanaOwner }; },
  async request({ method, params }) {
    window.mockSolana.push({ phantom: method, message: params.message });
    const calls = Number(localStorage.getItem('mock:phantom-sends') || 0) + 1;
    localStorage.setItem('mock:phantom-sends', String(calls));
    return { serialize: () => new Uint8Array([1, ...Array(64).fill(7), 1, 2, 3]) };
  },
} };
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
  if (String(url).includes('/solana/')) {
    const body = options.body ? JSON.parse(options.body) : null;
    window.mockSolana.push({ url: String(url), body });
    const path = String(url).split('/solana/')[1];
    if (path === 'readiness') return Response.json({ ok: true, ready: mode !== 'blocked', message: 'Vault paused',
      vault_program_id: solanaProgram, light_client_epoch: 100, per_deposit_cap_atoms: '25000000', total_cap_atoms: '100000000', available_atoms: '25000000' });
    if (path === 'intent') localStorage.setItem('mock:solana-request', JSON.stringify(body));
    if (path === 'intent') return Response.json({ ok: true, ...body, message_b58: '3mJr7AoUXx2Wqd', vault_program_id: solanaProgram,
      nonce: solanaNonce, last_valid_block_height: 1234 });
    if (path === 'send' && mode === 'interrupted') throw Error('Lost response after broadcast');
    if (path === 'send') return Response.json({ ok: true, signature: solanaSignature });
    if (path === 'recovery') return Response.json(mode === 'interrupted' ? { ok: true, expired: false } : { ok: true, signature: solanaSignature });
    if (path === 'jobs' && body.signature === solanaSignature) return Response.json({ ok: true, job_id: solanaJob });
    if (path !== 'jobs/' + solanaJob) throw Error('Unexpected Solana request');
    const stage = sessionStorage.getItem('mock:solana-stage') || 'finality';
    const end = stage === 'accepted', failed = stage === 'failed', active = failed ? 3 : solanaStages.indexOf(stage);
    const start = Number(sessionStorage.getItem('mock:solana-time') || Date.now() / 1000);
    sessionStorage.setItem('mock:solana-time', String(start));
    return Response.json({ ok: true, signature: solanaSignature, job_id: solanaJob, status: stage,
      receipts: end ? [{ ...JSON.parse(localStorage.getItem('mock:solana-request')), nonce: mode === 'wrong-receipt' ? '88'.repeat(32) : solanaNonce, vault_program_id: solanaProgram }] : [],
      receipt_id: end ? 'dc'.repeat(48) : '', receipt_code: end ? 'ACCEPTED' : '', ledger_tx_id: end ? 'ee'.repeat(48) : undefined,
      updated_at_unix: end || failed ? start + 10 : start, message: failed ? 'Deposit proof rejected.' : '',
      stage_history: solanaStages.slice(0, end ? solanaStages.length : active + 1).map((stage, i) => ({
        stage, status: end || i < active ? 'complete' : failed ? 'failed' : 'running',
        started_at_unix: start + i * (i + 1) / 8, completed_at_unix: end || i < active ? start + (i + 1) * (i + 2) / 8 : null,
      })) });
  }
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
    if (method === 'receipts') return { ok: true, result: mode === 'missing-ledger-receipt' ? [] : [{ tx_id: 'ee'.repeat(48), code: 'accepted', accepted: true }] };
    if (method === 'vault_bridge_route') return routeReport();
    if (method === 'account_assets') {
      if (mode === 'balance-fail') throw new Error('Mock balance RPC unavailable');
      return { ok: true, result: { assets: [{ asset_id: 'ff'.repeat(48), balance: '99000000' }, { asset_id: asset, balance: '2000000' }] } };
    }
    throw new Error(`Unexpected mock client call ${method}`);
  } };
createRoot(document.getElementById('root')).render(<L1WalletContext.Provider value={client}><BridgeTab /></L1WalletContext.Provider>);
