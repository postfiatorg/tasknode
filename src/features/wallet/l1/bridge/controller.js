import * as evm from "./evm.js";
import { creditedBalance } from "./balance.js";
import * as api from "./bridge-relay.js";
import { parseGovernedVaultBridgeRoute } from "./bridge-route.js";

const CHAIN = "postfiat-wan-devnet-2";
const GENESIS = "ce22ca8c932da0998b484483a09647138a30e0bf44408dd49a8d6d452787ad25521aff3ed334da07e150a7233a3e90a9";
export function amountAtoms(value) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) return null;
  const atoms = evm.usdcToAtoms(value);
  return atoms > 0n && atoms <= (1n << 64n) - 1n ? atoms : null;
}
// A broadcast deposit normally gets its bridge job within a few minutes: the receipt wait gives up after
// 120 s and job creation follows at once. 15 minutes is well past that and past Ethereum finality (about 13 minutes).
export const STUCK_AFTER_MS = 15 * 60 * 1000;
// Recovery controls are only for a stuck deposit: no hash, a failed check of the hash, or no job after STUCK_AFTER_MS.
export function needsRecovery(pending, checkFailed, now = Date.now()) {
  if (!pending || pending.jobId) return false;
  if (!pending.tx || checkFailed) return true;
  return !(now - pending.txSavedAt < STUCK_AFTER_MS);
}
export function rpcEnvelope(response) {
  return response?.ok === undefined ? { ok: true, result: response } : response;
}
export class BridgeController {
  constructor(client, { ethereum = evm, service = api, storage = globalThis.localStorage, changed = () => {} } = {}) {
    this.client = client;
    this.ethereum = ethereum;
    this.service = service;
    this.storage = storage;
    this.changed = changed;
    this.address = client.address;
    this.accountId = client.accountId;
    this.key = `tn:l1:bridge:v1:${this.accountId}:${this.address}`;
    this.active = true;
    this.abort = new AbortController();
    this.state = { ready: false, blocked: "Checking bridge readiness.", owner: "", balance: null, allowance: null, busy: false, quiet: false, checked: false, error: "", pending: null, checkFailed: false, job: null, result: null };
    try {
      const saved = JSON.parse(storage.getItem(this.key));
      // A deposit already shown as credited is history: it is not replayed on the next visit.
      if (saved?.done === true) storage.removeItem(this.key);
      else if (saved?.pending?.recipient === this.address && saved.accountId === this.accountId) this.state.pending = saved.pending;
    } catch { /* no saved public job */ }
  }
  guard() {
    if (!this.active || !this.client.unlocked || this.client.address !== this.address || this.client.accountId !== this.accountId) {
      throw new Error("Wallet session changed. Reopen the bridge.");
    }
  }
  set(patch) { if (this.active) { Object.assign(this.state, patch); this.changed({ ...this.state }); } }
  save(pending, broadcast = false) {
    if (!broadcast) this.guard();
    // Persist only public recovery data, scoped to Task Node account AND pf address.
    this.storage.setItem(this.key, JSON.stringify({ accountId: this.accountId, pending }));
    this.set({ pending, checkFailed: false });
  }
  dispose() { this.active = false; this.abort.abort(); }
  async readiness() {
    // A recheck of a ready bridge keeps the badge steady; any failure below still fails closed.
    if (!this.state.ready) this.set({ ready: false, blocked: "Checking bridge readiness." });
    try {
      this.guard();
      const ready = await this.service.loadBridgeReadiness();
      if (ready.ready !== true) throw new Error(ready.message || "Ingress is unavailable.");
      const response = await this.client.call("vault_bridge_route", { asset_id: ready.asset_id });
      const route = parseGovernedVaultBridgeRoute(rpcEnvelope(response), {
        chainId: CHAIN, genesisHash: GENESIS, assetId: ready.asset_id,
        sourceChainId: 1, tokenAddress: evm.ETH_MAINNET_USDC,
      });
      this.service.assertBridgeReadinessMatchesRoute(ready, route);
      this.guard();
      this.route = route;
      this.set({ ready: true, blocked: "" });
      return route;
    } catch (error) {
      this.route = null;
      this.set({ ready: false, blocked: error.message });
      throw error;
    }
  }
  async connect() {
    this.guard();
    const owner = (await this.ethereum.connectMetaMask()).toLowerCase();
    await this.ethereum.ensureEthereumMainnet();
    this.guard();
    this.set({ owner });
    await this.refreshEthereum();
  }
  async refreshEthereum() {
    if (!this.state.owner) return;
    const balance = await this.ethereum.getEthereumUsdcBalance(this.state.owner);
    const allowance = this.route ? await this.ethereum.getEthereumUsdcAllowance(this.state.owner, this.route.vaultAddress) : null;
    this.guard();
    this.set({ balance, allowance });
  }
  providerChanged() {
    this.route = null;
    this.set({ owner: "", balance: null, allowance: null, ready: false, blocked: "MetaMask account or network changed. Reconnect and check readiness." });
  }
  async preflight(amount) {
    this.guard();
    const atoms = amountAtoms(amount);
    if (!atoms) throw new Error("Enter a positive USDC amount with at most six decimals.");
    const expected = this.route?.profileHash;
    const route = await this.readiness();
    if (expected && expected !== route.profileHash) throw new Error("Bridge route changed. Review it before signing.");
    await this.ethereum.ensureEthereumMainnet();
    const owner = (await this.ethereum.getEvmBalance())?.toLowerCase();
    if (!owner || owner !== this.state.owner) throw new Error("MetaMask account changed. Reconnect.");
    await this.ethereum.assertContractCodeHash(route.vaultAddress, route.vaultRuntimeCodeHash);
    await this.ethereum.assertContractCodeHash(route.tokenAddress, route.tokenRuntimeCodeHash);
    await this.refreshEthereum();
    if (this.state.balance < atoms) throw new Error("Insufficient USDC balance.");
    this.guard();
    return { route, atoms, owner };
  }
  async approve(amount) {
    const { route, atoms } = await this.preflight(amount);
    // Refresh immediately before invoking MetaMask, even if the displayed check was healthy.
    const fresh = await this.readiness();
    if (fresh.profileHash !== route.profileHash) throw new Error("Bridge route changed before approval. Review again.");
    this.guard();
    const tx = await this.ethereum.approveEthereumUsdc(route.vaultAddress, atoms, this.state.owner, () => this.guard());
    this.set({ approvalTx: tx });
    await this.ethereum.waitForReceipt(tx);
    await this.refreshEthereum();
  }
  async deposit(amount) {
    if (this.state.pending) {
      // A credited deposit no longer blocks the form: starting a new one replaces its record.
      const done = this.state.result && !this.state.result.balancePending;
      if (!done) throw new Error("Resume the existing deposit before starting another.");
      this.newDeposit();
    }
    const { route, atoms, owner } = await this.preflight(amount);
    if (this.state.allowance < atoms) throw new Error("Approve this amount first.");
    const nonce = this.ethereum.generateNonce();
    // Verify that recovery storage works BEFORE requesting an irreversible transaction.
    const pending = { recipient: this.address, route, owner, amountAtoms: String(atoms), nonce, tx: null, jobId: null };
    const fresh = await this.readiness();
    if (fresh.profileHash !== route.profileHash) throw new Error("Bridge route changed before deposit. Review again.");
    this.guard();
    this.save(pending);
    let tx;
    try {
      tx = await this.ethereum.depositToEthereumBridge(route.vaultAddress, atoms, this.address, nonce, route.routeBinding, owner, () => this.guard());
    } catch (error) {
      this.save(null, true);
      throw error;
    }
    // A provider can return the hash after logout; retain it under the OLD account's key.
    try { this.save({ ...pending, tx, txSavedAt: Date.now() }, true); }
    catch { throw new Error(`Ethereum deposit broadcast: ${tx}. Recovery storage failed; retain this hash.`); }
    this.guard();
    await this.resume();
  }
  newDeposit() {
    if (!this.state.result || this.state.result.balancePending) throw new Error("Verify the existing claim balance first.");
    this.save(null);
    this.set({ job: null, result: null, approvalTx: null, error: "" });
  }
  storedJobId() {
    try { return JSON.parse(this.storage.getItem(this.key))?.pending?.jobId || null; } catch { return null; }
  }
  // Clears a deposit that never reached the bridge. A record with a bridge job is never discarded.
  discard() {
    this.guard();
    if (!this.state.pending) return;
    if (this.state.pending.jobId || this.storedJobId()) throw new Error("This deposit has a bridge job and cannot be discarded.");
    this.save(null);
    this.set({ job: null, result: null, approvalTx: null, error: "" });
  }
  // Public state only: no keys, no wallet secrets.
  diagnostics() {
    const { ready, blocked, owner, busy, error, pending, job, result } = this.state;
    return {
      at: new Date().toISOString(), recipient: this.address, ready, blocked, owner, busy, error,
      balance: this.state.balance === null ? null : String(this.state.balance),
      allowance: this.state.allowance === null ? null : String(this.state.allowance),
      pending: pending && { tx: pending.tx, jobId: pending.jobId, amountAtoms: pending.amountAtoms, owner: pending.owner },
      job: job && { id: job.job_id, status: job.status, code: job.code || null },
      result: result && { receipt: result.receipt, balancePending: result.balancePending },
      rpcTimings: (globalThis.__l1Timings || []).slice(-40),
      apiTimings: (globalThis.performance?.getEntriesByType?.("resource") || []).filter(entry => entry.name.includes("/api/"))
        .slice(-40).map(entry => ({ path: new URL(entry.name).pathname, startMs: Math.round(entry.startTime), ms: Math.round(entry.duration) })),
    };
  }
  async recoverHash(tx) {
    if (!/^0x[0-9a-f]{64}$/.test(tx)) throw new Error("Enter the Ethereum deposit transaction hash.");
    const pending = this.state.pending;
    if (!pending || pending.jobId || this.storedJobId()) throw new Error("No interrupted broadcast to recover.");
    this.guard();
    // Check the candidate before saving it; a wrong hash is never stored.
    await this.depositEvent(pending, tx);
    this.guard();
    if (this.state.pending !== pending) throw new Error("Deposit changed during recovery. Reload the bridge.");
    this.save({ ...pending, tx, txSavedAt: pending.txSavedAt || Date.now() });
    await this.resume();
  }
  async depositEvent(pending, tx) {
    await this.ethereum.ensureEthereumMainnet();
    try {
      await this.ethereum.waitForReceipt(tx);
      const event = await this.ethereum.watchDepositEvent(pending.route.vaultAddress, tx, pending.route.routeBinding);
      if (!event || event.pftl_recipient !== this.address || event.depositor.toLowerCase() !== pending.owner
          || String(event.amount) !== pending.amountAtoms || event.nonce !== pending.nonce
          || Number(event.source_chain_id) !== 1 || event.vault !== pending.route.vaultAddress
          || event.token !== pending.route.tokenAddress) throw new Error("Deposit event does not match the reviewed request.");
      return event;
    } catch (error) {
      // Only a failed check of the stored hash marks the deposit stuck; a rejected candidate hash does not.
      if (this.state.pending?.tx === tx) this.set({ checkFailed: true });
      throw error;
    }
  }
  async resume() {
    this.guard();
    let pending = this.state.pending;
    if (!pending?.tx) throw new Error("No broadcast deposit to resume. If MetaMask broadcast during reload, enter its transaction hash.");
    if (!pending.jobId) {
      const event = await this.depositEvent(pending, pending.tx);
      const request = {
        route_id: api.ROUTE_ID, source_chain_id: 1, deposit_tx_hash: pending.tx, deposit_id: event.deposit_id,
        pftl_recipient: this.address, depositor: pending.owner, amount_atoms: pending.amountAtoms,
        idempotency_key: pending.tx, route_profile_hash: pending.route.profileHash,
        route_epoch: pending.route.routeEpoch, route_binding: pending.route.routeBinding,
      };
      this.guard();
      const job = await this.service.createBridgeJob(request);
      pending = { ...pending, jobId: job.job_id };
      this.save(pending);
    }
    await this.poll();
  }
  async poll() {
    if (!this.state.pending?.jobId) return;
    const job = await this.service.loadBridgeJob(this.state.pending.jobId, this.abort.signal);
    this.guard();
    const request = job.request;
    if (job.job_id !== this.state.pending.jobId || request?.pftl_recipient !== this.address
        || request.deposit_tx_hash !== this.state.pending.tx || request.amount_atoms !== this.state.pending.amountAtoms
        || request.route_id !== api.ROUTE_ID || request.depositor !== this.state.pending.owner) {
      throw new Error("Bridge job does not match this wallet's deposit.");
    }
    this.set({ job, result: null });
    if (job.status === "failed") throw new Error(job.message || job.code || "Bridge claim failed.");
    if (job.status === "accepted") {
      if (!/^[0-9a-f]{96}$/.test(job.credited_asset_id || "")
          || job.asset_id !== this.state.pending.route?.profile?.asset_id) {
        throw new Error("Claim credited-asset identity is unverified; relay upgrade required.");
      }
      if (job.receipt_code !== "ACCEPTED" || !/^(0x)?([0-9a-f]{64}|[0-9a-f]{96})$/.test(job.receipt_id || job.tx_id || "")) {
        throw new Error("Claim has no accepted receipt.");
      }
      this.set({ result: { receipt: job.receipt_id || job.tx_id, balancePending: true } });
      const response = await this.client.call("account_assets", { account: this.address });
      const balance = creditedBalance(rpcEnvelope(response), job.credited_asset_id);
      this.guard();
      this.set({ result: { receipt: job.receipt_id || job.tx_id, ...balance, balancePending: false } });
      // Mark the stored record finished without touching what this visit shows.
      try { this.storage.setItem(this.key, JSON.stringify({ accountId: this.accountId, pending: this.state.pending, done: true })); } catch { /* shown state is unaffected */ }
    }
  }
  // quiet: a background check. It still excludes other actions but does not grey out the form.
  async run(action, { quiet = false } = {}) {
    if (this.state.busy) return;
    this.set({ busy: true, quiet, error: "" });
    try { return await action(); } catch (error) { this.set({ error: error.message }); }
    finally { this.set({ busy: false, quiet: false, checked: true }); }
  }
}
