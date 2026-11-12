import { useState } from "react";
import { units } from "../market/amounts.js";
import { snapshot } from "../market/model.js";
import { ActionReview, PoolState, useNavcoin, WalletNotice } from "../market/ui.jsx";
import { facilityReady } from "../redeem/model.js";
import { buildFund, mintPreflight, validateEquityPlan, validateFeeOperation, verifyFee, verifyFund, verifyMint } from "./model.js";
async function publicArtifact(path) {
  const response = await fetch(`/api/l1/navcoin/${path}`, { credentials: "same-origin", cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Public preparation artifact is unavailable");
  return body;
}
export default function IssuerTab({ client }) {
  const { data, error, loading, refresh } = useNavcoin(client);
  const [funding, setFunding] = useState(""), [bps, setBps] = useState("20"), [equity, setEquity] = useState(null), [request, setRequest] = useState(null), [actionError, setActionError] = useState("");
  const [preparing, setPreparing] = useState(false);
  function review(intent, description, verify, preflight, recipient = null) {
    setRequest({ id: crypto.randomUUID(), accountId: client.accountId, address: client.address, intent, description, verify, preflight,
      read: () => snapshot(client, data.config, { recipient }) });
  }
  async function loadEquity() {
    setActionError(""); setRequest(null); setEquity(null); setPreparing(true);
    try { const plan = await publicArtifact("equity"); validateEquityPlan(plan, data.config); setEquity({ plan, accountId: client.accountId, address: client.address }); }
    catch (e) { setActionError(e.message); } finally { setPreparing(false); }
  }
  function mint(operation) {
    setActionError(""); setRequest(null);
    try {
      if (client.address !== data.config.issuer_address) throw new Error("Unlock the B23 issuer wallet for the opening mint");
      const plan = equity.plan, intent = { kind: "asset", operation };
      mintPreflight(plan, data.config, intent, data.state);
      review(intent, "Opening mint counts the current B23 supply, including the earlier wire, once. Each of the three steps needs its own accepted receipt and state read-back.",
        (intent, before, after) => verifyMint(data.config, intent, before, after),
        (intent, before) => mintPreflight(plan, data.config, intent, before), data.config.alice_holder_address);
    } catch (e) { setActionError(e.message); }
  }
  function fund(event) {
    event.preventDefault(); setActionError(""); setRequest(null);
    try { review(buildFund(data.config, client.address, data.state, funding), "Transfer PFUSDC into the redemption reserve. No B23 is minted.",
      (intent, before, after) => verifyFund(data.config, intent, before, after), (_intent, before) => facilityReady(data.config, before)); }
    catch (e) { setActionError(e.message); }
  }
  async function fee(event) {
    event.preventDefault(); setActionError(""); setRequest(null); setPreparing(true);
    try {
      if (client.address !== data.config.issuer_address) throw new Error("Unlock the issuer wallet to change the redemption fee");
      const { operation } = await publicArtifact(`fee?bps=${encodeURIComponent(bps)}`);
      const intent = validateFeeOperation(operation, data.config, data.state, bps);
      review(intent, `Set the redemption fee to ${bps} bps by advancing the route epoch. The management wallet receives that spread. Policy capacities reset on epoch advance; review all bounds below.`,
        (intent, before, after) => verifyFee(data.config, intent, before, after), (intent, current) => validateFeeOperation(intent.operation, data.config, current, bps));
    } catch (e) { setActionError(e.message); } finally { setPreparing(false); }
  }
  const plan = equity?.accountId === client.accountId && equity?.address === client.address ? equity.plan : null;
  const visibleRequest = request?.accountId === client.accountId && request?.address === client.address && client.unlocked;
  return <div className="nc"><h2>B23 issuer</h2><ol className="nc-steps" aria-label="Alice journey"><li>Mint B23 at NAV against Schwab net liquidation value.</li><li>Fund the PFUSDC redemption reserve without minting.</li><li>Use the holder wallet in Market to post a sell offer.</li></ol><p>These PFTL actions do not require MetaMask.</p>
    <WalletNotice client={client} error={error} loading={loading} refresh={refresh} />
    {data && <><PoolState state={data.state} config={data.config} />
      <section className="nc-card"><h3>1. Mint B23 at NAV</h3><p>Schwab’s reported net liquidation value, with no adjustments. The existing wire and all existing B23 count toward opening supply.</p>
        <p className="nc-muted">The existing B23 proof profile is operator-attested (placeholder), not an independently authenticated Schwab proof.</p>
        <button type="button" disabled={preparing} onClick={loadEquity}>Load account-equity opening plan</button>
        {plan && <><dl className="nc-grid"><div><dt>Schwab net liquidation value</dt><dd>${plan.packet.liquidation_value_usd}</dd></div><div><dt>Opening NAV per B23</dt><dd>$1.000000</dd></div><div><dt>Current B23 supply in plan</dt><dd>{units(plan.current_supply_atoms)}</dd></div><div><dt>Target B23 supply</dt><dd>{units(plan.target_supply_atoms)}</dd></div><div><dt>Additional B23 to mint</dt><dd>{units(plan.additional_mint_atoms)}</dd></div></dl>
          <p>Snapshot cutoff: {plan.packet.cutoff_at_utc}</p><p className="nc-address">Account commitment: {plan.packet.account_commitment_sha256}</p>
          <div className="nc-grid">{plan.operations.map((op, i) => <button key={op.operation} type="button" onClick={() => mint(op)}>{["Review reserve submit", "Review epoch finalize", "Review mint at NAV"][i]}</button>)}</div></>}
      </section>
      <section className="nc-card"><h3>2. Fund reserve</h3><p>No B23 is minted by this action.</p><form onSubmit={fund} onChange={() => setRequest(null)}><label>PFUSDC to add<input inputMode="decimal" value={funding} onChange={e => setFunding(e.target.value)} required /></label><button type="submit" disabled={!data.config.g1_passed}>Review reserve funding</button></form></section>
      <section className="nc-card"><h3>Set redemption fee</h3><form onSubmit={fee} onChange={() => setRequest(null)}><label>Fee x (0–500 bps)<input type="number" min="0" max="500" step="1" value={bps} onChange={e => setBps(e.target.value)} required /></label><button type="submit" disabled={!data.config.g1_passed || preparing}>Review fee change</button></form><p className="nc-muted">The current policy, capacities, recipient, and new epoch are included in the exact intent before signing.</p></section>
    </>}{actionError && <p role="alert">{actionError}</p>}{visibleRequest && <ActionReview key={request.id} client={client} request={request} onComplete={refresh} />}
  </div>;
}
