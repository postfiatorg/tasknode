import { poolAddress, publicAccount, assetId } from '../../../../../shared/private-payment.js';
import { safeInteger } from '../market/amounts.js';
import { shieldAuthorization } from './shield.js';

export function walletAssets(lines, snapshot) {
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
    if (!byId.has(id)) byId.set(id, { id, label: id.slice(0, 8) + ' (atoms)', precision: 0, publicBalance: 0 });
  }
  return [...byId.values()].map(asset => ({ ...asset, available: snapshot?.available[asset.id] || 0,
    reserved: String(BigInt(snapshot?.balances[asset.id] || 0) - BigInt(snapshot?.available[asset.id] || 0)) }));
}
export function makeJob(mode, asset, input, destination, address) {
  const m = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(input.trim());
  if (!asset || input.length > 40 || !m || (m[2]?.length || 0) > asset.precision) throw Error('Enter a positive amount in the displayed units.');
  const amount = safeInteger(BigInt(m[1] + (m[2] || '').padEnd(asset.precision, '0')), 'Amount');
  if (!amount || BigInt(amount) > BigInt(mode === 'shield' ? asset.publicBalance : asset.available)) throw Error('Enter an amount within the available balance.');
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

// Each dispatch has a durable recovery record before it can leave the browser.
export async function advance(wallet, initial, { confirm = false, progress, save, signal, pause = delay }) {
  let job = initial, polls = 0;
  const persist = async next => { await save(next); job = next; };
  for (;;) {
    signal.throwIfAborted();
    if (job.phase === 'prepare') {
      progress('Preparing the public funding terms. No funds have moved.');
      const prepared = await wallet.request('shield/prepare', job.terms, signal);
      const { fee } = shieldAuthorization(prepared, { ...job.terms, issuer: job.issuer, account: job.account });
      await persist({ ...job, prepared, fee, phase: 'review' });
      return 'Review the funding fee and sign in this wallet. No funds have moved.';
    }
    if (job.phase === 'review') {
      if (!confirm) return 'Review the prepared funding terms. No funds have moved.';
      progress('Signing the funding authorization in this browser.');
      const { prepared, terms, issuer } = job;
      const authorization = wallet.authorize(prepared, { ...terms, issuer });
      await persist({ mode: 'shield', phase: 'submit', terms: { pending_id: prepared.pending_id, owner_tag: prepared.owner_tag, authorization } });
    }
    if (job.phase === 'submit') {
      progress('Building the proof. This usually takes about 10 seconds.');
      const action = await wallet.request(job.mode === 'shield' ? 'shield/finish' : job.mode, job.terms, signal);
      await persist({ ...job, phase: 'receipt', action });
    }
    const { operation, state, intent_id, owner_tag } = job.action;
    if (state === 'accepted') {
      if (operation !== 'merge') {
        const mode = job.mode;
        await persist(null);
        return { shield: 'Funds moved to your private balance.', pay: 'Private payment accepted.', exit: 'Funds moved to the public destination.' }[mode];
      }
      progress('Notes combined in your private balance. Building the requested payment proof.');
      // Every tab or recovery of this merge derives the same next id.
      await persist({ mode: job.mode, phase: 'submit', terms: { ...job.terms, request_id: intent_id.slice(0,64) } });
      continue;
    }
    if (state === 'built' || state === 'abandoned' || state === 'rejected') {
      await persist(null);
      return state === 'built' ? 'Proof built in offline mode. Nothing was submitted. Funds have not moved and notes may remain reserved.' :
        'The network ' + state + ' this action. The requested transfer did not move funds.';
    }
    const message = operation === 'merge' ? 'Combining private notes. Waiting for finality before continuing. The recipient has not been paid.' :
      'Waiting for finality. The transfer is unconfirmed.';
    progress(message);
    if (++polls > 45) return message + ' Check status again.';
    await pause(2000, signal);
    signal.throwIfAborted();
    const receipt = await wallet.request('receipt', { intent_id, owner_tag }, signal);
    await persist({ ...job, action: { ...job.action, state: receipt.state } });
  }
}
