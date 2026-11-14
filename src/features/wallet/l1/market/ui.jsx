import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, RefreshCw, TriangleAlert } from "lucide-react";
import { loadConfig } from "./constants.js";
import { readBook, readPool } from "./model.js";
import { prepareAction, submitAction } from "./transaction.js";
import { Amount, Badge, Card, CardHead, Details, IdChip, JsonBlock, KV, Mono, Notice, Spinner } from "../ui.jsx";
import { amount, percentFromBps, plainError } from "../format.js";
import { finalizedReadings } from "../gallery/model.js";
export function useNavcoin(client, market = false, marketConfig = null) {
  const clientRef = useRef(client); clientRef.current = client;
  const generation = useRef(0), retries = useRef(0), refreshRef = useRef(null);
  const [data, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const accountId = client?.accountId, address = client?.address, unlocked = client?.unlocked;
  const refresh = useCallback(async () => {
    const ticket = ++generation.current, current = clientRef.current;
    setError(""); setData(null);
    if (!current?.unlocked || !current.address) { setLoading(false); return; }
    setLoading(true);
    try {
      const config = marketConfig || await loadConfig();
      const [state, book, balances] = await Promise.all([readPool(current, config), market ? readBook(current, config) : null, current.getBalances()]);
      if (market) state.nav = finalizedReadings(state.proof).at(-1);
      if (ticket === generation.current) setData({ config, state, book, balances, address: current.address, accountId: current.accountId, readAt: Date.now() });
      retries.current = 0;
    } catch (e) {
      if (ticket !== generation.current) return;
      setError(e.message);
      // A dropped connection or a busy node should heal on its own, not leave the screen blank.
      if (retries.current < 5) { retries.current++; setTimeout(() => { if (ticket === generation.current) void refreshRef.current(); }, 2000 * retries.current); }
    }
    finally { if (ticket === generation.current) setLoading(false); }
  }, [market, marketConfig]);
  refreshRef.current = refresh;
  useEffect(() => { const token = generation; void refresh(); return () => { token.current++; }; }, [refresh, accountId, address, unlocked]);
  return { data: data?.address === address && data?.accountId === accountId && unlocked ? data : null, error, loading, refresh };
}
export function WalletNotice({ client, error, loading, refresh, data }) {
  const time = data?.readAt ? new Date(data.readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
  return <>
    <div className="l1-toolbar">
      <div>{!client?.unlocked ? "Unlock your L1 wallet to read balances and review actions." : loading ? <><Spinner size={14} />Reading chain state…</> : time ? <>Chain state read at {time}</> : null}</div>
      <button type="button" className="l1-btn is-sm is-ghost" onClick={refresh} disabled={loading || !client?.unlocked} aria-label="Refresh state"><RefreshCw size={14} aria-hidden />Refresh</button>
    </div>
    {error && <div style={{ marginBottom: 16 }}><Notice tone="danger" role="alert" title="Chain state is unavailable">{plainError(error)}</Notice></div>}
  </>;
}
export function PoolState({ state, config }) {
  const p = state.pool, symbol = config.symbol || "B23";
  const fee = Number.isSafeInteger(p.redeem_multiplier_bps) ? 10000 - p.redeem_multiplier_bps : null;
  return <Card aria-label={`${symbol} reserve state`}>
    <CardHead eyebrow="Standing reserve" title={`${symbol} reserve`}>{p.invariant_holds === true ? <Badge tone="success" dot>Supply balanced</Badge> : p.invariant_holds === false ? <Badge tone="danger">Supply mismatch</Badge> : null}</CardHead>
    <div className="l1-facts-nav"><strong><Amount atoms={p.settlement_reserve_atoms} unit="PFUSDC" /></strong></div>
    <p className="l1-muted l1-small" style={{ marginBottom: 12 }}>Available to pay cash-ins at NAV. Larger cash-ins are rejected, not partly filled.</p>
    <KV rows={[
      [`${symbol} that can be cashed in now`, <Amount atoms={p.available_redeem_atoms} unit={symbol} />],
      [`${symbol} outstanding`, <Amount atoms={state.supply} unit={symbol} />],
      [`NAV per ${symbol}`, state.nav ? `$${amount(state.nav.nav_per_unit, { min: 2 })}` : "Finalized NAV unavailable"],
      ["Cash-in fee", fee == null ? "Unavailable" : percentFromBps(fee), fee == null ? null : `${fee} bps`],
    ]} />
    {!config.g1_passed && <div style={{ marginTop: 14 }}><Notice tone="warning" role="status" title="Cash-ins and reserve funding are switched off">They open once the operator enables this route on the network.</Notice></div>}
    <Details summary="On-chain details"><KV className="is-tight" rows={[
      ["Fee recipient", p.spread_recipient ? <Mono value={p.spread_recipient} /> : "Not set on the live route"],
      ["Route epoch / policy", `${p.route_epoch} / ${p.policy_epoch}`],
      ["Per cash-in", p.min_order_atoms != null ? `${amount(p.min_order_atoms, { min: 0 })} – ${amount(p.max_order_atoms, { min: 0 } )} ${symbol}` : "—"],
    ]} /></Details>
  </Card>;
}
const STEPS = ["Review", "Quote", "Sign", "Verified"];
function stepIndex(phase) { return { review: 0, quoting: 1, quoted: 1, submitting: 2, failed: 2, complete: 3 }[phase] ?? 0; }
function DeltaCard({ label, atoms, unit }) {
  const value = BigInt(atoms ?? 0);
  return <div className={`l1-delta ${value > 0n ? "is-up" : value < 0n ? "is-down" : ""}`}><small>{label}</small><span><Amount atoms={atoms} unit={unit} sign /></span></div>;
}
export function ActionReview({ client, request, onComplete, onCancel }) {
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
  const at = stepIndex(phase), effects = outcome?.effects;
  // Builder rejections read "Transaction <id> rejected: <reason>"; show the reason and the id separately.
  const rejection = /^Transaction (\S+) rejected: ([\s\S]*)$/.exec(error || "");
  const failureText = rejection ? `Transaction not accepted: ${rejection[2]}` : error;
  const fee = prepared?.quote?.minimum_fee;
  return <Card className="l1-review" aria-label="Review transaction">
    <CardHead eyebrow={request.title || "Transaction"} title="Review and confirm">{onCancel && phase !== "submitting" && phase !== "complete" && <button type="button" className="l1-btn is-sm is-ghost" onClick={onCancel}>Discard</button>}</CardHead>
    <ol className="l1-review-steps" aria-label="Progress">{STEPS.map((label, index) => <li key={label} className={index < at || (phase === "complete" && index === at) ? "is-done" : index === at ? "is-current" : ""}><i>{index < at || (phase === "complete" && index === at) ? "✓" : index + 1}</i>{label}</li>)}</ol>
    {request.summary?.length > 0 && <dl className="l1-summary">{request.summary.filter(Boolean).map(([label, value, total], index) => <div key={index} className={total ? "is-total" : ""}><dt>{label}</dt><dd>{value}</dd></div>)}
      {fee != null && <div><dt>Network fee</dt><dd><Amount atoms={fee} unit="PFT" max={6} /></dd></div>}
    </dl>}
    {request.description && <p className="l1-review-note">{plainError(request.description)}</p>}
    {phase === "review" && <div className="l1-review-actions"><button type="button" className="l1-btn is-primary" onClick={quote}>Get fee quote</button><span className="l1-muted l1-small">Nothing is signed until you confirm.</span></div>}
    {phase === "quoted" && <div className="l1-review-actions"><button type="button" className="l1-btn is-primary" onClick={submit}>Sign and submit</button><span className="l1-muted l1-small">Signed in this browser, then checked against the chain.</span></div>}
    {phase === "quoting" && <p className="l1-status-line" role="status"><Spinner />Reading balances and getting a fee quote…</p>}
    {phase === "submitting" && <p className="l1-status-line" role="status"><Spinner />Signing locally, submitting, and verifying the receipt and balances…</p>}
    {error && phase !== "failed" && <Notice tone="danger" role="alert">{plainError(error)} Review a fresh action before retrying.</Notice>}
    {phase === "failed" && <div className="l1-outcome">
      <div className="l1-outcome-head"><span className="l1-outcome-icon is-danger"><CircleAlert size={22} aria-hidden /></span><div><h4>{rejection || /not accepted/i.test(error) ? "Rejected by the chain" : "Not completed"}</h4><p>No balance change was verified for this action.</p></div></div>
      <Notice tone="danger" role="alert">{plainError(failureText)} Review a fresh action before retrying.</Notice>
      {rejection && <div className="l1-row"><span className="l1-muted l1-small">Rejected transaction</span><IdChip value={rejection[1]} label="transaction id" /></div>}
    </div>}
    {outcome && <div role="status" className="l1-outcome">
      <div className="l1-outcome-head">
        <span className={`l1-outcome-icon ${outcome.verified ? "" : "is-warning"}`}>{outcome.verified ? <CircleCheck size={22} aria-hidden /> : <TriangleAlert size={22} aria-hidden />}</span>
        <div><h4>{outcome.verified ? "Accepted and verified" : "Accepted — balance/state verification incomplete"}</h4><p>{outcome.verified ? ((typeof request.successText === "function" ? request.successText(effects) : request.successText) || "Receipt accepted and balances re-read from the chain.") : plainError(outcome.verificationError)}</p></div>
      </div>
      {effects?.credits ? <div className="l1-deltas">
        <div className="l1-delta is-up"><small>You received</small><span><Amount atoms={effects.credits.settlement_value_atoms} unit="PFUSDC" testId="credit-holder" /></span></div>
        <div className="l1-delta"><small>Cash-in fee</small><span><Amount atoms={effects.credits.spread_value_atoms} unit="PFUSDC" testId="credit-fee" /></span></div>
        {effects.deltas && <DeltaCard label={`${request.symbol || "B23"} balance`} atoms={effects.deltas.B23} unit={request.symbol || "B23"} />}
      </div> : effects?.deltas && <div className="l1-deltas">
        <DeltaCard label={`${request.symbol || "B23"} balance`} atoms={effects.deltas.B23} unit={request.symbol || "B23"} />
        <DeltaCard label="PFUSDC balance" atoms={effects.deltas.PFUSDC} unit="PFUSDC" />
        {effects.locked && BigInt(effects.locked) > 0n && <div className="l1-delta"><small>Locked in your open offer</small><span><Amount atoms={effects.locked} unit={request.lockedUnit} /></span></div>}
      </div>}
      {effects?.capacityAfter != null && <KV rows={[["Cash-in capacity", <>{amount(effects.capacityBefore)} → <Amount atoms={effects.capacityAfter} unit={request.symbol || "B23"} /></>]]} />}
      <div className="l1-row"><span className="l1-muted l1-small">Transaction</span><IdChip value={outcome.txId} label="transaction id" /></div>
      <Details summary="Receipt and before/after balances">
        {effects?.message && <p className="l1-small l1-muted">{plainError(effects.message)}</p>}
        {effects?.credits && <KV className="is-tight" rows={[["Payout asset", <Mono value={effects.payoutAssetId} />], ["Paid to", <Mono value={effects.credits.settlement_recipient} />], ["Fee to", <Mono value={effects.credits.spread_recipient} />]]} />}
        <JsonBlock value={{ receipt: outcome.receipt, before: outcome.before?.balances, after: outcome.after?.balances, managementBefore: outcome.before?.managementLines, managementAfter: outcome.after?.managementLines, effects: outcome.effects }} />
      </Details>
    </div>}
    <Details summary="Exact operation">
      <JsonBlock value={request.intent} />
      {prepared && <><p className="l1-small l1-muted">Quoted fee and operation</p><JsonBlock value={prepared.quote} /></>}
    </Details>
  </Card>;
}
