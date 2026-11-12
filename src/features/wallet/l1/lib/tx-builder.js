// Focused port of wallet-web quote/sign/submit. Finality never implies acceptance.
import { CHAIN_ID, GENESIS_HASH, PROTOCOL_VERSION, isValidAddress } from './utils.js';
import { rpcResult } from './rpc-client.js';
const integerKeys = new Set(['amount', 'sequence', 'fee', 'epoch', 'limit', 'mint_amount', 'mint_amount_atoms', 'nav_epoch', 'redeem_amount', 'redeem_amount_atoms', 'settlement_amount', 'settlement_amount_atoms']);
function canonical(value, key = '') {
  if (integerKeys.has(key) && /^(0|[1-9][0-9]*)$/.test(String(value))) return JSON.stringify(String(value));
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k], k)}`).join(',')}}`;
}
export function reviewedSignedOperation(signed, operation) {
  const unsigned = signed?.unsigned;
  if (!unsigned || !operation || typeof operation !== 'object') return null;
  if (unsigned.operation && typeof unsigned.operation === 'object') return unsigned.operation;
  // SignedAssetTransaction flattens its tagged operation into the unsigned
  // envelope. Compare every reviewed field, including nested policy fields.
  if (!Object.keys(operation).every(key => Object.hasOwn(unsigned, key))) return null;
  return Object.fromEntries(Object.keys(operation).map(key => [key, unsigned[key]]));
}
export function safeAtoms(value) {
  if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error('Amount must be positive integer atoms within the safe range');
  return Number(value);
}
export function pftInputAtoms(value) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) throw new Error('Enter PFT with at most six decimal places');
  const [whole, fraction = ''] = value.split('.');
  return String(safeAtoms(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))));
}
export function validateQuote(intent, quote, address) {
  if (quote?.chain_id !== CHAIN_ID || quote?.genesis_hash !== GENESIS_HASH || quote?.protocol_version !== PROTOCOL_VERSION) throw new Error('Fee quote does not match devnet-2');
  if (!Number.isSafeInteger(Number(quote.minimum_fee)) || Number(quote.minimum_fee) < 0 || quote.minimum_fee == null
    || !Number.isSafeInteger(Number(quote.sequence)) || Number(quote.sequence) < 1) throw new Error('Invalid quote fee or sequence');
  if (intent.kind === 'transfer') {
    if (!isValidAddress(intent.to) || quote.from !== address || quote.to !== intent.to || String(quote.amount) !== String(safeAtoms(intent.amount))) throw new Error('Fee quote does not match reviewed payment');
    if (quote.sender_meets_reserve_after_transfer !== true) throw new Error('Insufficient PFT after payment and reserve');
  } else if (['asset', 'offer'].includes(intent.kind)) {
    if (quote.source !== address || !quote.operation || canonical(quote.operation) !== canonical(intent.operation)) throw new Error('Fee quote does not match reviewed operation');
    if (quote.sender_meets_reserve_after_fee !== true || quote.sender_meets_reserve_after_fee_and_reserve === false) throw new Error('Insufficient PFT for fee and reserve');
  } else throw new Error('Unsupported transaction kind');
}
export function explicitReceipt(txId, result) {
  const candidates = [result?.finality?.receipt, result?.receipt,
    ...(result?.finality?.local_hot_finality || result?.local_hot_finality || []).map(row => row.receipt),
    ...(Array.isArray(result) ? result : []), ...(result?.receipts || [])];
  return candidates.find(receipt => receipt?.tx_id === txId && typeof receipt.accepted === 'boolean') || null;
}
export function requireAccepted(txId, receipt) {
  if (receipt?.tx_id !== txId || typeof receipt?.accepted !== 'boolean') throw new Error(`No execution receipt for ${txId}; check activity before retrying`);
  if (!receipt.accepted) throw new Error(`Transaction ${txId} rejected: ${receipt.reject_reason || receipt.code || receipt.message || 'execution rejected'}`);
  return receipt;
}
export class TxBuilder {
  #quotes = new WeakMap();
  #signed = new WeakMap();
  constructor(rpc, assertCurrent = () => {}) { this.rpc = rpc; this.assertCurrent = assertCurrent; }
  async quote(intent, address) {
    this.assertCurrent();
    const snapshot = structuredClone(intent);
    let method, params;
    if (snapshot.kind === 'transfer') {
      if (!isValidAddress(snapshot.to)) throw new Error('Enter a valid pf recipient');
      method = 'transfer_fee_quote'; params = { from: address, to: snapshot.to, amount: safeAtoms(snapshot.amount) };
    } else if (['asset', 'offer'].includes(snapshot.kind) && snapshot.operation && typeof snapshot.operation === 'object') {
      method = `${snapshot.kind}_fee_quote`; params = { source: address, operation_json: JSON.stringify(snapshot.operation) };
    } else throw new Error('Unsupported transaction intent');
    const quote = rpcResult(await this.rpc.call(method, params));
    this.assertCurrent(); validateQuote(snapshot, quote, address);
    this.#quotes.set(quote, { intent: canonical(snapshot), snapshot: canonical(quote), address });
    return quote;
  }
  sign(intent, quote, address, backup, wasm) {
    this.assertCurrent();
    const reviewed = this.#quotes.get(quote);
    if (!reviewed || reviewed.address !== address || reviewed.intent !== canonical(intent) || reviewed.snapshot !== canonical(quote)) throw new Error('Quote changed; request a fresh review');
    validateQuote(intent, quote, address);
    let signed, method, field;
    if (intent.kind === 'transfer') {
      signed = wasm.wallet_sign_transfer(backup, JSON.stringify(quote), JSON.stringify({ from: address, to: intent.to, amount: safeAtoms(intent.amount) }));
      method = 'mempool_submit_signed_transfer_finality'; field = 'signed_transfer_json';
    } else {
      const fields = { chain_id: quote.chain_id, genesis_hash: quote.genesis_hash, protocol_version: quote.protocol_version, source: address, fee: quote.minimum_fee, sequence: quote.sequence, operation: quote.operation };
      if (intent.kind === 'asset') {
        signed = wasm.wallet_sign_asset_transaction_fields(backup, JSON.stringify(fields));
        method = 'mempool_submit_signed_asset_transaction_finality'; field = 'signed_asset_transaction_json';
      } else {
        signed = wasm.wallet_sign_offer_transaction_fields(backup, JSON.stringify(fields));
        method = 'mempool_submit_signed_offer_transaction'; field = 'signed_offer_json';
      }
    }
    if (intent.kind !== 'transfer' && canonical(reviewedSignedOperation(signed, quote.operation)) !== canonical(quote.operation)) {
      throw new Error('Wallet WASM cannot preserve the reviewed operation; a compatible wallet artifact is required');
    }
    this.#quotes.delete(quote);
    const handle = Object.freeze({ kind: intent.kind });
    this.#signed.set(handle, { method, params: { [field]: JSON.stringify(signed) } });
    return handle;
  }
  async submit(handle, { timeoutMs = 30000, pollMs = 1000 } = {}) {
    this.assertCurrent();
    const signed = this.#signed.get(handle);
    if (!signed) throw new Error('Signed transaction is stale or already submitted');
    this.#signed.delete(handle); // Never replay automatically after transport uncertainty.
    const result = rpcResult(await this.rpc.call(signed.method, signed.params));
    const txId = result?.tx_id;
    if (typeof txId !== 'string' || !txId) throw new Error('Submission returned no transaction id; check activity before retrying');
    const deadline = Date.now() + timeoutMs;
    let receipt = explicitReceipt(txId, result);
    while (!receipt && Date.now() < deadline) {
      this.assertCurrent();
      await new Promise(resolve => setTimeout(resolve, pollMs));
      this.assertCurrent();
      receipt = explicitReceipt(txId, rpcResult(await this.rpc.call('receipts', { tx_id: txId })));
    }
    this.assertCurrent();
    return { txId, receipt: requireAccepted(txId, receipt), finality: result.finality || null };
  }
}
