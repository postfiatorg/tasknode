import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inferenceCallGraph } from './inference-call-graph.mjs';
import { sanitizeContextHtml } from '../shared/context-html.js';
import { contextBodyText } from '../shared/context-line-map.js';
import { selectContextRewriteResearchQueries } from '../server/context-rewrite-search.js';
import { reportActionDecision } from '../server/repositories/hive-report-contract.js';
import { classifyAccountReservations } from '../server/repositories/hive-account-live-state.js';
import { classifyEvidenceReference } from '../server/task-evidence-intent.js';
import { guardBoardManagerMessageUserFreshness } from '../server/board-manager-message-policy.js';
const complete = value => async () => ({body:{choices:[{message:{content:JSON.stringify(value)}}]}});

for (const html of [
  '<p onclick="bad()">Hello &amp; <b>world</b></p><script>bad()</script>',
  '<p>Hello &amp; <b style="color:red">world</b></p><style>bad()</style>',
  '<p>Hello &amp; <b>world</b></p><!-- bad() -->',
]) {
  assert.equal(sanitizeContextHtml(html), '<p>Hello &amp; <b>world</b></p>');
  assert.equal(contextBodyText(html), 'Hello & world');
}
assert.equal(sanitizeContextHtml('<p>&lt;script&gt;visible&lt;/script&gt;</p>'), '<p>&lt;script&gt;visible&lt;/script&gt;</p>');
assert.ok(!sanitizeContextHtml('<svg><script>bad()</script></svg>').includes('bad()'));
assert.equal(selectContextRewriteResearchQueries({research_requests:[{question:'How can retries recover safely?',why_it_matters:'Prevent duplication.'}]} )[0].query, 'How can retries recover safely?');
assert.equal(reportActionDecision('## Recommended Actions\n### ADD_BOARD\nDecision: none\nNo action recommended.', 'ADD_BOARD').decision, 'none');
assert.equal(reportActionDecision('## Recommended Actions\n### ADD_BOARD\nDecision: recommended\nA scoped board.', 'ADD_BOARD').decision, 'recommended');
assert.equal(reportActionDecision('We should not ADD_BOARD despite the action mentioned here.', 'ADD_BOARD').decision, 'unknown');
assert.equal(reportActionDecision('## Recommended Actions\n### ADD_BOARD\nDecision: recommended\nDecision: none', 'ADD_BOARD').decision, 'unknown');

const accounts = [{accountId:'alice',entries:[{id:'a',body:'For task work my minimum is 20 PFT.'}]},{accountId:'bob',entries:[{id:'b',body:'My balance is 20 PFT.'}]}];
const valid = {accountId:'alice',entryId:'a',minPft:20,citation:accounts[0].entries[0].body};
assert.equal((await classifyAccountReservations(accounts,{complete:complete({reservations:[valid]})})).get('alice').minPft,20);
for (const reservations of [[{...valid,accountId:'bob'}],[valid,valid],[{...valid,citation:'Not in context'}]]) {
  assert.equal((await classifyAccountReservations(accounts,{complete:complete({reservations})})).size,0);
}
for (const text of ['The Discord post identifier is 123456789012345678.', 'Find the announcement using message 123456789012345678.']) {
  const value = {kind:'message_id',messageId:'123456789012345678',citation:text};
  assert.equal((await classifyEvidenceReference({text,hasScreenshot:false},{complete:complete(value)})).kind,'message_id');
}
assert.equal((await classifyEvidenceReference({text:'An announcement screenshot is attached.',hasScreenshot:false},{complete:complete({kind:'screenshot',messageId:'',citation:'An announcement screenshot is attached.'})})).kind,'missing');
assert.equal((await classifyEvidenceReference({text:'No identifier supplied.',hasScreenshot:false},{complete:complete({kind:'message_id',messageId:'123456789012345678',citation:'No identifier supplied.'})})).kind,'missing');
for (const messageText of ['Could you take the next step on this offer?', 'Please decide whether you want this task.']) {
  const guard = await guardBoardManagerMessageUserFreshness({messageText,accountLiveState:{ok:true}}, {complete:complete({intent:'task_action'})});
  assert.equal(guard.precondition.reason,'board_manager_message_user_missing_structured_precondition');
}
assert.equal((await guardBoardManagerMessageUserFreshness({messageText:'Ambiguous note.'},{complete:async()=>{throw new Error('offline');}})).reason,'board_manager_message_intent_uncertain');

const directory = await mkdtemp(path.join(tmpdir(),'inference-graph-'));
try {
  await writeFile(path.join(directory,'entry.mjs'), 'import { run as renamed } from "./barrel.mjs"; renamed();');
  await writeFile(path.join(directory,'barrel.mjs'), 'export { run } from "./helper.mjs";');
  await writeFile(path.join(directory,'helper.mjs'), 'export function run() { return /forbidden/.test("input"); }');
  assert.equal(inferenceCallGraph([path.join(directory,'entry.mjs')]).violations.length,1);
  await writeFile(path.join(directory,'helper.mjs'), 'export function run() { return new RegExp("forbidden"); }');
  assert.equal(inferenceCallGraph([path.join(directory,'entry.mjs')]).violations.length,1);
  await writeFile(path.join(directory,'entry.mjs'), 'const helper = await import("./helper.mjs"); helper.run();');
  assert.equal(inferenceCallGraph([path.join(directory,'entry.mjs')]).violations.length,1);
  await writeFile(path.join(directory,'helper.mjs'), 'export function run() { return JSON.parse("{}"); }');
  assert.equal(inferenceCallGraph([path.join(directory,'entry.mjs')]).violations.length,0);
} finally { await rm(directory,{recursive:true,force:true}); }
console.log('Reliability text contracts passed: HTML parsing, structured decisions, owner-scoped citations, conservative failure, transitive regex regression.');
