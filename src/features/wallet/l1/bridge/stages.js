export const STAGES = [
  ['confirming_deposit', 'Confirm Ethereum deposit'],
  ['waiting_for_ethereum_finality', 'Ethereum finality'],
  ['capturing_state_proof', 'Proof capture'],
  ['proving', 'Proving'],
  ['verifying', 'Propose'],
  ['growing_backed_cap', 'Finalize'],
  ['claiming', 'Claim PFUSDC'],
];
export function stageRows(job) {
  const current = STAGES.findIndex(([stage]) => stage === job?.status);
  const accepted = job?.status === 'accepted' && job.receipt_code === 'ACCEPTED'
    && /^(0x)?([0-9a-f]{64}|[0-9a-f]{96})$/.test(job.receipt_id || job.tx_id || '')
    && /^[0-9a-f]{96}$/.test(job.credited_asset_id || '');
  return STAGES.map(([stage, label], index) => {
    const history = job?.stage_history?.find((row) => row.stage === stage);
    const status = job?.status === 'accepted' && !accepted && stage === 'claiming' ? 'unverified' : history?.status || (accepted || (current >= 0 && index < current) ? 'complete'
      : current === index ? (job.retryable && job.code ? 'retrying' : 'running') : 'pending');
    return { stage, label, status, started: history?.started_at_unix ?? null, completed: history?.completed_at_unix ?? null };
  });
}
export function timestamp(seconds) {
  return Number.isSafeInteger(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : 'Not recorded';
}
