import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readValidatedJson } from "../server/request-validation.js";
import { routePolicyForPath, routeBodyPolicyForRequest } from "../server/route-policies.js";
import { terminalTaskEvidenceSubmission } from "../server/tasknode-terminal-evidence.js";
import { applyOffchainTaskTransitionWithClient, transitionForSubmissionMode } from "../server/offchain-task-lifecycle.js";

const path = "/api/terminal/tasknode/tasks/task_report_fixture/evidence";
const route = routePolicyForPath(path);
assert.equal(route.auth, "bearer");
assert.deepEqual(route.methods, ["POST"]);
const contract = routeBodyPolicyForRequest(route, "POST", path);
const stored = [];
// Exercise the HTTP body boundary and real event serialization; database writes
// are captured in a fixture client. No real account, task or reward is changed.
const server = createServer(async (req, res) => {
  try {
    const body = await readValidatedJson(req, contract.maxBytes, contract.schema);
    const payload = terminalTaskEvidenceSubmission(body, "task_report_fixture");
    const client = {
      async query(sql, params = []) {
        if (sql.includes("INSERT INTO task_events")) stored.push(JSON.parse(params[8]));
        return { rowCount: 1, rows: [] };
      },
    };
    await applyOffchainTaskTransitionWithClient(client, {
      accountId: "acct_report_fixture",
      walletAddress: "rReportFixture",
      task: { task_id: "task_report_fixture", status: body.mode === "verification_response" ? "verification_requested" : "accepted" },
      transition: transitionForSubmissionMode(body.mode),
      payload,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    res.writeHead(error.status || 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message, field: error.field }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}${path}`;
async function submit(body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), method: "POST", headers: { "content-type": "application/json", connection: "close" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
try {
  for (const mode of ["initial_submission", "verification_response"]) {
    for (const length of [24_001, 40_000, 120_000]) {
      for (const citations of [false, true]) {
        const ending = "\nFinal conclusion: evidence intact. 結論 ✓";
        const report = "Measured findings with citations. ".repeat(4000).slice(0, length - ending.length) + ending;
        assert.equal(report.length, length);
        const evidence = citations ? [{ type: "url", url: "https://example.com/audit" }] : [];
        const result = await submit({ mode, summary: report, evidence, source: "pfterminal-cli" });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        const event = stored.at(-1);
        assert.equal(event.evidence_items[0].value, report);
        assert.equal(event.phase, mode);
        assert.equal(event.schema, mode === "verification_response" ? "pf.task.verification_response.v1" : "pf.task.submission.v1");
        if (mode === "verification_response") assert.ok(event.response_text.includes(report));
        if (citations) assert.equal(event.evidence_items[1].value, "https://example.com/audit");
      }
    }
    const before = stored.length;
    const tooLong = await submit({ mode, summary: "x".repeat(120_001) });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.field, "body.summary");
    assert.equal(tooLong.body.error, "request_body_field_too_long");
    const tooLarge = await submit({ mode, summary: "Report", evidence: [{ type: "text", value: "界".repeat(400_000) }] });
    assert.equal(tooLarge.status, 413);
    assert.equal(stored.length, before, "Rejected reports must not create lifecycle events");
  }
  const duplicate = terminalTaskEvidenceSubmission({ summary: "Report", evidence: [{ type: "text", value: "Report" }, { type: "url", url: "https://example.com/audit" }] });
  assert.equal(duplicate.evidence_items.length, 2);
  assert.equal(duplicate.evidence_items[0].value, "Report");
  const valueOnly = terminalTaskEvidenceSubmission({ value: "Legacy report" });
  assert.equal(valueOnly.evidence_items[0].value, "Legacy report");
  const urlOnly = terminalTaskEvidenceSubmission({ evidence: [{ type: "url", url: "https://example.com/audit" }] });
  assert.equal(urlOnly.evidence_items[0].artifact_type, "url");
  console.log("PASS: long reports accepted over HTTP for both phases; complete text and citations retained in event writes; oversize requests rejected without writes.");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
