import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha3_384 } from '@noble/hashes/sha3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { fundingAlgorithm } from '../../../../../shared/private-funding.js';
import { privateMessage, privatePaths, privateSignatureContext, restoreMessage } from '../../../../../shared/private-payment.js';
import { assertNoCustodyMaterial } from '../lib/custody-boundary.js';
import { CHAIN_ID, GENESIS_HASH } from '../lib/utils.js';
import { fundingContext, shieldAuthorization } from './shield.js';

const utf8 = new TextEncoder();
export async function openPrivateSession({ backup, accountId, address, current }) {
  const b = JSON.parse(backup);
  // Match the L1 wallet SDK's derive_wallet_seed. This signature domain cannot authorize an L1 transaction.
  const payload = JSON.stringify([b.derivation_domain, b.algorithm_id, b.chain_id, b.account_index, b.key_role, b.master_seed_hex]);
  const digest = sha3_384(utf8.encode(b.derivation_domain + '\0' + payload));
  const keys = ml_dsa65.keygen(digest.subarray(0, 32));
  digest.fill(0);
  const publicKey = bytesToHex(keys.publicKey);
  const derived = sha3_384.create().update(utf8.encode('postfiat.address.v1\0')).update(keys.publicKey).digest();
  if ('pf' + bytesToHex(derived.subarray(0, 20)) !== address) throw Error('Unlock the matching L1 wallet.');
  const storageKey = 'private-payment-v1:' + accountId + ':' + address;
  const master = hexToBytes(b.master_seed_hex);
  const base = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveKey']);
  master.fill(0);
  const cipher = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(storageKey), info: utf8.encode('local recovery') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
  const registeredKey = storageKey + ':registered:' + CHAIN_ID + ':' + GENESIS_HASH;
  let registeredAddress;
  current();
  return {
    async balance(signal) {
      if (!registeredAddress) {
        const path = localStorage.getItem(registeredKey) ? 'address' : 'wallet/create';
        try { registeredAddress = (await this.request(path, {}, signal)).address; }
        catch (error) {
          if (error.message === restoreMessage) localStorage.setItem(registeredKey, '1');
          throw error;
        }
        localStorage.setItem(registeredKey, '1');
      }
      const balance = await this.request('balance', {}, signal);
      if (balance.address !== registeredAddress) throw Error(restoreMessage);
      if (balance.snapshot?.chain_id !== CHAIN_ID || balance.snapshot.genesis_hash !== GENESIS_HASH) throw Error('Private balance is from another network.');
      return balance;
    },
    storageKey,
    close() { keys.secretKey.fill(0); },
    async request(path, body = {}, signal) {
      current();
      if (!privatePaths.has(path)) throw Error('Unknown private wallet request.');
      assertNoCustodyMaterial(body);
      const expires = Date.now() + 60000;
      const signature = bytesToHex(ml_dsa65.sign(privateMessage(accountId, path, body, expires), keys.secretKey, { context: privateSignatureContext }));
      const response = await fetch('/api/l1/private/' + path, {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(65000)]) : AbortSignal.timeout(65000),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, proof: { expires, publicKey, signature } }),
      });
      current();
      const value = await response.json();
      if (!response.ok) {
        const message = response.status === 401 ? 'Sign in again to use the private wallet.' :
          value.error === 'l1_origin_rejected' ? 'Open the wallet on the Task Node site to use private payments.' :
          value.error || 'The private wallet request failed.';
        const error = Error(message);
        error.refused = response.status === 400 && value.unchanged === true;
        throw error;
      }
      return value;
    },
    async authorize(prepared, terms, signal) {
      current();
      const own = await this.request('address', {}, signal);
      if (own.address !== registeredAddress) throw Error(restoreMessage);
      return shieldAuthorization(prepared, { ...terms, account: address, privateAddress: own.address }, digest => ({
        algorithm_id: fundingAlgorithm, public_key_hex: publicKey,
        signature_hex: bytesToHex(ml_dsa65.sign(digest, keys.secretKey, { context: fundingContext })),
      }));
    },
    async load() {
      current();
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const { iv, data } = JSON.parse(raw);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(iv) }, cipher, hexToBytes(data));
      current();
      return JSON.parse(new TextDecoder().decode(plain));
    },
    async save(job) {
      current();
      if (!job) { localStorage.removeItem(storageKey); return; }
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cipher, utf8.encode(JSON.stringify(job)));
      current();
      localStorage.setItem(storageKey, JSON.stringify({ iv: bytesToHex(iv), data: bytesToHex(new Uint8Array(data)) }));
    },
  };
}
