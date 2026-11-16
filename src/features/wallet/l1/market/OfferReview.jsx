import { useMemo, useState } from 'react';
import { ActionReview } from './ui.jsx';
import { trustPreflight, verifyTrust } from './offer-setup.js';
import { Amount, Card, IdChip } from '../ui.jsx';

// Each prerequisite has its own fresh sequence/fee and explicit confirmation.
// Never continue after a rejection, uncertain submit or incomplete read-back.
export default function OfferReview({ client, request, onComplete, onCancel }) {
  const [step, setStep] = useState(0), [completed, setCompleted] = useState([]);
  const setup = request.setup || [], prerequisite = setup[step];
  const active = useMemo(() => prerequisite ? {
    ...request, intent: prerequisite.intent, title: `Set up ${prerequisite.unit}`,
    description: `This buy/sell flow first sets up ${prerequisite.unit} in your wallet. It pays a separate PFT network fee and reserves PFT for the asset line. No assets are bought or converted by this step.`,
    summary: [['Asset', prerequisite.unit], ['Receiving limit', <Amount atoms={prerequisite.intent.operation.limit} unit={prerequisite.unit} />]],
    successText: `${prerequisite.unit} setup was accepted and verified. Continue to the next reviewed step.`,
    verify: verifyTrust, preflight: trustPreflight,
  } : request, [request, prerequisite]);
  return <>
    {setup.length > 0 && <Card>
      <p className="l1-small l1-muted">Review each required asset setup, then confirm the offer. Completed setup remains if you stop before placing the offer.</p>
      <ol>{setup.map((item, i) => <li key={item.intent.operation.asset_id}>{i < completed.length ? 'Verified: ' : ''}Set up {item.unit}</li>)}<li>Place {request.title?.toLowerCase() || 'offer'}</li></ol>
      {completed.map((result, i) => <div className="l1-row" key={result.txId}><span>{setup[i].unit} setup</span><IdChip value={result.txId} label="transaction id" /></div>)}
    </Card>}
    <ActionReview key={step} client={client} request={active} onCancel={onCancel} onComplete={result => {
      if (prerequisite) { if (result.verified) setCompleted(previous => [...previous, result]); }
      else onComplete?.(result);
    }} />
    {prerequisite && completed.length > step && <button type="button" className="l1-btn is-primary" onClick={() => setStep(value => value + 1)}>{step + 1 === setup.length ? 'Continue to offer review' : 'Continue asset setup'}</button>}
  </>;
}
