import * as evm from "./evm.js";
import * as api from "./bridge-relay.js";
import { parseGovernedVaultBridgeRoute } from "./bridge-route.js";

const CHAIN = "postfiat-wan-devnet-2";
const GENESIS = "ce22ca8c932da0998b484483a09647138a30e0bf44408dd49a8d6d452787ad25521aff3ed334da07e150a7233a3e90a9";
export function amountAtoms(value) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) return null;
  const atoms = evm.usdcToAtoms(value);
  return atoms > 0n && atoms <= (1n << 64n) - 1n ? atoms : null;
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
    this.state = { ready: false, blocked: "Checking bridge readiness.", owner: "", balance: null, allowance: null, busy: false, error: "", pending: null, job: null, result: null };
    try {
      const saved = JSON.parse(storage.getItem(this.key));
      if (saved?.pending?.recipient === this.address && saved.accountId === this.accountId) this.state.pending = saved.pending;
    } catch { /* no saved public job */ }
  }
  guard() {
    if (!this.active || !this.client.unlocked || this.client.address !== this.address || this.client.accountId !== this.accountId) {
      throw new Error("Wallet session changed. Reopen the bridge.");
    }
  }
  set(patch) { if (this.active) { Object.assign(this.state, patch); this.changed({ ...this.state }); } }
  save(pending) {
    this.guard();
    // Persist only public recovery data, scoped to Task Node account AND pf address.
    this.storage.setItem(this.key, JSON.stringify({ accountId: this.accountId, pending }));
    this.set({ pending });
  }
  dispose() { this.active = false; this.abort.abort(); }
  async readiness() {
    this.set({ ready: false, blocked: "Checking bridge readiness." });
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
    await this.readiness();
    this.guard();
    const tx = await this.ethereum.approveEthereumUsdc(route.vaultAddress, atoms);
    this.set({ approvalTx: tx });
    await this.ethereum.waitForReceipt(tx);
    await this.refreshEthereum();
  }
  async deposit(amount) {
    if (this.state.pending) throw new Error("Resume the existing deposit before starting another.");
    const { route, atoms, owner } = await this.preflight(amount);
    if (this.state.allowance < atoms) throw new Error("Approve this amount first.");
    const nonce = this.ethereum.generateNonce();
    // Verify that recovery storage works BEFORE requesting an irreversible transaction.
    const pending = { recipient: this.address, route, owner, amountAtoms: String(atoms), nonce, tx: null, jobId: null };
    this.save(pending);
    await this.readiness();
    this.guard();
    let tx;
    try {
      tx = await this.ethereum.depositToEthereumBridge(route.vaultAddress, atoms, this.address, nonce, route.routeBinding);
    } catch (error) {
      this.save(null);
      throw error;
    }
    this.save({ ...pending, tx });
    await this.resume();
  }
  async resume() {
    this.guard();
    let pending = this.state.pending;
    if (!pending?.tx) throw new Error("No broadcast deposit to resume. If MetaMask broadcast during reload, enter its transaction hash.");
    if (!pending.jobId) {
      await this.ethereum.ensureEthereumMainnet();
      await this.ethereum.waitForReceipt(pending.tx);
      const event = await this.ethereum.watchDepositEvent(pending.route.vaultAddress, pending.tx, pending.route.routeBinding);
      if (!event || event.pftl_recipient !== this.address || event.depositor.toLowerCase() !== pending.owner
          || String(event.amount) !== pending.amountAtoms || event.nonce !== pending.nonce
          || Number(event.source_chain_id) !== 1 || event.vault !== pending.route.vaultAddress
          || event.token !== pending.route.tokenAddress) throw new Error("Deposit event does not match the reviewed request.");
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
    this.set({ job });
    if (job.status === "failed") throw new Error(job.message || job.code || "Bridge claim failed.");
    if (job.status === "accepted") {
      if (job.receipt_code !== "ACCEPTED" || !/^(0x)?([0-9a-f]{64}|[0-9a-f]{96})$/.test(job.receipt_id || job.tx_id || "")) {
        throw new Error("Claim has no accepted receipt.");
      }
      this.set({ result: { receipt: job.receipt_id || job.tx_id, balancePending: true } });
    }
  }
  async run(action) {
    if (this.state.busy) return;
    this.set({ busy: true, error: "" });
    try { return await action(); } catch (error) { this.set({ error: error.message }); }
    finally { this.set({ busy: false }); }
  }
}
