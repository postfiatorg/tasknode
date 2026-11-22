import { poolAddress, publicAccount, assetId, isU64, missingDraft, finalizedAcceptance, refusalMessage } from '../../../../../shared/private-payment.js';
import { shieldAuthorization } from './shield.js';

export function walletAssets(lines, snapshot, metadata = {}) {
  const byId = new Map();
  for (const line of lines) {
    if (!assetId.test(line.asset_id)) continue;
    const code = line.code || line.asset_code;
    const precision = line.precision ?? (code?.toUpperCase() === 'PFUSDC' ? 6 : undefined);
    const known = Number.isInteger(precision) && precision >= 0 && precision <= 19;
    byId.set(line.asset_id, { id: line.asset_id, label: (code || line.asset_id.slice(0, 8)) + (known ? '' : ' (atoms)'),
      precision: known ? precision : 0, issuer: line.issuer, publicBalance: line.frozen ? 0 : line.balance ?? line.balance_atoms ?? 0 });
  }
  for (const id of Object.keys(snapshot?.balances || {})) {
    if (byId.has(id)) continue;
    const info = metadata[id];
    const known = info?.asset_id === id && info.code && Number.isInteger(info.precision) && info.precision >= 0 && info.precision <= 19;
    byId.set(id, { id, label: known ? info.code : id.slice(0, 8) + ' (atoms)', precision: known ? info.precision : 0, publicBalance: 0 });
  }
  return [...byId.values()].map(asset => ({ ...asset, total: snapshot?.balances[asset.id] || 0, available: snapshot?.available[asset.id] || 0,
    reserved: String(BigInt(snapshot?.balances[asset.id] || 0) - BigInt(snapshot?.available[asset.id] || 0)) }));
}
export function makeJob(mode, asset, input, destination, address) {
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(input.trim());
  if (!asset || input.length > 40 || !m || (m[2]?.length || 0) > asset.precision) throw Error('Enter a positive amount in the displayed units.');
  const atoms = BigInt(m[1] + (m[2] || '').padEnd(asset.precision, '0'));
  const amount = atoms <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(atoms) : String(atoms);
  const balance = mode === 'shield' ? asset.publicBalance : asset.available;
  if (!isU64(amount) || !isU64(balance) || !atoms || atoms > BigInt(balance)) throw Error('Enter an amount within the available balance.');
  const terms = { asset: asset.id, amount };
  if (mode === 'shield') {
    if (!publicAccount.test(asset.issuer)) throw Error('Refresh the public asset details before funding.');
    return { mode, terms, issuer: asset.issuer, account: address, phase: 'prepare' };
  }
  const dest = destination.trim();
  if (!(mode === 'pay' ? poolAddress : publicAccount).test(dest)) throw Error(mode === 'pay' ? 'Enter a valid pfs1 private address.' : 'Enter a valid public pf address.');
  return { mode, phase: 'submit', terms: { ...terms, [mode === 'pay' ? 'recipient' : 'destination']: dest, request_id: crypto.randomUUID() } };
}
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
  signal.addEventListener('abort', cancel, { once: true });
});

const waiting = {
  queued: 'Queued for submission.', dispatched: 'Sent to the network.',
  delivery_unknown: 'The prover lost the delivery acknowledgement.',
  pending_unknown: 'The nodes have no admission record yet.', unknown: 'The network outcome is unknown.',
  rejected: 'Rejection was reported. Checking the reason with the network.',
  accepted: 'Acceptance was reported. Waiting for a finalized receipt.',
};
const held = {
  built: 'Proof built. The prover did not submit it. Local funds are reserved and an exported copy may still settle.',
  unsubmitted: 'The prover has not submitted the transfer. Funds have not moved.',
  refused: 'Submission was temporarily refused. Funds have not moved. Retry the same request or cancel it.',
};
export function pendingMessage(state) {
  return held[state] || (waiting[state] && waiting[state] + ' Transfer settlement is unconfirmed.');
}
export function canAbandon(job) {
  return job?.phase === 'review' || job?.phase === 'unsigned' || Object.hasOwn(held, job?.action?.state);
}
export async function abandon(wallet, job, signal) {
  const draft = job.prepared || (job.mode === 'shield' && job.terms);
  const body = draft ? { pending_id: draft.pending_id, owner_tag: draft.owner_tag } : { request_id: job.terms.request_id };
  let reply;
  try { reply = await wallet.request('abandon', body, signal); }
  catch (error) {
    if (!job.action && draft && error.refused && error.message === missingDraft) return missingDraft;
    throw error;
  }
  if (reply.state !== 'abandoned' || (job.action ? reply.intent_id !== job.action.intent_id : reply.pending_id !== body.pending_id)) {
    throw Error('Cancellation could not be confirmed.');
  }
  return reply.exported_action_may_still_settle ? 'Local funds released. An exported copy may still settle.' :
    'Cancelled and released. No funds moved.';
}

// Each dispatch has a durable recovery record before it can leave the browser.
export async function advance(wallet, initial, { confirm = false, retry = false, privateAddress, progress, save, signal, pause = delay }) {
  let job = initial, polls = 0;
  const persist = async next => { await save(next); job = next; };
  if (retry && ['unsubmitted','refused','delivery_unknown','pending_unknown','unknown'].includes(job.action?.state)) {
    await persist({ ...job, receipt: undefined, action: undefined, phase: 'submit' });
  }
  for (;;) {
    signal.throwIfAborted();
    if (job.phase === 'prepare') {
      progress('Preparing the public funding terms. No funds have moved.');
      const prepared = await wallet.request('shield/prepare', job.terms, signal);
      await persist({ ...job, prepared, phase: 'unsigned' });
    }
    if (job.phase === 'unsigned') {
      const { fee } = shieldAuthorization(job.prepared, { ...job.terms, issuer: job.issuer, account: job.account, privateAddress });
      await persist({ ...job, fee, phase: 'review' });
      return 'Review the private destination and funding fee. No funds have moved.';
    }
    if (job.phase === 'review') {
      if (!confirm) return 'Review the prepared funding terms. No funds have moved.';
      progress('Signing the funding authorization in this browser.');
      const { prepared, terms, issuer } = job;
      const funding_authorization = await wallet.authorize(prepared, { ...terms, issuer, fee: job.fee }, signal);
      await persist({ mode: 'shield', phase: 'submit', terms: { pending_id: prepared.pending_id, owner_tag: prepared.owner_tag, funding_authorization } });
    }
    if (job.phase === 'submit') {
      progress('Building the proof. This usually takes about 10 seconds.');
      const action = await wallet.request(job.mode === 'shield' ? 'shield/finish' : job.mode, job.terms, signal);
      await persist({ ...job, phase: 'receipt', action });
      // Leave an offline reservation recoverable. A later status check may find a finalized export.
      if (action.state === 'built') return held.built;
    }
    const { operation, state, intent_id, owner_tag } = job.action;
    if (state === 'accepted' && finalizedAcceptance(intent_id, job.receipt)) {
      if (operation !== 'merge') {
        const mode = job.mode;
        await persist(null);
        return { shield: 'Funds moved to your private balance.', pay: 'Private payment accepted.', exit: 'Funds moved to the public destination.' }[mode];
      }
      progress('Notes combined in your private balance. Building the requested payment proof.');
      await persist({ mode: job.mode, phase: 'submit', terms: { ...job.terms, request_id: crypto.randomUUID() } });
      continue;
    }
    const rejected = state === 'rejected' && (job.action.admission === 'not_reserved' || job.receipt?.state === 'rejected');
    if (rejected || state === 'abandoned') {
      const reason = refusalMessage(job.action.code || job.receipt?.code);
      await persist(null);
      return state === 'rejected' ? [reason || 'Transfer rejected.', 'The requested funds did not move.'].join(' ') :
        'The request was abandoned. Any previously exported copy may still settle.';
    }
    if (state === 'refused' || state === 'unsubmitted') return [refusalMessage(job.action.code), held[state]].filter(Boolean).join(' ');
    const message = [operation === 'merge' ? 'Combining private notes. The recipient has not been paid.' : '',
      waiting[state] || held[state], 'Transfer settlement is unconfirmed.'].filter(Boolean).join(' ');
    progress(message);
    if (++polls > 45) return message + ' Check status again.';
    await pause(2000, signal);
    signal.throwIfAborted();
    const receipt = await wallet.request('receipt', { intent_id, owner_tag }, signal);
    if (receipt.intent_id !== intent_id) throw Error('Receipt belongs to a different transfer.');
    if (state === 'built' && receipt.state === 'pending_unknown') return held.built;
    const retryable = ['orchard_pool_paused','shielded_atomic_batch_not_active','asset_orchard_transfer_not_active','private_action_not_proposer','private_action_busy'];
    const temporary = receipt.state === 'rejected' && receipt.contract_receipt?.inclusion_height == null &&
      retryable.includes(receipt.contract_receipt?.code);
    await persist({ ...job, receipt: receipt.contract_receipt, action: { ...job.action, state: temporary ? 'refused' : receipt.state } });
  }
}
