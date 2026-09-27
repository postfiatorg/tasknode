import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readChatTaskActivity } from "../server/repositories/chat-task-activity.js";
import { loadChatTaskActivity, taskContextFromActivity } from "../server/chat-task-activity.js";
import { formatChatTaskContext } from "../server/chat-task-context.js";
import { taskNodeInstructions } from "../server/chat-memory-context.js";
import { loadChatExecutionContext } from "../server/chat-context-load.js";

const container = process.env.TASKNODE_TEST_POSTGRES_CONTAINER;
if (!container) throw new Error("Set TASKNODE_TEST_POSTGRES_CONTAINER to the local Postgres container; this test uses only temporary tables.");

const fixture = `
CREATE TEMP TABLE app_accounts (account_id text, hive_handle text);
CREATE TEMP TABLE task_history_grants (subject_account_id text, viewer_account_id text, status text, scope text);
CREATE TEMP TABLE team_context_preferences (account_id text, include_in_personal_context boolean);
CREATE TEMP TABLE task_projections (
 account_id text, task_id text, title text, status text, description text,
 subject_wallet text, reward_actual_pft numeric, updated_at timestamptz, last_event_at timestamptz,
 deadline_at timestamptz, accept_by timestamptz, source text, metadata_json jsonb
);
CREATE TEMP TABLE task_events (
 id text, account_id text, task_id text, wallet_address text, event_type text, occurred_at timestamptz, payload_json jsonb
);
INSERT INTO app_accounts VALUES ('viewer','manager'),('worker','researcher'),('reverse','outgoing-only'),('stranger','unrelated');
INSERT INTO team_context_preferences VALUES ('viewer',true);
INSERT INTO task_history_grants VALUES ('worker','viewer','active','task_history_v1'),('viewer','reverse','active','task_history_v1');
INSERT INTO task_projections
 SELECT account_id, account_id||'_task','Deliver '||hive_handle||' report','verification_requested',
        'Reviewable work, not yet rewarded', 'wallet_'||account_id,0,
        '2026-09-22T10:30:00Z','2026-09-22T10:30:00Z',NULL,NULL,'direct_write','{}'::jsonb
 FROM app_accounts;
INSERT INTO task_events
 SELECT account_id||'_submit',account_id,account_id||'_task','wallet_'||account_id,
        'pf.task.submission.v1','2026-09-22T10:00:00Z','{"transition":"submitted"}'::jsonb FROM app_accounts;
INSERT INTO task_events VALUES ('old','worker','worker_task','wallet_worker','pf.task.submission.v1','2026-09-10T10:00:00Z','{}');
INSERT INTO task_events VALUES ('wrong_wallet','worker','worker_task','another_wallet','pf.task.submission.v1','2026-09-22T10:01:00Z','{}');
`;

function quote(value) {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return "'" + String(value).replaceAll("'", "''") + "'";
}
function queryFixture(mutation = "") {
  return async (sql, params) => {
    let expanded = sql;
    for (let n = params.length; n > 0; n--) expanded = expanded.replaceAll("$" + n, quote(params[n - 1]));
    const input = "BEGIN;\n" + fixture + "\n" + mutation
      + "\nSELECT COALESCE(jsonb_agg(result), '[]'::jsonb) FROM (" + expanded + ") result;\nROLLBACK;";
    const output = execFileSync("docker", ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "tasknodeofficial", "-d", "tasknodeofficial"], { input, encoding: "utf8" });
    return { rows: JSON.parse(output.trim()) };
  };
}
const options = { accountId: "viewer", now: new Date("2026-09-22T12:00:00Z"), enabled: true, teamEnabled: true };
const activity = await readChatTaskActivity({ ...options, queryFn: queryFixture() });
assert.deepEqual(activity.members.map((m) => m.accountId), ["viewer", "worker"]);
const worker = activity.members.find((m) => m.accountId === "worker");
assert.equal(worker.events.length, 1, "Only recent, correctly wallet-bound events may appear");
assert.equal(worker.events[0].transition, "submitted");
assert.equal(worker.tasks[0].status, "verification_requested");
assert.equal(worker.tasks[0].reward_actual_pft, 0, "Unpaid work must remain visible");
assert.equal(activity.capturedAt, "2026-09-22T12:00:00.000Z");

for (const mutation of [
  "UPDATE task_history_grants SET status='revoked' WHERE subject_account_id='worker';",
  "UPDATE task_history_grants SET scope='unsupported' WHERE subject_account_id='worker';",
  "UPDATE team_context_preferences SET include_in_personal_context=false;",
]) {
  const result = await readChatTaskActivity({ ...options, queryFn: queryFixture(mutation) });
  assert.deepEqual(result.members.map((m) => m.accountId), ["viewer"]);
}
assert.deepEqual((await readChatTaskActivity({ ...options, teamEnabled: false, queryFn: queryFixture() })).members.map((m) => m.accountId), ["viewer"]);
assert.equal(await readChatTaskActivity({ ...options, accountId: "", queryFn: () => assert.fail("Anonymous read") }), null);
assert.equal(await readChatTaskActivity({ ...options, enabled: false, queryFn: () => assert.fail("Disabled database read") }), null);

const many = await readChatTaskActivity({ ...options, queryFn: queryFixture(`
INSERT INTO task_events SELECT 'many_'||n,'worker','worker_task','wallet_worker','pf.task.update.v1','2026-09-22T11:00:00Z','{}' FROM generate_series(1,50) n;
`) });
const bounded = many.members.find((m) => m.accountId === "worker");
assert.equal(bounded.events.length, 40);
assert.equal(bounded.recentEventCount, 51);

const loaded = await loadChatTaskActivity("viewer", { readActivity: async () => activity });
assert.equal(loaded.status.included, true);
assert.equal((await loadChatTaskActivity("viewer", { readActivity: async () => { throw new Error("offline"); } })).status.state, "error");
assert.equal((await loadChatTaskActivity("viewer", { timeoutMs: 5, readActivity: () => new Promise(() => {}) })).status.state, "timeout");
const activityContext = taskContextFromActivity(activity);
assert.equal(activityContext.verification.length, 1);
assert.equal(activityContext.verification[0].task_id, "viewer_task");
const fallback = formatChatTaskContext(activityContext);
assert.ok(fallback.includes("worker_submit"));
assert.ok(!fallback.includes("<outstanding_tasks"), "A timed-out older projection must not add false empty lists");
for (const message of ["What has my teammate done today?", "Which tasks need verification?", "Has the researcher submitted anything this morning?"]) {
  const prompt = taskNodeInstructions({ message, taskContext: { activityOnly: true, activity }, deliveryContext: { source: "telegram_bot" } });
  assert.ok(prompt.includes("worker_submit"));
  assert.ok(prompt.includes("2026-09-22T10:00:00"));
  assert.ok(prompt.includes("Telegram Delivery Contract"));
}
let coreLoaded = false;
let legacyReads = 0;
const loaders = {
  loadDocument: async () => ({ context: { body: "Personal context" }, status: { state: "included" } }),
  loadMemory: async () => ({ context: { memories: [{ memory: "Remembered task" }] }, status: { state: "included" } }),
  loadActivity: async () => { coreLoaded = true; return loaded; },
  loadTasks: async () => { legacyReads++; return { context: null, status: { state: "timeout" } }; },
  loadTeam: async () => { assert.equal(coreLoaded, true); return { state: {}, text: "" }; },
};
const assembled = await loadChatExecutionContext("viewer", loaders);
assert.equal(legacyReads, 0, "Fresh activity must avoid the expensive UI task aggregation");
assert.equal(assembled.contextStatus.tasks.included, true);
assert.equal(assembled.contextStatus.tasks.counts.verification, 1);
assert.equal(assembled.memoryContext.memories[0].memory, "Remembered task");
await loadChatExecutionContext("viewer", { ...loaders, loadActivity: async () => ({ context: null, status: { state: "error" } }) });
assert.equal(legacyReads, 1, "Use the legacy reader only if the fresh snapshot is unavailable");
console.log("PASS: real SQL ACL, immediate revocation, opt-out, event bounds, phased context loading without UI aggregation, fallback and Telegram prompt parity.");
