import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Wallet } from 'xrpl';
process.env.TASKNODE_OFFCHAIN_TASK_LIFECYCLE='true';
process.env.TASKNODE_OFFCHAIN_TASK_LIFECYCLE_DUAL_WRITE='false';
process.env.TASKNODE_PROCESS_ROLE='web';
const {query,closePool}=await import('../server/db/pool.js');
const {migrateDatabase}=await import('../server/db/migrate.js');
const {saveContextDocument}=await import('../server/repositories/context.js');
const {createTaskRequestForNetworkJob}=await import('../server/network-task-generation-worker.js');
const id='direct_network_'+randomUUID(),other=id+'_other',wallet=Wallet.generate().classicAddress;
const need='Implement a retry control using the findings in my earlier queue audit.';
async function seed(suffix){const jobId=id+'_'+suffix;await query("INSERT INTO network_task_allocations(id,project_id,candidate_account_id) VALUES($1,$2,$2)",[jobId,id]);
 await query("INSERT INTO network_task_generation_jobs(id,allocation_id,project_id,candidate_account_id,status,worker_attempt_id,lease_expires_at) VALUES($1,$1,$2,$2,'running','attempt',now()+interval '5 minutes')",[jobId,id]);
 return {...(await query('SELECT * FROM network_task_generation_jobs WHERE id=$1',[jobId])).rows[0],candidate_wallet_address:'rOldWallet',reward_min_pft:2,reward_max_pft:4,source_payload_json:{project:{title:'Fixture board'},networkTask:{projectNeedSummary:need},taskLineage:{lineageTaskIds:[]}}};}
const assessment={relationship:'continuation',priorTaskIds:[id+'_prior'],newOutput:'A working retry control',actionable:true,scopeClear:true,reason:'A new artifact builds on the earlier audit.'};
try {
 await migrateDatabase();await query("INSERT INTO network_projects(id,title,status) VALUES($1,'Fixture board','active')",[id]);
 await query('INSERT INTO account_linked_wallets(account_id,wallet_address) VALUES($1,$2)',[id,wallet]);
 await saveContextDocument({accountId:id,title:'Full context',body:'<p>OWN_PRIVATE_CONTEXT: Own all queue recovery UX. '+ 'Detailed requirements. '.repeat(6000)+'</p>'});
 await saveContextDocument({accountId:other,title:'Other context',body:'OTHER_PRIVATE_CONTEXT'});
 for (const owner of [id,other]) await query("INSERT INTO task_projections(task_id,account_id,subject_wallet,status,title,task_kind) VALUES($1,$2,$3,'rewarded','Earlier queue audit','network')",[owner+'_prior',owner,wallet]);
 const job=await seed('valid');
 const result=await createTaskRequestForNetworkJob(job,{assess:async input=>{assert.equal(input.need,need);assert.deepEqual(input.priorTasks.map(task=>task.task_id),[id+'_prior']);return assessment;}});
 const request=(await query('SELECT * FROM task_requests WHERE request_id=$1',[result.requestId])).rows[0];
 assert.equal(request.subject_wallet,wallet);assert.equal(request.user_detail_text,need);assert.ok(request.request_bundle_cid.startsWith('postgres:'));
 assert.ok(JSON.stringify(request.metadata_json).includes('OWN_PRIVATE_CONTEXT'));assert.ok(!JSON.stringify(request.metadata_json).includes('OTHER_PRIVATE_CONTEXT'));
 assert.deepEqual(request.metadata_json.requestBundle.network_task.task_lineage.lineage_task_ids,[id+'_prior']);
 for(const relationship of ['duplicate','uncertain']){const rejected=await seed(relationship);await assert.rejects(createTaskRequestForNetworkJob(rejected,{assess:async()=>({...assessment,relationship})}),error=>error.message.startsWith('network_task_intent_needs_review:'));assert.equal((await query('SELECT 1 FROM task_requests WHERE metadata_json->>\'generationJobId\'=$1',[rejected.id])).rowCount,0);}
 const stale=await seed('stale');await assert.rejects(createTaskRequestForNetworkJob(stale,{assess:async()=>{await query("UPDATE network_task_generation_jobs SET worker_attempt_id='replacement' WHERE id=$1",[stale.id]);return assessment;}}),{message:'network_task_generation_attempt_lost'});
 console.log('Direct network intake passed: no encryption RPC, actual Kimi need, current linked wallet, full owned context, typed continuation, duplicate/uncertain hold, stale assessment rejection.');
} finally {
 await query('DELETE FROM task_requests WHERE account_id=$1',[id]);await query('DELETE FROM task_projections WHERE account_id=ANY($1::text[])',[[id,other]]);
 await query('DELETE FROM network_projects WHERE id=$1',[id]);await query('DELETE FROM account_linked_wallets WHERE account_id=$1',[id]);
 await query('DELETE FROM context_revisions WHERE account_id=ANY($1::text[])',[[id,other]]);await query('DELETE FROM context_documents WHERE account_id=ANY($1::text[])',[[id,other]]);await closePool();
}
