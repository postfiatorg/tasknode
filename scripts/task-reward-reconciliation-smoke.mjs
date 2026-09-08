import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../server/db/pool.js';
import { migrateDatabase } from '../server/db/migrate.js';
import { buildPftPointerMemo } from '../server/pftl-pointer.js';
import { reconcileRewardPayments, retryReconciledReward, validateRewardTransaction } from '../server/task-reward-reconciliation.js';
import { rewardPaymentGuardBlocksRetry } from '../server/task-review-core.js';
const taskId='reconcile_'+randomUUID();
const hash='A'.repeat(64), cid='QmVPmha4nWwFjfKFpdJ4Ls5GbDFzVHro6WzGhsRv4VNMPQ';
const row={task_id:taskId,subject_wallet:'rFixtureRecipient'};
const pointer=buildPftPointerMemo({cid,taskId,kind:'REWARD',schema:1});
const receipt={tx_hash:hash,cid,account:'rFixtureReward',destination:row.subject_wallet,amount_drops:'400000',sequence:4};
const guard={status:'submit_unknown',reward_pft:'0.40',event_id:'original_decision',transaction_receipt:receipt};
const result={hash,validated:true,ledger_index:42,tx_json:{TransactionType:'Payment',Account:receipt.account,Destination:receipt.destination,DeliverMax:receipt.amount_drops,Sequence:4,Memos:[{Memo:{MemoType:pointer.memoTypeHex,MemoFormat:pointer.memoFormatHex,MemoData:pointer.memoDataHex}}]},meta:{TransactionResult:'tecNO_DST_INSUF_XRP'}};
assert.equal(validateRewardTransaction({row,guard,receipt,result}).paid,false);
for(const invalid of [{...result,validated:false},{...result,hash:'B'.repeat(64)},{...result,tx_json:{...result.tx_json,Destination:'another-wallet'}},{...result,meta:{TransactionResult:'terQUEUED'}}]) {
  assert.throws(()=>validateRewardTransaction({row,guard,receipt,result:invalid}));
}
assert.throws(()=>validateRewardTransaction({row,guard,receipt,result:{...result,meta:{TransactionResult:'tesSUCCESS',delivered_amount:'1'}}}));
let reduced=0,stored=0;
const dependencies={readTransaction:async()=>result,storeTransactions:async()=>{stored+=1;},reduce:async()=>{reduced+=1;}};
async function reset(){
 await query(`UPDATE task_projections SET metadata_json=$2::jsonb,updated_at=now()-interval '1 day' WHERE task_id=$1`,[taskId,JSON.stringify({reward_payment_guard:guard})]);
 await query(`UPDATE task_review_publications SET status='reserved' WHERE task_id=$1`,[taskId]);
}
try {
 await migrateDatabase();
 await query("INSERT INTO task_projections(task_id,account_id,subject_wallet,status,metadata_json,updated_at) VALUES($1,$1,$2,'verification_response_submitted',$3::jsonb,now()-interval '1 day')",[taskId,row.subject_wallet,JSON.stringify({reward_payment_guard:guard})]);
 await query("INSERT INTO task_review_publications(task_id,worker_name,status) VALUES($1,'reward_scoring','reserved')",[taskId]);
 assert.equal((await reconcileRewardPayments({taskId},dependencies)).outcomes[0].applied,false);
 assert.equal(stored,0);
 assert.equal((await reconcileRewardPayments({taskId,apply:true},dependencies)).outcomes[0].applied,true);
 assert.equal(reduced,0);
 const saved=(await query("SELECT metadata_json->'reward_payment_guard' guard FROM task_projections WHERE task_id=$1",[taskId])).rows[0].guard;
 assert.equal(saved.status,'failed_validated');assert.equal(rewardPaymentGuardBlocksRetry(saved),true);
 await assert.rejects(retryReconciledReward({taskId,txHash:'wrong'}));
 assert.equal((await retryReconciledReward({taskId,txHash:hash})).requeued,true);
 await assert.rejects(retryReconciledReward({taskId,txHash:hash}));
 const history=(await query("SELECT metadata_json->'reward_payment_history' history FROM task_projections WHERE task_id=$1",[taskId])).rows[0].history;
 assert.equal(history[0].reconciliation.txHash,hash);
 await reset();
 const success={...result,meta:{TransactionResult:'tesSUCCESS',delivered_amount:'400000'}};
 assert.equal((await reconcileRewardPayments({taskId,apply:true},{...dependencies,readTransaction:async()=>success})).outcomes[0].state,'paid_replay_required');
 assert.equal(reduced,1);
 await reset();
 const changed=await reconcileRewardPayments({taskId,apply:true},{...dependencies,readTransaction:async()=>{
   await query("UPDATE task_projections SET metadata_json=jsonb_set(metadata_json,'{reward_payment_guard,event_id}','\"replacement\"') WHERE task_id=$1",[taskId]);return result;
 }});
 assert.equal(changed.outcomes[0].applied,false,'Old reconciliation cannot replace a new payment attempt');
 await reset();
 assert.equal((await reconcileRewardPayments({taskId,apply:true},{...dependencies,readTransaction:async()=>{throw new Error('offline');}})).outcomes[0].state,'held');
 assert.equal((await query("SELECT metadata_json->'reward_payment_guard'->>'status' status FROM task_projections WHERE task_id=$1",[taskId])).rows[0].status,'submit_unknown');
 console.log('Reward reconciliation passed: validated matching evidence, no guessed success, guarded failures, explicit retry, immutable history, stale attempt rejection. No payment was submitted.');
} finally {
 await query('DELETE FROM task_review_publications WHERE task_id=$1',[taskId]);
 await query('DELETE FROM task_projections WHERE task_id=$1',[taskId]);
 await closePool();
}
