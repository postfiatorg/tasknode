import { query, transaction } from './db/pool.js';
import { readPftlTransaction } from './pftl-submit.js';
import { extractPointerMemosFromTransaction } from './repositories/pftl-cache.js';

export function validateLegacyRejection({row,event,result}) {
  const payload=event.payload_json;
  if (payload?.schema !== 'pf.task.reward_decision.v1' || payload.task_id !== row.task_id ||
      payload.status_after !== 'reward_decided' || payload.score?.decision !== 'reject' ||
      !['string','number'].includes(typeof payload.score?.reward_pft) || !String(payload.score.reward_pft).trim() || Number(payload.score.reward_pft) !== 0 || payload.subject_wallet !== row.subject_wallet) throw new Error('legacy_review_not_explicit_zero_rejection');
  const tx=result.tx_json || result.tx || result;
  const hash=result.hash || tx.hash;
  if (result.validated !== true || result.meta?.TransactionResult !== 'tesSUCCESS' || hash !== event.source_tx_hash ||
      tx.TransactionType !== 'Payment' || String(tx.Amount ?? tx.DeliverMax) !== '1' ||
      String(result.meta?.delivered_amount ?? result.meta?.DeliveredAmount) !== '1' ||
      tx.Destination !== row.subject_wallet || ![row.authority_wallet,row.allocation_wallet].filter(Boolean).includes(tx.Account) ||
      payload.authority_wallet !== tx.Account || !extractPointerMemosFromTransaction({txHash:hash,tx}).some(pointer=>pointer.taskId===row.task_id&&pointer.cid===event.source_cid)) throw new Error('legacy_review_authority_receipt_mismatch');
  return {decision:'reject',rewardPft:'0.00',txHash:hash,cid:event.source_cid,ledgerIndex:result.ledger_index,validated:true};
}

// Historical reject/zero decisions are final review outcomes, not pending money.
// Positive or conflicting legacy decisions still require payment reconciliation.
export async function recoverLegacyRejectedReview({taskId,apply=false},{readTransaction=readPftlTransaction}={}) {
  const row=(await query('SELECT * FROM task_projections WHERE task_id=$1',[taskId])).rows[0];
  if (!row) throw new Error('legacy_review_task_missing');
  if (row.metadata_json?.legacy_rejected_review) {
    const receipt=row.metadata_json.legacy_rejected_review.receipts?.at(-1);
    if (apply && receipt?.validated && receipt.decision === 'reject') await query(`UPDATE task_projections SET
      last_event_tx_hash=$2,last_event_cid=$3,last_event_at=COALESCE((SELECT close_time FROM pftl_transactions WHERE tx_hash=$2),last_event_at)
      WHERE task_id=$1 AND status='rejected'`,[taskId,receipt.txHash,receipt.cid]);
    return {taskId,alreadyRecovered:true};
  }
  if (!['verification_response_submitted','reward_decided'].includes(row.status) || row.metadata_json?.reward_payment_guard) throw new Error('legacy_review_not_recoverable');
  const events=(await query("SELECT source_tx_hash,source_cid,payload_json,event_type FROM task_events WHERE task_id=$1 AND event_type IN ('pf.task.reward_decision.v1','pf.reward.v1') ORDER BY created_at",[taskId])).rows;
  if (!events.length || events.some(event=>event.event_type!=='pf.task.reward_decision.v1')) throw new Error('legacy_review_has_payment_or_no_decision');
  const receipts=[];
  for(const event of events) receipts.push(validateLegacyRejection({row,event,result:await readTransaction({txHash:event.source_tx_hash})}));
  if (!apply) return {taskId,status:'rejected',applied:false,receipts};
  return transaction(async client=>{
    await client.query('SELECT task_id FROM task_projections WHERE task_id=$1 FOR UPDATE',[taskId]);
    const changed=await client.query(`UPDATE task_projections SET status='rejected',reward_actual_pft=0,last_event_tx_hash=$5,last_event_cid=$6,
      last_event_at=COALESCE((SELECT close_time FROM pftl_transactions WHERE tx_hash=$5),last_event_at),
      metadata_json=metadata_json||jsonb_build_object('legacy_rejected_review',$3::jsonb),updated_at=now()
      WHERE task_id=$1 AND status=$2 AND metadata_json=$4::jsonb
      AND NOT EXISTS(SELECT 1 FROM task_events WHERE task_id=$1 AND event_type='pf.reward.v1') RETURNING task_id`,[taskId,row.status,JSON.stringify({receipts,recoveredAt:new Date().toISOString()}),JSON.stringify(row.metadata_json),receipts.at(-1).txHash,receipts.at(-1).cid]);
    if (!changed.rowCount) throw new Error('legacy_review_state_changed');
    await client.query(`UPDATE task_review_publications SET status='published',source_tx_hash=$2,source_cid=$3,error='',
      metadata_json=metadata_json||jsonb_build_object('legacy_rejected_review',$4::jsonb),published_at=COALESCE(published_at,now()),updated_at=now()
      WHERE task_id=$1 AND worker_name='reward_scoring'`,[taskId,receipts.at(-1).txHash,receipts.at(-1).cid,JSON.stringify(receipts)]);
    return {taskId,status:'rejected',applied:true,receipts};
  });
}
