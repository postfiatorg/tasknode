import { query, transaction } from './db/pool.js';
import { readPftlTransaction } from './pftl-submit.js';
import { fetchAndDecryptTasknodePayload } from './task-payloads.js';
import { extractPointerMemosFromTransaction, storePftlAccountTransactions } from './repositories/pftl-cache.js';
import { runPftlCacheReducerOnce } from './pftl-cache-reducer.js';
import { pftToDrops, sha256 } from './task-review-core.js';

// A missing transaction, provisional result, or mismatched receipt never frees a guard.
export function validateRewardTransaction({ row, guard, receipt, result }) {
  const tx = result.tx_json || result.tx || result;
  const hash = result.hash || tx.hash;
  const meta = result.meta || {};
  const pointers = extractPointerMemosFromTransaction({txHash:hash,tx});
  if (result.validated !== true || hash !== receipt.tx_hash || tx.TransactionType !== 'Payment' ||
      tx.Account !== receipt.account || tx.Destination !== row.subject_wallet || tx.Destination !== receipt.destination ||
      String(tx.Amount ?? tx.DeliverMax) !== String(receipt.amount_drops) || Number(tx.Sequence) !== Number(receipt.sequence) ||
      !pointers.some(pointer => pointer.taskId === row.task_id && pointer.pointerKind === 'REWARD' && pointer.cid === receipt.cid)) {
    throw new Error('reward_reconciliation_receipt_mismatch_or_unvalidated');
  }
  const expectedDrops = Number(guard.reward_pft) > 0 ? pftToDrops(guard.reward_pft) : '1';
  if (String(receipt.amount_drops) !== expectedDrops) throw new Error('reward_reconciliation_amount_mismatch');
  const code = meta.TransactionResult;
  if (code !== 'tesSUCCESS' && !(typeof code === 'string' && code.startsWith('tec'))) throw new Error('reward_reconciliation_result_not_final');
  if (code === 'tesSUCCESS') {
    const delivered = meta.delivered_amount ?? meta.DeliveredAmount;
    if (String(delivered) !== expectedDrops) throw new Error('reward_reconciliation_delivered_amount_mismatch');
  }
  return {txHash:hash,cid:receipt.cid,account:tx.Account,destination:tx.Destination,amountDrops:expectedDrops,
    result:code,ledgerIndex:result.ledger_index,validated:true,paid:code==='tesSUCCESS'};
}

async function findReceipt(row, guard, {readTransaction, readPayload}) {
  if (guard.transaction_receipt?.tx_hash) {
    const receipt = guard.transaction_receipt;
    return {receipt,result:await readTransaction({txHash:receipt.tx_hash})};
  }
  // Historical guards did not save a hash. Require the original encrypted payload
  // to match the guard's immutable digest and event ID, not just a similar payment.
  const candidates = await query(`SELECT DISTINCT t.tx_hash,m.cid FROM pftl_pointer_memos m
    JOIN pftl_transactions t USING(tx_hash) WHERE m.task_id=$1 AND m.pointer_kind='REWARD'
    AND t.destination=$2 LIMIT 6`,[row.task_id,row.subject_wallet]);
  if (candidates.rows.length !== 1) throw new Error('reward_reconciliation_legacy_reference_ambiguous');
  const candidate = candidates.rows[0];
  const {payload} = await readPayload({cid:candidate.cid});
  if (payload.task_id !== row.task_id || payload.event_id !== guard.event_id || sha256(payload) !== guard.payload_digest ||
      payload.schema !== 'pf.reward.v1' || payload.subject_wallet !== row.subject_wallet) throw new Error('reward_reconciliation_legacy_payload_mismatch');
  const result = await readTransaction({txHash:candidate.tx_hash});
  const tx = result.tx_json || result.tx || result;
  if (![payload.allocation_wallet,payload.authority_wallet].filter(Boolean).includes(tx.Account)) throw new Error('reward_reconciliation_signer_mismatch');
  return {result,receipt:{tx_hash:candidate.tx_hash,cid:candidate.cid,account:tx.Account,destination:tx.Destination,
    amount_drops:tx.Amount ?? tx.DeliverMax,sequence:tx.Sequence,last_ledger_sequence:tx.LastLedgerSequence}};
}

export async function reconcileRewardPayments({taskId='',limit=2,apply=false}={}, {
  readTransaction=readPftlTransaction, readPayload=fetchAndDecryptTasknodePayload,
  storeTransactions=storePftlAccountTransactions, reduce=runPftlCacheReducerOnce,
}={}) {
  const rows = await query(`SELECT task_id,account_id,subject_wallet,metadata_json->'reward_payment_guard' AS guard
    FROM task_projections WHERE ($1='' OR task_id=$1) AND status='verification_response_submitted'
    AND metadata_json->'reward_payment_guard'->>'status' IN ('submitting','submitted','submit_unknown')
    AND updated_at < now() - interval '15 minutes'
    AND COALESCE(NULLIF(metadata_json->'reward_payment_guard'->>'last_reconciliation_at','')::timestamptz,'-infinity'::timestamptz) < now() - interval '15 minutes'
    ORDER BY updated_at LIMIT $2`,[taskId,Math.min(10,Math.max(1,Number(limit)||2))]);
  const outcomes=[];
  for (const row of rows.rows) {
    const guard=row.guard;
    try {
      const {receipt,result} = await findReceipt(row,guard,{readTransaction,readPayload});
      const evidence=validateRewardTransaction({row,guard,receipt,result});
      let changed=false;
      if (apply) {
        // Preserve chain evidence before marking successful publications for replay.
        await storeTransactions({walletAddress:row.subject_wallet,transactions:[result],syncKind:'reward_reconciliation'});
        changed=await transaction(async client=>{
          const next={...guard,transaction_receipt:receipt,status:evidence.paid?'submitted':'failed_validated',
            reconciliation:evidence,last_reconciliation_at:new Date().toISOString()};
          const updated=await client.query(`UPDATE task_projections SET metadata_json=jsonb_set(metadata_json,'{reward_payment_guard}',$3::jsonb),updated_at=now()
            WHERE task_id=$1 AND status='verification_response_submitted' AND metadata_json->'reward_payment_guard'=$2::jsonb RETURNING task_id`,[row.task_id,JSON.stringify(guard),JSON.stringify(next)]);
          if (!updated.rowCount) return false;
          await client.query(`UPDATE task_review_publications SET status=$2,error=$3,source_tx_hash=$4,source_cid=$5,
            metadata_json=metadata_json||jsonb_build_object('reconciliation',$6::jsonb),updated_at=now()
            WHERE task_id=$1 AND worker_name='reward_scoring'`,[row.task_id,evidence.paid?'published':'error',evidence.paid?'':`reward_payment_failed:${evidence.result}`,receipt.tx_hash,receipt.cid,JSON.stringify(evidence)]);
          return true;
        });
        if (changed && evidence.paid) await reduce({taskId:row.task_id,txHash:receipt.tx_hash,batchLimit:12,logger:{}});
      }
      outcomes.push({taskId:row.task_id,state:evidence.paid?'paid_replay_required':'failed_payment_requires_retry',applied:changed,evidence});
    } catch (error) {
      // Bound repeated reads, while leaving the payment guard intact.
      if (apply) await query(`UPDATE task_projections SET metadata_json=jsonb_set(metadata_json,'{reward_payment_guard}',
        (metadata_json->'reward_payment_guard')||jsonb_build_object('last_reconciliation_at',now()))
        WHERE task_id=$1 AND metadata_json->'reward_payment_guard'=$2::jsonb`,[row.task_id,JSON.stringify(guard)]);
      outcomes.push({taskId:row.task_id,state:'held',reason:String(error?.code || error?.message || 'reconciliation_unavailable').slice(0,200)});
    }
  }
  return {outcomes};
}

export async function retryReconciledReward({taskId,txHash}) {
  return transaction(async client=>{
    const current=await client.query(`SELECT metadata_json->'reward_payment_guard' guard FROM task_projections
      WHERE task_id=$1 AND status='verification_response_submitted' FOR UPDATE`,[taskId]);
    const guard=current.rows[0]?.guard;
    if (guard?.status !== 'failed_validated' || guard.reconciliation?.paid !== false || guard.reconciliation?.validated !== true || guard.reconciliation.txHash !== txHash) throw new Error('reward_retry_requires_matching_failed_transaction');
    const next={...guard,status:'retry_wait',retry_after:new Date().toISOString()};
    await client.query(`UPDATE task_projections SET metadata_json=jsonb_set(metadata_json||jsonb_build_object('reward_payment_history',
      COALESCE(metadata_json->'reward_payment_history','[]'::jsonb)||$2::jsonb),'{reward_payment_guard}',$3::jsonb),updated_at=now() WHERE task_id=$1`,[taskId,JSON.stringify([guard]),JSON.stringify(next)]);
    await client.query(`UPDATE task_review_publications SET status='retry_wait',source_tx_hash='',source_cid='',error='',
      metadata_json=metadata_json||jsonb_build_object('retry_after',now(),'retry_authorization','operator_reconciled_failure'),updated_at=now()
      WHERE task_id=$1 AND worker_name='reward_scoring'`,[taskId]);
    return {taskId,requeued:true,failedTxHash:txHash};
  });
}
