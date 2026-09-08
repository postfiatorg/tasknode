import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query,closePool } from '../server/db/pool.js';
import { migrateDatabase } from '../server/db/migrate.js';
import { buildPftPointerMemo } from '../server/pftl-pointer.js';
import { recoverLegacyRejectedReview,validateLegacyRejection } from '../server/task-legacy-review-recovery.js';
import { importTaskReplayReceipt } from '../server/repositories/task-replay-import.js';
const id='legacy_review_'+randomUUID(),hash='B'.repeat(64),cid='QmVPmha4nWwFjfKFpdJ4Ls5GbDFzVHro6WzGhsRv4VNMPQ';
const row={task_id:id,subject_wallet:'rFixtureUser',authority_wallet:'rFixtureAuthority',allocation_wallet:'rFixtureReward'};
const payload={schema:'pf.task.reward_decision.v1',task_id:id,subject_wallet:row.subject_wallet,authority_wallet:row.allocation_wallet,status_after:'reward_decided',score:{decision:'reject',reward_pft:'0.00'}};
const event={payload_json:payload,source_tx_hash:hash,source_cid:cid};
const pointer=buildPftPointerMemo({taskId:id,cid,kind:'TASK_UPDATE',schema:1});
const result={hash,validated:true,ledger_index:42,meta:{TransactionResult:'tesSUCCESS',delivered_amount:'1'},tx_json:{TransactionType:'Payment',Account:row.allocation_wallet,Destination:row.subject_wallet,Amount:'1',Memos:[{Memo:{MemoType:pointer.memoTypeHex,MemoFormat:pointer.memoFormatHex,MemoData:pointer.memoDataHex}}]}};
assert.equal(validateLegacyRejection({row,event,result}).decision,'reject');
for(const changed of [{...payload,score:{decision:'reward',reward_pft:'1'}},{...payload,score:{decision:'reject',reward_pft:'1'}},{...payload,score:{decision:'reject',reward_pft:null}}]) assert.throws(()=>validateLegacyRejection({row,event:{...event,payload_json:changed},result}));
for(const changed of [{...result,validated:false},{...result,tx_json:{...result.tx_json,Account:'rUnrelated'}},{...result,tx_json:{...result.tx_json,Amount:'1000000'}}]) assert.throws(()=>validateLegacyRejection({row,event,result:changed}));
try {
 await migrateDatabase();await query("INSERT INTO task_projections(task_id,account_id,subject_wallet,authority_wallet,allocation_wallet,status) VALUES($1,$1,$2,$3,$4,'verification_response_submitted')",[id,row.subject_wallet,row.authority_wallet,row.allocation_wallet]);
 await query("INSERT INTO task_events(id,task_id,account_id,event_type,source_tx_hash,source_cid,payload_json) VALUES($1,$1,$1,'pf.task.reward_decision.v1',$2,$3,$4::jsonb)",[id,hash,cid,JSON.stringify(payload)]);
 await query("INSERT INTO task_review_publications(task_id,worker_name,status) VALUES($1,'reward_scoring','reserved')",[id]);
 assert.equal((await recoverLegacyRejectedReview({taskId:id},{readTransaction:async()=>result})).applied,false);
 assert.equal((await recoverLegacyRejectedReview({taskId:id,apply:true},{readTransaction:async()=>result})).status,'rejected');
 assert.equal((await recoverLegacyRejectedReview({taskId:id,apply:true},{readTransaction:async()=>{throw new Error('should not reread');}})).alreadyRecovered,true);
 await importTaskReplayReceipt({task_id:id,fixture:{account_id:id},wallets:[{role:'user',address:row.subject_wallet}],projection:{[id]:{status:'verification_response_submitted'}},hydrated_events:[]});
 assert.equal((await query('SELECT status FROM task_projections WHERE task_id=$1',[id])).rows[0].status,'rejected','A stale historical replay cannot reopen a verified legacy rejection');
 console.log('Legacy review recovery passed: explicit zero rejection, validated authority receipt, no payment inference, idempotent repair, stale replay preservation.');
} finally {
 await query('DELETE FROM pftl_task_sync_runs WHERE account_id=$1',[id]);await query('DELETE FROM task_review_publications WHERE task_id=$1',[id]);await query('DELETE FROM task_events WHERE task_id=$1',[id]);await query('DELETE FROM task_projections WHERE task_id=$1',[id]);await closePool();
}
