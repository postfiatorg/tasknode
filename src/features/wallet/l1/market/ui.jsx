import { useCallback, useEffect, useRef, useState } from "react";
import { loadConfig } from "./constants.js";
import { readBook, readPool } from "./model.js";
import { prepareAction, submitAction } from "./transaction.js";
import { units } from "./amounts.js";
import "./navcoin.css";
export function useNavcoin(client, market = false) {
  const clientRef = useRef(client); clientRef.current = client;
  const generation = useRef(0);
  const [data, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const accountId = client?.accountId, address = client?.address, unlocked = client?.unlocked;
  const refresh = useCallback(async () => {
    const ticket = ++generation.current, current = clientRef.current;
    setError(""); setData(null);
    if (!current?.unlocked || !current.address) { setLoading(false); return; }
    setLoading(true);
    try {
      const config = await loadConfig();
      const [state, book, balances] = await Promise.all([readPool(current, config), market ? readBook(current, config) : null, current.getBalances()]);
      if (ticket === generation.current) setData({ config, state, book, balances, address: current.address, accountId: current.accountId });
    } catch (e) { if (ticket === generation.current) setError(e.message); }
    finally { if (ticket === generation.current) setLoading(false); }
  }, [market]);
  useEffect(() => { const token = generation; void refresh(); return () => { token.current++; }; }, [refresh, accountId, address, unlocked]);
  return { data: data?.address === address && data?.accountId === accountId && unlocked ? data : null, error, loading, refresh };
}
export function WalletNotice({ client, error, loading, refresh }) {
  return <><p className="nc-muted">{client?.unlocked ? `PFTL wallet: ${client.address}` : "Unlock your L1 wallet to read balances and review actions."}</p>
    <button type="button" onClick={refresh} disabled={loading || !client?.unlocked}>Refresh state</button>
    {loading && <p role="status">Reading chain state…</p>}{error && <p role="alert">{error}</p>}</>;
}
export function PoolState({ state, config }) {
  const p = state.pool;
  return <section className="nc-card" aria-label="Redemption pool state"><h3>Redemption pool</h3><dl className="nc-grid">
    <div><dt>PFUSDC reserve</dt><dd>{units(p.settlement_reserve_atoms)}</dd></div>
    <div><dt>Total B23 supply</dt><dd>{units(state.supply)}</dd></div>
    <div><dt>B23 redeemable now</dt><dd>{units(p.available_redeem_atoms)}</dd></div>
    <div><dt>Supply invariant holds</dt><dd>{p.invariant_holds === true ? "Yes" : p.invariant_holds === false ? "No" : "Unavailable"}</dd></div>
    <div><dt>Current redemption fee</dt><dd>{Number.isSafeInteger(p.redeem_multiplier_bps) ? `${10000 - p.redeem_multiplier_bps} bps` : "Unavailable"}</dd></div>
    <div><dt>NAV per B23</dt><dd>{state.nav ? `$${units(state.nav.nav_per_unit)}` : "Matching finalized NAV unavailable"}</dd></div>
  </dl><p className="nc-address">Management address: {p.spread_recipient || "Not set on the live route"}</p>
  {!config.g1_passed && <p role="status">Fund and redeem are blocked until G1 deployment is verified.</p>}
  <p className="nc-muted">Capacity is the current reserve and policy limit. Larger redemptions reject; they are not partially filled.</p></section>;
}
export function ActionReview({ client, request, onComplete }) {
  const [prepared, setPrepared] = useState(null), [outcome, setOutcome] = useState(null), [error, setError] = useState(""), [phase, setPhase] = useState("review");
  const active = useRef(true), latest = useRef({ client, request }); latest.current = { client, request };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const current = () => active.current && latest.current.request === request && latest.current.client.accountId === client.accountId && latest.current.client.address === client.address && latest.current.client.unlocked;
  async function quote() {
    setPhase("quoting"); setError("");
    try { const next = await prepareAction(client, request.intent, request.read); if (current()) { setPrepared(next); setPhase("quoted"); } }
    catch (e) { if (current()) { setError(e.message); setPhase("review"); } }
  }
  async function submit() {
    setPhase("submitting"); setError("");
    try {
      const result = await submitAction(client, prepared, request.read, request.verify, current, request.preflight);
      if (current()) { setOutcome(result); setPhase("complete"); onComplete?.(result); }
    } catch (e) { if (current()) { setError(e.message); setPhase("failed"); } }
  }
  return <section className="nc-card" aria-label="Review transaction"><h3>Review exact intent</h3><p>{request.description}</p>
    <pre>{JSON.stringify(request.intent, null, 2)}</pre>
    {prepared && <details open><summary>Quoted transaction fee and operation</summary><pre>{JSON.stringify(prepared.quote, null, 2)}</pre></details>}
    {phase === "review" && <button type="button" onClick={quote}>Get fee quote</button>}
    {phase === "quoted" && <button type="button" onClick={submit}>Sign and submit</button>}
    {phase === "quoting" && <p role="status">Reading balances and getting a fee quote…</p>}
    {phase === "submitting" && <p role="status">Signing locally, submitting, and verifying receipt and balances…</p>}
    {error && <p role="alert">{error} Review a fresh action before retrying.</p>}
    {outcome && <div role="status"><h4>{outcome.verified ? "Accepted and verified" : "Accepted — balance/state verification incomplete"}</h4>
      <p>{outcome.effects?.message || outcome.verificationError}</p><p>Transaction: {outcome.txId}</p>
      {outcome.effects?.deltas && <p>Wallet changes: B23 {units(outcome.effects.deltas.B23)}; PFUSDC {units(outcome.effects.deltas.PFUSDC)}</p>}
      {outcome.effects?.credits && <div><p className="nc-address">PFUSDC payout asset: {outcome.effects.payoutAssetId}</p><p>Holder credit: {units(outcome.effects.credits.settlement_value_atoms)} PFUSDC → {outcome.effects.credits.settlement_recipient}</p><p>Management credit: {units(outcome.effects.credits.spread_value_atoms)} PFUSDC → {outcome.effects.credits.spread_recipient}</p></div>}
      <details><summary>Receipt and before/after balances</summary><pre>{JSON.stringify({ receipt: outcome.receipt, before: outcome.before?.balances, after: outcome.after?.balances, managementBefore: outcome.before?.managementLines, managementAfter: outcome.after?.managementLines, effects: outcome.effects }, null, 2)}</pre></details>
    </div>}
  </section>;
}
