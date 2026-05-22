import startHere from "../../../docs/wiki/index.md?raw";
import agents from "../../../docs/wiki/surfaces/agents.md?raw";
import chat from "../../../docs/wiki/surfaces/chat.md?raw";
import context from "../../../docs/wiki/surfaces/context.md?raw";
import dailyAirdrop from "../../../docs/wiki/surfaces/daily-airdrop.md?raw";
import hive from "../../../docs/wiki/surfaces/hive.md?raw";
import memory from "../../../docs/wiki/surfaces/memory.md?raw";
import profile from "../../../docs/wiki/surfaces/profile.md?raw";
import refineContext from "../../../docs/wiki/surfaces/refine-context.md?raw";
import search from "../../../docs/wiki/surfaces/search.md?raw";
import tasks from "../../../docs/wiki/surfaces/tasks.md?raw";
import wallet from "../../../docs/wiki/surfaces/wallet.md?raw";
import aiProviders from "../../../docs/wiki/architecture/ai-providers.md?raw";
import database from "../../../docs/wiki/architecture/database.md?raw";
import encryption from "../../../docs/wiki/architecture/encryption.md?raw";
import executionMandate from "../../../docs/wiki/architecture/execution-mandate.md?raw";
import ipfs from "../../../docs/wiki/architecture/ipfs.md?raw";
import nostr from "../../../docs/wiki/architecture/nostr.md?raw";
import pftl from "../../../docs/wiki/architecture/pftl.md?raw";
import pftlTransactionCache from "../../../docs/wiki/architecture/pftl-transaction-cache.md?raw";
import taskAsyncEngine from "../../../docs/wiki/architecture/task-async-engine.md?raw";
import taskLifecycle from "../../../docs/wiki/architecture/task-lifecycle.md?raw";
import boardManager from "../../../docs/wiki/plans/board-manager.md?raw";
import codeReviewBurndown from "../../../docs/wiki/plans/code-review-burndown.md?raw";
import contextEditChatMode from "../../../docs/wiki/plans/context-edit-chat-mode.md?raw";
import dataArchitectureHardeningPlan from "../../../docs/wiki/plans/data-architecture-hardening-plan.md?raw";
import dailyAirdropMigrationPlan from "../../../docs/wiki/plans/daily-airdrop-migration-plan.md?raw";
import gettingTasksOverLine from "../../../docs/wiki/plans/getting-tasks-over-line.md?raw";
import jobsChatSpirit from "../../../docs/wiki/plans/jobs-chat-spirit.md?raw";
import makingFunctionalNetworkTasks from "../../../docs/wiki/plans/making-functional-network-tasks.md?raw";
import networkTaskProfileMemoryPlan from "../../../docs/wiki/plans/network-task-profile-memory-plan.md?raw";
import pftlTransactionCacheMilestone from "../../../docs/wiki/plans/pftl-transaction-cache-milestone.md?raw";
import profileAndHiveMindPlan from "../../../docs/wiki/plans/profile-and-hive-mind-plan.md?raw";
import publicProfileRealDataPlan from "../../../docs/wiki/plans/public-profile-real-data-plan.md?raw";
import pythonicTaskEngineSpeedrun from "../../../docs/wiki/plans/pythonic-task-engine-speedrun.md?raw";
import taskEngineUxIntegrationPlan from "../../../docs/wiki/plans/task-engine-ux-integration-plan.md?raw";
import taskNodeInstructionsPrompt from "../../../prompts/chat/task_node_instructions_v1.md?raw";
import jobsChatOsPrompt from "../../../prompts/chat/jobs_chat_os_v1.xml?raw";
import contextEditJobsPrompt from "../../../prompts/context/context_edit_jobs_v1.xml?raw";
import accountMemoryContextPrompt from "../../../prompts/chat/account_memory_context_v1.md?raw";
import accountTasksContextPrompt from "../../../prompts/chat/account_tasks_context_v1.md?raw";
import chatMemoryPrompt from "../../../prompts/memory/chat_memory_v1.md?raw";
import deepMemoryPrompt from "../../../prompts/memory/deep_memory_v1.md?raw";
import networkTaskProfilePrompt from "../../../prompts/memory/network_task_profile_v2.md?raw";
import boardManagerPrompt from "../../../prompts/hive/board_manager_v1.md?raw";
import hiveSecretaryPrompt from "../../../prompts/hive/hive_secretary_v1.md?raw";
import hiveActiveProjectsPrompt from "../../../prompts/hive/hive_active_projects_v1.md?raw";
import dailyAirdropPrompt from "../../../prompts/profile/daily_airdrop_v1.md?raw";
import publicProfileSnapshotPrompt from "../../../prompts/profile/public_profile_snapshot_v1.md?raw";
import blockContractPrompt from "../../../prompts/task_engine/block_contract_v1.md?raw";
import evidenceScreenshotPrompt from "../../../prompts/task_engine/evidence_screenshot_read_v1.md?raw";
import rewardScoringPrompt from "../../../prompts/task_engine/reward_scoring_v1.md?raw";
import taskgenPrompt from "../../../prompts/task_engine/taskgen_minimal_v1.md?raw";
import taskgenRepairPrompt from "../../../prompts/task_engine/taskgen_repair_v1.md?raw";
import verificationRequestPrompt from "../../../prompts/task_engine/verification_request_v1.md?raw";
import profileNftImagePrompt from "../../../prompts/profile_nft_image.placeholder.md?raw";

const PROMPT_SOURCES = [
  {
    family: "Profile",
    title: "Daily Airdrop Scoring",
    path: "prompts/profile/daily_airdrop_v1.md",
    summary: "Scores the recent positive-reward task packet into the daily PFT airdrop amount and explanatory bullets.",
    status: "Active for scoring and operator-triggered live issuance",
    usedBy: [
      "server/profile-daily-airdrop.js::runDailyAirdropScore",
      "scripts/profile-daily-airdrop-score.mjs",
      "scripts/profile-daily-airdrop-issue.mjs",
      "GET /api/profile/daily-airdrop",
    ],
    content: dailyAirdropPrompt,
  },
  {
    family: "Profile",
    title: "Profile NFT Image",
    path: "prompts/profile_nft_image.placeholder.md",
    summary: "Public fallback template for profile NFT image generation. Production uses ignored private_prompts/profile_nft_image.md or PROFILE_NFT_PROMPT_PATH.",
    status: "Fallback template; private production prompt is intentionally not exposed",
    usedBy: [
      "server/profile-nft-prompts.js::renderProfileNftPrompt",
      "server/profile-nft-generation.js::profileNftGenerateStart",
    ],
    content: profileNftImagePrompt,
  },
  {
    family: "Profile",
    title: "Public Profile Snapshot",
    path: "prompts/profile/public_profile_snapshot_v1.md",
    summary: "Generates role title, role summary, skills, and archetype from deterministic public profile metrics.",
    status: "Active for public profile snapshot regeneration",
    usedBy: [
      "server/profile-public-snapshot.js::runPublicProfileSnapshot",
      "scripts/profile-public-snapshot.mjs",
      "POST /api/profile/public/regenerate",
    ],
    content: publicProfileSnapshotPrompt,
  },
  {
    family: "Chat",
    title: "Task Node Instructions",
    path: "prompts/chat/task_node_instructions_v1.md",
    summary: "Base chat system instructions for OpenAI Frontier modes and OpenRouter Private modes.",
    status: "Active",
    usedBy: [
      "server/chat-memory-context.js::taskNodeInstructions",
      "server/chat-router.js::openRouterMessages",
      "server/chat-router.js::openAiResponseRequest",
    ],
    content: taskNodeInstructionsPrompt,
  },
  {
    family: "Chat",
    title: "Jobs Chat Spirit",
    path: "prompts/chat/jobs_chat_os_v1.xml",
    summary: "Shared XML operating prompt that gives all four chat modes the Jobs-style product voice while preserving Task Node context, memory, and task awareness.",
    status: "Active by default; disabled only when TASKNODE_CHAT_SPIRIT_ENABLED=false",
    usedBy: [
      "server/chat-spirit-context.js::formatChatSpiritContext",
      "server/chat-memory-context.js::taskNodeInstructions",
      "server/chat-router.js::openRouterMessages",
      "server/chat-router.js::openAiResponseRequest",
    ],
    content: jobsChatOsPrompt,
  },
  {
    family: "Chat",
    title: "Context Refine Jobs",
    path: "prompts/context/context_edit_jobs_v1.xml",
    summary: "Dedicated structured-output prompt for Chat Context Refine mode.",
    status: "Active for Context Refine",
    usedBy: [
      "server/context-edit-prompts.js::renderContextEditPrompt",
      "server/context-edit-chat.js::executeContextEditChat",
    ],
    content: contextEditJobsPrompt,
  },
  {
    family: "Chat",
    title: "Account Memory Context",
    path: "prompts/chat/account_memory_context_v1.md",
    summary: "Template around deep memory and recent memory injected into chat instructions.",
    status: "Active when memory exists",
    usedBy: [
      "server/chat-memory-context.js::formatChatMemoryContext",
      "server/chat-memory-context.js::taskNodeInstructions",
    ],
    content: accountMemoryContextPrompt,
  },
  {
    family: "Chat",
    title: "Account Tasks Context",
    path: "prompts/chat/account_tasks_context_v1.md",
    summary: "Task projection context grouped as Outstanding, Pending Verification, Refused, and Rewarded.",
    status: "Active when account task state exists",
    usedBy: [
      "server/chat-task-context.js::formatChatTaskContext",
      "server/chat-task-context.js::taskContextForAccount",
      "server/chat-memory-context.js::taskNodeInstructions",
    ],
    content: accountTasksContextPrompt,
  },
  {
    family: "Memory",
    title: "Turn Memory Summary",
    path: "prompts/memory/chat_memory_v1.md",
    summary: "Async summary prompt for one user/assistant exchange.",
    status: "Active async worker",
    usedBy: [
      "server/chat-memory-worker.js::memorySystemPrompt",
      "server/chat-memory-worker.js::fetchMemorySummary",
      "server/repositories/chat-memory.js::completeChatMemoryJob",
    ],
    content: chatMemoryPrompt,
  },
  {
    family: "Memory",
    title: "Deep Memory Summary",
    path: "prompts/memory/deep_memory_v1.md",
    summary: "Async summary prompt that compresses 36 turn memories into account-level memory.",
    status: "Active async worker",
    usedBy: [
      "server/chat-memory-worker.js::deepMemorySystemPrompt",
      "server/chat-memory-worker.js::fetchDeepMemorySummary",
      "server/repositories/chat-memory.js::completeDeepMemoryJob",
    ],
    content: deepMemoryPrompt,
  },
  {
    family: "Memory",
    title: "Network Task Profile",
    path: "prompts/memory/network_task_profile_v2.md",
    summary: "Async diagnostic profile prompt over context, memory, profile, and Network Context Inputs.",
    status: "Active async worker",
    usedBy: [
      "server/chat-memory-worker.js::fetchNetworkTaskProfile",
      "server/repositories/network-task-profile.js::completeNetworkTaskProfileJob",
      "GET /api/memory/network-task-profile",
    ],
    content: networkTaskProfilePrompt,
  },
  {
    family: "Hive",
    title: "Board Manager",
    path: "prompts/hive/board_manager_v1.md",
    summary: "Operating prompt for the single leased Board Manager action registry.",
    status: "Active for persistent Board Manager Codex Exec runs and first action hooks",
    usedBy: [
      "docs/wiki/plans/board-manager.md",
      "scripts/board-manager-codex-exec.mjs",
      "server/repositories/board-manager.js::formatBoardManagerCodexPrompt",
    ],
    content: boardManagerPrompt,
  },
  {
    family: "Hive",
    title: "Hive Secretary",
    path: "prompts/hive/hive_secretary_v1.md",
    summary: "Updates the network context report from validated-wallet Hive Input entries.",
    status: "Active async worker",
    usedBy: [
      "server/hive-secretary-worker.js::fetchHiveSecretaryReport",
      "server/repositories/hive-context.js::completeHiveSecretaryJob",
      "GET /api/hive/context",
    ],
    content: hiveSecretaryPrompt,
  },
  {
    family: "Hive",
    title: "Hive Active Projects",
    path: "prompts/hive/hive_active_projects_v1.md",
    summary: "Determines the active network project set from the latest Hive Secretary report and current project registry.",
    status: "Active async worker",
    usedBy: [
      "server/hive-project-worker.js::fetchHiveActiveProjects",
      "server/repositories/hive-project-planning.js::completeHiveProjectPlanningJob",
      "GET /api/hive/projects",
    ],
    content: hiveActiveProjectsPrompt,
  },
  {
    family: "Task Engine",
    title: "Task Generation",
    path: "prompts/task_engine/taskgen_minimal_v1.md",
    summary: "Generates one concise PFTL task from request, context, memory, chat, wallet, and policy blocks.",
    status: "Active app worker and Python reference",
    usedBy: [
      "server/task-generation-worker.js::generateTaskWithOpenAi",
      "reference_clients/python/tasknode_pftl/taskgen.py::generate_task",
      "reference_clients/python/tasknode_pftl/taskgen.py::benchmark_taskgen",
      "reference_clients/python/tasknode_pftl/taskgen.py::TASKGEN_RESPONSE_FORMAT",
    ],
    content: taskgenPrompt,
  },
  {
    family: "Task Engine",
    title: "Task Block Contract",
    path: "prompts/task_engine/block_contract_v1.md",
    summary: "Human-readable contract for taskgen input blocks.",
    status: "Documentation contract",
    usedBy: [
      "reference_clients/python/tasknode_pftl/taskgen.py::project_taskgen_input",
      "reference_clients/python/tasknode_pftl/app_data.py::build_request_bundle_from_fixture",
    ],
    content: blockContractPrompt,
  },
  {
    family: "Task Engine",
    title: "Task JSON Repair",
    path: "prompts/task_engine/taskgen_repair_v1.md",
    summary: "Reserved repair prompt for malformed task generation JSON.",
    status: "Reserved",
    usedBy: ["No runtime caller yet"],
    content: taskgenRepairPrompt,
  },
  {
    family: "Verification",
    title: "Verification Request",
    path: "prompts/task_engine/verification_request_v1.md",
    summary: "Policy for a single follow-up verification ask after initial task submission.",
    status: "Active app worker and Python reference",
    usedBy: [
      "server/task-review-worker.js::processSubmittedTask",
      "reference_clients/python/tasknode_pftl/engine/scoring.py::build_verification_request",
    ],
    content: verificationRequestPrompt,
  },
  {
    family: "Verification",
    title: "Screenshot Evidence Read",
    path: "prompts/task_engine/evidence_screenshot_read_v1.md",
    summary: "Vision prompt for describing screenshot evidence without inventing hidden state.",
    status: "Active",
    usedBy: [
      "server/task-evidence-processing.js::processEvidenceFileForSubmission",
      "reference_clients/python/tasknode_pftl/verification.py::describe_screenshot_with_openai",
    ],
    content: evidenceScreenshotPrompt,
  },
  {
    family: "Reward",
    title: "Reward Scoring",
    path: "prompts/task_engine/reward_scoring_v1.md",
    summary: "Scores verification evidence and produces reward, partial reward, or zero-reward decisions.",
    status: "Active app worker and Python reference",
    usedBy: [
      "server/task-review-worker.js::processVerificationResponse",
      "reference_clients/python/tasknode_pftl/engine/scoring.py::score_reward",
    ],
    content: rewardScoringPrompt,
  },
];

const PROMPT_PAGES = [
  {
    slug: "prompts-index",
    title: "Prompt Index",
    summary: "Source-controlled prompts and runtime call sites.",
    markdown: promptIndexMarkdown(),
  },
  promptFamilyPage({
    slug: "prompts-profile",
    title: "Profile Prompts",
    summary: "Daily airdrop scoring and profile generation prompts.",
    family: "Profile",
  }),
  promptFamilyPage({
    slug: "prompts-chat",
    title: "Chat Prompts",
    summary: "System instructions and account memory context used by chat.",
    family: "Chat",
  }),
  promptFamilyPage({
    slug: "prompts-memory",
    title: "Memory Prompts",
    summary: "Async memory compression prompts.",
    family: "Memory",
  }),
  promptFamilyPage({
    slug: "prompts-hive",
    title: "Hive Prompts",
    summary: "Network context synthesis prompts.",
    family: "Hive",
  }),
  promptFamilyPage({
    slug: "prompts-task-engine",
    title: "Task Engine Prompts",
    summary: "Task generation and input block prompt contracts.",
    family: "Task Engine",
  }),
  promptFamilyPage({
    slug: "prompts-verification",
    title: "Verification Prompts",
    summary: "Follow-up verification and evidence reading prompts.",
    family: "Verification",
  }),
  promptFamilyPage({
    slug: "prompts-reward",
    title: "Reward Prompts",
    summary: "Reward scoring prompt policy.",
    family: "Reward",
  }),
];

function promptIndexMarkdown() {
  const entries = PROMPT_SOURCES.flatMap((source) => [
    `### ${source.family}: ${source.title}`,
    `- Prompt file: \`${source.path}\``,
    `- Status: ${source.status}`,
    `- Summary: ${source.summary}`,
    `- Used by: ${source.usedBy.map((item) => `\`${item}\``).join(", ")}`,
  ]).join("\n\n");
  return [
    "# Prompt Index",
    "Prompt text shown in this Help section is imported directly from files under `prompts/` using Vite raw imports. Do not paste prompt text into docs by hand; update the prompt file and this page will change on the next build.",
    "Runtime code should record prompt version and prompt digest whenever prompt output becomes part of a PFTL payload, database cache, or audit trail.",
    "## Runtime Map",
    entries,
  ].join("\n\n");
}

function promptFamilyPage({ slug, title, summary, family }) {
  const sources = PROMPT_SOURCES.filter((source) => source.family === family);
  return {
    slug,
    title,
    summary,
    markdown: [
      `# ${title}`,
      summary,
      "These prompt blocks are rendered from the source files listed below. Editing a prompt file changes the Help rendering on the next frontend build.",
      ...sources.flatMap((source) => promptSourceSections(source)),
    ].join("\n\n"),
  };
}

function promptSourceSections(source) {
  return [
    `## ${source.title}`,
    `Source file: \`${source.path}\``,
    `Runtime status: ${source.status}`,
    ["Used by:", ...source.usedBy.map((item) => `- \`${item}\``)].join("\n"),
    ["Prompt text:", "```text", source.content.trim(), "```"].join("\n"),
  ];
}

export const DOC_GROUPS = [
  {
    title: "Start",
    pages: [
      {
        slug: "start",
        title: "Start Here",
        summary: "The product and protocol mental model.",
        markdown: startHere,
      },
    ],
  },
  {
    title: "Surfaces",
    pages: [
      { slug: "chat", title: "Chat", summary: "The primary work surface.", markdown: chat },
      { slug: "search", title: "Search", summary: "Retrieval across cached work.", markdown: search },
      { slug: "tasks", title: "Tasks", summary: "Portable task lifecycle state.", markdown: tasks },
      { slug: "hive", title: "Hive", summary: "Network project routing and operator coordination.", markdown: hive },
      { slug: "wallet", title: "Wallet", summary: "Identity, balances, and custody.", markdown: wallet },
      { slug: "profile", title: "Profile", summary: "Member trust surface and daily airdrop state.", markdown: profile },
      {
        slug: "daily-airdrop",
        title: "Daily Airdrop",
        summary: "Account-level contributor scoring and identity-cloud recipient selection.",
        markdown: dailyAirdrop,
      },
      { slug: "context", title: "Context", summary: "Durable working profile.", markdown: context },
      {
        slug: "refine-context",
        title: "Refine Context",
        summary: "Clean up context without changing meaning.",
        markdown: refineContext,
      },
      { slug: "agents", title: "Agents", summary: "External wallet-native workers.", markdown: agents },
      { slug: "memory", title: "Memory", summary: "Inspectable chat compression.", markdown: memory },
    ],
  },
  {
    title: "Architecture",
    pages: [
      { slug: "pftl", title: "PFTL Usage", summary: "Chain records and pointer usage.", markdown: pftl },
      {
        slug: "pftl-transaction-cache",
        title: "PFTL Transaction Cache",
        summary: "Wallet transaction mirror and sync strategy.",
        markdown: pftlTransactionCache,
      },
      {
        slug: "ai-providers",
        title: "AI Providers",
        summary: "Mode routing across OpenAI and OpenRouter.",
        markdown: aiProviders,
      },
      {
        slug: "encryption",
        title: "Encryption",
        summary: "MessageKey and encrypted payloads.",
        markdown: encryption,
      },
      { slug: "ipfs", title: "IPFS", summary: "CID-backed payload standards.", markdown: ipfs },
      { slug: "database", title: "Database", summary: "Postgres cache architecture.", markdown: database },
      {
        slug: "execution-mandate",
        title: "Execution Mandate",
        summary: "Verification rules for repo work and claims of completion.",
        markdown: executionMandate,
      },
      {
        slug: "task-lifecycle",
        title: "Task Lifecycle",
        summary: "Replayable task state machine.",
        markdown: taskLifecycle,
      },
      {
        slug: "task-async-engine",
        title: "Task Async Engine",
        summary: "Wallet queues, worker ownership, and request edge states.",
        markdown: taskAsyncEngine,
      },
      { slug: "nostr", title: "Nostr TBD", summary: "Public broadcast boundary.", markdown: nostr },
    ],
  },
  {
    title: "Prompts",
    pages: PROMPT_PAGES,
  },
  {
    title: "Plans",
    pages: [
      {
        slug: "board-manager",
        title: "Board Manager",
        summary: "Plan for the leased Codex Exec manager that owns Hive actions and replaces independent Hive crons.",
        markdown: boardManager,
      },
      {
        slug: "code-review-burndown",
        title: "Code Review Burndown",
        summary: "Doc-driven review queue for visible app promises.",
        markdown: codeReviewBurndown,
      },
      {
        slug: "getting-tasks-over-line",
        title: "Getting Tasks Over The Line",
        summary: "Plan to make task requests, submissions, rewards, and projections real.",
        markdown: gettingTasksOverLine,
      },
      {
        slug: "task-engine-ux-integration-plan",
        title: "Task Engine UX Integration Plan",
        summary: "Audit plan for porting the backend task engine into the visible app lifecycle.",
        markdown: taskEngineUxIntegrationPlan,
      },
      {
        slug: "data-architecture-hardening-plan",
        title: "Data Architecture Hardening Plan",
        summary: "Audit and burndown for making PFTL cache, task projections, worker queues, and read models trustworthy.",
        markdown: dataArchitectureHardeningPlan,
      },
      {
        slug: "jobs-chat-spirit",
        title: "Jobs Chat Spirit",
        summary: "Plan for the Jobs XML chat prompt and later pgvector retrieval over Jobs notes.",
        markdown: jobsChatSpirit,
      },
      {
        slug: "context-edit-chat-mode",
        title: "Context Refine Chat Mode",
        summary: "Plan for line-numbered Jobs-calibrated context editing inside Chat.",
        markdown: contextEditChatMode,
      },
      {
        slug: "profile-and-hive-mind-plan",
        title: "Profile and Hive Mind Plan",
        summary: "Plan for member profiles, discoverability, recommendation jobs, and deterministic hive priorities.",
        markdown: profileAndHiveMindPlan,
      },
      {
        slug: "making-functional-network-tasks",
        title: "Making Functional Network Tasks",
        summary: "Plan for Hive projects, project-linked PFTL tasks, routing allocations, and Network Diagnostic Report matching.",
        markdown: makingFunctionalNetworkTasks,
      },
      {
        slug: "network-task-profile-memory-plan",
        title: "Network Task Profile Memory Plan",
        summary: "Plan for an auditable Memory packet used to route future network tasks.",
        markdown: networkTaskProfileMemoryPlan,
      },
      {
        slug: "public-profile-real-data-plan",
        title: "Public Profile Real Data Plan",
        summary: "Plan to replace public profile mock fields with real profile metrics, NFTs, and DeepSeek-generated role copy.",
        markdown: publicProfileRealDataPlan,
      },
      {
        slug: "daily-airdrop-migration-plan",
        title: "Daily Airdrop Migration Plan",
        summary: "PFTasks research and Task Node plan for a DeepSeek V4 Pro daily drop.",
        markdown: dailyAirdropMigrationPlan,
      },
      {
        slug: "pythonic-task-engine-speedrun",
        title: "Pythonic Task Engine Speedrun",
        summary: "Review plan for the raw Python multi-wallet task lifecycle proof.",
        markdown: pythonicTaskEngineSpeedrun,
      },
      {
        slug: "pftl-transaction-cache-milestone",
        title: "PFTL Transaction Cache Milestone",
        summary: "Milestone for the wallet transaction mirror, sync workers, and cache consumers.",
        markdown: pftlTransactionCacheMilestone,
      },
    ],
  },
];

export const DOC_PAGES = DOC_GROUPS.flatMap((group) =>
  group.pages.map((page) => ({ ...page, group: group.title }))
);
