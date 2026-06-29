import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "hive-project-planning-smoke-key";
delete process.env.TASKNODE_HIVE_PROJECT_MODEL;
delete process.env.TASKNODE_HIVE_PROJECT_REASONING_EFFORT;

const { fetchHiveActiveProjects } = await import("../server/hive-project-worker.js");
const { projectHasOperatorArchiveLock } = await import("../server/repositories/hive-project-planning.js");
const {
  applyHiveProjectsViewerContext,
  hiveProjectsDocumentForTests,
} = await import("../server/repositories/hive-projects.js");

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
assert.equal(result.output.projects[0].id, "task_node_core_product");
assert.equal(result.output.projects[0].title, "Task Node Core Product");
assert.equal(result.output.projects[0].type, "protocol_applications");
assert.equal(result.output.projects[0].task_count, 0);
assert.equal(result.output.projects[0].contributor_count, 0);
assert.equal(result.output.projects[0].pft_routed, 0);
assert.equal(result.usage.reasoningTokens, 25);
assert.equal(projectHasOperatorArchiveLock({ metadata_json: { archived_reason: "agent_archived_without_operator_lock" } }), false);
assert.equal(projectHasOperatorArchiveLock({ metadata_json: { operator_archived: true } }), true);
assert.equal(projectHasOperatorArchiveLock({ metadata_json: { archive_lock_source: "migration" } }), true);
assert.equal(projectHasOperatorArchiveLock({ metadata_json: { rationale: "normal active project" } }), false);

const boardDocument = hiveProjectsDocumentForTests({
  projectRows: [
    {
      id: "empty_active_project",
      title: "Empty active project",
      summary: "Planning-only card.",
      status: "active",
      priority: 10,
      metadata_json: {},
    },
    {
      id: "live_project",
      title: "Live project",
      summary: "Backed by a task projection.",
      status: "active",
      priority: 20,
      metadata_json: {},
    },
    {
      id: "agent_archived_project",
      title: "Agent archived project",
      summary: "Can return when execution evidence exists.",
      status: "archived",
      priority: 30,
      metadata_json: { agent_archived: true },
    },
    {
      id: "operator_archived_project",
      title: "Operator archived project",
      summary: "Locked out even with stale rows.",
      status: "archived",
      priority: 40,
      metadata_json: { operator_archived: true },
    },
    {
      id: "pending_generation_project",
      title: "Pending generation project",
      summary: "No task row until PFTL projection exists.",
      status: "active",
      priority: 50,
      metadata_json: {},
    },
  ],
  taskRows: [
    {
      id: "ref_live",
      project_id: "live_project",
      task_id: "task_live",
      request_id: "req_live",
      title: "Stale title",
      state: "proposed",
      assignee_wallet: "rOld",
      reward_pft: 100,
      projected_title: "Projected task",
      projected_status: "accepted",
      projected_subject_wallet: "rProjected",
      projected_reward_pft: 250,
      created_at: "2026-05-26T00:00:00.000Z",
      projected_updated_at: "2026-05-26T00:01:00.000Z",
    },
    {
      id: "ref_rewarded_history",
      project_id: "live_project",
      task_id: "task_rewarded_history",
      title: "Rewarded history",
      state: "rewarded",
      assignee_wallet: "rHistory",
      reward_pft: 0,
      created_at: "2026-05-25T23:50:00.000Z",
      updated_at: "2026-05-25T23:55:00.000Z",
    },
    {
      id: "ref_refused_history",
      project_id: "live_project",
      task_id: "task_refused_history",
      title: "Refused history",
      state: "refused",
      assignee_wallet: "rHistory",
      reward_pft: 0,
      created_at: "2026-05-25T23:40:00.000Z",
      updated_at: "2026-05-25T23:45:00.000Z",
    },
    {
      id: "ref_cancelled_history",
      project_id: "live_project",
      task_id: "task_cancelled_history",
      title: "Cancelled history",
      state: "cancelled",
      assignee_wallet: "rHistory",
      reward_pft: 0,
      created_at: "2026-05-25T23:30:00.000Z",
      updated_at: "2026-05-25T23:35:00.000Z",
    },
    {
      id: "ref_agent_archived",
      project_id: "agent_archived_project",
      task_id: "task_resurrected",
      title: "Resurrection evidence",
      state: "accepted",
      assignee_wallet: "rProjected",
      reward_pft: 300,
      created_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:01:00.000Z",
    },
    {
      id: "ref_operator_archived",
      project_id: "operator_archived_project",
      task_id: "task_locked",
      title: "Locked evidence",
      state: "accepted",
      assignee_wallet: "rLocked",
      reward_pft: 300,
      created_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:01:00.000Z",
    },
  ],
  pendingGenerationRows: [
    { project_id: "pending_generation_project", pending_generation_count: 1 },
  ],
});
assert.deepEqual(boardDocument.projectIds, ["live_project", "pending_generation_project"]);
assert.deepEqual(boardDocument.archivedProjectIds, ["agent_archived_project", "operator_archived_project"]);
assert.equal(boardDocument.stats.activeProjects, 2);
assert.equal(boardDocument.stats.archivedProjects, 2);
assert.equal(boardDocument.stats.tasksInFlight, 1);
assert.equal(boardDocument.stats.taskRows, 4);
assert.equal(boardDocument.stats.terminalTaskRows, 3);
assert.equal(boardDocument.stats.pftRouted, 250);
assert.equal(boardDocument.projects.empty_active_project, undefined);
assert.equal(boardDocument.projects.agent_archived_project, undefined);
assert.equal(boardDocument.projects.operator_archived_project, undefined);
assert.equal(boardDocument.archivedProjects.agent_archived_project.name, "Agent archived project");
assert.equal(boardDocument.archivedProjects.agent_archived_project.taskCount, 1);
assert.equal(boardDocument.archivedProjects.agent_archived_project.operatorArchiveLock, false);
assert.equal(boardDocument.archivedProjects.operator_archived_project.operatorArchiveLock, true);
assert.equal(boardDocument.projects.live_project.tasks[0].title, "Projected task");
assert.equal(boardDocument.projects.live_project.tasks[0].state, "accepted");
assert.equal(boardDocument.projects.live_project.tasks[0].assignee, "rProjected");
assert.equal(boardDocument.projects.live_project.tasks[0].pft, 250);
assert.equal(boardDocument.projects.live_project.taskCount, 4);
assert.equal(boardDocument.projects.live_project.tasksInFlight, 1);
assert.equal(boardDocument.projects.live_project.terminalTaskCount, 3);
assert.equal(boardDocument.projects.pending_generation_project.pendingGenerationCount, 1);
assert.equal(boardDocument.projects.pending_generation_project.tasks.length, 0);
assert.equal(boardDocument.operators.rProjected.load, 1);
assert.equal(boardDocument.operators.rProjected.currentTasks.length, 1);

const personalizedRows = {
  projectRows: [
    {
      id: "personalized_project",
      title: "Personalized project",
      summary: "Backed by multiple active tasks.",
      status: "active",
      priority: 10,
      metadata_json: {},
    },
  ],
  taskRows: [
    {
      id: "ref_other_active",
      project_id: "personalized_project",
      task_id: "task_other_active",
      title: "Other active task",
      state: "accepted",
      assignee_wallet: "rOther",
      reward_pft: 300,
      account_id: "acct_other",
      created_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:01:00.000Z",
    },
    {
      id: "ref_viewer_active",
      project_id: "personalized_project",
      task_id: "task_viewer_active",
      title: "Viewer active task",
      state: "accepted",
      assignee_wallet: "rViewer",
      reward_pft: 100,
      account_id: "acct_viewer",
      created_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:02:00.000Z",
    },
  ],
};
const anonymousBoardDocument = hiveProjectsDocumentForTests(personalizedRows);
assert.equal(anonymousBoardDocument.projects.personalized_project.nextTask.title, "Other active task");
assert.equal(anonymousBoardDocument.projects.personalized_project.nextTask.viewerScoped, false);
const viewerBoardDocument = hiveProjectsDocumentForTests({
  ...personalizedRows,
  viewerAccountId: "acct_viewer",
  viewerWalletAddress: "rViewer",
});
assert.equal(viewerBoardDocument.projects.personalized_project.nextTask.title, "Viewer active task");
assert.equal(viewerBoardDocument.projects.personalized_project.nextTask.viewerScoped, true);
assert.equal(viewerBoardDocument.projects.personalized_project.nextTask.viewerRelation, "active");
assert.equal(viewerBoardDocument.projects.personalized_project.nextTask.viewerActive, true);
const overlaidViewerDocument = applyHiveProjectsViewerContext(anonymousBoardDocument, {
  viewerAccountId: "acct_viewer",
  viewerWalletAddress: "rViewer",
});
assert.equal(anonymousBoardDocument.projects.personalized_project.nextTask.title, "Other active task");
assert.equal(overlaidViewerDocument.projects.personalized_project.nextTask.title, "Viewer active task");
assert.equal(overlaidViewerDocument.projects.personalized_project.nextTask.viewerScoped, true);
assert.equal(overlaidViewerDocument.projects.personalized_project.nextTask.viewerRelation, "active");

const viewerOfferDocument = hiveProjectsDocumentForTests({
  projectRows: personalizedRows.projectRows,
  taskRows: [
    personalizedRows.taskRows[0],
    {
      id: "ref_viewer_offer",
      project_id: "personalized_project",
      task_id: "task_viewer_offer",
      title: "Viewer proposed offer",
      state: "proposed",
      assignee_wallet: "rViewer",
      reward_pft: 500,
      account_id: "acct_viewer",
      created_at: "2026-05-26T00:00:00.000Z",
      updated_at: "2026-05-26T00:03:00.000Z",
    },
  ],
  viewerAccountId: "acct_viewer",
  viewerWalletAddress: "rViewer",
});
assert.equal(viewerOfferDocument.projects.personalized_project.nextTask.title, "Viewer proposed offer");
assert.equal(viewerOfferDocument.projects.personalized_project.nextTask.viewerScoped, true);
assert.equal(viewerOfferDocument.projects.personalized_project.nextTask.viewerRelation, "offer");
assert.equal(viewerOfferDocument.projects.personalized_project.nextTask.viewerActive, false);

console.log("hive project planning smoke ok");
