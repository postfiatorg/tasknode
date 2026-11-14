import { useMemo, useState } from 'react';
import { ActionReview } from '../market/ui.jsx';
import { snapshot } from '../market/model.js';
import { Amount, Card, CardHead, Notice } from '../ui.jsx';
import { percentFromBps } from '../format.js';
import { createPlan, primaryPreflight, verifyPrimary } from './model.js';

// Public recovery journal only: no key, signature or session token. Each step
// has a separate quote and explicit confirmation; uncertain attempts never replay.
export default function CreateReview({ client, config, quantity, onComplete }) {
  const key = `navcoin-create:${client.chainId}:${client.address}:${config.route_id}`;
  const [journal, setJournal] = useState(() => { try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; } });
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [advance, setAdvance] = useState(journal?.verified === true), [restored, setRestored] = useState(Boolean(journal?.pending || journal?.verified));
  const save = value => { localStorage.setItem(key, JSON.stringify(value)); setJournal(value); };
  async function review() {
    setBusy(true); setError('');
    try { const plan = await createPlan(client, config, quantity); save({ plan, index: 0, receipts: [], pending: false }); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const plan = journal?.plan, step = plan?.steps[journal.index], q = plan?.quote;
  const titles = { setup: `Set up ${step?.unit}`, reserve: 'Reserve PFUSDC for creation', subscribe: `Create ${config.symbol} at NAV`, release: 'Finish native creation', cancel: 'Cancel creation and refund PFUSDC' };
  const request = useMemo(() => step && { id: `${key}:${journal.index}`, address: client.address, accountId: client.accountId, intent: step.intent, symbol: config.symbol, title: titles[step.kind],
    summary: step.kind === 'setup' ? [['Receiving asset', step.unit], ['Receiving limit', <Amount atoms={step.intent.operation.limit} unit={step.unit} />]] : [
      ['New coins', <Amount atoms={q.amount} unit={config.symbol} />], ['Value at NAV', <Amount atoms={q.gross} unit="PFUSDC" />], [`Creation fee (${percentFromBps(q.feeBps)})`, <Amount atoms={q.fee} unit="PFUSDC" />], [step.kind === 'reserve' ? 'PFUSDC (S) held now' : 'Total creation cost (reserved once)', <Amount atoms={q.due} unit="PFUSDC" />, true]],
    description: step.kind === 'setup' ? 'This separate setup changes only your receiving limit and pays a PFT network fee.' : step.kind === 'reserve' ? `This step holds the total PFUSDC (S). Continue to create ${config.symbol}, or cancel for a PFUSDC refund. PFT network fees are not refunded. Created coins stay in this wallet and can be cashed in at NAV minus ${percentFromBps(10000 - config.redeem_multiplier_bps)} while the matching reserve and route policy permit. Book purchases cannot use that cash-in route.` : step.kind === 'subscribe' ? `Use the reserved PFUSDC to create new ${config.symbol}. The creation fee stays outside NAV. Cash-in is at NAV minus ${percentFromBps(10000 - config.redeem_multiplier_bps)}, subject to funded reserve and current policy. Selling on the book requires a matching buyer; the recipient does not inherit cash-in eligibility.` : step.kind === 'cancel' ? 'Release this reservation and refund its held PFUSDC. Previously paid PFT fees are not refunded.' : 'Release the unused Ethereum export capacity. Your native coins and cash-in eligibility stay in this wallet. No Ethereum transaction occurs.',
    successText: step.kind === 'subscribe' ? `${config.symbol} created. Balance, supply, source reserve and retained creation fee verified. Finish the last step to release unused export capacity.` : step.kind === 'reserve' ? 'PFUSDC held for this exact reservation; no coins have been created yet.' : step.kind === 'release' ? 'Native creation finished. Unused export capacity was released; your coins remain eligible for cash-in while reserve and policy permit.' : step.kind === 'cancel' ? 'Reservation canceled and PFUSDC refund verified.' : 'Receiving limit verified.',
    read: () => snapshot(client, config),
    preflight: (intent, current, reviewed) => primaryPreflight(config, plan, step, current, reviewed),
    onSubmitting: () => { setBusy(true); save({ ...journal, pending: true }); },
    verify: (intent, before, after, receipt, txId) => verifyPrimary(client, config, plan, step, before, after, receipt, txId),
  // The active review object must survive journal writes during signing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, journal?.index, client, config]);
  return <div className="l1-stack">
    <Card><CardHead title="Create at NAV" /><p>Pay PFUSDC (S) at NAV +{percentFromBps(config.issue_multiplier_bps - 10000)} for new {config.symbol}. Cash in tracked subscription holdings at NAV −{percentFromBps(10000 - config.redeem_multiplier_bps)} while the matching reserve is funded, or sell to a buyer on the book.</p>
      <p className="l1-small l1-muted">Reserve funds, create coins, then finish native creation. Each step has a separate PFT fee and confirmation. Leaving after reservation keeps funds held until you continue or cancel here. Uncertain submissions require checking Activity before continuing.</p>
      {!plan && <button className="l1-btn is-primary" disabled={busy} onClick={review}>{busy ? 'Reading creation terms…' : 'Review creation'}</button>}
      {plan && !journal.pending && !journal.receipts.length && <button className="l1-btn" onClick={() => { localStorage.removeItem(key); setJournal(null); }}>Discard unstarted creation</button>}
      {plan?.fundingOnly && <Notice title="Set up PFUSDC before funding">This step raises your receiving limit for the total creation cost. Add the missing PFUSDC (S), then review creation again. It creates no coins and reserves no PFUSDC.</Notice>}
      {plan && <p>Step {journal.index + 1} of {plan.steps.length}: {titles[step?.kind] || 'Complete'} · {journal.receipts.length} accepted and verified.</p>}
      {journal?.pending && !advance && <Notice title="This creation has an unfinished attempt">Do not submit it again. Check Activity and the recorded transaction before continuing. The saved reservation ID is {plan.release?.operation.reservation_id || step?.intent.operation.asset_id}.</Notice>}
      {journal?.receipts.map(row => <p className="l1-small l1-mono" key={row.txId}>{row.kind}: {row.txId}</p>)}
      {error && <Notice tone="danger">{error}</Notice>}
    </Card>
    {request && !restored && <ActionReview key={`${journal.index}:${step.kind}`} client={client} request={request} onComplete={result => {
      setBusy(false);
      if (!result.verified) { save({ ...journal, pending: true, uncertainTxId: result.txId }); return; }
      save({ ...journal, pending: false, verified: true, receipts: [...journal.receipts, { kind: step.kind, txId: result.txId }] }); setAdvance(true);
    }} />}
    {advance && <button className="l1-btn is-primary" onClick={() => {
      setAdvance(false); setRestored(false);
      if (journal.index + 1 < plan.steps.length) save({ ...journal, index: journal.index + 1, verified: false });
      else { localStorage.removeItem(key); setJournal(null); onComplete?.(); }
    }}>{journal.index + 1 < plan.steps.length ? 'Continue creation' : plan.fundingOnly ? 'Done setting up PFUSDC' : 'Done creating'}</button>}
    {!journal?.pending && !advance && step?.kind === 'subscribe' && <button className="l1-btn" onClick={() => save({ ...journal, plan: { ...plan, steps: [...plan.steps.slice(0, journal.index), { kind: 'cancel', intent: plan.release }] } })}>Cancel reserved creation</button>}
  </div>;
}
