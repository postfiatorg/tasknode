import assert from 'node:assert/strict';
import { fetchUrlExcerpt, buildRewardEvidenceEvaluationContext } from '../server/task-review-evidence.js';
const url='https://gist.github.com/synthetic/abcdef123456';
const lookupFn=async()=>[{address:'140.82.112.133',family:4}];
const fixture={description:'Synthetic resolver QA',files:{'REPORT.md':{filename:'REPORT.md',content:'SYNTHETIC-PFT-QA\nNo credentials, wallets, or private data.\n'}}};
for (const name of ['fetched','unavailable','truncated','missing-processing']) {
 const calls=[];
 const fetchImpl=async address=>{
  calls.push(String(address));
  if(name==='unavailable') return new Response('Unavailable',{status:404});
  const body=structuredClone(fixture);
  if(name==='truncated') body.files['REPORT.md'].content='A'.repeat(40000)+'END-MARKER';
  return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
 };
 const output=name==='missing-processing'?null:await fetchUrlExcerpt(url,{fetchImpl,lookupFn});
 const packet={artifacts:[{artifact_type:'url',status:'provided',source:{url},excerpt:url},...(output?[{artifact_type:'url',...output}]:[])]};
 const context=buildRewardEvidenceEvaluationContext({initial:packet});
 if(name==='fetched') {assert.equal(output.status,'extracted');assert.match(output.excerpt,/SYNTHETIC-PFT-QA/);assert.equal(context.counts.verified,1);}
 if(name==='unavailable') {assert.equal(output.status,'http_error');assert.equal(context.counts.unverified,1);assert.equal(context.counts.verified,0);assert.equal(calls.length,2);}
 if(name==='truncated') {assert.equal(output.status,'extracted');assert.ok(output.excerpt.length<=30000);assert.ok(!output.excerpt.includes('END-MARKER'));assert.ok(output.excerpt.includes("[truncated omitted_chars=10050]"),"truncation warning must survive final budget");assert.equal(context.counts.verified,1);}
 if(name==='missing-processing') {assert.equal(context.counts.verified,0);assert.equal(context.counts.self_attested,1);}
 console.log(JSON.stringify({case:name,input:url,calls,output:output?{...output,excerpt:name==='truncated'?output.excerpt.slice(0,180)+"..."+output.excerpt.slice(-30):output.excerpt}:null,context}));
}
console.log('PASS: fetched, unavailable, excerpt truncation, and missing-processing boundaries');
