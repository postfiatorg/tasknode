import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "hive-project-planning-smoke-key";
delete process.env.TASKNODE_HIVE_PROJECT_MODEL;
delete process.env.TASKNODE_HIVE_PROJECT_REASONING_EFFORT;

const { fetchHiveActiveProjects } = await import("../server/hive-project-worker.js");
const { projectHasOperatorArchiveLock } = await import("../server/repositories/hive-project-planning.js");

let capturedBody = null;
const result = await fetchHiveActiveProjects(
  {
    source_packet_text: [
      "HIVE SECRETARY REPORT",
      JSON.stringify({
        summary: "The network is prioritizing Task Node, the L1, and capital deployment.",
        project_signals: [
          {
            project_type: "protocol_development",
            signal: "Task Node needs a reliable task allocation surface.",
            reason: "Validated Hive Context entry named it as a key product.",
            input_refs: ["hivectx_smoke"],
          },
        ],
      }),
    ].join("\n\n"),
  },
  {
    fetchImpl: async (_url, options = {}) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            id: "resp_hive_project_smoke",
            model: "gpt-5.5-pro-2026-04-23",
            output_text: JSON.stringify({
              title: "Hive Active Projects",
              summary: "Task Node is the strongest active project signal.",
              projects: [
                {
                  id: "task_node_reliability",
                  type: "protocol_applications",
                  title: "Task Node reliability",
                  summary: "Make the Task Node loop reliable enough for daily network work.",
                  objective: "Stabilize the task request, allocation, review, and reward loop.",
                  about: "This project exists because the validated network context identifies Task Node as a key product and current execution bottleneck.",
                  phase_label: "1 of 3",
                  phase_current: 1,
                  phase_total: 3,
                  task_count: 8,
                  contributor_count: 3,
                  pft_routed: 240,
                  priority: 10,
                  rationale: "The Secretary report supports this project directly.",
                },
              ],
            }),
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
              output_tokens_details: { reasoning_tokens: 25 },
            },
          });
        },
      };
    },
  }
);

assert.equal(capturedBody.model, "gpt-5.5-pro");
assert.equal(capturedBody.reasoning.effort, "high");
assert.equal(capturedBody.text.verbosity, "low");
assert.equal(capturedBody.text.format.type, "json_schema");
assert.equal(capturedBody.text.format.name, "hive_active_projects");
assert.equal(capturedBody.store, false);
assert.equal(result.provider, "openai");
assert.equal(result.model, "gpt-5.5-pro-2026-04-23");
assert.equal(result.output.projects.length, 1);
assert.equal(result.output.projects[0].id, "task_node_reliability");
assert.equal(result.output.projects[0].type, "protocol_applications");
assert.equal(result.usage.reasoningTokens, 25);
assert.equal(projectHasOperatorArchiveLock({ metadata_json: { archived_reason: "operator_rejected" } }), true);
assert.equal(projectHasOperatorArchiveLock({ metadata_json: { operator_archived: true } }), true);
assert.equal(projectHasOperatorArchiveLock({ metadata_json: { rationale: "normal active project" } }), false);

console.log("hive project planning smoke ok");
