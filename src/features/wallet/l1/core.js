import { registerCustodyMaterial, clearCustodyMaterialRegistry } from './lib/custody-boundary.js';
import { initWasm } from './lib/wasm-loader.js';
import { encryptVault, decryptVault, loadVault, saveVault } from './lib/vault.js';
import { TxBuilder } from './lib/tx-builder.js';
import { RpcClient, rpcResult } from './lib/rpc-client.js';
import { assertL1CallAllowed } from './lib/rpc-methods.js';
import { CHAIN_ID, ACCOUNT_INDEX } from './lib/utils.js';

// A controller belongs to exactly one mounted Task Node account. Private
// signing material never enters React props, storage in plaintext, or RPC.
export class L1WalletCore {
  #builder = null;
  #rpc = null;
  #backup = null;
  #generation = 0;
  #disposed = false;
  constructor(accountId, isCurrent = () => true) {
    if (!accountId) throw new Error('Sign in first');
    this.accountId = accountId;
    this.isCurrent = isCurrent;
    this.address = null;
  }
  get unlocked() { return Boolean(this.#backup) && !this.#disposed && this.isCurrent(); }
  assertCurrent(generation = this.#generation) {
    if (this.#disposed || !this.isCurrent() || generation !== this.#generation) throw new Error('L1 account session changed or locked');
  }
  lock() { clearCustodyMaterialRegistry(); this.#generation += 1; this.#backup = null; this.address = null; this.#rpc?.close(); this.#rpc = null; this.#builder = null; }
  dispose() { this.lock(); this.#disposed = true; }
  async call(method, params = {}) {
    const generation = this.#generation;
    this.assertCurrent(generation);
    assertL1CallAllowed(method, this.unlocked);
    this.#rpc ||= new RpcClient();
    const result = await this.#rpc.call(method, params);
    this.assertCurrent(generation);
    return result;
  }
  async status() { const generation = this.#generation; this.assertCurrent(generation); const vault = await loadVault(this.accountId); this.assertCurrent(generation); return vault; }
  requireUnlocked() { this.assertCurrent(); if (!this.#backup || !this.address) throw new Error('Unlock your L1 wallet'); }
  builder() {
    this.requireUnlocked();
    this.#rpc ||= new RpcClient();
    const generation = this.#generation;
    this.#builder ||= new TxBuilder(this.#rpc, () => { this.assertCurrent(generation); this.requireUnlocked(); });
    return this.#builder;
  }
  async getBalances() {
    this.requireUnlocked();
    const address = this.address;
    const [pft, assets] = await Promise.all([this.call('account', { address }), this.call('account_lines', { account: address })]);
    return { address, pft: rpcResult(pft), assets: rpcResult(assets) };
  }
  quote(intent) { return this.builder().quote(intent, this.address); }
  async sign(intent, quote) {
    const generation = this.#generation;
    const builder = this.builder();
    const wasm = await initWasm();
    this.assertCurrent(generation);
    return builder.sign(intent, quote, this.address, this.#backup, wasm);
  }
  submit(handle) { return this.builder().submit(handle); }
  async subscribe(handler) {
    this.requireUnlocked();
    const generation = this.#generation;
    const response = rpcResult(await this.call('wallet_subscribe', { address: this.address, include_assets: true, interval_ms: 1500 }));
    if (!response.subscription_id) throw new Error('Wallet subscription unavailable');
    this.assertCurrent(generation);
    const off = this.#rpc.onNotification(event => {
      if (!this.unlocked || generation !== this.#generation) return;
      if (event.method === 'wallet_update' && event.params?.subscription_id === response.subscription_id) handler(event.params.snapshot);
    });
    return () => { off(); if (this.unlocked && generation === this.#generation) void this.call('wallet_unsubscribe', { subscription_id: response.subscription_id }).catch(() => {}); };
  }
  async create(passphrase, seed = null) {
    const generation = this.#generation;
    this.assertCurrent(generation);
    if (passphrase.length < 10) throw new Error('Use at least 10 characters');
    if (await loadVault(this.accountId)) throw new Error('An L1 wallet already exists for this account');
    const wasm = await initWasm();
    this.assertCurrent(generation);
    const masterSeed = seed || wasm.random_master_seed();
    if (!/^[0-9a-f]{64}$/.test(masterSeed)) throw new Error('Seed must be 64 lowercase hex characters');
    const result = wasm.wallet_keygen(CHAIN_ID, masterSeed, ACCOUNT_INDEX);
    const blob = await encryptVault(masterSeed, passphrase);
    this.assertCurrent(generation);
    const metadata = { address: result.address, public_key_hex: result.public_key_hex, chain_id: CHAIN_ID };
    await saveVault(this.accountId, blob, metadata);
    this.assertCurrent(generation);
    registerCustodyMaterial({ seed: masterSeed, backupJson: result.backup_json, passphrase });
    this.#backup = result.backup_json;
    this.address = result.address;
    return this.address;
  }
  async unlock(passphrase) {
    const generation = this.#generation;
    const stored = await this.status();
    if (!stored) throw new Error('No L1 wallet found');
    const seed = await decryptVault(stored.blob, passphrase);
    const wasm = await initWasm();
    this.assertCurrent(generation);
    const result = wasm.wallet_keygen(CHAIN_ID, seed, ACCOUNT_INDEX);
    if (result.address !== stored.metadata?.address || (stored.metadata.chain_id && stored.metadata.chain_id !== CHAIN_ID)) throw new Error('Backup address or chain does not match devnet-2');
    registerCustodyMaterial({ seed, backupJson: result.backup_json, passphrase });
    this.#backup = result.backup_json;
    this.address = result.address;
    return this.address;
  }
  async importBackup(backup, passphrase) {
    const generation = this.#generation;
    this.assertCurrent(generation);
    if (await loadVault(this.accountId)) throw new Error('An L1 wallet already exists for this account');
    if (!backup?.vault || !backup?.metadata?.address) throw new Error('Invalid encrypted wallet backup');
    if (backup.metadata.chain_id && backup.metadata.chain_id !== CHAIN_ID) throw new Error('Backup belongs to a different chain');
    const seed = await decryptVault(backup.vault, passphrase);
    const wasm = await initWasm();
    this.assertCurrent(generation);
    const result = wasm.wallet_keygen(CHAIN_ID, seed, ACCOUNT_INDEX);
    if (result.address !== backup.metadata.address) throw new Error('Backup address does not match its seed');
    const metadata = { address: result.address, public_key_hex: result.public_key_hex, chain_id: CHAIN_ID };
    const { salt, iv, ciphertext } = backup.vault;
    await saveVault(this.accountId, { salt, iv, ciphertext }, metadata);
    this.assertCurrent(generation);
    registerCustodyMaterial({ seed, backupJson: result.backup_json, passphrase });
    this.#backup = result.backup_json;
    this.address = result.address;
    return this.address;
  }
  async exportBackup() {
    const stored = await this.status();
    if (!stored) throw new Error('No L1 wallet found');
    return { version: 1, vault: stored.blob, metadata: stored.metadata };
  }
}
