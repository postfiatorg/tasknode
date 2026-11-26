import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { l1Fixture } from './fixtures/l1-validator-fixture.mjs';
import { closePool, query } from '../server/db/pool.js';
import { migrateDatabase } from '../server/db/migrate.js';
import { issueValidatorConnect, validatorConnectChallenge, finishValidatorConnect } from '../server/repositories/validator-connect.js';
import { grantL1ValidatorReward } from '../server/l1-validator-rewards.js';
import { runValidatorRewards } from '../server/validator-rewards.js';
import { deleteAccountDatabaseData } from '../server/account-deletion-db.js';

const accountId=`l1_rewards_${randomUUID()}`, other=`${accountId}_other`, archive=`${accountId}_archive`;
const now=new Date('2026-12-01T01:00:00Z'), month='2026-12';
const fixture=l1Fixture(now);const registry=fixture.registry;
const validatorId=`fixture_${randomUUID()}`;
registry.validators[0].validator_id=validatorId;registry.source_heights[0].validator_id=validatorId;registry.latest_commit.precommit_signers[0]=validatorId;
const p=registry.validators[0].participation;
const registryOptions={now,fetchImpl:async()=>new Response(JSON.stringify(registry))};
const deps={registryOptions};
async function connect(owner=accountId){
 const token=await issueValidatorConnect(owner);const {challenge}=await validatorConnectChallenge(token.token);
 return finishValidatorConnect({token:token.token,network:'l1-devnet',validatorId,mlDsaPublicKey:fixture.publicKey,signature:fixture.sign(challenge)},{registryOptions});
}
try{
 await migrateDatabase();const binding=await connect();
 process.env.TASKNODE_VALIDATOR_REWARDS_ENABLED='true';
 const inspect=()=>runValidatorRewards({accountId,month,now},deps);
 const payout=()=>runValidatorRewards({accountId,month,now,dryRun:false},deps);
 assert.equal((await inspect()).report[0].eligible,false);
 assert.equal(await grantL1ValidatorReward(binding,month,{...deps,now}),false);
 p.available=true;
 p.daily=Array.from({length:24},(_,i)=>({date:new Date(Date.parse(p.window_start)+i*86400000).toISOString().slice(0,10),complete:true,reported:true,committed_blocks:100,signed_blocks:95,score:0.95,from_height:i*100+1,to_height:(i+1)*100}));
 assert.equal((await payout()).granted,0,'24 days cannot earn credit even if publisher claims available');
 p.daily.push({...p.daily[0],date:new Date(Date.parse(p.window_start)+24*86400000).toISOString().slice(0,10),from_height:2401,to_height:2500});
 p.daily[24].complete=false;assert.equal((await payout()).granted,0);p.daily[24].complete=true;
 p.daily[24].signed_blocks=94;p.daily[24].score=.94;assert.equal((await payout()).granted,0);
 p.daily[24].signed_blocks=95;p.daily[24].score=.95;
 registry.validators[0].active=false;assert.equal((await payout()).granted,0);registry.validators[0].active=true;
 registry.generated_at=new Date(+now-3600001).toISOString();assert.equal((await payout()).granted,0);registry.generated_at=now.toISOString();
 const dry=await inspect();assert.equal(dry.report[0].eligible,true);assert.equal(dry.granted,0);
 const racers=await Promise.all(Array.from({length:5},()=>payout()));assert.equal(racers.reduce((n,r)=>n+r.granted,0),1);
 assert.equal((await payout()).granted,0);
 const key=`validator-reward:l1-devnet:${registry.chain_id}:${validatorId}:${month}`;
 assert.equal((await query('SELECT amount_usd::text FROM billing_ledger_entries WHERE idempotency_key=$1',[key])).rows[0].amount_usd,'20.000000');
 assert.equal((await query('SELECT count(*)::int AS n FROM l1_validator_reward_grants WHERE account_id=$1',[accountId])).rows[0].n,1);
 assert.equal((await inspect()).report[0].alreadyGranted,true);
 await deleteAccountDatabaseData({accountId,archiveId:archive,account:{id:accountId}});
 assert.equal((await query('SELECT account_id,evidence_json FROM l1_validator_reward_grants WHERE idempotency_key=$1',[key])).rows[0].account_id,archive);
 const rebound=await connect(other);
 assert.equal(await grantL1ValidatorReward(rebound,month,{...deps,now}),false,'deletion and rebind cannot collect again');
 assert.equal((await query('SELECT count(*)::int AS n FROM billing_ledger_entries WHERE idempotency_key=$1',[key])).rows[0].n,1);
 console.log('l1-validator-rewards-postgres-smoke PASS: 0/24/incomplete/low-score/inactive/stale refused; 25 observed days at95% eligible; dry-run no grant; concurrent once-only20USD; archive/rebind replay refused');
}finally{
 for(const table of ['l1_validator_reward_grants','billing_ledger_entries','billing_accounts','validator_connect_tokens','validator_bindings','validator_challenges'])await query(`DELETE FROM ${table} WHERE account_id=ANY($1::text[])`,[[accountId,other,archive]]);
 await closePool();
}
