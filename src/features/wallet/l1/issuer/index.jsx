import { useState } from "react";
import { ChartCandlestick, Landmark } from "lucide-react";
import { lineBalance, snapshot } from "../market/model.js";
import { ActionReview, PoolState, useNavcoin, WalletNotice } from "../market/ui.jsx";
import { Amount, Badge, Card, Details, IdChip, KV, Mono, Notice, Skeleton } from "../ui.jsx";
import { dateTime, percentFromBps, plainError } from "../format.js";
import { facilityReady } from "../redeem/model.js";
import { buildFund, mintPreflight, validateEquityPlan, validateFeeOperation, verifyFee, verifyFund, verifyMint } from "./model.js";
async function publicArtifact(path) {
  const response = await fetch(`/api/l1/navcoin/${path}`, { credentials: "same-origin", cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Public preparation artifact is unavailable");
  return body;
}
const MINT_STEPS = [
  ["Submit reserve packet", "Publishes the Schwab account value for the new NAV epoch.", "Review reserve submit"],
  ["Finalize NAV epoch", "Locks the NAV the mint is priced at.", "Review epoch finalize"],
  ["Mint B23 at NAV", "Credits the new B23 to the holder wallet.", "Review mint at NAV"],
];
function OpHead({ n, title, children }) {
  return <div className="l1-op-head"><span className="l1-step-num">{n}</span><div><h3>{title}</h3>{children && <p>{children}</p>}</div></div>;
}
export default function IssuerTab({ client, onNavigate }) {
  const { data, error, loading, refresh } = useNavcoin(client);
  const [funding, setFunding] = useState(""), [bps, setBps] = useState("20"), [equity, setEquity] = useState(null), [request, setRequest] = useState(null), [actionError, setActionError] = useState("");
  const [preparing, setPreparing] = useState(false);
  function review(intent, description, verify, preflight, recipient = null, extra = {}) {
    setRequest({ id: crypto.randomUUID(), accountId: client.accountId, address: client.address, intent, description, verify, preflight, ...extra,
      read: () => snapshot(client, data.config, { recipient }) });
  }
  async function loadEquity() {
    setActionError(""); setRequest(null); setEquity(null); setPreparing(true);
    try { const plan = await publicArtifact("equity"); validateEquityPlan(plan, data.config); setEquity({ plan, accountId: client.accountId, address: client.address }); }
    catch (e) { setActionError(e.message); } finally { setPreparing(false); }
  }
  function mint(operation, index) {
    setActionError(""); setRequest(null);
    try {
      if (client.address !== data.config.issuer_address) throw new Error("Unlock the B23 issuer wallet for the opening mint");
      const plan = equity.plan, intent = { kind: "asset", operation };
      mintPreflight(plan, data.config, intent, data.state);
      review(intent, "The opening mint counts the current B23 supply, including the earlier wire, once. Each of the three steps needs its own accepted receipt and state read-back.",
        (intent, before, after) => verifyMint(data.config, intent, before, after),
        (intent, before) => mintPreflight(plan, data.config, intent, before), data.config.alice_holder_address,
        { title: MINT_STEPS[index]?.[0] || "Mint at NAV", summary: [["Step", `${index + 1} of 3 · ${MINT_STEPS[index]?.[0]}`], ["NAV epoch", String(operation.epoch)], index === 2 && ["B23 minted", <Amount atoms={operation.amount} unit="B23" />, true], index === 2 && ["To holder wallet", <Mono value={operation.to} />]] });
    } catch (e) { setActionError(e.message); }
  }
  function fund(event) {
    event.preventDefault(); setActionError(""); setRequest(null);
    try {
      const intent = buildFund(data.config, client.address, data.state, funding);
      review(intent, "Moves PFUSDC from this wallet into the standing reserve that pays cash-ins. No B23 is minted.",
        (intent, before, after) => verifyFund(data.config, intent, before, after), (_intent, before) => facilityReady(data.config, before), null,
        { title: "Fund the cash-in reserve", successText: "The reserve grew by exactly this payment and no B23 was minted.", summary: [["Add to reserve", <Amount atoms={intent.operation.amount_atoms} unit="PFUSDC" />, true], ["Reserve after", <Amount atoms={BigInt(data.state.pool.settlement_reserve_atoms) + BigInt(intent.operation.amount_atoms)} unit="PFUSDC" />]] });
    } catch (e) { setActionError(e.message); }
  }
  async function fee(event) {
    event.preventDefault(); setActionError(""); setRequest(null); setPreparing(true);
    try {
      if (client.address !== data.config.issuer_address) throw new Error("Unlock the issuer wallet to change the cash-in fee");
      const { operation } = await publicArtifact(`fee?bps=${encodeURIComponent(bps)}`);
      const intent = validateFeeOperation(operation, data.config, data.state, bps);
      review(intent, `Sets the cash-in fee to ${bps} bps by advancing the route epoch. The manager wallet receives the fee. Policy capacities reset when the epoch advances; check every bound in the exact operation.`,
        (intent, before, after) => verifyFee(data.config, intent, before, after), (intent, current) => validateFeeOperation(intent.operation, data.config, current, bps), null,
        { title: "Change the cash-in fee", summary: [["New fee", `${percentFromBps(Number(bps))} (${bps} bps)`, true], ["Next route epoch", String(operation.next_route_epoch ?? "—")]] });
    } catch (e) { setActionError(e.message); } finally { setPreparing(false); }
  }
  const plan = equity?.accountId === client.accountId && equity?.address === client.address ? equity.plan : null;
  const visibleRequest = request?.accountId === client.accountId && request?.address === client.address && client.unlocked;
  let pfusdc = null;
  try { if (data) pfusdc = lineBalance(data.balances.assets, data.config.pfusdc_asset_id); } catch { pfusdc = null; }
  const role = data ? client.address === data.config.issuer_address ? "issuer" : client.address === data.config.alice_holder_address ? "holder" : "other" : null;
  const epochPacket = plan && data?.state?.proof?.packets?.find(packet => packet.epoch === plan.operations[0].epoch);
  const mintDone = [Boolean(epochPacket), epochPacket?.state === "finalized", plan && data && BigInt(data.state.supply) >= BigInt(plan.target_supply_atoms)];
  const currentFee = data && Number.isSafeInteger(data.state.pool.redeem_multiplier_bps) ? 10000 - data.state.pool.redeem_multiplier_bps : null;
  return <div className="l1-view">
    <div className="l1-desk-banner"><Landmark size={20} aria-hidden /><div><strong>For the B23 issuer and its holder wallet.</strong> Buying B23 and cashing in at NAV happen under Market and Cash in; nothing here is needed for that.</div></div>
    <WalletNotice client={client} error={error} loading={loading} refresh={refresh} data={data} />
    {data && role === "other" && <div style={{ marginBottom: 16 }}><Notice tone="warning" title="This wallet is not the B23 issuer">Mint and fee changes need the issuer wallet; posting B23 for sale needs the holder wallet. The chain refuses them from any other wallet.</Notice></div>}
      <div className="l1-split">
        <div className="l1-stack">
          {!data ? <Card>{loading ? <Skeleton height={320} /> : <p className="l1-muted">Refresh to read the B23 route state.</p>}</Card> : <>
          <Card className="l1-op">
            <OpHead n="1" title="Mint B23 at NAV">Raise supply to match the Schwab account&rsquo;s reported net liquidation value at NAV $1.00. Existing B23 and the earlier wire count once.</OpHead>
            {!plan && <div className="l1-row"><button type="button" className="l1-btn" disabled={preparing} onClick={loadEquity}>Load account-equity opening plan</button><span className="l1-muted l1-small">Reads the latest Schwab account snapshot prepared for this mint.</span></div>}
            {plan && <>
              <KV rows={[
                ["Schwab net liquidation value", `$${Number(plan.packet.liquidation_value_usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, `as of ${dateTime(plan.packet.cutoff_at_utc)}`],
                ["NAV per B23", "$1.00"],
                ["B23 outstanding now", <Amount atoms={plan.current_supply_atoms} unit="B23" />],
                ["B23 after mint", <Amount atoms={plan.target_supply_atoms} unit="B23" />],
                ["To mint", <b style={{ color: "var(--l1-b23)" }}><Amount atoms={plan.additional_mint_atoms} unit="B23" sign /></b>],
              ]} />
              <div className="l1-mint-steps">{plan.operations.map((op, i) => <div key={op.operation} className="l1-mint-step">
                <span className="l1-step-num" style={mintDone[i] ? { background: "var(--l1-accent)", color: "var(--l1-on-ink)" } : undefined}>{mintDone[i] ? "✓" : i + 1}</span>
                <div><b>{MINT_STEPS[i][0]}</b><small>{MINT_STEPS[i][1]}</small></div>
                <button type="button" className={`l1-btn is-sm ${!mintDone[i] && mintDone.slice(0, i).every(Boolean) ? "is-primary" : ""}`} onClick={() => mint(op, i)}>{MINT_STEPS[i][2]}</button>
              </div>)}</div>
              <Details summary="Snapshot details"><KV className="is-tight" rows={[["Account commitment", <Mono value={plan.packet.account_commitment_sha256} />], ["Packet", <Mono value={plan.packet.packet_hash} />], ["Proof profile", "Operator-attested"]]} /></Details>
            </>}
          </Card>
          <Card className="l1-op">
            <OpHead n="2" title="Fund the cash-in reserve">PFUSDC added here pays holders who cash in at NAV. Funding mints no B23.</OpHead>
            <form onSubmit={fund} onChange={() => setRequest(null)}>
              <label className="l1-field"><span>PFUSDC to add</span><span className="l1-input-wrap"><input aria-label="PFUSDC to add" inputMode="decimal" placeholder="0.00" value={funding} onChange={e => setFunding(e.target.value)} required /><span className="l1-input-suffix">PFUSDC</span></span>
                <span className="l1-field-hint"><span>{pfusdc === null ? "" : <>This wallet holds <Amount atoms={pfusdc} unit="PFUSDC" /></>}</span></span></label>
              <button type="submit" className="l1-btn is-primary" style={{ minHeight: 46, alignSelf: "start", marginTop: 27 }} disabled={!data.config.g1_passed}>Review reserve funding</button>
            </form>
          </Card>
          <Card className="l1-op">
            <OpHead n="3" title="Post B23 for sale">Sell offers come from the holder wallet, not the issuer. Unlock the holder wallet, then place a sell offer on the market.</OpHead>
            <div className="l1-row"><span className="l1-muted l1-small">Holder wallet</span><IdChip value={data.config.alice_holder_address} label="holder address" />{role === "holder" && <Badge tone="success">This wallet</Badge>}</div>
            {onNavigate && <div><button type="button" className="l1-btn" onClick={() => onNavigate("Market")}><ChartCandlestick size={16} aria-hidden />Open the market</button></div>}
          </Card>
          <Card className="l1-op">
            <OpHead n="4" title="Cash-in fee">Currently {currentFee == null ? "unavailable" : `${percentFromBps(currentFee)} (${currentFee} bps)`}. A change advances the route epoch.</OpHead>
            <form onSubmit={fee} onChange={() => setRequest(null)}>
              <label className="l1-field"><span>Cash-in fee (0–500 bps)</span><input type="number" min="0" max="500" step="1" value={bps} onChange={e => setBps(e.target.value)} required /></label>
              <button type="submit" className="l1-btn" style={{ minHeight: 46 }} disabled={!data.config.g1_passed || preparing}>Review fee change</button>
            </form>
          </Card>
          </>}
        </div>
        <div className="l1-stack">
          {actionError && <Notice tone="danger" role="alert">{plainError(actionError)}</Notice>}
          {visibleRequest && <ActionReview key={request.id} client={client} request={request} onComplete={refresh} onCancel={() => setRequest(null)} />}
          {data ? <PoolState state={data.state} config={data.config} /> : <Card>{loading ? <Skeleton height={300} /> : null}</Card>}
        </div>
      </div>
  </div>;
}
