import { initWasm } from './lib/wasm-loader.js';
import { encryptVault, decryptVault, loadVault, saveVault } from './lib/vault.js';
import { CHAIN_ID, ACCOUNT_INDEX } from './lib/utils.js';

// A controller belongs to exactly one mounted Task Node account. Private
// signing material never enters React props, storage in plaintext, or RPC.
export class L1WalletCore {
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
  lock() { this.#generation += 1; this.#backup = null; this.address = null; }
  dispose() { this.lock(); this.#disposed = true; }
  async status() { this.assertCurrent(); return loadVault(this.accountId); }
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
